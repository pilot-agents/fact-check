/**
 * テスト用の PDF をその場で組み立てる。
 *
 * バイナリの fixture をリポジトリに置かないのは、中身が読めないファイルは「何を検証しているか」が
 * コードから消えるため。構造を保つ最小限の PDF（非圧縮・Helvetica・WinAnsi）をここで作る。
 * 文面は呼び出し側が渡す（テストが自分の期待値を持つ）。
 *
 * 文字は WinAnsi で書ける範囲に限る。日本語を埋め込むには CID フォントの埋め込みが要り、
 * それは「PDF の本文を取り出せるか」を確かめるためには要らない複雑さ。
 */

const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842
const FONT_SIZE = 14
const LINE_HEIGHT = 24
const FIRST_BASELINE = 780
const LEFT_MARGIN = 60

/** 1 ページ = 1 行ずつの配列。 */
export function buildSamplePdf(pages: ReadonlyArray<readonly string[]>): Buffer {
  if (pages.length === 0) throw new Error('PDF には 1 ページ以上が要る')
  const fontId = 3 + pages.length * 2
  const objects = new Map<number, string>()
  const streams = new Map<number, string>()

  objects.set(1, '<</Type/Catalog/Pages 2 0 R>>')
  const kids = pages.map((_page, index) => `${3 + index * 2} 0 R`).join(' ')
  objects.set(2, `<</Type/Pages/Kids[${kids}]/Count ${pages.length}>>`)
  pages.forEach((lines, index) => {
    const pageId = 3 + index * 2
    const contentId = pageId + 1
    objects.set(
      pageId,
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}]` +
        `/Resources<</Font<</F1 ${fontId} 0 R>>>>/Contents ${contentId} 0 R>>`,
    )
    const content = contentStream(lines)
    objects.set(contentId, `<</Length ${content.length}>>`)
    streams.set(contentId, content)
  })
  objects.set(fontId, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>')

  const chunks: Buffer[] = [latin1('%PDF-1.4\n')]
  let offset = chunks[0]?.length ?? 0
  const offsets = new Map<number, number>()
  for (let id = 1; id <= fontId; id += 1) {
    offsets.set(id, offset)
    const stream = streams.get(id)
    const body =
      `${id} 0 obj\n${objects.get(id) ?? ''}\n` +
      (stream === undefined ? '' : `stream\n${stream}endstream\n`) +
      'endobj\n'
    const buffer = latin1(body)
    chunks.push(buffer)
    offset += buffer.length
  }

  let xref = `xref\n0 ${fontId + 1}\n0000000000 65535 f \n`
  for (let id = 1; id <= fontId; id += 1) {
    xref += `${String(offsets.get(id) ?? 0).padStart(10, '0')} 00000 n \n`
  }
  xref += `trailer\n<</Size ${fontId + 1}/Root 1 0 R>>\nstartxref\n${offset}\n%%EOF\n`
  chunks.push(latin1(xref))
  return Buffer.concat(chunks)
}

function contentStream(lines: readonly string[]): string {
  let content = `BT /F1 ${FONT_SIZE} Tf\n`
  lines.forEach((line, index) => {
    const y = FIRST_BASELINE - index * LINE_HEIGHT
    content += `1 0 0 1 ${LEFT_MARGIN} ${y} Tm (${escapePdfString(line)}) Tj\n`
  })
  return `${content}ET\n`
}

function escapePdfString(text: string): string {
  return text.replace(/([\\()])/g, '\\$1')
}

function latin1(text: string): Buffer {
  return Buffer.from(text, 'latin1')
}
