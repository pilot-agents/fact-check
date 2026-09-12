import * as cheerio from 'cheerio'
import { FactCheckError } from '../errors.js'

/**
 * HTML から本文テキストを取り出す。
 *
 * 落とすのは 2 種類だけに限る。
 * - スクリプト・スタイル等、そもそも文章ではないもの
 * - ナビゲーション・ヘッダ・フッタ・cookie バナーという、どのページにも同じ形で付く周辺部品
 *
 * それ以外を機械が捨てると「引用文がページに在るのに証拠本文には無い」という最も紛らわしい失敗に
 * なるため、広告らしさ・重要度といった当てずっぽうの判定はしない。
 *
 * 記事領域（main / article など）が見つかればそこだけを本文とする。
 *
 * 併せて prose_length（リンクの文字列を除いた地の文の長さ）を返す。「取れたかどうか」はこの長さで
 * 判定してもらう。実運用で当たったページは、記事領域を選んだ後でもサイトマップのリンク文字列が
 * 300 文字近く残り、単純な文字数では足切りを越えてしまった。本文の無いページに残るのはリンクの塊で、
 * 記事本文はリンクでない文字を必ず持つ、という違いのほうが当てになる。
 * 本文テキスト自体からリンクを落とさないのは、引用文がリンクの文言を含むことがあるため。
 */

const DROPPED = 'script, style, noscript, template, svg, iframe, canvas'

/** どのページにも同じ形で付く周辺部品。本文には含めない。 */
const CHROME = [
  'nav',
  'header',
  'footer',
  'aside',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="search"]',
  '[class*="cookie"]',
  '[id*="cookie"]',
  '[class*="consent"]',
  '[id*="consent"]',
].join(', ')

/** 記事領域の候補。上から順に、最初に見つかったものを本文とする。 */
const ARTICLE_ROOTS = ['main', '[role="main"]', 'article', '#main', '#content'] as const

const BLOCK =
  'p, div, section, article, header, footer, main, aside, h1, h2, h3, h4, h5, h6, li, tr, blockquote, pre, table, figure, figcaption, dt, dd, hr'

export type ExtractedHtml = {
  /** 記事領域のテキスト（周辺部品を除いたもの）。証拠本文にはこれを使う */
  text: string
  /** 本文としてどこを採ったか。'body' は記事領域が見つからなかったことを意味する */
  region: string
  /** 周辺部品も含めたページ全体のテキスト長 */
  full_length: number
  /** text のうち、リンク (a 要素) の文字列を除いた長さ。記事本文が在るかの判定はこれで行う */
  prose_length: number
}

export function extractHtml(html: string, origin: string): ExtractedHtml {
  const $ = loadPrepared(html, origin)
  const fullLength = bodyText($).length

  $(CHROME).remove()
  for (const selector of ARTICLE_ROOTS) {
    const found = $(selector).first()
    if (found.length === 0) continue
    const text = collapseWhitespace(found.text())
    if (text.length === 0) continue
    return { text, region: selector, full_length: fullLength, prose_length: proseLength($, selector) }
  }
  return {
    text: bodyText($),
    region: 'body',
    full_length: fullLength,
    prose_length: proseLength($, 'body'),
  }
}

/** リンクの文言を除いた地の文の長さ。元の木は壊さないので複製の上で落とす。 */
function proseLength($: cheerio.CheerioAPI, selector: string): number {
  const clone = $(selector).first().clone()
  clone.find('a').remove()
  return collapseWhitespace(clone.text()).length
}

/** 解析して、文章でない要素を落とし、ブロック要素の境界を改行にした木を返す。 */
function loadPrepared(html: string, origin: string): cheerio.CheerioAPI {
  let $: cheerio.CheerioAPI
  try {
    $ = cheerio.load(html)
  } catch (cause) {
    throw FactCheckError.fromCause(`HTML を解析できない (origin=${origin})`, cause)
  }
  $(DROPPED).remove()
  $('br').replaceWith('\n')
  $(BLOCK).each((_index, element) => {
    $(element).after('\n')
  })
  return $
}

function bodyText($: cheerio.CheerioAPI): string {
  const body = $('body')
  return collapseWhitespace(body.length > 0 ? body.text() : $.root().text())
}

/** 行内の空白の連続は 1 つに、空行の連続は 1 つに畳む。テキスト系ファイルにも使う。 */
export function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t 　]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
