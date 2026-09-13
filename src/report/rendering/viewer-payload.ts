import { effectiveAttachments, effectiveRecords } from '../../session/ledger-effective.js'
import type { AttachmentLike, EvidenceLike, LedgerLike } from '../../session/ledger-like.js'
import type { LedgerSummary } from '../../session/ledger-summary.js'
import type { Attachment, DiscoveredVia, Evidence, Ledger } from '../../session/ledger-types.js'
import { buildTextSpans, type TextSpan } from '../../source-text/spans.js'
import type { AttentionItem } from '../attention.js'

/**
 * ビューア (report.html) に埋め込むデータ。中身は report.json と同じ台帳に、
 * 本文全文 (source.txt) と塗り分け用の区間を足したもの。
 *
 * version 1 の台帳には discovered_via / pdf / pdf_page が無い。欠けたまま埋めると
 * ビューア側で undefined が「未記録」なのか「描画漏れ」なのか区別できなくなるので、
 * ここで null に正規化し、「旧版のため未記録」と出せるようにする。
 */

/** 正規化後の証拠。旧版で記録が無かった項目は null になる。 */
export type ViewerEvidence = Omit<Evidence, 'discovered_via'> & { discovered_via: DiscoveredVia | null }

export type ViewerLedger = Omit<Ledger, 'evidence' | 'attachments'> & {
  evidence: ViewerEvidence[]
  attachments: Attachment[]
}

/**
 * 今も有効な記録の id。**有効かどうかの規則はサーバー側にしか無い**（ledger-effective.ts）。
 *
 * 以前はビューアの JavaScript が同じ規則を書き写していた。同じことを 2 つの言語で書けば、
 * 片方だけ直したときに画面と集計が静かに食い違う（「唯一の場所」と書いたコメントの隣で
 * 複製が動いていた）。ブラウザは**結果の id 集合を受け取って描くだけ**にする。
 *
 * 取り消された記録そのものは `ledger` に残す（履歴の節がそれを読む）。
 */
export type EffectiveIds = {
  claims: string[]
  non_claims: string[]
  evidence: string[]
  attachments: string[]
}

export type ViewerPayload = {
  generated_at: string
  summary: LedgerSummary
  attention: AttentionItem[]
  ledger: ViewerLedger
  /** 今も有効な記録の id。ブラウザはこれで絞り込む */
  effective: EffectiveIds
  /** 元ネタ本文の全文。左ペインはこれを塗り分けて表示する */
  source_text: string
  /** 本文を「重なりの状態が変わらない区間」に割ったもの */
  spans: TextSpan[]
}

export function buildViewerPayload(args: {
  generatedAt: string
  ledger: LedgerLike
  summary: LedgerSummary
  attention: AttentionItem[]
  sourceText: string
}): ViewerPayload {
  const ledger = normalizeLedger(args.ledger)
  const liveClaims = effectiveRecords(ledger.exclusions, 'claim', ledger.claims)
  const liveNonClaims = effectiveRecords(ledger.exclusions, 'non_claim', ledger.non_claims)
  return {
    generated_at: args.generatedAt,
    summary: args.summary,
    attention: args.attention,
    ledger,
    effective: {
      claims: liveClaims.map((claim) => claim.id),
      non_claims: liveNonClaims.map((nonClaim) => nonClaim.id),
      evidence: effectiveRecords(ledger.exclusions, 'evidence', ledger.evidence).map((e) => e.id),
      attachments: effectiveAttachments(ledger).map((attachment) => attachment.id),
    },
    source_text: args.sourceText,
    // 塗り分けも有効な範囲だけ。取り消した範囲を塗り続けると、網羅率（取り消しを引いた値）と
    // 本文の見た目が食い違い、「埋まっているのに未処理と言われる」ように見える。
    spans: buildTextSpans(
      args.sourceText.length,
      liveClaims.map((claim) => ({ id: claim.id, start: claim.start, end: claim.end })),
      liveNonClaims.map((n) => ({ id: n.id, start: n.start, end: n.end })),
    ),
  }
}

function normalizeLedger(ledger: LedgerLike): ViewerLedger {
  return {
    version: ledger.version,
    session_id: ledger.session_id,
    title: ledger.title,
    created_at: ledger.created_at,
    source: ledger.source,
    claims: ledger.claims,
    non_claims: ledger.non_claims,
    evidence: ledger.evidence.map(normalizeEvidence),
    attachments: ledger.attachments.map(normalizeAttachment),
    // 取り消し履歴を持たない台帳は「取り消し無し」。ビューア側で undefined を
    // 「履歴が無い」と「読み込めていない」に読み分けさせない。
    exclusions: ledger.exclusions ?? [],
    reports_stale_since: ledger.reports_stale_since ?? null,
  }
}

function normalizeEvidence(evidence: EvidenceLike): ViewerEvidence {
  return {
    ...evidence,
    discovered_via: evidence.discovered_via ?? null,
    discovery_note: evidence.discovery_note ?? null,
    pdf: evidence.pdf ?? null,
    term_check: evidence.term_check ?? null,
  }
}

function normalizeAttachment(attachment: AttachmentLike): Attachment {
  return {
    ...attachment,
    pdf_page: attachment.pdf_page ?? null,
    screenshot_source: attachment.screenshot_source ?? null,
    screenshot_attempts: attachment.screenshot_attempts ?? [],
  }
}
