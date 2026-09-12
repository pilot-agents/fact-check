import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describeCause, FactCheckError } from '../errors.js'
import type { PdfHighlightSpan } from '../evidence/pdf-text.js'
import { writeSessionFile } from '../session/ledger-store.js'
import { getBrowser } from './browser-pool.js'
import type { HighlightOutcome } from './highlight-quote.js'

/**
 * PDF の 1 ページを PNG に描画し、引用箇所に枠を重ねる。
 *
 * 描画にキャンバスが要るが、Node でキャンバスを持つには結局ネイティブ拡張が要る。ここでは
 * **既に依存している** Playwright の Chromium を使い、そのページの中で pdf.js に描画させる。
 * 新しいネイティブ依存も外部コマンドも増えない。
 *
 * ページには実在しないホスト (https://pdf.invalid/) を割り当て、pdf.js 本体・ワーカー・PDF 本体を
 * すべて Playwright のルーティングでローカルから返す。外部へは 1 バイトも出ない。about:blank ではなく
 * 普通のオリジンを与えるのは、ES モジュールの import と Worker の生成が不透明オリジンでは弾かれるため。
 *
 * 引用箇所の枠は、pdf.js の text item（1 行ぶんの文字列とその配置行列）を単位に描く。item の内側は
 * 文字数の比で按分するので、プロポーショナルフォントでは枠の左右端が 1 文字ぶん程度ずれる。
 * 「どの行のどのあたりか」を示すには足り、ずれても引用文の実在判定には影響しない（判定は台帳側の
 * 完全部分一致で既に済んでいる）。
 */

/** 実在しないホスト。ここへの要求はすべてローカルの中身で応答する。 */
const VIRTUAL_ORIGIN = 'https://pdf.invalid'

/** 描画倍率。等倍だと本文が小さすぎて、スクショを人が読めない。 */
const RENDER_SCALE = 1.5

export async function renderPdfPageWithHighlight(args: {
  sessionId: string
  pdfBytes: Uint8Array
  pageNumber: number
  spans: readonly PdfHighlightSpan[]
  screenshotRelativePath: string
  origin: string
}): Promise<HighlightOutcome> {
  let browser: Awaited<ReturnType<typeof getBrowser>>
  try {
    browser = await getBrowser()
  } catch (cause) {
    return { screenshotPath: null, highlighted: false, note: describeCause(cause) }
  }
  const context = await browser.newContext()
  try {
    const assets = await pdfjsAssets()
    const pdfBody = Buffer.from(args.pdfBytes)
    await context.route(`${VIRTUAL_ORIGIN}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname
      const asset = assets.get(pathname)
      if (asset !== undefined) {
        await route.fulfill({ contentType: asset.contentType, body: asset.body })
        return
      }
      if (pathname === '/document.pdf') {
        await route.fulfill({ contentType: 'application/pdf', body: pdfBody })
        return
      }
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not routed' })
    })

    const page = await context.newPage()
    await page.goto(`${VIRTUAL_ORIGIN}/index.html`)
    const painted = await page.evaluate(renderInPage, {
      libUrl: `${VIRTUAL_ORIGIN}/pdf.mjs`,
      workerUrl: `${VIRTUAL_ORIGIN}/pdf.worker.mjs`,
      pdfUrl: `${VIRTUAL_ORIGIN}/document.pdf`,
      pageNumber: args.pageNumber,
      scale: RENDER_SCALE,
      spans: args.spans.map((span) => ({ ...span })),
    })

    const screenshot = await page.locator('canvas').screenshot()
    await writeSessionFile(args.sessionId, args.screenshotRelativePath, screenshot)
    if (painted === 0) {
      return {
        screenshotPath: args.screenshotRelativePath,
        highlighted: false,
        note: `PDF の ${args.pageNumber} ページ目は描画できたが、引用箇所の位置を持つ text item が無く枠を重ねられなかった（画像だけのページ・テキストレイヤの無い PDF の可能性）(origin=${args.origin})`,
      }
    }
    return { screenshotPath: args.screenshotRelativePath, highlighted: true, note: null }
  } catch (cause) {
    // 潰すのは「スクショが撮れなかった」だけ。attach_evidence 自体は引用照合に通っている以上
    // 成立させ、撮れなかった事実は返り値と台帳とレポートに残す。
    return {
      screenshotPath: null,
      highlighted: false,
      note: describeCause(
        FactCheckError.fromCause(
          `PDF ${args.pageNumber} ページ目の描画に失敗した (origin=${args.origin})`,
          cause,
        ),
      ),
    }
  } finally {
    await context.close()
  }
}

type RouteAsset = { contentType: string; body: string }

let assetCache: Map<string, RouteAsset> | null = null

/** pdf.js 本体とワーカーをディスクから読む。1 プロセスで何度も使うので 1 回だけ読む。 */
async function pdfjsAssets(): Promise<Map<string, RouteAsset>> {
  if (assetCache !== null) return assetCache
  const require = createRequire(import.meta.url)
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'))
  const [lib, worker] = await Promise.all([
    readFile(path.join(root, 'build', 'pdf.min.mjs'), 'utf8'),
    readFile(path.join(root, 'build', 'pdf.worker.min.mjs'), 'utf8'),
  ])
  assetCache = new Map<string, RouteAsset>([
    [
      '/index.html',
      {
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff"></body>',
      },
    ],
    ['/pdf.mjs', { contentType: 'text/javascript; charset=utf-8', body: lib }],
    ['/pdf.worker.mjs', { contentType: 'text/javascript; charset=utf-8', body: worker }],
  ])
  return assetCache
}

type RenderArgs = {
  libUrl: string
  workerUrl: string
  pdfUrl: string
  pageNumber: number
  scale: number
  spans: Array<{ itemIndex: number; fromRatio: number; toRatio: number }>
}

/**
 * ページの中で走る。ここで照合はしない（どの item のどこを塗るかは Node 側が決めて渡す）。
 * 戻り値は実際に塗れた枠の数。
 */
async function renderInPage(args: RenderArgs): Promise<number> {
  const pdfjs = (await import(/* webpackIgnore: true */ args.libUrl)) as {
    GlobalWorkerOptions: { workerSrc: string }
    getDocument: (options: unknown) => { promise: Promise<PdfDocumentLike> }
  }
  pdfjs.GlobalWorkerOptions.workerSrc = args.workerUrl
  const doc = await pdfjs.getDocument({ url: args.pdfUrl, verbosity: 0 }).promise
  const page = await doc.getPage(args.pageNumber)
  const viewport = page.getViewport({ scale: args.scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('キャンバスの 2d コンテキストを取得できない')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport }).promise

  const items = (await page.getTextContent()).items
  let painted = 0
  // multiply にすると、蛍光ペンのように下の文字を残したまま重ねられる。
  ctx.globalCompositeOperation = 'multiply'
  for (const span of args.spans) {
    const item = items[span.itemIndex]
    if (item === undefined || !('transform' in item)) continue
    const originX = item.transform[4]
    const originY = item.transform[5]
    if (originX === undefined || originY === undefined) continue
    const left = originX + item.width * span.fromRatio
    const right = originX + item.width * span.toRatio
    const [x0, y0] = viewport.convertToViewportPoint(left, originY)
    const [x1, y1] = viewport.convertToViewportPoint(right, originY + item.height)
    if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) continue
    const box = {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      w: Math.abs(x1 - x0),
      h: Math.abs(y1 - y0),
    }
    if (box.w <= 0 || box.h <= 0) continue
    ctx.fillStyle = 'rgba(255,214,0,0.45)'
    ctx.fillRect(box.x, box.y, box.w, box.h)
    ctx.strokeStyle = '#e08b00'
    ctx.lineWidth = 2
    ctx.strokeRect(box.x, box.y, box.w, box.h)
    painted += 1
  }
  return painted
}

/** ページ内で使う pdf.js の最小限の形。pdf.js の型はブラウザ側には持ち込めないのでここで宣言する。 */
type PdfDocumentLike = {
  getPage: (pageNumber: number) => Promise<{
    getViewport: (options: { scale: number }) => {
      width: number
      height: number
      convertToViewportPoint: (x: number, y: number) => number[]
    }
    render: (options: unknown) => { promise: Promise<void> }
    getTextContent: () => Promise<{
      items: Array<{ transform?: number[]; width: number; height: number }>
    }>
  }>
}
