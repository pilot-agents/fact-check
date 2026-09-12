import { FactCheckError } from '../errors.js'
import type { Attachment, Claim, Evidence, NonClaim, SourceRecord } from './ledger-types.js'

/**
 * version を問わず「台帳の形をしているか」だけを確かめて読む経路。
 *
 * ツールの本流（loadLedger）は version が合わない台帳を拒否する。必須になった項目を持たない
 * 台帳で裏取りを続けると、記録の無い項目が undefined のままレポートに出るため。
 * 一方で、済んだ結果を読み返すだけの経路（report:rebuild とセッション一覧）まで閉じると、
 * 過去のセッションが二度と開けなくなる。読むだけの入口はこちらを通す。
 *
 * 欠けていてよいのは version 1 に無かった項目だけ。それ以外が欠けていれば、描画の途中で
 * 意味の分からない TypeError になる前に、どの項目がおかしいかを言って落とす。
 */

/** version 1 の証拠には discovered_via / discovery_note / pdf が無い。 */
export type EvidenceLike = Omit<Evidence, 'discovered_via' | 'discovery_note' | 'pdf'> &
  Partial<Pick<Evidence, 'discovered_via' | 'discovery_note' | 'pdf'>>

/** version 1 の紐づけには pdf_page が無い。 */
export type AttachmentLike = Omit<Attachment, 'pdf_page'> & Partial<Pick<Attachment, 'pdf_page'>>

export type LedgerLike = {
  version: number
  session_id: string
  title: string | null
  created_at: string
  source: SourceRecord
  claims: Claim[]
  non_claims: NonClaim[]
  evidence: EvidenceLike[]
  attachments: AttachmentLike[]
}

export function parseLedgerLike(value: unknown, filePath: string): LedgerLike {
  const ledger = asRecord(value, '台帳', filePath)
  const source = asRecord(ledger.source, '台帳の source', filePath)

  const problems: string[] = []
  if (typeof ledger.version !== 'number') problems.push('version が数値でない')
  if (typeof ledger.session_id !== 'string') problems.push('session_id が文字列でない')
  if (typeof source.length !== 'number') problems.push('source.length が数値でない')
  if (typeof source.text_path !== 'string') problems.push('source.text_path が文字列でない')
  for (const key of ['claims', 'non_claims', 'evidence', 'attachments']) {
    if (!Array.isArray(ledger[key])) problems.push(`${key} が配列でない`)
  }
  if (problems.length > 0) {
    throw new FactCheckError(`台帳として読めない (path=${filePath}): ${problems.join(' / ')}`)
  }
  return ledger as unknown as LedgerLike
}

export function asRecord(value: unknown, label: string, filePath: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FactCheckError(
      `${label} がオブジェクトでない (path=${filePath}, 実際=${value === null ? 'null' : typeof value})`,
    )
  }
  return value as Record<string, unknown>
}

export function parseJsonFile(raw: string, filePath: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (cause) {
    throw FactCheckError.fromCause(`JSON が壊れている (path=${filePath})`, cause)
  }
}
