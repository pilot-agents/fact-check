import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { captureQuoteHighlight } from '../browser/highlight-quote.js'
import { renderPdfPageWithHighlight } from '../browser/render-pdf-page.js'
import { FactCheckError } from '../errors.js'
import { sha256 } from '../evidence/fetch-source.js'
import { extractPdfText, highlightSpans } from '../evidence/pdf-text.js'
import { findQuote } from '../quote-matching/find-quote.js'
import {
  ATTACHMENT_DIR,
  nextId,
  readSessionBytes,
  readSessionFile,
  updateLedger,
} from '../session/ledger-store.js'
import type { Attachment, Evidence, Ledger, PdfSnapshot } from '../session/ledger-types.js'
import { findClaim, findEvidence, jsonResult, sessionIdInput } from './tool-context.js'

const DESCRIPTION = [
  'claim と evidence を引用文で結びつける。このツールは引用文を鵜呑みにしない:',
  '引用文が証拠の本文テキストに実在するかを、空白の連続を 1 つに畳み Unicode NFKC 正規化した上での',
  '完全部分一致で照合し、見つからなければ登録を拒否する（最も近い箇所の抜粋を添えて返す）。',
  '証拠の URL が元ネタの URL と同じ場合も自己参照として拒否する。',
  'URL 証拠は照合に通った時点でブラウザを開き、該当箇所までスクロールしてハイライトしたスクショを保存する。',
  'PDF 証拠は引用箇所のあるページを描画し、その箇所に枠を重ねたスクショを保存する（ページ番号も記録する）。',
  '次に呼ぶもの: その claim を支える／否定する証拠を出し切ったら set_verdict。',
].join('\n')

export function registerAttachEvidence(server: McpServer): void {
  server.registerTool(
    'attach_evidence',
    {
      title: '引用文の実在を照合して証拠を主張に紐づける',
      description: DESCRIPTION,
      inputSchema: {
        session_id: sessionIdInput,
        claim_id: z.string().min(1).describe('register_claim が返した claim_id'),
        evidence_id: z.string().min(1).describe('fetch_evidence / submit_agent_capture が返した evidence_id'),
        quote: z
          .string()
          .min(1)
          .describe('証拠の本文からそのままコピーした引用文。要約や言い換えは照合に通らない'),
        relation: z
          .enum(['supports', 'contradicts', 'partial', 'irrelevant'])
          .describe('この引用文が主張に対して持つ関係'),
        rationale: z.string().min(1).describe('なぜこの引用文がその関係だと言えるのかの説明'),
      },
    },
    async ({ session_id, claim_id, evidence_id, quote, relation, rationale }) => {
      const outcome = await updateLedger(session_id, async (ledger) => {
        const claim = findClaim(ledger, claim_id)
        const evidence = findEvidence(ledger, evidence_id)
        assertNotSelfReference(ledger, evidence)

        const evidenceText = await readSessionFile(session_id, evidence.text_path)
        const match = findQuote(evidenceText, quote)
        if (!match.found) {
          throw new FactCheckError(
            [
              `引用文が証拠の本文テキストに見つからなかった (evidence_id=${evidence_id}, claim_id=${claim_id})。`,
              '照合は空白の連続を 1 つに畳み Unicode NFKC 正規化した上での完全部分一致で行う。要約・言い換え・',
              '記憶からの復元は通らない。証拠本文から文字列をそのままコピーすること。',
              match.nearest === null
                ? '本文中に近い箇所も見つからなかった。証拠が正しいか、fetch_evidence の抽出本文を読み直すこと。'
                : `最も長く一致した前方部分は ${match.nearest.matchedChars} 文字。本文中の該当箇所の周辺: 「${match.nearest.excerpt}」`,
            ].join('\n'),
          )
        }

        const attachmentId = nextId('attachment', ledger.attachments)
        const shot = await screenshotFor(session_id, attachmentId, evidence, quote, match)
        const attachment: Attachment = {
          id: attachmentId,
          claim_id,
          evidence_id,
          quote,
          relation,
          rationale,
          created_at: new Date().toISOString(),
          match: { start: match.start, end: match.end },
          pdf_page: shot.pdfPage,
          screenshot_path: shot.screenshotPath,
          screenshot_note: shot.note,
        }
        ledger.attachments.push(attachment)

        const counts = {
          supports: ledger.attachments.filter((a) => a.claim_id === claim_id && a.relation === 'supports')
            .length,
          contradicts: ledger.attachments.filter(
            (a) => a.claim_id === claim_id && a.relation === 'contradicts',
          ).length,
        }
        return { attachment, match, counts, claimId: claim.id }
      })
      return jsonResult({
        attachment_id: outcome.attachment.id,
        quote_verified: true,
        quote_match: {
          start: outcome.match.start,
          end: outcome.match.end,
          matched_text: outcome.match.matchedText,
        },
        pdf_page: outcome.attachment.pdf_page,
        screenshot_path: outcome.attachment.screenshot_path,
        screenshot_note: outcome.attachment.screenshot_note,
        claim_attachment_counts: outcome.counts,
        next_step: `この claim (${outcome.claimId}) に出せる証拠を出し切ったら set_verdict を呼ぶこと。`,
      })
    },
  )
}

/** 元ネタ自身を証拠にするのは裏取りではない。URL でもローカルファイルでも同じ理由で拒否する。 */
function assertNotSelfReference(ledger: Ledger, evidence: Evidence): void {
  const origin = ledger.source.origin
  if (origin === null) return
  if (
    evidence.source.type === 'url' &&
    ledger.source.kind === 'url' &&
    sameUrl(origin, evidence.source.url)
  ) {
    throw new FactCheckError(
      `自己参照は証拠にできない: 証拠の URL が元ネタの URL と同じ (url=${evidence.source.url})。別の取得元を探すこと。`,
    )
  }
  if (
    evidence.source.type === 'file' &&
    ledger.source.kind === 'file' &&
    path.resolve(evidence.source.path) === path.resolve(origin)
  ) {
    throw new FactCheckError(
      `自己参照は証拠にできない: 証拠のファイルが元ネタのファイルと同じ (path=${evidence.source.path})。別の取得元を探すこと。`,
    )
  }
}

/**
 * 両方とも取得に成功した URL なので、ここで URL として読めないのは台帳の破損。
 * 素の文字列比較に落として続行すると自己参照の見逃しにつながるため、隠さず投げる。
 */
function sameUrl(a: string, b: string): boolean {
  let left: URL
  let right: URL
  try {
    left = new URL(a)
    right = new URL(b)
  } catch (cause) {
    throw FactCheckError.fromCause(`台帳に URL として読めない値がある (source=${a}, evidence=${b})`, cause)
  }
  left.hash = ''
  right.hash = ''
  return left.href === right.href
}

type ScreenshotOutcome = { screenshotPath: string | null; note: string | null; pdfPage: number | null }

async function screenshotFor(
  sessionId: string,
  attachmentId: string,
  evidence: Evidence,
  quote: string,
  match: { start: number; end: number },
): Promise<ScreenshotOutcome> {
  if (evidence.pdf !== null) {
    return await pdfScreenshot(sessionId, attachmentId, evidence, evidence.pdf, match)
  }
  if (evidence.provenance === 'agent_captured') {
    return evidence.screenshot_path === null
      ? {
          screenshotPath: null,
          note: 'AI が提出した証拠にスクリーンショットが添えられていなかった',
          pdfPage: null,
        }
      : {
          screenshotPath: evidence.screenshot_path,
          note: 'AI が提出したスクリーンショットをそのまま使っている（ツールが撮影したものではない）',
          pdfPage: null,
        }
  }
  if (evidence.source.type === 'file') {
    return {
      screenshotPath: null,
      note: `証拠がローカルファイルのためスクリーンショットは無い (path=${evidence.source.path})`,
      pdfPage: null,
    }
  }
  const outcome = await captureQuoteHighlight({
    sessionId,
    url: evidence.source.url,
    quote,
    screenshotRelativePath: path.posix.join(ATTACHMENT_DIR, `${attachmentId}.png`),
  })
  return { screenshotPath: outcome.screenshotPath, note: outcome.note, pdfPage: null }
}

/**
 * PDF 証拠のスクショ。引用箇所のページを描画し、その位置に枠を重ねる。
 *
 * 枠の位置に要る「ページ内のどの text item か」は台帳に持っていない（全 item を持つと台帳が肥大する）。
 * 保存した PDF から取り直すが、取り直した本文が保存時と 1 文字でも違えば位置がずれるので、
 * sha256 で同一性を確かめ、違えば枠を諦めてページ全体の描画だけを残す。
 */
async function pdfScreenshot(
  sessionId: string,
  attachmentId: string,
  evidence: Evidence,
  pdf: PdfSnapshot,
  match: { start: number; end: number },
): Promise<ScreenshotOutcome> {
  const origin = evidence.source.type === 'url' ? evidence.source.url : evidence.source.path
  const page = pdf.pages.find((p) => p.start <= match.start && match.start < p.end) ?? null
  if (page === null) {
    return {
      screenshotPath: null,
      note: `引用箇所 [${match.start}, ${match.end}) がどのページ範囲にも入らなかった (origin=${origin})`,
      pdfPage: null,
    }
  }
  const bytes = await readSessionBytes(sessionId, pdf.path)
  const reextracted = await extractPdfText(bytes, origin)
  const consistent = sha256(reextracted.text) === evidence.text_sha256
  const reextractedPage = reextracted.pages.find((p) => p.page === page.page)
  const spans =
    consistent && reextractedPage !== undefined ? highlightSpans(reextractedPage, match.start, match.end) : []
  const outcome = await renderPdfPageWithHighlight({
    sessionId,
    pdfBytes: bytes,
    pageNumber: page.page,
    spans,
    screenshotRelativePath: path.posix.join(ATTACHMENT_DIR, `${attachmentId}.png`),
    origin,
  })
  if (!consistent && outcome.screenshotPath !== null) {
    return {
      screenshotPath: outcome.screenshotPath,
      note: `保存済みの PDF から取り直した本文が保存時と一致しなかったため、枠を重ねずに ${page.page} ページ目全体を描画した (origin=${origin})`,
      pdfPage: page.page,
    }
  }
  return { screenshotPath: outcome.screenshotPath, note: outcome.note, pdfPage: page.page }
}
