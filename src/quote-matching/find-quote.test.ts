import { describe, expect, test, vi } from 'vitest'
import { findQuote, findQuoteAll, locateQuoteIgnoringWhitespace } from './find-quote.js'
import * as normalizeModule from './normalize.js'
import { normalizeForMatch, normalizeWithIndex } from './normalize.js'

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

/**
 * fetch_evidence の find が「何件あるか」を出せないと、呼ぶ側は先頭 1 件を見て
 * 「この記述はここにしかない」と誤解する。件数と位置が findQuote と同じ規則で出ることを固定する。
 */
describe('findQuoteAll: 一致箇所を全部返す', () => {
  const REPEATED = '売上は増えた。利益も増えた。来期も増えた。'

  test.each([
    { name: '一致なし', haystack: REPEATED, quote: '減った', expected: [] },
    { name: '一致 1 件', haystack: REPEATED, quote: '売上', expected: ['売上'] },
    { name: '一致 3 件', haystack: REPEATED, quote: '増えた', expected: ['増えた', '増えた', '増えた'] },
    { name: '空の検索語', haystack: REPEATED, quote: '', expected: [] },
    { name: '空白だけの検索語', haystack: REPEATED, quote: ' 　\n', expected: [] },
    { name: '空の本文', haystack: '', quote: '増えた', expected: [] },
    {
      name: '正規化: 全角で書いても半角の本文に当たる',
      haystack: 'A 120% と 120% ',
      quote: '１２０％',
      expected: ['120%', '120%'],
    },
    {
      name: '空白差: 本文側の連続空白を畳んで当たる',
      haystack: '売上は  前年比 と 売上は 前年比',
      quote: '売上は 前年比',
      expected: ['売上は  前年比', '売上は 前年比'],
    },
    { name: '重なりは数えない', haystack: 'aaaa', quote: 'aa', expected: ['aa', 'aa'] },
  ])('$name', ({ haystack, quote, expected }) => {
    const ranges = findQuoteAll(haystack, quote)
    expect(ranges.map((range) => haystack.slice(range.start, range.end))).toEqual(expected)
  })

  /**
   * 写像の破損（normalizeWithIndex の starts/ends が normalized と揃わない）は内部バグであって
   * 「本文に無かった」ではない。読み飛ばすと、原因不明のまま「引用が見つからない」と報告される。
   *
   * 破損は正常な入力からは作れないので、oracle は「正規化の写像が常に揃っている」ことの全数確認と、
   * 人工的に壊した 1 件で詳細付きの例外が出ることの 2 本立てにする。
   */
  test.each([
    { name: 'ASCII', text: 'sales grew 120%' },
    { name: '和文', text: '売上は前年比 120% に達した。' },
    { name: '全角英数', text: 'ＡＢＣ１２３' },
    { name: '半角カタカナ', text: 'ｶﾀｶﾅを含む' },
    { name: 'サロゲートペア', text: '🇯🇵の売上🇯🇵' },
    { name: 'ZWJ 絵文字', text: '👨‍👩‍👧‍👦 は 3 件' },
    { name: '結合文字', text: 'é と é' },
    { name: '空白だけ', text: ' 　\n\t ' },
    { name: '空文字列', text: '' },
  ])('$name: 正規化の写像は normalized と常に同じ長さ', ({ text }) => {
    const normalized = normalizeWithIndex(text)
    expect(normalized.starts).toHaveLength(normalized.normalized.length)
    expect(normalized.ends).toHaveLength(normalized.normalized.length)
    const dropped = normalizeWithIndex(text, 'drop')
    expect(dropped.starts).toHaveLength(dropped.normalized.length)
    expect(dropped.ends).toHaveLength(dropped.normalized.length)
  })

  test('写像が壊れていたら読み飛ばさず、位置を添えて投げる', () => {
    // 正常な入力からは作れない状態なので、写像だけを人工的に削って注入する。
    const haystack = '売上は前年比 120% に達した。'
    const broken = normalizeWithIndex(haystack)
    broken.ends.length = 1
    const spy = vi.spyOn(normalizeModule, 'normalizeWithIndex').mockReturnValueOnce(broken)
    try {
      expect(() => findQuoteAll(haystack, '前年比')).toThrow(/正規化位置の写像が壊れている/)
    } finally {
      spy.mockRestore()
    }
  })

  test('返る位置は昇順で、findQuote の 1 件目と一致する', () => {
    const ranges = findQuoteAll(REPEATED, '増えた')
    expect(ranges.map((range) => range.start)).toEqual(
      [...ranges.map((range) => range.start)].sort((a, b) => a - b),
    )
    const first = findQuote(REPEATED, '増えた')
    expect(first.found).toBe(true)
    if (!first.found) return
    expect(ranges[0]).toEqual({ start: first.start, end: first.end })
  })
})
