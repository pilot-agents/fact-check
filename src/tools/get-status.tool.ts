import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { effectiveAttachments, effectiveRecords, isSessionArchived } from '../session/ledger-effective.js'
import { loadLedger, loadSourceText } from '../session/ledger-store.js'
import { ledgerCoverage, summarizeLedger } from '../session/ledger-summary.js'
import { jsonResult, sessionIdInput } from './tool-context.js'
import { verdictBasisProblem } from './verdict-basis.js'

const DESCRIPTION = [
  'セッションの現在地を返す: 網羅率、まだ claim にも non_claim にもなっていない範囲（オフセットと実テキスト）、',
  'verdict が未設定の claim、根拠が無くなった判定、取り消しの履歴、各種件数。',
  'finalize が通るかどうかはここで分かる。取り消した記録は件数にも網羅率にも数えない。',
  '次に呼ぶもの: 未処理の範囲があれば register_claim / mark_non_claim、判定漏れがあれば set_verdict、',
  '誤登録があれば revise_record、どれも無ければ finalize。',
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
      const liveClaims = effectiveRecords(ledger.exclusions, 'claim', ledger.claims)
      const liveAttachments = effectiveAttachments(ledger)
      const pending = liveClaims.filter((claim) => claim.verdict === null)
      // 根拠が無くなった判定は finalize が拒否する。何が起きているかを先にここで見せる。
      const withoutBasis = liveClaims.flatMap((claim) => {
        if (claim.verdict === null) return []
        const problem = verdictBasisProblem(ledger, claim.id, claim.verdict.value)
        return problem === null ? [] : [{ claim_id: claim.id, verdict: claim.verdict.value, problem }]
      })
      const archived = isSessionArchived(ledger)
      const finalizeReady = summary.coverage.complete && pending.length === 0 && withoutBasis.length === 0
      return jsonResult({
        session_id,
        title: ledger.title,
        archived,
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
          attachments: liveAttachments
            .filter((a) => a.claim_id === claim.id)
            .map((a) => ({ attachment_id: a.id, evidence_id: a.evidence_id, relation: a.relation })),
        })),
        verdicts_without_basis: withoutBasis,
        // 履歴は全件返す。復元済みも含めないと「一度取り消して戻した」が読めない。
        exclusions: ledger.exclusions,
        reports_stale_since: ledger.reports_stale_since,
        finalize_ready: finalizeReady,
        next_step: nextStep({
          archived,
          finalizeReady,
          stale: ledger.reports_stale_since !== null,
          withoutBasis: withoutBasis.length,
        }),
      })
    },
  )
}

function nextStep(state: {
  archived: boolean
  finalizeReady: boolean
  stale: boolean
  withoutBasis: number
}): string {
  if (state.archived) {
    return (
      'このセッションは保管されている。台帳を変える操作は受け付けない。' +
      '続きをやるなら revise_record で action=restore / target_type=session を呼ぶこと。'
    )
  }
  if (!state.finalizeReady) {
    return (
      '上の uncovered_ranges と claims_without_verdict を全部片付けること。' +
      (state.withoutBasis > 0
        ? `verdicts_without_basis の ${state.withoutBasis} 件は、根拠を付け直すか set_verdict で判定を変えること。`
        : '') +
      'finalize はそれまで拒否される。'
    )
  }
  return state.stale
    ? 'finalize を呼んでレポートを出力すること（今あるレポートは台帳より古い）。'
    : 'finalize を呼んでレポートを出力すること。'
}
