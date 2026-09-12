import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { loadLedger, loadSourceText } from '../session/ledger-store.js'
import { ledgerCoverage, summarizeLedger } from '../session/ledger-summary.js'
import { jsonResult, sessionIdInput } from './tool-context.js'

const DESCRIPTION = [
  'セッションの現在地を返す: 網羅率、まだ claim にも non_claim にもなっていない範囲（オフセットと実テキスト）、',
  'verdict が未設定の claim、各種件数。finalize が通るかどうかはここで分かる。',
  '次に呼ぶもの: 未処理の範囲があれば register_claim / mark_non_claim、判定漏れがあれば set_verdict、',
  'どちらも無ければ finalize。',
].join('\n')

export function registerGetStatus(server: McpServer): void {
  server.registerTool(
    'get_status',
    {
      title: '網羅率と残り作業を確認する',
      description: DESCRIPTION,
      inputSchema: { session_id: sessionIdInput },
    },
    async ({ session_id }) => {
      const ledger = await loadLedger(session_id)
      const sourceText = await loadSourceText(ledger)
      const coverage = ledgerCoverage(ledger)
      const summary = summarizeLedger(ledger)
      const pending = ledger.claims.filter((c) => c.verdict === null)
      return jsonResult({
        session_id,
        title: ledger.title,
        summary,
        uncovered_ranges: coverage.gaps.map((gap) => ({
          start: gap.start,
          end: gap.end,
          text: sourceText.slice(gap.start, gap.end),
        })),
        claims_without_verdict: pending.map((claim) => ({
          claim_id: claim.id,
          claim: claim.claim,
          range: { start: claim.start, end: claim.end },
          attachments: ledger.attachments
            .filter((a) => a.claim_id === claim.id)
            .map((a) => ({ attachment_id: a.id, evidence_id: a.evidence_id, relation: a.relation })),
        })),
        finalize_ready: summary.coverage.complete && pending.length === 0,
        next_step:
          summary.coverage.complete && pending.length === 0
            ? 'finalize を呼んでレポートを出力すること。'
            : '上の uncovered_ranges と claims_without_verdict を全部片付けること。finalize はそれまで拒否される。',
      })
    },
  )
}
