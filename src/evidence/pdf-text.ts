import { createRequire } from 'node:module'
import path from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { FactCheckError } from '../errors.js'

/**
 * PDF から本文テキストを、ページ境界を保ったまま取り出す。
 *
 * 一次資料（官公庁の調査文書・裁判所の訴状）は PDF で配られることが多く、これを扱えないと
 * 「一次資料であるほど AI の提出した証拠（ツール未検証）になる」という逆転が起きる。
 *
 * ライブラリは pdfjs-dist（Apache-2.0・依存ゼロ・純 JS）。ネイティブ拡張も外部コマンドも要らない。
 * 描画だけはキャンバスが要るので、既に依存している Playwright の Chromium 上で行う
 * （browser/render-pdf-page.ts）。そのためにここでは描画に触れない。
 *
 * verbosity を 0 に落としているのは必須。pdf.js の警告は console.log、つまり **stdout** に出る。
 * stdout は MCP のトランスポートが占有しているので、1 行でも混ざるとプロトコルが壊れる。
 */

/** PDF の先頭バイト列。拡張子ではなく中身で判定する。 */
const PDF_MAGIC = '%PDF-'

/** ページの区切り。ページ内の改行と区別が付くよう空行にする。 */
const PAGE_SEPARATOR = '\n\n'

export type PdfTextItem = {
  /** そのページの getTextContent().items の添字。描画側が同じ添字で item を引き当てる */
  index: number
  /** 抽出テキスト全体でのオフセット [start, end) */
  start: number
  end: number
}

export type PdfPageText = {
  /** 1 始まりのページ番号 */
  page: number
  start: number
  end: number
  items: PdfTextItem[]
}

export type PdfText = { text: string; pages: PdfPageText[] }

export function looksLikePdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).toString('latin1') === PDF_MAGIC
}

/** pdf.js に同梱されている補助データ（標準フォント・CMap・wasm）の置き場所。 */
function pdfjsAssetDirs(): { standardFontDataUrl: string; cMapUrl: string; wasmUrl: string } {
  const require = createRequire(import.meta.url)
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'))
  return {
    standardFontDataUrl: `${path.join(root, 'standard_fonts')}${path.sep}`,
    cMapUrl: `${path.join(root, 'cmaps')}${path.sep}`,
    wasmUrl: `${path.join(root, 'wasm')}${path.sep}`,
  }
}

export async function extractPdfText(bytes: Uint8Array, origin: string): Promise<PdfText> {
  const loading = openPdf(bytes, origin)
  const doc = await awaitPdf(loading, origin)
  try {
    const pages: PdfPageText[] = []
    let text = ''
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      if (text.length > 0) text += PAGE_SEPARATOR
      const pageStart = text.length
      const items: PdfTextItem[] = []
      const content = await (await doc.getPage(pageNumber)).getTextContent()
      content.items.forEach((item, index) => {
        if (!('str' in item)) return
        const start = text.length
        text += item.str
        items.push({ index, start, end: text.length })
        // 行末は pdf.js が hasEOL で教えてくれる。ここで改行を入れないと行同士がくっつく。
        if (item.hasEOL) text += '\n'
      })
      pages.push({ page: pageNumber, start: pageStart, end: text.length, items })
    }
    return { text, pages }
  } finally {
    await loading.destroy()
  }
}

function openPdf(bytes: Uint8Array, origin: string) {
  try {
    // data は pdf.js が破壊的に読むので、渡した配列を使い回さないようコピーを渡す。
    return getDocument({
      data: new Uint8Array(bytes),
      verbosity: 0,
      ...pdfjsAssetDirs(),
      cMapPacked: true,
    })
  } catch (cause) {
    throw FactCheckError.fromCause(`PDF を開けない (origin=${origin})`, cause)
  }
}

async function awaitPdf(loading: ReturnType<typeof getDocument>, origin: string) {
  try {
    return await loading.promise
  } catch (cause) {
    throw FactCheckError.fromCause(`PDF を解析できない (origin=${origin})`, cause)
  }
}

/** テキスト全体のオフセット範囲が何ページ目にあたるか。またがっていれば開始側のページを返す。 */
export function pageOfOffset(pages: readonly PdfPageText[], offset: number): PdfPageText | null {
  return pages.find((page) => page.start <= offset && offset < page.end) ?? null
}

/** ページ内で、与えたオフセット範囲に重なる text item と、その item 内での重なりの割合。 */
export type PdfHighlightSpan = { itemIndex: number; fromRatio: number; toRatio: number }

export function highlightSpans(page: PdfPageText, start: number, end: number): PdfHighlightSpan[] {
  const spans: PdfHighlightSpan[] = []
  for (const item of page.items) {
    const from = Math.max(item.start, start)
    const to = Math.min(item.end, end)
    if (to <= from) continue
    const length = item.end - item.start
    if (length === 0) continue
    spans.push({
      itemIndex: item.index,
      fromRatio: (from - item.start) / length,
      toRatio: (to - item.start) / length,
    })
  }
  return spans
}
