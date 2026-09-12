import * as cheerio from 'cheerio'
import { describeCause } from '../errors.js'

/**
 * ページの中の PDF へのリンクを拾う。
 *
 * 本文が取れなかったページの中身が「表題と PDF へのリンクだけ」であることは珍しくない
 * （官公庁・裁判所・IR の一次資料はほぼこの形）。このとき AI に必要なのは「取れなかった」
 * という結論ではなく、次に渡すべき URL そのものなので、失敗のエラー文に候補を並べて渡す。
 *
 * 記事領域の抽出（html-to-text）とは違い、ここではナビゲーションもフッタも落とさない。
 * 資料へのリンクはページの端に置かれていることが多く、落とすと候補が消える。
 */

/** エラー文に並べる上限。多すぎると AI がどれを選ぶべきか判断できなくなる。 */
export const MAX_PDF_LINKS = 5

export function findPdfLinks(html: string, baseUrl: string): string[] {
  let $: cheerio.CheerioAPI
  try {
    $ = cheerio.load(html)
  } catch (cause) {
    // 候補を出せないだけで、失敗そのものは呼び出し側が既に報告している。理由は残す。
    process.stderr.write(
      `PDF リンクの探索のための HTML 解析に失敗した (url=${baseUrl}): ${describeCause(cause)}\n`,
    )
    return []
  }
  const found: string[] = []
  $('a[href], link[href]').each((_index, element) => {
    if (found.length >= MAX_PDF_LINKS) return
    const href = $(element).attr('href')
    if (href === undefined || href.trim() === '') return
    const absolute = toAbsolute(href, baseUrl)
    if (absolute === null) return
    const type = $(element).attr('type') ?? ''
    if (!isPdfPath(absolute) && !/application\/pdf/i.test(type)) return
    if (!found.includes(absolute)) found.push(absolute)
  })
  return found
}

/** 相対 URL は取得元を基準に絶対化する。絶対化できない href（javascript: など）は候補にしない。 */
function toAbsolute(href: string, baseUrl: string): string | null {
  try {
    const url = new URL(href, baseUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * `.pdf` で終わるかの判定は pathname で行う。href そのものの末尾で見ると、
 * `?download=1` や `#page=3` が付いた実在の PDF リンクを取りこぼす。
 */
function isPdfPath(absolute: string): boolean {
  try {
    return new URL(absolute).pathname.toLowerCase().endsWith('.pdf')
  } catch {
    return false
  }
}
