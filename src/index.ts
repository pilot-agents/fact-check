#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { closeBrowser } from './browser/browser-pool.js'
import { FactCheckError } from './errors.js'
import { resolveBaseDir } from './session/ledger-store.js'
import { registerTools } from './tools/register-tools.js'

/**
 * エントリ。MCP 接続（= このプロセスの起動）でサーバーが立ち上がる。
 * ヘッドレスブラウザは初回に必要になった時点で起動する（browser-pool）。常駐デーモンは持たない。
 */

const INSTRUCTIONS = [
  'このサーバーは「AI が裏取りをしたふりをできない」ことを目的にしたファクトチェック用の台帳です。',
  'AI の判断を信じるのは「この証拠がこの主張を支持するか」の判定だけで、引用文の実在・網羅率・証拠の',
  '取得・スクリーンショット・最終レポートはすべてツール側が機械的に検証・生成します。',
  '',
  'ワークフロー:',
  '  1. start_session — 元ネタを取り込む。返ってくる segments は本文を隙間なく敷き詰めた候補範囲。',
  '     **長い元ネタでは 1 ページ分しか返らない。** truncated と next_segment_offset を見て、',
  '     next_segment_offset が null になるまで read_source_segments に segment_offset を渡して',
  '     続きを読む（読み取り専用。台帳は変わらない）。1 ページ分だけで本文を全部分類したことにはならない',
  '  2. register_segments — 返ってきた segments を claim / non_claim に割り当てて **1 回でまとめて** 登録する。',
  '     本文の全文字がどちらかに入るまで埋める（網羅率 100%）。1 件ずつ登録したいときだけ',
  '     register_claim / mark_non_claim を使う',
  '  3. fetch_evidence — 証拠をツールに取りに行かせる。Web ページ・ローカルファイル・PDF を扱える。',
  '     証拠ごとに discovered_via（元ネタが示した出典か、AI が自分で探したか）の申告が要る。',
  '     取得できなければエラーの指示に従い、あなた自身のブラウザ操作ツールで取得して',
  '     submit_agent_capture で提出する',
  '  4. attach_evidence — 証拠本文からそのままコピーした引用文で claim と結びつける。',
  '     引用文は正規化した上で完全部分一致が取れなければ拒否される（要約・言い換えは通らない）',
  '  5. set_verdict — 各 claim に最終判定を付ける。台帳と矛盾する判定は拒否される',
  '  6. get_status — 残りを確認する。いつ呼んでもよい',
  '  7. finalize — 網羅率 100% かつ全 claim 判定済みのときだけレポートを書き出す',
  '',
  '誤って登録したものは、どの段階でも revise_record で理由つきに取り消せます（復元もできます）。',
  '取り消しは論理的な無効化で、記録も取得したファイルも消えません。取り消しで根拠が無くなった判定は',
  'get_status の verdicts_without_basis に出て、finalize が拒否します。',
  '',
  `保存先は環境変数 FACT_CHECK_DIR（未設定なら <cwd>/.fact-check）。現在の保存先: ${resolveBaseDir()}`,
].join('\n')

/**
 * 起動時に名乗る版。**package.json を唯一の元にする。**
 *
 * ここに版を書き写すと、`npm version` が上げた版と起動時の案内が静かに食い違い、
 * 「どの版が動いているのか」を利用者が確かめる手段が消える（実際 0.1.1 の配布物は 0.1.0 と名乗っていた）。
 * package.json は `src/index.ts`（tsx 実行）からも `dist/index.js`（npm 配置）からも 1 つ上にあるので、
 * 同じ相対指定で両方から解決できる。読めない・版が無いときは黙って既定値に落とさず起動を止める。
 */
function serverVersion(): string {
  const manifestUrl = new URL('../package.json', import.meta.url)
  let raw: string
  try {
    raw = readFileSync(manifestUrl, 'utf8')
  } catch (cause) {
    throw FactCheckError.fromCause(`package.json を読めない (path=${fileURLToPath(manifestUrl)})`, cause)
  }
  const version = (JSON.parse(raw) as { version?: unknown }).version
  if (typeof version !== 'string' || version === '') {
    throw new FactCheckError(
      `package.json に version が無い (path=${fileURLToPath(manifestUrl)}, 実際=${JSON.stringify(version)})`,
    )
  }
  return version
}

async function main(): Promise<void> {
  const server = new McpServer(
    { name: 'fact-check', version: serverVersion() },
    { instructions: INSTRUCTIONS, capabilities: { tools: {} } },
  )
  registerTools(server)

  const transport = new StdioServerTransport()
  await server.connect(transport)

  const shutdown = async (): Promise<void> => {
    await closeBrowser()
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((error: unknown) => {
  // stdout は MCP のトランスポートが占有しているので、致命的な失敗は stderr に出して落ちる。
  console.error(error)
  process.exit(1)
})
