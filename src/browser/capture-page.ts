import path from 'node:path'
import { FactCheckError } from '../errors.js'
import { writeSessionFile } from '../session/ledger-store.js'
import { getBrowser } from './browser-pool.js'

/**
 * ブラウザで URL を開き、描画後の DOM（HTML）とフルページスクショを取る。
 *
 * innerText ではなく outerHTML を返すのは、HTTP 取得と同じ抽出規則（記事領域を選び、ナビ・
 * フッタ・cookie バナーを落とす）を 1 本で通すため。抽出規則が段階ごとに違うと、同じページなのに
 * 段階によって証拠本文が変わる。
 */

export const PAGE_TIMEOUT_MS = 30_000

export type BrowserCapture = { html: string; screenshotPath: string }

export async function captureWithBrowser(args: {
  sessionId: string
  url: string
  screenshotRelativePath: string
}): Promise<BrowserCapture> {
  const browser = await getBrowser()
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    const response = await page.goto(args.url, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS })
    if (response === null) {
      throw new FactCheckError(`ブラウザでページを開いたが応答が取れなかった (url=${args.url})`)
    }
    if (!response.ok()) {
      throw new FactCheckError(
        `ブラウザで開いた URL が失敗ステータスを返した (url=${args.url}, status=${response.status()} ${response.statusText()})`,
      )
    }
    const html = await page.evaluate(() => document.documentElement.outerHTML)
    const screenshot = await page.screenshot({ fullPage: true })
    await writeSessionFile(args.sessionId, args.screenshotRelativePath, screenshot)
    return { html, screenshotPath: args.screenshotRelativePath }
  } catch (cause) {
    if (cause instanceof FactCheckError) throw cause
    throw FactCheckError.fromCause(`ブラウザでの取得に失敗した (url=${args.url})`, cause)
  } finally {
    await context.close()
  }
}

export function evidenceScreenshotPath(evidenceDir: string, evidenceId: string): string {
  return path.posix.join(evidenceDir, `${evidenceId}.png`)
}
