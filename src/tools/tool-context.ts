import { z } from 'zod'
import type { Ledger } from '../session/ledger-types.js'

/** 共有契約: ツール層で使う入力スキーマ断片と応答の形。 */

export const sessionIdInput = z
  .string()
  .min(1)
  .describe('start_session が返した session_id。プロセスを再起動しても同じ id で再開できる')

/**
 * 長いテキストを返すときの 1 回あたりの文字数。切り詰めたことは必ず返り値に書く。
 *
 * 既定を大きめに取るのは、18000 文字のページを読むのに 4 回呼ばせるのが単に往復の無駄だったため
 * （実運用）。上限は、1 回の応答で AI の文脈を食い潰さないための歯止め。
 */
export const DEFAULT_TEXT_CHARS = 12_000
export const MAX_TEXT_CHARS = 40_000

export const textLimitInput = z
  .number()
  .int()
  .min(1)
  .max(MAX_TEXT_CHARS)
  .optional()
  .describe(`1 回に返す本文の文字数（既定 ${DEFAULT_TEXT_CHARS}、上限 ${MAX_TEXT_CHARS}）`)

export const discoveredViaInput = z
  .enum(['cited_in_source', 'agent_search', 'agent_knowledge'])
  .describe(
    'この証拠の出どころ。cited_in_source=元ネタ自身が出典として示していた / ' +
      'agent_search=あなたが検索などで見つけた / agent_knowledge=あなたの知識から当たりを付けた。' +
      'レポートに出るので、読み手が「元ネタが示した裏付け」と「AI が後から探した裏付け」を区別できる',
  )

export const discoveryNoteInput = z
  .string()
  .min(1)
  .optional()
  .describe('どこに出典として書いてあったか、何の語で検索したか。任意だが書くと読み手の判断が楽になる')

export type TextWindow = {
  text: string
  text_offset: number
  text_length: number
  truncated: boolean
  next_offset: number | null
  truncation_note: string | null
}

export function textWindow(
  text: string,
  offset: number,
  howToContinue: string,
  limit: number = DEFAULT_TEXT_CHARS,
): TextWindow {
  const start = Math.min(Math.max(Math.trunc(offset), 0), text.length)
  const slice = text.slice(start, start + Math.min(Math.max(Math.trunc(limit), 1), MAX_TEXT_CHARS))
  const end = start + slice.length
  const truncated = end < text.length || start > 0
  return {
    text: slice,
    text_offset: start,
    text_length: text.length,
    truncated,
    next_offset: end < text.length ? end : null,
    truncation_note:
      end < text.length
        ? `全 ${text.length} 文字のうち [${start}, ${end}) だけを返した。続きは ${howToContinue} で読むこと`
        : null,
  }
}

/** MCP のツール応答。構造化データは JSON テキストとして返す。 */
export function jsonResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

export function findClaim(ledger: Ledger, claimId: string) {
  const claim = ledger.claims.find((c) => c.id === claimId)
  if (claim === undefined) {
    throw new Error(
      `claim_id が見つからない (claim_id=${claimId}, 登録済み=[${ledger.claims.map((c) => c.id).join(', ')}])`,
    )
  }
  return claim
}

export function findEvidence(ledger: Ledger, evidenceId: string) {
  const evidence = ledger.evidence.find((e) => e.id === evidenceId)
  if (evidence === undefined) {
    throw new Error(
      `evidence_id が見つからない (evidence_id=${evidenceId}, 登録済み=[${ledger.evidence.map((e) => e.id).join(', ')}])`,
    )
  }
  return evidence
}
