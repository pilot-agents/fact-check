import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { getBrowser } from '../browser/browser-pool.js'
import { FactCheckError } from '../errors.js'
import { fileExists, loadLedger, loadSourceText, writeFileAtomic } from '../session/ledger-store.js'
import { summarizeLedger } from '../session/ledger-summary.js'
import { buildAttention } from './attention.js'
import { inlineScreenshots } from './rendering/inline-assets.js'
import { renderHtml } from './rendering/render-html.js'
import { buildViewerPayload } from './rendering/viewer-payload.js'

/**
 * レポートを**セッションの外へ**、1 ファイルで持ち出せる形（HTML / PDF）で書き出す。
 *
 * finalize が書く report.html は、画像をセッションディレクトリからの相対パスで参照する
 * （ディレクトリごと渡す前提）。ここで書くものは画像を中身ごと埋め込むので、そのファイル
 * 1 つを別の場所へ置いても・メールに付けても、同じに読める。
 *
 * PDF は同じ HTML を Chromium の印刷経路（`@media print` のスタイル）に通して作る。
 * 印刷用の CSS と「全主張・対象外の範囲・取り消し履歴を全件出す」規則はビューア側に既にあり、
 * ここで別のレイアウトを持たない（画面・印刷・PDF で違う紙を作らない）。
 *
 * finalize を通していない台帳でも書き出せる。その場合はビューアと同じ「暫定表示」の断りが
 * 焼き込まれ、応答にも同じ警告を返す。検証を通ったかどうかは台帳の `reports_stale_since`
 * が唯一の記録で、ここで別の判定はしない。
 */

export type ExportFormat = 'html' | 'pdf'

export const EXPORT_FORMATS: readonly ExportFormat[] = ['html', 'pdf']

/** 形式ごとに受け付ける拡張子。形式と拡張子が食い違うファイルを作らない。 */
const EXTENSIONS_BY_FORMAT: Record<ExportFormat, readonly string[]> = {
  html: ['.html', '.htm'],
  pdf: ['.pdf'],
}

/** A4 縦。余白はビューアの印刷 CSS が前提にしている一般的な値で、設定の口は持たない。 */
const PDF_OPTIONS = {
  format: 'A4',
  printBackground: true,
  margin: { top: '14mm', right: '12mm', bottom: '14mm', left: '12mm' },
} as const

/** 画像の読み込みを待つ上限。data URI なので通常は一瞬で終わる。 */
const IMAGE_LOAD_TIMEOUT_MS = 30_000

export type ExportedReport = {
  session_id: string
  format: ExportFormat
  path: string
  bytes: number
  /** 埋め込んだ画像の件数（台帳が参照する screenshot_path の種類数） */
  inlined_images: number
  /** 非 null なら、この内容は finalize の検証を通していない暫定のもの */
  reports_stale_since: string | null
}

export type ExportArgs = {
  sessionId: string
  format: ExportFormat
  /** 絶対パス。相対パスはサーバープロセスの作業ディレクトリ基準になり、呼び手には分からないので受けない */
  outputPath: string
  /** 既存のファイルを置き換えてよいか。既定は拒否 */
  overwrite: boolean
}

/**
 * 入力の検査は書き出しより前に全部済ませる（ブラウザを起こしてから「拡張子が違う」と言わない）。
 * 検査に通らないものは 1 度に全部返す。
 */
export function assertExportTarget(format: ExportFormat, outputPath: string): void {
  const problems: string[] = []
  if (!path.isAbsolute(outputPath)) {
    problems.push(`output_path は絶対パスで指定すること (実際=${JSON.stringify(outputPath)})`)
  }
  const extension = path.extname(outputPath).toLowerCase()
  const accepted = EXTENSIONS_BY_FORMAT[format]
  if (!accepted.includes(extension)) {
    problems.push(
      `format=${format} の出力先は拡張子 ${accepted.join(' / ')} にすること (実際=${JSON.stringify(extension)}, path=${outputPath})`,
    )
  }
  if (problems.length > 0) throw new FactCheckError(problems.join('\n'))
}

export async function exportReport(args: ExportArgs): Promise<ExportedReport> {
  assertExportTarget(args.format, args.outputPath)
  if (!args.overwrite && (await fileExists(args.outputPath))) {
    throw new FactCheckError(
      `出力先に既にファイルがある (path=${args.outputPath})。置き換えるなら overwrite=true を付けること`,
    )
  }
  const ledger = await loadLedger(args.sessionId)
  const sourceText = await loadSourceText(ledger)
  const assets = await inlineScreenshots(args.sessionId, ledger.attachments)
  const html = renderHtml(
    buildViewerPayload({
      generatedAt: new Date().toISOString(),
      ledger,
      summary: summarizeLedger(ledger),
      attention: buildAttention(ledger),
      sourceText,
      assets,
    }),
  )
  const body: string | Uint8Array = args.format === 'html' ? html : await printToPdf(html, args.outputPath)
  try {
    await mkdir(path.dirname(args.outputPath), { recursive: true })
  } catch (cause) {
    throw FactCheckError.fromCause(`出力先のディレクトリを作れない (path=${args.outputPath})`, cause)
  }
  await writeFileAtomic(args.outputPath, body)
  return {
    session_id: args.sessionId,
    format: args.format,
    path: args.outputPath,
    bytes: Buffer.byteLength(body),
    inlined_images: Object.keys(assets).length,
    reports_stale_since: ledger.reports_stale_since,
  }
}

/**
 * HTML を Chromium で開いて PDF にする。
 *
 * **描画の失敗は握りつぶさない。** ビューアの JS が例外で止まれば白紙の PDF ができるが、
 * それを成功として返すと「レポートが空」という壊れ方が呼び手に見えない。pageerror と
 * 読み込めなかった画像は集めて、1 つでもあれば PDF を書かずに落とす。
 *
 * ビューアの画像は `loading="lazy"` で作られる（画面では 60 件を一度に読まないため）。
 * 印刷では画面外の画像が読まれないまま紙になるので、PDF にする前に eager へ戻して
 * 全部の読み込みを待つ。data URI なのでネットワークは発生しない。
 */
async function printToPdf(html: string, outputPath: string): Promise<Uint8Array> {
  const browser = await getBrowser()
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => {
      pageErrors.push(`${error.message}\n${error.stack ?? '(stack なし)'}`)
    })
    await page.setContent(html, { waitUntil: 'load' })
    await page.emulateMedia({ media: 'print' })
    // ページへ渡す関数の中に名前の付く関数を書かない（tsx が __name で包み、ページ側で
    // ReferenceError になる。`pnpm dev:mcp` / `pnpm start` はこの経路を通る）。
    const failedImages = await page.evaluate(
      (timeoutMs) =>
        Promise.all(
          // src を持たない <img>（原寸表示用の器）は読み込み対象ではないので数えない。
          Array.from(document.images)
            .filter((image) => (image.getAttribute('src') ?? '') !== '')
            .map((image) => {
              image.loading = 'eager'
              const settled = image.complete
                ? Promise.resolve()
                : new Promise<void>((done) => {
                    image.addEventListener('load', () => done(), { once: true })
                    image.addEventListener('error', () => done(), { once: true })
                    setTimeout(done, timeoutMs)
                  })
              return settled.then(() => (image.naturalWidth > 0 ? null : image.src.slice(0, 60)))
            }),
        ).then((results) => [
          ...results.filter((result): result is string => result !== null),
          // ビューアは読み込みに失敗した画像を figure から外して「読み込めませんでした」に
          // 置き換える。その後に見に来ると <img> は無いので、器だけ残った figure で数える。
          ...Array.from(document.querySelectorAll('figure.shot:not(:has(img))')).map(
            () => '(ビューアが読み込み失敗として外した画像)',
          ),
        ]),
      IMAGE_LOAD_TIMEOUT_MS,
    )
    const problems = [
      ...pageErrors.map((error) => `ビューアの描画コードが例外を投げた: ${error}`),
      ...failedImages.map((src) => `画像を読み込めなかった (src=${src}…)`),
    ]
    if (problems.length > 0) {
      throw new FactCheckError(
        [
          `PDF にする前の描画で ${problems.length} 件の問題があったので、PDF は書かない (path=${outputPath}):`,
          ...problems.map((problem) => `  - ${problem}`),
        ].join('\n'),
      )
    }
    return await page.pdf(PDF_OPTIONS)
  } catch (cause) {
    if (cause instanceof FactCheckError) throw cause
    throw FactCheckError.fromCause(`PDF の生成に失敗した (path=${outputPath})`, cause)
  } finally {
    await context.close()
  }
}
