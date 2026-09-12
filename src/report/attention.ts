import type { Ledger, VerdictValue } from '../session/ledger-types.js'

/**
 * レポートの冒頭に出す「要確認一覧」。
 *
 * claim が 67 件あるレポートでは、読み手が本当に知りたい「どこを直すべきか」が本文の末尾まで
 * 散らばる。verified 以外だけを、重い順（矛盾 → 一部のみ → 裏取り不能）に先頭へ集める。
 * verified は直すところが無いので載せない（載せると一覧が本文の写しになって役に立たない）。
 */

/** 重い順。この順に並べる。 */
const ATTENTION_ORDER: readonly VerdictValue[] = ['contradicted', 'partially_verified', 'unverifiable']

export type AttentionItem = {
  claim_id: string
  verdict: VerdictValue
  /** 元ネタの該当文 */
  source_text: string
  /** 判定の理由 */
  rationale: string
  range: { start: number; end: number }
}

export function buildAttention(ledger: Pick<Ledger, 'claims'>): AttentionItem[] {
  const items: AttentionItem[] = []
  for (const verdict of ATTENTION_ORDER) {
    for (const claim of ledger.claims) {
      if (claim.verdict === null || claim.verdict.value !== verdict) continue
      items.push({
        claim_id: claim.id,
        verdict,
        source_text: claim.source_text.trim(),
        rationale: claim.verdict.rationale,
        range: { start: claim.start, end: claim.end },
      })
    }
  }
  return items
}
