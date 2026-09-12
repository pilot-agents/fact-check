import { describe, expect, test } from 'vitest'
import { findQuote, locateQuoteIgnoringWhitespace } from './find-quote.js'
import { normalizeForMatch } from './normalize.js'

describe('normalizeForMatch', () => {
  test.each([
    { name: '空白の連続は 1 つに畳む', input: 'これは   テスト', expected: 'これは テスト' },
    { name: '改行とタブも空白として畳む', input: 'abc\n\tdef', expected: 'abc def' },
    { name: '全角スペースも空白', input: 'A　B', expected: 'A B' },
    { name: '前後の空白は落とす', input: '  テスト  ', expected: 'テスト' },
    { name: '全角英数字は半角になる', input: 'ＡＢＣ１２３', expected: 'ABC123' },
    { name: '半角カタカナは全角になる', input: 'ｶﾀｶﾅ', expected: 'カタカナ' },
    { name: '空文字列', input: '', expected: '' },
    { name: '空白だけ', input: ' \n\t 　', expected: '' },
  ])('$name', ({ input, expected }) => {
    expect(normalizeForMatch(input)).toBe(expected)
  })
})

const SOURCE = '見出し\n\n売上は  前年比 ＋１２０％ に達した。\n次の段落はｶﾀｶﾅを含む。'

describe('findQuote: 通る照合', () => {
  test.each([
    { name: 'そのままの部分文字列', quote: '前年比' },
    { name: '空白差: 複数空白を 1 つにしても通る', quote: '売上は 前年比' },
    { name: '空白差: 元が 2 個でも引用が 1 個でも通る', quote: '売上は 前年比 ＋１２０％ に達した。' },
    { name: '空白差: 改行をまたぐ引用', quote: 'に達した。 次の段落は' },
    { name: '全角半角: 全角数字の引用を半角で書いても通る', quote: '+120%' },
    { name: '全角半角: 半角カタカナは全角で書いても通る', quote: 'カタカナを含む' },
    { name: '前後の空白は無視される', quote: '  前年比  ' },
  ])('$name', ({ quote }) => {
    const match = findQuote(SOURCE, quote)
    expect(match.found).toBe(true)
  })

  test('一致位置は原文のオフセットで返る', () => {
    const match = findQuote(SOURCE, '+120%')
    expect(match.found).toBe(true)
    if (!match.found) return
    expect(SOURCE.slice(match.start, match.end)).toBe('＋１２０％')
    expect(match.matchedText).toBe('＋１２０％')
  })

  test('空白差のある引用でも、返る範囲は原文の実テキスト', () => {
    const match = findQuote(SOURCE, '売上は 前年比')
    expect(match.found).toBe(true)
    if (!match.found) return
    expect(SOURCE.slice(match.start, match.end)).toBe('売上は  前年比')
  })
})

describe('findQuote: 見つからない照合', () => {
  test.each([
    {
      name: '言い換え: 数値が違う',
      quote: '売上は前年比 +130% に達した',
      nearestNotNull: true,
    },
    { name: '要約: 本文に無い語（近い箇所も無い）', quote: '売上が大幅に伸びた', nearestNotNull: false },
    { name: '完全に無関係な文字列', quote: 'ZZZZZZZZZZ', nearestNotNull: false },
    { name: '空の引用文', quote: '', nearestNotNull: false },
    { name: '空白だけの引用文', quote: '   ', nearestNotNull: false },
  ])('$name', ({ quote, nearestNotNull }) => {
    const match = findQuote(SOURCE, quote)
    expect(match.found).toBe(false)
    if (match.found) return
    expect(match.nearest !== null).toBe(nearestNotNull)
  })

  test('最も近い箇所には、一致した前方部分の長さと原文の抜粋が付く', () => {
    const match = findQuote(SOURCE, '売上は前年比 +130% に達した')
    expect(match.found).toBe(false)
    if (match.found) return
    expect(match.nearest).not.toBeNull()
    expect(match.nearest?.matchedChars).toBeGreaterThanOrEqual(4)
    expect(match.nearest?.excerpt).toContain('売上は')
  })
})

/**
 * ブラウザの DOM 側でハイライト位置を引くための照合。スナップショット本文（cheerio 由来）は
 * ブロック境界に改行を入れるが、DOM のテキストノードは境界に何も持たない。逆にインライン要素の
 * 継ぎ目は、スナップショット側では空白が入らない。どちらのずれでも位置を引けることを確かめる。
 */
describe('locateQuoteIgnoringWhitespace', () => {
  test.each([
    {
      name: 'ブロックまたぎ: DOM 側に区切りがあり、引用側は 1 つの空白',
      haystack: '積載量は 2,500 kg\nto LEO まで。',
      quote: '2,500 kg to LEO',
      expected: '2,500 kg\nto LEO',
    },
    {
      name: 'ブロックまたぎ: DOM 側に区切りが無く、引用側に空白がある',
      haystack: '積載量は2,500 kgto LEOまで。',
      quote: '2,500 kg to LEO',
      expected: '2,500 kgto LEO',
    },
    {
      name: 'インラインまたぎ: DOM 側に区切りがあり、引用側は区切り無し',
      haystack: '売上は前年比\n120\n%に達した。',
      quote: '前年比120%',
      expected: '前年比\n120\n%',
    },
    {
      name: '空白差: 連続する空白と改行',
      haystack: '営業利益は   前年比\n\n95% に\tとどまった。',
      quote: '営業利益は前年比95%にとどまった。',
      expected: '営業利益は   前年比\n\n95% に\tとどまった。',
    },
    {
      name: '空白差: 全角スペース',
      haystack: '第一四半期　の　売上',
      quote: '第一四半期の売上',
      expected: '第一四半期　の　売上',
    },
    {
      name: '正規化: 全角英数と半角カタカナも吸収する',
      haystack: '出力は ＋１２０％ で、ｶﾀｶﾅ も含む。',
      quote: '+120% で、カタカナ',
      expected: '＋１２０％ で、ｶﾀｶﾅ',
    },
    {
      name: '先頭から始まる引用',
      haystack: '売上は\n増えた。',
      quote: '売上は増えた。',
      expected: '売上は\n増えた。',
    },
  ])('$name', ({ haystack, quote, expected }) => {
    const located = locateQuoteIgnoringWhitespace(haystack, quote)
    expect(located).not.toBeNull()
    if (located === null) return
    expect(haystack.slice(located.start, located.end)).toBe(expected)
  })

  test.each([
    { name: '本文に無い文字列', haystack: '売上は増えた。', quote: '利益は増えた。' },
    { name: '空の引用文', haystack: '売上は増えた。', quote: '' },
    { name: '空白だけの引用文', haystack: '売上は増えた。', quote: ' 　\n' },
    { name: '文字の順序が違う', haystack: '売上は増えた。', quote: '増えた売上は。' },
  ])('$name は見つからない', ({ haystack, quote }) => {
    expect(locateQuoteIgnoringWhitespace(haystack, quote)).toBeNull()
  })

  test('空白を無視するので、判定には使わない（findQuote は同じ入力を通さない）', () => {
    // 「売上 は」と「売上は」を区別できないのがこの関数の性質。実在判定に使ってはいけないことを、
    // findQuote との違いとして固定しておく。
    const haystack = '売上\nは増えた。'
    expect(locateQuoteIgnoringWhitespace(haystack, '売上は増えた。')).not.toBeNull()
    expect(findQuote(haystack, '売上は増えた。').found).toBe(false)
  })
})
