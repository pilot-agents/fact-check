import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describeCause, FactCheckError } from '../errors.js'
import { collapseWhitespace, extractHtml } from './html-to-text.js'
import { extractPdfText, looksLikePdf, type PdfPageText } from './pdf-text.js'

/**
 * 「素材を本文テキストにする」だけを担う層。元ネタの取り込み (start_session) と
 * 証拠の取得 (fetch_evidence) が同じ抽出規則を通るように、ここに 1 本化する。
 * 保存も再試行もしない。
 */

export const HTTP_TIMEOUT_MS = 20_000
const USER_AGENT = 'fact-check-mcp/0.1'
export const TEXT_FILE_EXTENSIONS = ['.txt', '.md', '.html', '.htm', '.pdf'] as const

/**
 * 取り込んだ素材の中身。種類ごとに「保存すべき原本」が違う（HTML は生 HTML、PDF は元のバイト列と
 * ページ境界）ので、text だけに潰さずここで型を分ける。
 */
export type LoadedBody =
  | { kind: 'html'; text: string; html: string; region: string; full_length: number; prose_length: number }
  | { kind: 'text'; text: string }
  | { kind: 'pdf'; text: string; bytes: Uint8Array; pages: PdfPageText[] }

export type LoadedFile = { absolute: string; body: LoadedBody }

export async function loadLocalTextFile(filePath: string): Promise<LoadedFile> {
  const absolute = path.resolve(filePath)
  const extension = path.extname(absolute).toLowerCase()
  if (!(TEXT_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new FactCheckError(
      `読めるのは ${TEXT_FILE_EXTENSIONS.join(' / ')} だけ (path=${absolute}, 拡張子=${extension === '' ? 'なし' : extension})`,
    )
  }
  let raw: Buffer
  try {
    raw = await readFile(absolute)
  } catch (cause) {
    throw FactCheckError.fromCause(`ローカルファイルを読めない (path=${absolute})`, cause)
  }
  return { absolute, body: await toBody(raw, absolute, extension === '.html' || extension === '.htm') }
}

export type HttpLoad =
  | { ok: true; body: LoadedBody; contentType: string; status: number }
  | { ok: false; detail: string }

export async function loadUrlText(url: string): Promise<HttpLoad> {
  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,text/plain;q=0.9,application/pdf;q=0.9,*/*;q=0.5',
      },
    })
  } catch (cause) {
    return { ok: false, detail: `HTTP 要求そのものが失敗した: ${describeCause(cause)}` }
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok) {
    return {
      ok: false,
      detail: `ステータスが ${response.status} ${response.statusText} (content-type=${contentType === '' ? '不明' : contentType})`,
    }
  }
  let raw: Buffer
  try {
    raw = Buffer.from(await response.arrayBuffer())
  } catch (cause) {
    return { ok: false, detail: `本文の読み出しに失敗した: ${describeCause(cause)}` }
  }

  const isHtml = /\bx?html\b/i.test(contentType)
  const isPlainText = /^text\/(plain|markdown)/i.test(contentType)
  const isPdf = /\bapplication\/pdf\b/i.test(contentType) || looksLikePdf(raw)
  if (!isHtml && !isPlainText && !isPdf) {
    return {
      ok: false,
      detail: `HTML でもテキストでも PDF でもない (content-type=${contentType === '' ? '不明' : contentType})`,
    }
  }
  try {
    const body = await toBody(raw, url, isHtml)
    return { ok: true, body, contentType, status: response.status }
  } catch (cause) {
    return { ok: false, detail: describeCause(cause) }
  }
}

/**
 * バイト列を本文テキストにする。PDF の判定は拡張子や content-type ではなく先頭バイトで行う
 * （拡張子が .pdf でない PDF、content-type が octet-stream の PDF が実在するため）。
 *
 * PDF 以外の復号は UTF-8 固定。fetch の Response.text() も仕様上 UTF-8 固定で、初版からの挙動を
 * 変えないため。バイト列で受けているのは PDF の判定に必要だからで、復号規則の変更ではない。
 */
async function toBody(raw: Buffer, origin: string, isHtml: boolean): Promise<LoadedBody> {
  if (looksLikePdf(raw)) {
    const extracted = await extractPdfText(raw, origin)
    return { kind: 'pdf', text: extracted.text, bytes: raw, pages: extracted.pages }
  }
  const decoded = raw.toString('utf8')
  if (isHtml) {
    const extracted = extractHtml(decoded, origin)
    return {
      kind: 'html',
      text: extracted.text,
      html: decoded,
      region: extracted.region,
      full_length: extracted.full_length,
      prose_length: extracted.prose_length,
    }
  }
  return { kind: 'text', text: collapseWhitespace(decoded) }
}
