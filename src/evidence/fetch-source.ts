import { createHash } from 'node:crypto'
import path from 'node:path'
import { captureWithBrowser, evidenceScreenshotPath } from '../browser/capture-page.js'
import { describeCause, FactCheckError } from '../errors.js'
import { EVIDENCE_DIR, writeSessionFile } from '../session/ledger-store.js'
import type { FetchAttempt, Provenance, SourceRef } from '../session/ledger-types.js'
import { extractHtml } from './html-to-text.js'
import { type LoadedBody, loadLocalTextFile, loadUrlText } from './load-text.js'
import { findPdfLinks } from './pdf-links.js'
import type { PdfPageText } from './pdf-text.js'

/**
 * 証拠の取得。ツール自身が取りに行き、スナップショットを保存する。
 *
 * URL は HTTP → ブラウザの順に試す。これは「失敗を隠す fallback」ではない。どの段階で何が
 * 起きたかを attempts に全部残し、返り値にも載せる。両方失敗したときは黙って空の証拠を
 * 作らず、AI に自分のブラウザ操作ツールでの取得と submit_agent_capture を促して投げる。
 *
 * 「取れた」の判定は、記事領域の中の**リンクでない文字**の長さで行う。ページ全体の文字数で
 * 判定すると、ナビゲーションのリンク文字列だけで足切りを越えて、記事本文が 1 文字も無いページが
 * 「HTTP 取得成功」として記録される（実運用で実際に起きた。抽出 6600 文字のうち本文 0 文字）。
 * 記事領域を選ぶだけでは足りず、選んだ後にもサイトマップのリンクが数百文字残ることがある。
 */

/** これ未満しか抽出できなかった応答は、JS 描画ページとみなして次の段階へ送る。 */
export const MIN_EXTRACTED_CHARS = 200

export type FetchedEvidence = {
  text: string
  provenance: Provenance
  attempts: FetchAttempt[]
  htmlPath: string | null
  screenshotPath: string | null
  /** PDF を取得したときの元バイト列の保存先。それ以外は null */
  pdfPath: string | null
  /** PDF のページ境界。attach_evidence が引用箇所のページ番号を出すのに使う */
  pdfPages: PdfPageText[] | null
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function attempt(stage: FetchAttempt['stage'], ok: boolean, detail: string): FetchAttempt {
  return { stage, ok, detail, at: new Date().toISOString() }
}

/** 抽出結果の内訳。成功時も失敗時も同じ文面で attempts に残す。 */
function describeBody(body: LoadedBody): string {
  if (body.kind === 'html') {
    return (
      `記事領域 ${body.region} から ${body.text.length} 文字` +
      `（うちリンクでない地の文 ${body.prose_length} 文字 / ページ全体では ${body.full_length} 文字）`
    )
  }
  if (body.kind === 'pdf') {
    return `PDF ${body.pages.length} ページから ${body.text.length} 文字`
  }
  return `テキスト ${body.text.length} 文字`
}

/**
 * 本文が取れたと言えるか。
 *
 * 文字数の足切りは HTML にだけ効かせる。足切りの目的は「JS で描画するページを次の段階（ブラウザ）へ
 * 送る」ことなので、次の段階が存在しない PDF とテキストに同じ物差しを当てると、1 ページだけの
 * 短い一次資料（訴状の抜粋など）を「取れなかった」と誤って捨てることになる。PDF とテキストは
 * 1 文字でも取れていれば成功、0 文字なら失敗（テキストレイヤの無いスキャン PDF がこれに当たる）。
 */
function extractedEnough(body: LoadedBody): boolean {
  if (body.kind === 'html') return body.prose_length >= MIN_EXTRACTED_CHARS
  return body.text.length > 0
}

export async function fetchEvidence(args: {
  sessionId: string
  evidenceId: string
  source: SourceRef
}): Promise<FetchedEvidence> {
  if (args.source.type === 'file') {
    return await fetchFromFile(args.source.path, args.evidenceId, args.sessionId)
  }
  return await fetchFromUrl(args.source.url, args.evidenceId, args.sessionId)
}

/** 抽出できた本文を、種類に応じた原本と一緒にセッションディレクトリへ保存する。 */
async function saveSnapshot(
  sessionId: string,
  evidenceId: string,
  body: LoadedBody,
): Promise<{ htmlPath: string | null; pdfPath: string | null; pdfPages: PdfPageText[] | null }> {
  if (body.kind === 'html') {
    const htmlPath = await writeSessionFile(
      sessionId,
      path.posix.join(EVIDENCE_DIR, `${evidenceId}.html`),
      body.html,
    )
    return { htmlPath, pdfPath: null, pdfPages: null }
  }
  if (body.kind === 'pdf') {
    const pdfPath = await writeSessionFile(
      sessionId,
      path.posix.join(EVIDENCE_DIR, `${evidenceId}.pdf`),
      body.bytes,
    )
    return { htmlPath: null, pdfPath, pdfPages: body.pages }
  }
  return { htmlPath: null, pdfPath: null, pdfPages: null }
}

async function fetchFromFile(
  filePath: string,
  evidenceId: string,
  sessionId: string,
): Promise<FetchedEvidence> {
  const loaded = await loadLocalTextFile(filePath)
  if (loaded.body.text.length === 0) {
    throw new FactCheckError(
      `ローカルファイルから本文テキストを 1 文字も抽出できなかった (path=${loaded.absolute}, ${describeBody(loaded.body)})`,
    )
  }
  const saved = await saveSnapshot(sessionId, evidenceId, loaded.body)
  return {
    text: loaded.body.text,
    provenance: 'file',
    attempts: [attempt('file', true, `読み込み成功 (path=${loaded.absolute}, ${describeBody(loaded.body)})`)],
    screenshotPath: null,
    ...saved,
  }
}

async function fetchFromUrl(url: string, evidenceId: string, sessionId: string): Promise<FetchedEvidence> {
  const attempts: FetchAttempt[] = []
  // 「本文が短い」で失敗したときに、そのページがリンクしている PDF を次の手として示すために持つ。
  let pdfLinks: readonly string[] = []

  const http = await loadUrlText(url)
  if (!http.ok) {
    attempts.push(attempt('http', false, http.detail))
  } else if (!extractedEnough(http.body)) {
    attempts.push(
      attempt(
        'http',
        false,
        http.body.kind === 'pdf'
          ? `PDF としては読めたが、テキストレイヤが無く 1 文字も抽出できなかった (${describeBody(http.body)})`
          : `本文を ${describeBody(http.body)} しか抽出できず、記事本文として ${MIN_EXTRACTED_CHARS} 文字に満たない (content-type=${http.contentType})`,
      ),
    )
    if (http.body.kind === 'html') pdfLinks = findPdfLinks(http.body.html, url)
    // PDF はブラウザで開いてもダウンロードになるだけで、次の段階に打つ手が無い。
    if (http.body.kind === 'pdf') throw giveUp(url, attempts, pdfLinks)
  } else {
    attempts.push(
      attempt(
        'http',
        true,
        `HTTP 取得成功 (status=${http.status}, content-type=${http.contentType}, ${describeBody(http.body)})`,
      ),
    )
    const saved = await saveSnapshot(sessionId, evidenceId, http.body)
    return {
      text: http.body.text,
      provenance: 'http',
      attempts,
      screenshotPath: null,
      ...saved,
    }
  }

  try {
    const captured = await captureWithBrowser({
      sessionId,
      url,
      screenshotRelativePath: evidenceScreenshotPath(EVIDENCE_DIR, evidenceId),
    })
    const extracted = extractHtml(captured.html, url)
    const body: LoadedBody = {
      kind: 'html',
      text: extracted.text,
      html: captured.html,
      region: extracted.region,
      full_length: extracted.full_length,
      prose_length: extracted.prose_length,
    }
    if (extractedEnough(body)) {
      attempts.push(attempt('browser', true, `ブラウザで取得成功 (${describeBody(body)})`))
      const saved = await saveSnapshot(sessionId, evidenceId, body)
      return {
        text: body.text,
        provenance: 'browser',
        attempts,
        screenshotPath: captured.screenshotPath,
        ...saved,
      }
    }
    attempts.push(
      attempt(
        'browser',
        false,
        `描画後の DOM からも ${describeBody(body)} しか抽出できず、記事本文として ${MIN_EXTRACTED_CHARS} 文字に満たない`,
      ),
    )
    // 描画後の DOM のほうが候補を多く持つ（JS でリンクを足すページがある）ので、こちらを採る。
    pdfLinks = findPdfLinks(captured.html, url)
  } catch (cause) {
    attempts.push(attempt('browser', false, describeCause(cause)))
  }

  throw giveUp(url, attempts, pdfLinks)
}

/** どの段階で何が起きたかを全部載せて、次にすべきことを指示して投げる。 */
function giveUp(url: string, attempts: readonly FetchAttempt[], pdfLinks: readonly string[]): FactCheckError {
  return new FactCheckError(buildFetchFailureMessage(url, attempts, pdfLinks))
}

/**
 * 取得に失敗したときに AI へ返す文面。
 *
 * PDF リンクが見つかったときは、一般論（「PDF があるならその URL を渡せ」）ではなく、実際に
 * そのページに在った URL を並べる。一般論だけだと、AI はページを見ずに諦めるか、URL を
 * 推測して作り出す。どちらも「確認できなかった」で終わらせないための指示にならない。
 */
export function buildFetchFailureMessage(
  url: string,
  attempts: readonly FetchAttempt[],
  pdfLinks: readonly string[],
): string {
  const nextStep =
    pdfLinks.length > 0
      ? [
          `このページには PDF へのリンクが ${pdfLinks.length} 件ある。本文がこの PDF にある可能性が高いので、`,
          'その URL で fetch_evidence を呼ぶこと:',
          ...pdfLinks.map((link) => `  - ${link}`),
        ]
      : [
          'ページに記事本文が無い場合（表題と PDF へのリンクしか置いていないページなど）は、',
          'そのページがリンクしている PDF の URL を fetch_evidence にそのまま渡すこと。PDF は本文を',
          '抽出して証拠にできる。',
        ]
  return [
    `この URL からは証拠を取得できなかった (url=${url})。`,
    '試した段階と結果:',
    ...attempts.map((a) => `  - ${a.stage}: ${a.detail}`),
    '',
    ...nextStep,
    '',
    'それでも取得できないときは、ここで諦めて「確認できなかった」と書いてはいけない。あなた自身の',
    'ブラウザ操作ツール（ブラウザ拡張・ブラウザ操作 MCP・スクリーンショットが取れる任意の手段）で',
    'この URL を開き、ページ本文のテキストとスクリーンショットを取得して、submit_agent_capture ツールに',
    '{ session_id, url, text または text_path, discovered_via, screenshot_path, note } の形で提出すること。',
    'それも不可能な場合に限り、その claim の verdict を unverifiable にして理由を書くこと。',
  ].join('\n')
}
