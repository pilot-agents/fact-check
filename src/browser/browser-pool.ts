import { type Browser, chromium } from 'playwright'
import { FactCheckError } from '../errors.js'

/**
 * ヘッドレスブラウザの遅延起動。
 *
 * MCP 接続（プロセス起動）の時点では立ち上げない。ブラウザを一度も要らないセッション
 * （ローカルファイルだけの裏取り）で数百 MB のプロセスを抱えないため。初回利用時に
 * 1 つだけ起動し、以降は使い回す。常駐デーモンは作らない。
 *
 * Chromium 本体は npm パッケージに同梱されない（数百 MB あり、postinstall で自動的に落とすと
 * インストールが重くも脆くもなる）。入っていない環境は普通に起こるので、起動できなかったときは
 * 入れ方をそのままエラー文に載せる。HTTP 取得だけで済む証拠はブラウザ無しでも取れるため、
 * ここで落ちても裏取り全体が止まるわけではない。
 */

/**
 * ブラウザを起動できないときの案内。npx で入れた利用者がそのまま打てる形にしてある
 * （このパッケージにはリポジトリのタスクランナーが無い）。
 */
export const BROWSER_LAUNCH_HINT =
  'ヘッドレスブラウザ (Chromium) を起動できない。この MCP サーバーは Chromium 本体を同梱していないので、' +
  '`npx playwright install chromium` を実行してから、ブラウザが要る操作をやり直すこと'

let browserPromise: Promise<Browser> | null = null

export async function getBrowser(): Promise<Browser> {
  if (browserPromise === null) {
    browserPromise = chromium.launch({ headless: true }).catch((cause: unknown) => {
      // 失敗した Promise を握ったままだと次回以降も同じ失敗を返し続けるので捨てる。
      browserPromise = null
      throw FactCheckError.fromCause(BROWSER_LAUNCH_HINT, cause)
    })
  }
  return browserPromise
}

export async function closeBrowser(): Promise<void> {
  const pending = browserPromise
  if (pending === null) return
  browserPromise = null
  const browser = await pending
  await browser.close()
}
