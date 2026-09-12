import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { FactCheckError } from '../errors.js'
import { updateLedger } from '../session/ledger-store.js'
import { ledgerCoverage } from '../session/ledger-summary.js'
import type { Ledger, VerdictValue } from '../session/ledger-types.js'
import { findClaim, jsonResult, sessionIdInput } from './tool-context.js'

const DESCRIPTION = [
  'claim に最終判定を付ける。台帳に残っている attachment と矛盾する判定は拒否される:',
  'verified は relation=supports の attachment が 1 件以上、contradicted は relation=contradicts が 1 件以上必要。',
  'unverifiable は attachment が無くてもよいが、なぜ裏取りできなかったかの rationale が必須。',
  '次に呼ぶもの: 全 claim に判定が付いたら get_status で残りを確認し、finalize でレポートを出力すること。',
].join('\n')

/** 判定ごとに要求する attachment の関係。ここに無い判定は attachment を要求しない。 */
const REQUIRED_RELATION: Partial<Record<VerdictValue, 'supports' | 'contradicts'>> = {
  verified: 'supports',
  contradicted: 'contradicts',
}

export function registerSetVerdict(server: McpServer): void {
  server.registerTool(
    'set_verdict',
    {
      title: '主張に最終判定を付ける',
      description: DESCRIPTION,
      inputSchema: {
        session_id: sessionIdInput,
        claim_id: z.string().min(1).describe('register_claim が返した claim_id'),
        verdict: z
          .enum(['verified', 'contradicted', 'partially_verified', 'unverifiable'])
          .describe('最終判定'),
        rationale: z.string().min(1).describe('その判定に至った理由。どの証拠のどこを根拠にしたか'),
      },
    },
    async ({ session_id, claim_id, verdict, rationale }) => {
      const result = await updateLedger(session_id, async (ledger) => {
        const claim = findClaim(ledger, claim_id)
        assertVerdictAllowed(ledger, claim_id, verdict)
        claim.verdict = { value: verdict, rationale, decided_at: new Date().toISOString() }
        const coverage = ledgerCoverage(ledger)
        return { remaining: ledger.claims.filter((c) => c.verdict === null).map((c) => c.id), coverage }
      })
      return jsonResult({
        claim_id,
        verdict,
        claims_without_verdict: result.remaining,
        coverage: {
          covered: result.coverage.covered,
          total: result.coverage.total,
          ratio: result.coverage.ratio,
        },
        next_step:
          result.remaining.length === 0 && result.coverage.gaps.length === 0
            ? 'finalize を呼んでレポートを出力すること。'
            : 'get_status で残りを確認すること。finalize は網羅率 100% かつ全 claim 判定済みでないと通らない。',
      })
    },
  )
}

function assertVerdictAllowed(ledger: Ledger, claimId: string, verdict: VerdictValue): void {
  const required = REQUIRED_RELATION[verdict]
  if (required === undefined) return
  const matching = ledger.attachments.filter((a) => a.claim_id === claimId && a.relation === required)
  if (matching.length > 0) return
  const attached = ledger.attachments
    .filter((a) => a.claim_id === claimId)
    .map((a) => `${a.id}(${a.relation})`)
  throw new FactCheckError(
    `verdict=${verdict} は relation=${required} の attachment が 1 件以上ないと付けられない ` +
      `(claim_id=${claimId}, 現在の attachment=[${attached.join(', ')}])。` +
      `attach_evidence で ${required} の証拠を付けるか、別の verdict を選ぶこと。`,
  )
}
