import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { loadSourceText, updateLedger } from '../session/ledger-store.js'
import { assertValidRange } from '../source-text/ranges.js'
import { addClaim, coverageProgress } from './range-records.js'
import { assertSessionOpen, jsonResult, sessionIdInput } from './tool-context.js'

const DESCRIPTION = [
  '元ネタの 1 範囲を「裏取りすべき事実主張」として登録する。範囲は start_session が返した',
  '本文の文字オフセット [start, end)。範囲が本文の内側かはツールが検証し、範囲の実テキストを返す。',
  'まとめて登録するなら register_segments のほうが往復が少ない（このツールは 1 件ずつ）。',
  '次に呼ぶもの: 残りの範囲も register_claim / mark_non_claim で埋め、そのあと各 claim について',
  'fetch_evidence → attach_evidence → set_verdict を回すこと。',
].join('\n')

export function registerRegisterClaim(server: McpServer): void {
  server.registerTool(
    'register_claim',
    {
      title: '事実主張として範囲を登録する',
      description: DESCRIPTION,
      inputSchema: {
        session_id: sessionIdInput,
        start: z.number().int().min(0).describe('元ネタ本文の開始文字オフセット（この位置を含む）'),
        end: z.number().int().min(0).describe('元ネタ本文の終了文字オフセット（この位置を含まない）'),
        claim: z.string().min(1).describe('この範囲が主張している内容を、単独で検証できる一文にしたもの'),
        kind: z.string().optional().describe('主張の種別（数値・日付・引用・因果 など）。任意'),
      },
    },
    async ({ session_id, start, end, claim, kind }) => {
      const result = await updateLedger(session_id, async (ledger) => {
        assertSessionOpen(ledger)
        const sourceText = await loadSourceText(ledger)
        assertValidRange(sourceText.length, start, end, 'register_claim の範囲')
        const record = addClaim(ledger, sourceText, { start, end, claim, kind: kind ?? null })
        return { record, progress: coverageProgress(ledger) }
      })
      return jsonResult({
        claim_id: result.record.id,
        range: { start, end },
        source_text: result.record.source_text,
        ...result.progress,
        next_step:
          result.progress.uncovered_ranges === 0
            ? 'この claim について fetch_evidence で証拠を取りに行くこと。'
            : `未処理の範囲がまだ ${result.progress.uncovered_ranges} 個ある。get_status で確認して埋めること。`,
      })
    },
  )
}
