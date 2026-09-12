import { describe, expect, test } from 'vitest'
import { buildSamplePdf } from '../../e2e/fixtures/build-sample-pdf.js'
import { extractPdfText, highlightSpans, looksLikePdf, pageOfOffset } from './pdf-text.js'

/**
 * PDF は「本文が取れること」だけでなく「どのページのどこか」が取れることが要る。
 * ページ番号は attachment に残り、引用箇所の描画位置もここで決まる。
 */

const PAGES = [
  ['Fictional Agency Report', 'The northern survey counted 412 units in total.'],
  ['Second page continues here.', 'The committee recorded 87 objections to the plan.'],
]

const pdf = buildSamplePdf(PAGES)

describe('looksLikePdf', () => {
  test.each([
    { name: 'PDF の先頭バイト列', bytes: pdf, expected: true },
    { name: 'ただのテキスト', bytes: Buffer.from('%PDG-1.4 not a pdf'), expected: false },
    { name: '空', bytes: Buffer.alloc(0), expected: false },
    { name: 'HTML', bytes: Buffer.from('<!doctype html><body>x</body>'), expected: false },
  ])('$name', ({ bytes, expected }) => {
    expect(looksLikePdf(bytes)).toBe(expected)
  })
})

describe('extractPdfText', () => {
  test('全ページの本文が取れる', async () => {
    const extracted = await extractPdfText(pdf, 'test.pdf')
    for (const line of PAGES.flat()) expect(extracted.text).toContain(line)
  })

  test('ページ境界が本文を隙間なく覆い、ページ番号は 1 始まりで連番になる', async () => {
    const extracted = await extractPdfText(pdf, 'test.pdf')
    expect(extracted.pages.map((page) => page.page)).toEqual([1, 2])
    for (const page of extracted.pages) {
      expect(page.start).toBeLessThan(page.end)
      expect(extracted.text.slice(page.start, page.end)).toContain(PAGES[page.page - 1]?.[0] ?? '')
    }
  })

  test.each([
    { name: '1 ページ目の行', line: 'The northern survey counted 412 units in total.', page: 1 },
    { name: '2 ページ目の行', line: 'The committee recorded 87 objections to the plan.', page: 2 },
  ])('$name はページ $page として引ける', async ({ line, page }) => {
    const extracted = await extractPdfText(pdf, 'test.pdf')
    const offset = extracted.text.indexOf(line)
    expect(offset).toBeGreaterThanOrEqual(0)
    expect(pageOfOffset(extracted.pages, offset)?.page).toBe(page)
  })

  test('item の範囲は抽出テキストの実テキストと一致する', async () => {
    const extracted = await extractPdfText(pdf, 'test.pdf')
    const page = extracted.pages[0]
    expect(page).toBeDefined()
    if (page === undefined) return
    for (const item of page.items) {
      expect(extracted.text.slice(item.start, item.end).length).toBe(item.end - item.start)
    }
    expect(page.items.length).toBeGreaterThan(0)
  })
})

describe('highlightSpans', () => {
  test('引用範囲に重なる item だけを、重なりの割合つきで返す', async () => {
    const extracted = await extractPdfText(pdf, 'test.pdf')
    const quote = '412 units'
    const start = extracted.text.indexOf(quote)
    const page = pageOfOffset(extracted.pages, start)
    expect(page).not.toBeNull()
    if (page === null) return
    const spans = highlightSpans(page, start, start + quote.length)
    expect(spans.length).toBe(1)
    const span = spans[0]
    expect(span).toBeDefined()
    if (span === undefined) return
    expect(span.fromRatio).toBeGreaterThan(0)
    expect(span.toRatio).toBeLessThanOrEqual(1)
    expect(span.fromRatio).toBeLessThan(span.toRatio)
  })

  test('範囲がページ内のどの item にも重ならなければ空', async () => {
    const extracted = await extractPdfText(pdf, 'test.pdf')
    const page = extracted.pages[0]
    expect(page).toBeDefined()
    if (page === undefined) return
    expect(highlightSpans(page, page.end + 10, page.end + 20)).toEqual([])
  })
})
