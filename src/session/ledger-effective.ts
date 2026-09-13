import type { Exclusion, ExclusionTargetType } from './ledger-types.js'

/**
 * 共有契約: 「この記録は今も有効か」を決める唯一の場所。
 *
 * 取り消しは `exclusions` への追記だけで表す。claim / non_claim / evidence / attachment は
 * 登録された時のまま一切変わらない。今どうなっているかは、毎回ここで導く。
 *
 * なぜフラグを持たせないか（規律1: 表現から設計する）:
 * 元レコードに `excluded` を立てると、状態を持つ場所が台帳に 2 つできる。片方だけ更新した
 * 瞬間に集計とレポートが静かに食い違う。さらに、claim を取り消したときに、ぶら下がる添付へ
 * フラグを配って回ると、**復元のときに「もともと個別に取り消されていた添付」と「親に連鎖して
 * 無効になっただけの添付」の区別が付かなくなる**。導出にすれば、その区別は書かなくても
 * 自動的に付く（個別の取り消しは exclusions に残ったまま、親の取り消しだけが消えるため）。
 *
 * 不変条件:
 * - claim / non_claim / evidence が有効 = 自分が直接取り消されていない
 * - attachment が有効 = 自分が直接取り消されておらず、**親 claim と親 evidence の両方が有効**
 * - セッションが保管されていても、個々のレコードの有効・無効は変わらない
 *   （保管は「これ以上いじらない」という状態であって、記録の否定ではない）
 */

/** 今も効いている取り消し（復元されていないもの）だけを引く。 */
export function activeExclusion(
  exclusions: readonly Exclusion[] | undefined,
  targetType: ExclusionTargetType,
  targetId: string,
): Exclusion | null {
  if (exclusions === undefined) return null
  for (const exclusion of exclusions) {
    if (exclusion.restored !== null) continue
    if (exclusion.target_type === targetType && exclusion.target_id === targetId) return exclusion
  }
  return null
}

export function isExcluded(
  exclusions: readonly Exclusion[] | undefined,
  targetType: ExclusionTargetType,
  targetId: string,
): boolean {
  return activeExclusion(exclusions, targetType, targetId) !== null
}

/** 集計・判定・レポートが「有効なもの」を選ぶために必要な最小の形。 */
export type ExcludableLedger = {
  exclusions?: readonly Exclusion[]
  attachments: readonly { id: string; claim_id: string; evidence_id: string }[]
}

/**
 * 添付が有効か。親のどちらかが取り消されていれば、添付自身が生きていても根拠にならない。
 * 「親が除外された添付も有効にならない」を守るのはここ 1 箇所。
 */
export function isAttachmentEffective(
  ledger: ExcludableLedger,
  attachment: { id: string; claim_id: string; evidence_id: string },
): boolean {
  if (isExcluded(ledger.exclusions, 'attachment', attachment.id)) return false
  if (isExcluded(ledger.exclusions, 'claim', attachment.claim_id)) return false
  if (isExcluded(ledger.exclusions, 'evidence', attachment.evidence_id)) return false
  return true
}

/** 有効な記録だけを残す。id で引ける配列すべてに同じ規則を当てるための入口。 */
export function effectiveRecords<T extends { id: string }>(
  exclusions: readonly Exclusion[] | undefined,
  targetType: Exclude<ExclusionTargetType, 'attachment' | 'session'>,
  records: readonly T[],
): T[] {
  return records.filter((record) => !isExcluded(exclusions, targetType, record.id))
}

export function effectiveAttachments<
  T extends { id: string; claim_id: string; evidence_id: string },
>(ledger: { exclusions?: readonly Exclusion[]; attachments: readonly T[] }): T[] {
  return ledger.attachments.filter((attachment) => isAttachmentEffective(ledger, attachment))
}

/** セッションが保管されているか。保管中はこれ以上の裏取りを受け付けない。 */
export function isSessionArchived(ledger: {
  session_id: string
  exclusions?: readonly Exclusion[]
}): boolean {
  return isExcluded(ledger.exclusions, 'session', ledger.session_id)
}
