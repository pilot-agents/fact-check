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

export type ViewerPayload = {
  generated_at: string
  summary: LedgerSummary
  attention: AttentionItem[]
  ledger: ViewerLedger
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
  return {
    generated_at: args.generatedAt,
    summary: args.summary,
    attention: args.attention,
    ledger,
    source_text: args.sourceText,
    spans: buildTextSpans(
      args.sourceText.length,
      ledger.claims.map((claim) => ({ id: claim.id, start: claim.start, end: claim.end })),
      ledger.non_claims.map((nonClaim) => ({
        id: nonClaim.id,
        start: nonClaim.start,
        end: nonClaim.end,
      })),
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
  }
}

function normalizeEvidence(evidence: EvidenceLike): ViewerEvidence {
  return {
    ...evidence,
    discovered_via: evidence.discovered_via ?? null,
    discovery_note: evidence.discovery_note ?? null,
    pdf: evidence.pdf ?? null,
  }
}

function normalizeAttachment(attachment: AttachmentLike): Attachment {
  return { ...attachment, pdf_page: attachment.pdf_page ?? null }
}
