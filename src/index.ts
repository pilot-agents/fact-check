#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { closeBrowser } from './browser/browser-pool.js'
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
  '  1. start_session — 元ネタを取り込む。返ってくる segments は本文を隙間なく敷き詰めた候補範囲',
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
  `保存先は環境変数 FACT_CHECK_DIR（未設定なら <cwd>/.fact-check）。現在の保存先: ${resolveBaseDir()}`,
].join('\n')

async function main(): Promise<void> {
  const server = new McpServer(
    { name: 'fact-check', version: '0.1.0' },
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
