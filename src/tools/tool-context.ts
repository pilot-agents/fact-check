import { z } from 'zod'
import { FactCheckError } from '../errors.js'
import { activeExclusion, isSessionArchived } from '../session/ledger-effective.js'
import type { Ledger } from '../session/ledger-types.js'
import { DEFAULT_MAX_SEGMENTS, MAX_MAX_SEGMENTS } from '../source-text/segments.js'

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

/**
 * 候補区間のページング入力。start_session と read_source_segments が同じ意味で受け取るので、
 * 説明文も上限も 1 箇所に置く（別々に書くと片方だけ直したときに挙動が食い違う）。
 */
export const segmentGranularityInput = z
  .enum(['sentence', 'paragraph'])
  .optional()
  .describe('候補の粗さ。sentence=文ごと（既定） / paragraph=段落ごと（件数が 1/6 程度に減る）')

export const segmentOffsetInput = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('候補の何件目から返すか。前の応答の next_segment_offset をそのまま渡す')

export const maxSegmentsInput = z
  .number()
  .int()
  .min(1)
  .max(MAX_MAX_SEGMENTS)
  .optional()
  .describe(
    `1 回に返す候補の件数（既定 ${DEFAULT_MAX_SEGMENTS}、上限 ${MAX_MAX_SEGMENTS}）。` +
      '合計文字数にも別の上限があるため、指定した件数より少なく返ることがある',
  )

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

/**
 * 実際に返る 1 回分の文字数。既定値・下限・上限の丸めはここ 1 箇所で決める。
 * 窓の位置を決める側（fetch_evidence の find）が同じ値を見ないと、「窓に入るはずの一致が
 * 入っていない」がすり抜ける。
 */
export function effectiveTextLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? DEFAULT_TEXT_CHARS), 1), MAX_TEXT_CHARS)
}

export function textWindow(
  text: string,
  offset: number,
  howToContinue: string,
  limit: number = DEFAULT_TEXT_CHARS,
): TextWindow {
  const start = Math.min(Math.max(Math.trunc(offset), 0), text.length)
  const slice = text.slice(start, start + effectiveTextLimit(limit))
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
    throw new FactCheckError(
      `claim_id が見つからない (claim_id=${claimId}, 登録済み=[${ledger.claims.map((c) => c.id).join(', ')}])`,
    )
  }
  assertNotExcluded(ledger, 'claim', claimId)
  return claim
}

export function findEvidence(ledger: Ledger, evidenceId: string) {
  const evidence = ledger.evidence.find((e) => e.id === evidenceId)
  if (evidence === undefined) {
    throw new FactCheckError(
      `evidence_id が見つからない (evidence_id=${evidenceId}, 登録済み=[${ledger.evidence.map((e) => e.id).join(', ')}])`,
    )
  }
  assertNotExcluded(ledger, 'evidence', evidenceId)
  return evidence
}

/**
 * 取り消し済みの記録を新しい作業の相手にさせない。
 *
 * 「存在しない」とは言わない（記録は残っているし、復元もできる）。取り消されていることと
 * その理由・時刻を返し、復元の手順まで書く。黙って通すと、取り消したはずの主張に判定が付き、
 * 取り消したはずの証拠に新しい引用がぶら下がる。
 */
export function assertNotExcluded(
  ledger: Ledger,
  targetType: 'claim' | 'non_claim' | 'evidence' | 'attachment',
  targetId: string,
): void {
  const exclusion = activeExclusion(ledger.exclusions, targetType, targetId)
  if (exclusion === null) return
  throw new FactCheckError(
    `${targetType}_id=${targetId} は取り消されている (${exclusion.id}, ${exclusion.excluded_at}, 理由=「${exclusion.reason}」)。` +
      `使うなら revise_record で action=restore して戻すこと。`,
  )
}

/**
 * セッションが保管されていないこと。保管中は台帳を変える操作を受け付けない
 * （読み返しとレポートの再構築はできる）。
 */
export function assertSessionOpen(ledger: Ledger): void {
  if (!isSessionArchived(ledger)) return
  const exclusion = activeExclusion(ledger.exclusions, 'session', ledger.session_id)
  throw new FactCheckError(
    `このセッションは保管されている (session_id=${ledger.session_id}` +
      (exclusion === null ? '' : `, ${exclusion.excluded_at}, 理由=「${exclusion.reason}」`) +
      `)。台帳を変える操作は受け付けない。続けるなら ` +
      `revise_record で action=restore / target_type=session を呼んで戻すこと。` +
      `読み返しだけなら get_status と report:rebuild は保管中でも使える。`,
  )
}
