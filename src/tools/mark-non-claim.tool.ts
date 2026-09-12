import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { loadSourceText, updateLedger } from '../session/ledger-store.js'
import { assertValidRange } from '../source-text/ranges.js'
import { addNonClaim, coverageProgress } from './range-records.js'
import { jsonResult, sessionIdInput } from './tool-context.js'

const DESCRIPTION = [
  '元ネタの 1 範囲を「裏取り対象ではない」として登録する。見出し・感想・意見・接続句・空行など。',
  '対象外にした範囲も理由つきで台帳に残り、レポートに出る（黙って飛ばすことはできない）。',
  'まとめて登録するなら register_segments のほうが往復が少ない（このツールは 1 件ずつ）。',
  '次に呼ぶもの: 残りの範囲も register_claim / mark_non_claim で埋めること。get_status で残りが分かる。',
].join('\n')

export function registerMarkNonClaim(server: McpServer): void {
  server.registerTool(
    'mark_non_claim',
    {
      title: '裏取り対象外の範囲を登録する',
      description: DESCRIPTION,
      inputSchema: {
        session_id: sessionIdInput,
        start: z.number().int().min(0).describe('元ネタ本文の開始文字オフセット（この位置を含む）'),
        end: z.number().int().min(0).describe('元ネタ本文の終了文字オフセット（この位置を含まない）'),
        reason: z.string().min(1).describe('なぜ裏取り対象でないのか（見出し・感想・接続句・空行 など）'),
      },
    },
    async ({ session_id, start, end, reason }) => {
      const result = await updateLedger(session_id, async (ledger) => {
        const sourceText = await loadSourceText(ledger)
        assertValidRange(sourceText.length, start, end, 'mark_non_claim の範囲')
        const record = addNonClaim(ledger, sourceText, { start, end, reason })
        return { record, progress: coverageProgress(ledger) }
      })
      return jsonResult({
        non_claim_id: result.record.id,
        range: { start, end },
        source_text: result.record.source_text,
        ...result.progress,
        next_step:
          result.progress.uncovered_ranges === 0
            ? '網羅は埋まった。各 claim について fetch_evidence → attach_evidence → set_verdict を回すこと。'
            : `未処理の範囲がまだ ${result.progress.uncovered_ranges} 個ある。get_status で確認して埋めること。`,
      })
    },
  )
}
