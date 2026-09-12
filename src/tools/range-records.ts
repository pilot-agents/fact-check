import { nextId } from '../session/ledger-store.js'
import { ledgerCoverage } from '../session/ledger-summary.js'
import type { Claim, Ledger, NonClaim } from '../session/ledger-types.js'

/**
 * 範囲を claim / non_claim として台帳に足す。1 件ずつのツール (register_claim / mark_non_claim) と
 * まとめ登録 (register_segments) が同じ記録を作るように、記録の作り方はここだけに置く。
 * 範囲の検証はここではしない（呼び出し側が、1 件で投げるか全件集めて拒否するかを決める）。
 */

export function addClaim(
  ledger: Ledger,
  sourceText: string,
  input: { start: number; end: number; claim: string; kind: string | null },
): Claim {
  const record: Claim = {
    id: nextId('claim', ledger.claims),
    start: input.start,
    end: input.end,
    source_text: sourceText.slice(input.start, input.end),
    claim: input.claim,
    kind: input.kind,
    created_at: new Date().toISOString(),
    verdict: null,
  }
  ledger.claims.push(record)
  return record
}

export function addNonClaim(
  ledger: Ledger,
  sourceText: string,
  input: { start: number; end: number; reason: string },
): NonClaim {
  const record: NonClaim = {
    id: nextId('non_claim', ledger.non_claims),
    start: input.start,
    end: input.end,
    source_text: sourceText.slice(input.start, input.end),
    reason: input.reason,
    created_at: new Date().toISOString(),
  }
  ledger.non_claims.push(record)
  return record
}

/** 登録後にどのツールも同じ形で返す進捗。 */
export function coverageProgress(ledger: Ledger) {
  const coverage = ledgerCoverage(ledger)
  return {
    coverage: { covered: coverage.covered, total: coverage.total, ratio: coverage.ratio },
    uncovered_ranges: coverage.gaps.length,
  }
}
