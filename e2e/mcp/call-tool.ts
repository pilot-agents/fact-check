import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

/**
 * e2e から MCP のツールを呼ぶときの共通の受け口。
 *
 * ツール応答は「エラーかどうか」と「本文（成功時は JSON テキスト）」の 2 つで届く。この開き方を
 * 各 e2e が書き写すと、片方だけ isError の扱いを変えたときに「失敗したのに成功として数えた」
 * 検証が静かに生まれる。3 本の e2e が同じ形を持っていたので 1 箇所にまとめた。
 */

export type ToolOutcome = { ok: boolean; text: string; data: Record<string, unknown> }

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text: string }>
  const text = content.map((part) => part.text).join('\n')
  const ok = result.isError !== true
  return { ok, text, data: ok ? (JSON.parse(text) as Record<string, unknown>) : {} }
}
