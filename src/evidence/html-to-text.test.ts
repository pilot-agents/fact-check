import { describe, expect, test } from 'vitest'
import { MIN_EXTRACTED_CHARS } from './fetch-source.js'
import { collapseWhitespace, extractHtml } from './html-to-text.js'

/**
 * 実運用で当たった失敗: ナビゲーションのリンク文字列だけで 6600 文字あり、記事本文が 1 文字も
 * 無いページが「HTTP 取得成功」として記録された。記事領域を選び、その中の**リンクでない地の文**の
 * 長さで判定すれば、同じページは「取れなかった」と正しく記録される。記事領域を選ぶだけでは
 * 足りないのは、選んだ後にもサイトマップのリンクが数百文字残るページが実在するため。
 */

/** どのページにも付く周辺部品。これだけで MIN_EXTRACTED_CHARS を越える量を持たせる。 */
const NAVIGATION = Array.from(
  { length: 40 },
  (_unused, index) => `<li><a href="/section-${index}">案内リンク ${index} 製品 サービス 事業</a></li>`,
).join('')

const BODY_PARAGRAPH = `<p>${'架空の組織の説明文がここに入ります。'.repeat(20)}</p>`

function page(mainContent: string): string {
  return [
    '<!doctype html><html lang="ja"><head><title>架空のページ</title></head><body>',
    `<header><nav><ul>${NAVIGATION}</ul></nav></header>`,
    `<div id="cookie-consent-banner">クッキーの利用に同意してください。設定を変更する。</div>`,
    `<main><h1>発表の表題</h1>${mainContent}</main>`,
    `<footer><nav><ul>${NAVIGATION}</ul></nav><p>この文書は架空のサンプルです。</p></footer>`,
    '<script>console.log("本文テキストに含まれてはいけない")</script>',
    '</body></html>',
  ].join('')
}

describe('extractHtml: 記事領域の選び方', () => {
  test.each([
    {
      name: '本文が十分あるページ: 記事領域から本文が取れ、足切りを越える',
      html: page(BODY_PARAGRAPH),
      expectPassesGate: true,
    },
    {
      name: '本文の無いページ: 周辺部品でページ全体は長くても、記事領域は足切りに届かない',
      html: page('<p>2026年4月1日</p><p><a href="/x.pdf">PDFをダウンロード</a></p>'),
      expectPassesGate: false,
    },
    {
      name: '記事領域にサイトマップのリンクだけが残るページ: 地の文が足りないので越えない',
      html: page(
        `<p>2026年4月1日</p><ul>${Array.from({ length: 30 }, (_u, i) => `<li><a href="/s-${i}">事業案内 ${i} 製品 サービス</a></li>`).join('')}</ul>`,
      ),
      expectPassesGate: false,
    },
  ])('$name', ({ html, expectPassesGate }) => {
    const extracted = extractHtml(html, 'https://example.com/page')
    expect(extracted.region).toBe('main')
    expect(extracted.full_length).toBeGreaterThan(MIN_EXTRACTED_CHARS)
    expect(extracted.prose_length >= MIN_EXTRACTED_CHARS).toBe(expectPassesGate)
  })

  test('リンクの文言は本文には残るが、地の文の長さには数えない', () => {
    const extracted = extractHtml(
      '<body><main><p>地の文です。</p><p><a href="/x">リンクの文言</a></p></main></body>',
      'https://example.com/page',
    )
    expect(extracted.text).toContain('リンクの文言')
    expect(extracted.prose_length).toBe('地の文です。'.length)
  })

  test.each([
    { name: 'ナビゲーション', needle: '案内リンク 0' },
    { name: 'cookie バナー', needle: 'クッキーの利用に同意' },
    { name: 'フッター', needle: 'この文書は架空のサンプルです' },
    { name: 'script の中身', needle: '本文テキストに含まれてはいけない' },
  ])('$name は本文に入らない', ({ needle }) => {
    const extracted = extractHtml(page(BODY_PARAGRAPH), 'https://example.com/page')
    expect(extracted.text).not.toContain(needle)
  })

  test('記事の見出しと段落は本文に残る', () => {
    const extracted = extractHtml(page(BODY_PARAGRAPH), 'https://example.com/page')
    expect(extracted.text).toContain('発表の表題')
    expect(extracted.text).toContain('架空の組織の説明文がここに入ります。')
  })

  test.each([
    { name: 'main', html: '<body><main><p>本文です。</p></main></body>', region: 'main' },
    {
      name: 'role=main',
      html: '<body><div role="main"><p>本文です。</p></div></body>',
      region: '[role="main"]',
    },
    { name: 'article', html: '<body><article><p>本文です。</p></article></body>', region: 'article' },
    { name: 'id=main', html: '<body><div id="main"><p>本文です。</p></div></body>', region: '#main' },
    {
      name: 'id=content',
      html: '<body><div id="content"><p>本文です。</p></div></body>',
      region: '#content',
    },
    { name: '記事領域が無ければ body', html: '<body><p>本文です。</p></body>', region: 'body' },
  ])('$name を記事領域として選ぶ', ({ html, region }) => {
    const extracted = extractHtml(html, 'https://example.com/page')
    expect(extracted.region).toBe(region)
    expect(extracted.text).toBe('本文です。')
  })

  test('ブロック要素の境界は改行になる（引用文がブロックをまたいでも照合できる）', () => {
    const extracted = extractHtml(
      '<body><main><p>積載量は 2,500 kg</p><p>to LEO まで。</p></main></body>',
      'https://example.com/page',
    )
    expect(extracted.text).toBe('積載量は 2,500 kg\nto LEO まで。')
  })
})

describe('collapseWhitespace', () => {
  test.each([
    { name: '行内の連続空白', input: 'a   b', expected: 'a b' },
    { name: '全角スペースも畳む', input: 'a　　b', expected: 'a b' },
    { name: '空行の連続は 1 つに', input: 'a\n\n\n\nb', expected: 'a\n\nb' },
    { name: '前後の空白は落とす', input: '  a  ', expected: 'a' },
    { name: 'CRLF は LF に', input: 'a\r\nb', expected: 'a\nb' },
  ])('$name', ({ input, expected }) => {
    expect(collapseWhitespace(input)).toBe(expected)
  })
})
