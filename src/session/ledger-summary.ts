import { type Coverage, computeCoverage } from '../source-text/ranges.js'
import { effectiveAttachments, effectiveRecords } from './ledger-effective.js'
import type { Exclusion, Provenance, Relation, VerdictValue } from './ledger-types.js'

/** 台帳から導かれる集計。get_status・finalize・レポートが同じ数字を使うために 1 箇所で計算する。 */

/**
 * 集計に必要な項目だけを構造で受ける。
 *
 * Ledger そのものを要求すると、version 1 の report.json（必須になった discovered_via を持たない）を
 * 読み直す report:rebuild からは呼べない。集計は範囲・判定・provenance・relation しか見ておらず、
 * この 4 つは version 1 にもあるので、型を狭めるのではなく必要な形だけを求める。
 *
 * `exclusions` は取り消し履歴を持たない台帳（このツールより前に作ったもの）では undefined。
 * その場合は「取り消し無し」として全件を数える。
 */
export type SummarizableLedger = {
  source: { length: number }
  claims: readonly { id: string; start: number; end: number; verdict: { value: VerdictValue } | null }[]
  non_claims: readonly { id: string; start: number; end: number }[]
  evidence: readonly { id: string; provenance: Provenance }[]
  attachments: readonly { id: string; claim_id: string; evidence_id: string; relation: Relation }[]
  exclusions?: readonly Exclusion[]
}

/**
 * 網羅率。**取り消された範囲は網羅の根拠にしない。**
 *
 * 取り消した claim / non_claim を数え続けると、誤登録で本文を「埋めた」ことにして finalize が
 * 通ってしまう。取り消した瞬間にその範囲は未処理へ戻り、埋め直しを要求される。
 */
export function ledgerCoverage(
  ledger: Pick<SummarizableLedger, 'source' | 'claims' | 'non_claims' | 'exclusions'>,
): Coverage {
  const ranges = [
    ...effectiveRecords(ledger.exclusions, 'claim', ledger.claims),
    ...effectiveRecords(ledger.exclusions, 'non_claim', ledger.non_claims),
  ].map((r) => ({ start: r.start, end: r.end }))
  return computeCoverage(ledger.source.length, ranges)
}

export type LedgerSummary = {
  coverage: { covered: number; total: number; ratio: number; percent: string; complete: boolean }
  claims: Record<VerdictValue | 'total' | 'without_verdict', number>
  non_claims: number
  evidence: { total: number; by_provenance: Record<Provenance, number> }
  attachments: { total: number; by_relation: Record<Relation, number> }
  /** 取り消しの状況。0 件でも欄は出す（「履歴が無い」と「まだ読んでいない」を分ける） */
  exclusions: { active: number; restored: number; total: number }
}

/**
 * 集計。**数えるのは有効な記録だけ**。取り消されたものは exclusions の件数にだけ現れる。
 * get_status / finalize / report.md / report.json / ビューアが全部この関数を通るので、
 * 「画面ごとに件数が違う」が起きない。
 */
export function summarizeLedger(ledger: SummarizableLedger): LedgerSummary {
  const coverage = ledgerCoverage(ledger)
  const liveClaims = effectiveRecords(ledger.exclusions, 'claim', ledger.claims)
  const liveNonClaims = effectiveRecords(ledger.exclusions, 'non_claim', ledger.non_claims)
  const liveEvidence = effectiveRecords(ledger.exclusions, 'evidence', ledger.evidence)
  const liveAttachments = effectiveAttachments(ledger)

  const claims: LedgerSummary['claims'] = {
    total: liveClaims.length,
    without_verdict: 0,
    verified: 0,
    contradicted: 0,
    partially_verified: 0,
    unverifiable: 0,
  }
  for (const claim of liveClaims) {
    if (claim.verdict === null) claims.without_verdict += 1
    else claims[claim.verdict.value] += 1
  }
  const byProvenance: Record<Provenance, number> = { http: 0, browser: 0, file: 0, agent_captured: 0 }
  for (const evidence of liveEvidence) byProvenance[evidence.provenance] += 1
  const byRelation: Record<Relation, number> = { supports: 0, contradicts: 0, partial: 0, irrelevant: 0 }
  for (const attachment of liveAttachments) byRelation[attachment.relation] += 1

  const exclusions = ledger.exclusions ?? []
  return {
    coverage: {
      covered: coverage.covered,
      total: coverage.total,
      ratio: coverage.ratio,
      percent: `${(coverage.ratio * 100).toFixed(2)}%`,
      complete: coverage.covered === coverage.total && coverage.total > 0,
    },
    claims,
    non_claims: liveNonClaims.length,
    evidence: { total: liveEvidence.length, by_provenance: byProvenance },
    attachments: { total: liveAttachments.length, by_relation: byRelation },
    exclusions: {
      active: exclusions.filter((e) => e.restored === null).length,
      restored: exclusions.filter((e) => e.restored !== null).length,
      total: exclusions.length,
    },
  }
}
