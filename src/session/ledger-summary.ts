import { type Coverage, computeCoverage } from '../source-text/ranges.js'
import type { Provenance, Relation, VerdictValue } from './ledger-types.js'

/** 台帳から導かれる集計。get_status・finalize・レポートが同じ数字を使うために 1 箇所で計算する。 */

/**
 * 集計に必要な項目だけを構造で受ける。
 *
 * Ledger そのものを要求すると、version 1 の report.json（必須になった discovered_via を持たない）を
 * 読み直す report:rebuild からは呼べない。集計は範囲・判定・provenance・relation しか見ておらず、
 * この 4 つは version 1 にもあるので、型を狭めるのではなく必要な形だけを求める。
 */
export type SummarizableLedger = {
  source: { length: number }
  claims: readonly { start: number; end: number; verdict: { value: VerdictValue } | null }[]
  non_claims: readonly { start: number; end: number }[]
  evidence: readonly { provenance: Provenance }[]
  attachments: readonly { relation: Relation }[]
}

export function ledgerCoverage(
  ledger: Pick<SummarizableLedger, 'source' | 'claims' | 'non_claims'>,
): Coverage {
  const ranges = [...ledger.claims, ...ledger.non_claims].map((r) => ({ start: r.start, end: r.end }))
  return computeCoverage(ledger.source.length, ranges)
}

export type LedgerSummary = {
  coverage: { covered: number; total: number; ratio: number; percent: string; complete: boolean }
  claims: Record<VerdictValue | 'total' | 'without_verdict', number>
  non_claims: number
  evidence: { total: number; by_provenance: Record<Provenance, number> }
  attachments: { total: number; by_relation: Record<Relation, number> }
}

export function summarizeLedger(ledger: SummarizableLedger): LedgerSummary {
  const coverage = ledgerCoverage(ledger)
  const claims: LedgerSummary['claims'] = {
    total: ledger.claims.length,
    without_verdict: 0,
    verified: 0,
    contradicted: 0,
    partially_verified: 0,
    unverifiable: 0,
  }
  for (const claim of ledger.claims) {
    if (claim.verdict === null) claims.without_verdict += 1
    else claims[claim.verdict.value] += 1
  }
  const byProvenance: Record<Provenance, number> = { http: 0, browser: 0, file: 0, agent_captured: 0 }
  for (const evidence of ledger.evidence) byProvenance[evidence.provenance] += 1
  const byRelation: Record<Relation, number> = { supports: 0, contradicts: 0, partial: 0, irrelevant: 0 }
  for (const attachment of ledger.attachments) byRelation[attachment.relation] += 1

  return {
    coverage: {
      covered: coverage.covered,
      total: coverage.total,
      ratio: coverage.ratio,
      percent: `${(coverage.ratio * 100).toFixed(2)}%`,
      complete: coverage.covered === coverage.total && coverage.total > 0,
    },
    claims,
    non_claims: ledger.non_claims.length,
    evidence: { total: ledger.evidence.length, by_provenance: byProvenance },
    attachments: { total: ledger.attachments.length, by_relation: byRelation },
  }
}
