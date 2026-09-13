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
import type {
  Attachment,
  Evidence,
  Ledger,
  PdfSnapshot,
  ScreenshotAttempt,
  ScreenshotSource,
} from '../session/ledger-types.js'
import { assertSessionOpen, findClaim, findEvidence, jsonResult, sessionIdInput } from './tool-context.js'

const DESCRIPTION = [
  'claim と evidence を引用文で結びつける。このツールは引用文を鵜呑みにしない:',
  '引用文が証拠の本文テキストに実在するかを、空白の連続を 1 つに畳み Unicode NFKC 正規化した上での',
  '完全部分一致で照合し、見つからなければ登録を拒否する（最も近い箇所の抜粋を添えて返す）。',
  '証拠の URL が元ネタの URL と同じ場合も自己参照として拒否する。',
  'URL 証拠は照合に通った時点で、**取得時に保存したスナップショット**（HTML、無ければ抽出本文）を',
  'ブラウザで描き、該当箇所をハイライトしたスクショを保存する。ライブページは開き直さないので、',
  '取得後にページが落ちても 403 になっても画像は残る。代わりに外部 CSS と画像は当たらないため、',
  '画像は「取得時点の保存内容を描いたもの」であって元ページの外観の再現ではない（screenshot_source に残る）。',
  '保存 HTML で引用箇所を描けなかった場合は、取得時に保存した抽出本文を描いて撮り直す。',
  'その画像には「抽出本文を描画したもの」と焼き込む。HTML 側の失敗理由と画像は別パスに全部残る。',
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
        assertSessionOpen(ledger)
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
        const shot = await screenshotFor(session_id, attachmentId, evidence, evidenceText, quote, match)
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
          screenshot_source: shot.source,
          screenshot_attempts: shot.attempts,
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
        screenshot_source: outcome.attachment.screenshot_source,
        screenshot_note: outcome.attachment.screenshot_note,
        screenshot_attempts: outcome.attachment.screenshot_attempts,
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

type ScreenshotOutcome = {
  screenshotPath: string | null
  note: string | null
  pdfPage: number | null
  source: ScreenshotSource | null
  /** 採用しなかった試行も含めた全部。台帳にそのまま入る */
  attempts: ScreenshotAttempt[]
}

/** 試行を持たない結果（PDF・AI 提出・ローカルファイル）を、同じ形に揃えるための包み。 */
function withoutAttempts(outcome: Omit<ScreenshotOutcome, 'attempts'>): ScreenshotOutcome {
  return {
    ...outcome,
    attempts:
      outcome.source === null
        ? []
        : [
            {
              source: outcome.source,
              path: outcome.screenshotPath,
              highlighted: outcome.screenshotPath !== null && outcome.note === null,
              note: outcome.note,
              adopted: true,
            },
          ],
  }
}

/**
 * 添付の画像を作る。
 *
 * URL 証拠はライブページを開き直さず、取得時に保存したスナップショット（HTML、無ければ抽出本文）を
 * 描く。取り直すと取得時と違う内容が写り、外部の停止・403・タイムアウトにも引きずられる。
 * AI 提出証拠と PDF 証拠は取得経路が違うので、扱いも分けたまま残す。
 */
async function screenshotFor(
  sessionId: string,
  attachmentId: string,
  evidence: Evidence,
  evidenceText: string,
  quote: string,
  match: { start: number; end: number },
): Promise<ScreenshotOutcome> {
  if (evidence.pdf !== null) {
    return await pdfScreenshot(sessionId, attachmentId, evidence, evidence.pdf, match)
  }
  if (evidence.provenance === 'agent_captured') {
    return withoutAttempts(
      evidence.screenshot_path === null
        ? {
            screenshotPath: null,
            note: 'AI が提出した証拠にスクリーンショットが添えられていなかった',
            pdfPage: null,
            source: null,
          }
        : {
            screenshotPath: evidence.screenshot_path,
            note: 'AI が提出したスクリーンショットをそのまま使っている（ツールが撮影したものではない）',
            pdfPage: null,
            source: 'agent_captured',
          },
    )
  }
  if (evidence.source.type === 'file') {
    return withoutAttempts({
      screenshotPath: null,
      note: `証拠がローカルファイルのためスクリーンショットは無い (path=${evidence.source.path})`,
      pdfPage: null,
      source: null,
    })
  }
  return await urlScreenshot(sessionId, attachmentId, evidence, evidence.source.url, evidenceText, quote)
}

/**
 * URL 証拠の画像。**保存 HTML で撮れなければ、保存した抽出本文を描いて撮り直す。**
 *
 * 保存 HTML を描いても引用箇所に描画矩形が取れないことがある（実データで 35 件中 3 件。
 * 元ページで折りたたまれていた・非表示だった要素の中に引用があるとこうなる）。読める本文は
 * 保存してあるのに画像だけ得られないのは、証拠として不十分だった。
 *
 * ただし**撮り直しは 1 回だけ**で、手を変えて何度も試さない。そして
 * **HTML 側の失敗理由を 1 文字も捨てない**: 別のパスに保存した HTML の画像も、その失敗の
 * 全文も、screenshot_attempts に残す。「なぜ元ページの見た目で撮れなかったか」は、
 * 画像が手に入ったかどうかとは別に読み手が知るべきこと。
 *
 * 通信遮断と JS 無効は captureQuoteHighlight 側の条件をそのまま使う（どちらの試行も同じ）。
 * display:none の解除やペイウォールの回避は行わない。抽出本文は取得時に既に保存済みのもので、
 * 新たに外部へ当たることもない。
 */
async function urlScreenshot(
  sessionId: string,
  attachmentId: string,
  evidence: Evidence,
  origin: string,
  evidenceText: string,
  quote: string,
): Promise<ScreenshotOutcome> {
  const attempts: ScreenshotAttempt[] = []
  if (evidence.html_path !== null) {
    const html = await readSessionFile(sessionId, evidence.html_path)
    const outcome = await captureQuoteHighlight({
      sessionId,
      origin,
      snapshot: { kind: 'html', html },
      quote,
      // 撮り直すときに上書きしないよう、試行ごとにパスを分ける。同じ名前で 2 回書くと
      // 「HTML では何が写っていたか」が消えて、失敗の検証ができなくなる。
      screenshotRelativePath: path.posix.join(ATTACHMENT_DIR, `${attachmentId}-saved-html.png`),
    })
    attempts.push({
      source: 'saved_html',
      path: outcome.screenshotPath,
      highlighted: outcome.highlighted,
      note: outcome.note,
      adopted: outcome.highlighted,
    })
    if (outcome.highlighted) {
      return {
        screenshotPath: outcome.screenshotPath,
        note: null,
        pdfPage: null,
        source: 'saved_html',
        attempts,
      }
    }
  }

  const fallback = await captureQuoteHighlight({
    sessionId,
    origin,
    snapshot: { kind: 'text', text: evidenceText },
    quote,
    screenshotRelativePath: path.posix.join(ATTACHMENT_DIR, `${attachmentId}-saved-text.png`),
  })
  attempts.push({
    source: 'saved_text',
    path: fallback.screenshotPath,
    highlighted: fallback.highlighted,
    note: fallback.note,
    adopted: fallback.screenshotPath !== null,
  })
  if (fallback.screenshotPath === null) {
    // 両方だめだったときは両方の理由を返す。片方だけ返すと、HTML で何が起きたかが消える。
    return {
      screenshotPath: null,
      note: attemptSummary(attempts, origin),
      pdfPage: null,
      source: null,
      attempts,
    }
  }
  return {
    screenshotPath: fallback.screenshotPath,
    // 成功しても HTML 側の失敗の全文を残す。ここを null にすると、
    // 「保存 HTML では撮れなかった」という事実がレポートから消える。
    note: attemptSummary(attempts, origin),
    pdfPage: null,
    source: 'saved_text',
    attempts,
  }
}

/** 試行の並びを、切らずに 1 本の文にする。どの試行がどうなったかを順番に読めるようにする。 */
function attemptSummary(attempts: readonly ScreenshotAttempt[], origin: string): string {
  const lines = attempts.map((attempt) => {
    const state = attempt.highlighted
      ? 'ハイライト付きで撮れた'
      : attempt.path === null
        ? '画像を撮れなかった'
        : 'ハイライト無しの画像だけ撮れた'
    return (
      `- ${attempt.source}: ${state}` +
      (attempt.path === null ? '' : ` (${attempt.path})`) +
      (attempt.note === null ? '' : ` — ${attempt.note}`)
    )
  })
  return [`画像を作るために試したこと (origin=${origin}):`, ...lines].join('\n')
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
    return withoutAttempts({
      screenshotPath: null,
      note: `引用箇所 [${match.start}, ${match.end}) がどのページ範囲にも入らなかった (origin=${origin})`,
      pdfPage: null,
      source: null,
    })
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
    return withoutAttempts({
      screenshotPath: outcome.screenshotPath,
      note: `保存済みの PDF から取り直した本文が保存時と一致しなかったため、枠を重ねずに ${page.page} ページ目全体を描画した (origin=${origin})`,
      pdfPage: page.page,
      source: 'pdf_page',
    })
  }
  return withoutAttempts({
    screenshotPath: outcome.screenshotPath,
    note: outcome.note,
    pdfPage: page.page,
    source: outcome.screenshotPath === null ? null : 'pdf_page',
  })
}
