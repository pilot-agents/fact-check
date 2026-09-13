import { effectiveAttachments } from '../session/ledger-effective.js'
import type { Exclusion, Relation, VerdictValue } from '../session/ledger-types.js'

/**
 * 共有契約: 「この判定を台帳が支えているか」を決める唯一の場所。
 *
 * set_verdict が付けるときと、finalize が書き出す直前に確かめるときで、同じ規則を使う。
 * 別々に書くと、付けたときは通ったのに書き出しでは違う理由で落ちる（あるいはその逆で、
 * 根拠を取り消したあとの判定がそのままレポートに載る）。
 *
 * このツールが確かめるのは**根拠の形**だけで、主張が本当かどうかではない。
 * 「verified と言うなら supports の添付が 1 件以上ある」は、引用の実在と紐づけが
 * 記録されていることの確認であって、内容の正しさの証明ではない。
 */

/** 判定ごとに要求する attachment の関係。ここに無い判定は attachment を要求しない。 */
const REQUIRED_RELATION: Partial<Record<VerdictValue, Extract<Relation, 'supports' | 'contradicts'>>> = {
  verified: 'supports',
  contradicted: 'contradicts',
}

export type VerdictBasisLedger = {
  exclusions?: readonly Exclusion[]
  attachments: readonly { id: string; claim_id: string; evidence_id: string; relation: Relation }[]
}

/**
 * 判定に足りないものがあれば説明を返す。足りていれば null。
 *
 * 数えるのは**有効な添付だけ**。取り消した証拠・添付・claim にぶら下がるものは根拠にならない
 * （取り消したのに判定が通ったままになると、取り消しが見せかけになる）。
 */
export function verdictBasisProblem(
  ledger: VerdictBasisLedger,
  claimId: string,
  verdict: VerdictValue,
): string | null {
  const required = REQUIRED_RELATION[verdict]
  if (required === undefined) return null
  const live = effectiveAttachments(ledger).filter((a) => a.claim_id === claimId)
  if (live.some((a) => a.relation === required)) return null

  const excluded = ledger.attachments.filter(
    (a) => a.claim_id === claimId && !live.some((kept) => kept.id === a.id),
  )
  const shown = live.map((a) => `${a.id}(${a.relation})`)
  return (
    `verdict=${verdict} は relation=${required} の有効な attachment が 1 件以上ないと付けられない ` +
    `(claim_id=${claimId}, 有効な attachment=[${shown.join(', ')}]` +
    (excluded.length === 0
      ? ''
      : `, 取り消し済みで根拠にならない attachment=[${excluded.map((a) => `${a.id}(${a.relation})`).join(', ')}]`) +
    `)。attach_evidence で ${required} の証拠を付けるか、別の verdict を選ぶこと。`
  )
}
