import { describe, expect, test } from 'vitest'
import {
  DEFAULT_PAGE_CHARS,
  MAX_SEGMENT_CHARS,
  type SegmentGranularity,
  segmentPage,
  segmentSource,
} from './segments.js'

/**
 * 候補範囲が本文を隙間なく敷き詰めることは、このツールの使用可能性そのものに関わる不変条件。
 * 隙間があると、候補どおりに登録しても網羅率 100% に届かず finalize を永久に通せない。
 */
const TEXTS: Array<{ name: string; text: string }> = [
  { name: '1 文', text: '売上は前年比 120% に達した。' },
  { name: '複数文', text: '売上は増えた。利益も増えた。来期も伸びる見込みだ。' },
  { name: '段落 2 つ', text: '見出し\n\n本文の一文目。本文の二文目。' },
  { name: '空行が連続する', text: 'A。\n\n\n\nB。' },
  { name: '行末改行で終わる', text: '一行目。\n二行目。\n' },
  { name: '先頭が空行', text: '\n\n本文。' },
  { name: '終止符なしで終わる', text: '終わりの句点がない文' },
  { name: '英文の終止符', text: 'This is a sentence. This is another one.' },
  { name: 'ドメイン名を文境界にしない', text: 'example.com を参照した。' },
  { name: '1 文字', text: 'あ' },
  { name: '空白のみ', text: '   ' },
  // ページングの回帰用。絵文字（サロゲートペア・ZWJ）を途中で割ると text と [start,end) が食い違う。
  { name: '絵文字と空行', text: '🇯🇵の売上。\n\n👨‍👩‍👧‍👦 は 3 件だった。\n\n\n締め。' },
  {
    name: '1 文が 1 ページの予算を超える',
    text: `${'あ'.repeat(DEFAULT_PAGE_CHARS + 500)}。\n\n次の段落。`,
  },
  // 候補 1 件の上限の境界。on / just below / just above。
  { name: '候補の上限ちょうど', text: 'あ'.repeat(MAX_SEGMENT_CHARS) },
  { name: '候補の上限より 1 文字短い', text: 'あ'.repeat(MAX_SEGMENT_CHARS - 1) },
  { name: '候補の上限より 1 文字長い', text: 'あ'.repeat(MAX_SEGMENT_CHARS + 1) },
  {
    // サロゲートペアが分割位置に来るように、上限ぎりぎりまで 1 コード単位の文字を並べてから絵文字を置く。
    name: '分割位置にサロゲートペアが来る',
    text: `${'a'.repeat(MAX_SEGMENT_CHARS - 1)}🇯🇵${'b'.repeat(MAX_SEGMENT_CHARS)}`,
  },
  {
    name: '分割位置に ZWJ 絵文字が来る',
    text: `${'a'.repeat(MAX_SEGMENT_CHARS - 3)}👨‍👩‍👧‍👦${'b'.repeat(MAX_SEGMENT_CHARS)}`,
  },
  {
    name: '終止符も改行も無い巨大な塊（1 ページの予算の 3 倍超）',
    text: 'x'.repeat(DEFAULT_PAGE_CHARS * 3 + 7),
  },
  {
    name: '503 区間相当の長文',
    text: Array.from({ length: 84 }, (_, block) =>
      Array.from({ length: 6 }, (_, i) => `第${block}段落の${i}文目は前年比 ${i}% だった。`).join(''),
    ).join('\n\n'),
  },
]

const GRANULARITIES: SegmentGranularity[] = ['sentence', 'paragraph']

describe('segmentSource', () => {
  test.each(TEXTS)('$name: 候補が本文を隙間なく敷き詰める', ({ text }) => {
    const segments = segmentSource(text)
    expect(segments.length).toBeGreaterThan(0)
    expect(segments[0]?.start).toBe(0)
    expect(segments.at(-1)?.end).toBe(text.length)
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]?.start).toBe(segments[i - 1]?.end)
    }
    expect(segments.map((s) => s.text).join('')).toBe(text)
  })

  test.each(TEXTS)('$name: 各候補の text は start/end の実テキストと一致する', ({ text }) => {
    for (const segment of segmentSource(text)) {
      expect(segment.text).toBe(text.slice(segment.start, segment.end))
    }
  })

  test('ドメイン名のピリオドでは文を切らない', () => {
    const segments = segmentSource('example.com を参照した。次の文。')
    expect(segments[0]?.text).toBe('example.com を参照した。')
  })

  test('段落が違えば block 番号も違う', () => {
    const segments = segmentSource('第一段落。\n\n第二段落。')
    expect(segments[0]?.block).toBe(0)
    expect(segments.at(-1)?.block).toBe(1)
  })

  test.each(GRANULARITIES)('granularity=%s でも本文を隙間なく敷き詰める', (granularity) => {
    for (const { text } of TEXTS) {
      const segments = segmentSource(text, granularity)
      expect(segments.map((s) => s.text).join('')).toBe(text)
      expect(segments[0]?.start).toBe(0)
      expect(segments.at(-1)?.end).toBe(text.length)
    }
  })

  test('granularity=paragraph は段落 1 つにつき候補 1 件になる', () => {
    const text = '一文目。二文目。三文目。\n\n次の段落。もう一文。'
    expect(segmentSource(text, 'sentence')).toHaveLength(5)
    expect(segmentSource(text, 'paragraph')).toHaveLength(2)
  })

  test.each(GRANULARITIES)('granularity=%s で候補 1 件は必ず上限以下になる', (granularity) => {
    for (const { text } of TEXTS) {
      for (const segment of segmentSource(text, granularity)) {
        expect(segment.text.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS)
      }
    }
  })
})

/**
 * 候補列が満たすべき性質を、実装と別の道筋で確かめる oracle。
 *
 * 人が思いつく例だけを並べても、分割の off-by-one とサロゲートペアの破壊は通り抜ける。
 * ここで見るのは 7 つ:
 *   ① 連結すると原文と完全一致  ② text === slice(start,end)  ③ 各候補 ≤ 上限
 *   ④ 隙間も重複も無い  ⑤ index が 0..n-1  ⑥ block が非減少
 *   ⑦ 分割位置が必ずコードポイント境界（= サロゲートペアを割っていない）
 */
function checkSegmentInvariants(text: string, granularity: SegmentGranularity): void {
  const segments = segmentSource(text, granularity)
  // ⑦ の照合表。原文のコードポイント境界を、実装とは無関係に文字列反復子から作る。
  const codePointBoundaries = new Set<number>([text.length])
  let at = 0
  for (const codePoint of text) {
    codePointBoundaries.add(at)
    at += codePoint.length
  }

  expect(segments.map((s) => s.text).join('')).toBe(text) // ①
  expect(segments[0]?.start ?? 0).toBe(0)
  expect(segments.at(-1)?.end ?? 0).toBe(text.length)
  let previousEnd = 0
  let previousBlock = 0
  segments.forEach((segment, index) => {
    expect(segment.text).toBe(text.slice(segment.start, segment.end)) // ②
    expect(segment.text.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS) // ③
    expect(segment.start).toBe(previousEnd) // ④
    expect(segment.end).toBeGreaterThan(segment.start)
    expect(segment.index).toBe(index) // ⑤
    expect(segment.block).toBeGreaterThanOrEqual(previousBlock) // ⑥
    expect(codePointBoundaries.has(segment.start)).toBe(true) // ⑦
    expect(codePointBoundaries.has(segment.end)).toBe(true)
    previousEnd = segment.end
    previousBlock = segment.block
  })
}

/** 再現できる乱択のための線形合同法。seed を固定するので、落ちたケースは必ず再現する。 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

/** 分割を壊しやすい文字だけを集めた語彙。長さの境界は呼ぶ側が明示的に注入する。 */
const ALPHABET = ['a', 'あ', '。', '\n', '\n\n', ' ', '🇯🇵', '👨‍👩‍👧‍👦', '.', 'é']

describe('segmentSource: oracle 差分（境界の明示注入 + seed 固定の乱択）', () => {
  test.each(GRANULARITIES)('granularity=%s: 表の全入力で 7 性質を満たす', (granularity) => {
    for (const { text } of TEXTS) checkSegmentInvariants(text, granularity)
  })

  test.each(GRANULARITIES)('granularity=%s: 長さの境界を全数で確かめる', (granularity) => {
    // 上限とページ予算の on / just below / just above。割る位置がちょうど境界に来る。
    const lengths = [
      MAX_SEGMENT_CHARS - 1,
      MAX_SEGMENT_CHARS,
      MAX_SEGMENT_CHARS + 1,
      DEFAULT_PAGE_CHARS - 1,
      DEFAULT_PAGE_CHARS,
      DEFAULT_PAGE_CHARS + 1,
    ]
    for (const length of lengths) {
      for (const filler of ['a', '🇯🇵']) {
        checkSegmentInvariants(filler.repeat(length), granularity)
      }
    }
  })

  /**
   * 割り方が「上限まで詰めてから切る」ことを、件数そのもので固定する。
   *
   * 不変条件（≤ 上限・隙間なし）だけでは、1 単位ずつ早く切る実装も通ってしまう。早く切ると
   * 候補の件数が必要より増え、ページ数も増える。1 コード単位の文字だけで作った本文なら
   * 期待件数は ceil(長さ / 上限) にしかならないので、期待値を直に書ける。
   */
  test.each([
    { name: '上限ちょうど', length: MAX_SEGMENT_CHARS, expected: 1 },
    { name: '上限より 1 文字短い', length: MAX_SEGMENT_CHARS - 1, expected: 1 },
    { name: '上限より 1 文字長い', length: MAX_SEGMENT_CHARS + 1, expected: 2 },
    { name: '上限のちょうど 2 倍', length: MAX_SEGMENT_CHARS * 2, expected: 2 },
    { name: '上限の 2 倍より 1 文字長い', length: MAX_SEGMENT_CHARS * 2 + 1, expected: 3 },
    { name: '上限の 3 倍 + 端数', length: MAX_SEGMENT_CHARS * 3 + 7, expected: 4 },
  ])('$name: 候補は $expected 件（上限まで詰めてから切る）', ({ length, expected }) => {
    // 終止符も改行も無い 1 コード単位の文字だけ = 分割だけが件数を決める。
    const segments = segmentSource('x'.repeat(length))
    expect(segments).toHaveLength(expected)
    expect(segments.map((s) => s.text).join('')).toBe('x'.repeat(length))
  })

  test.each(GRANULARITIES)('granularity=%s: 乱択 200 本で 7 性質を満たす', (granularity) => {
    const random = makeRandom(20260913)
    for (let n = 0; n < 200; n += 1) {
      // 上限を跨ぐ長さが出るように、文字数ではなく「語彙を何個継ぐか」で長さを振る。
      const pieces = 1 + Math.floor(random() * 900)
      let text = ''
      for (let i = 0; i < pieces; i += 1) {
        text += ALPHABET[Math.floor(random() * ALPHABET.length)] ?? 'a'
      }
      if (text.length === 0) continue
      checkSegmentInvariants(text, granularity)
    }
  })
})

/**
 * ページングで守る不変条件は 2 つ。
 * (1) 全ページを繋ぐと本文が 1 文字も欠けずに復元できる（予算のために text を縮めない）。
 * (2) 1 ページの text 合計は必ず DEFAULT_PAGE_CHARS 以下。
 */
function readAllPages(text: string, granularity: SegmentGranularity, maxSegments?: number) {
  const pages: ReturnType<typeof segmentPage>[] = []
  let offset: number | null = 0
  while (offset !== null) {
    const page: ReturnType<typeof segmentPage> = segmentPage(text, {
      granularity,
      offset,
      ...(maxSegments === undefined ? {} : { maxSegments }),
    })
    pages.push(page)
    expect(page.segments.length).toBeGreaterThan(0)
    offset = page.next_segment_offset
  }
  return pages
}

describe('segmentPage: 全ページを繋ぐと本文が復元できる', () => {
  const CASES = TEXTS.flatMap((entry) =>
    GRANULARITIES.flatMap((granularity) =>
      // 件数の上限は境界の 3 点（1 件・既定より小さい値・全件を超える値）で見る
      [1, 7, 1000].map((maxSegments) => ({
        name: `${entry.name} / ${granularity} / max=${maxSegments}`,
        text: entry.text,
        granularity,
        maxSegments,
      })),
    ),
  )

  test.each(CASES)('$name: 隙間・重複・欠落なし', ({ text, granularity, maxSegments }) => {
    const pages = readAllPages(text, granularity, maxSegments)
    const segments = pages.flatMap((page) => page.segments)
    const all = segmentSource(text, granularity)

    expect(segments).toHaveLength(all.length)
    expect(pages[0]?.segment_total).toBe(all.length)
    expect(segments.map((s) => s.index)).toEqual(all.map((s) => s.index))
    expect(segments.map((s) => s.text).join('')).toBe(text)
    expect(segments[0]?.start).toBe(0)
    expect(segments.at(-1)?.end).toBe(text.length)
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]?.start).toBe(segments[i - 1]?.end)
    }
    for (const segment of segments) {
      expect(segment.text).toBe(text.slice(segment.start, segment.end))
    }
    expect(pages.at(-1)?.next_segment_offset).toBeNull()
    expect(pages.at(-1)?.truncation_note).toBeNull()
  })

  test.each(CASES)(
    '$name: 各ページの covered_range が候補の範囲と一致する',
    ({ text, granularity, maxSegments }) => {
      for (const page of readAllPages(text, granularity, maxSegments)) {
        expect(page.covered_range).toEqual({
          start: page.segments[0]?.start,
          end: page.segments.at(-1)?.end,
        })
      }
    },
  )

  test.each(CASES)('$name: どのページも text 合計が予算を超えない', ({ text, granularity, maxSegments }) => {
    for (const page of readAllPages(text, granularity, maxSegments)) {
      const total = page.segments.reduce((sum, segment) => sum + segment.text.length, 0)
      expect(total).toBeLessThanOrEqual(DEFAULT_PAGE_CHARS)
      expect(page.segments.length).toBeLessThanOrEqual(maxSegments)
    }
  })

  test.each(
    TEXTS.flatMap((entry) =>
      GRANULARITIES.map((granularity) => ({
        name: `${entry.name} / ${granularity}`,
        text: entry.text,
        granularity,
      })),
    ),
  )('$name: 候補列は max_segments に左右されない', ({ text, granularity }) => {
    // index と [start,end) がページの切り方で変わると、呼ぶ側がページを跨いで範囲を指せない。
    const reference = segmentSource(text, granularity).map((s) => [s.index, s.block, s.start, s.end])
    for (const maxSegments of [1, 2, 7, 100, 500]) {
      const paged = readAllPages(text, granularity, maxSegments)
        .flatMap((page) => page.segments)
        .map((s) => [s.index, s.block, s.start, s.end])
      expect(paged).toEqual(reference)
    }
  })
})

describe('segmentPage: 予算と継続位置', () => {
  const LONG = TEXTS.find((entry) => entry.name === '503 区間相当の長文')?.text ?? ''
  const HUGE = TEXTS.find((entry) => entry.name === '1 文が 1 ページの予算を超える')?.text ?? ''

  test.each([
    { name: '既定では 1 ページに収まらない', options: {}, expectTruncated: true },
    { name: 'max_segments=1 でも 1 件返る', options: { maxSegments: 1 }, expectTruncated: true },
    {
      name: '段落単位なら件数が減る',
      options: { granularity: 'paragraph' as const },
      expectTruncated: true,
    },
  ])('$name', ({ options, expectTruncated }) => {
    const page = segmentPage(LONG, options)
    expect(page.truncated).toBe(expectTruncated)
    expect(page.next_segment_offset).toBe(page.segment_offset + page.segments.length)
    expect(page.truncation_note).toContain('read_source_segments')
  })

  test('段落単位は文単位より候補の総数が少ない', () => {
    expect(segmentPage(LONG, { granularity: 'paragraph' }).segment_total).toBeLessThan(
      segmentPage(LONG, { granularity: 'sentence' }).segment_total,
    )
  })

  /**
   * 契約: 上限を超える塊は**候補を作る段階で割る**。縮めるのでも、1 件で丸ごと返すのでもない。
   * 割った候補を繋ぐと原文に戻り、ページの合計は必ず予算以下になる。
   */
  test('上限を超える塊は候補として割られ、text は縮まない', () => {
    const page = segmentPage(HUGE)
    expect(page.segments.length).toBeGreaterThan(1)
    for (const segment of page.segments) {
      expect(segment.text.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS)
      expect(segment.text).toBe(HUGE.slice(segment.start, segment.end))
    }
    const total = page.segments.reduce((sum, segment) => sum + segment.text.length, 0)
    expect(total).toBeLessThanOrEqual(DEFAULT_PAGE_CHARS)
    // 全ページを繋げば原文に戻る（割ったことで 1 文字も失われていない）。
    expect(
      readAllPages(HUGE, 'sentence')
        .flatMap((p) => p.segments)
        .map((s) => s.text)
        .join(''),
    ).toBe(HUGE)
  })

  test('段落単位でも上限を超える塊は割られる', () => {
    const page = segmentPage(HUGE, { granularity: 'paragraph' })
    for (const segment of page.segments) {
      expect(segment.text.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS)
    }
    const total = page.segments.reduce((sum, segment) => sum + segment.text.length, 0)
    expect(total).toBeLessThanOrEqual(DEFAULT_PAGE_CHARS)
  })

  test.each([
    { name: 'offset が負なら先頭から', offset: -5, expectedOffset: 0 },
    { name: 'offset が総数を超えたら末尾で空ページ', offset: 99_999, expectedOffset: -1 },
  ])('$name', ({ offset, expectedOffset }) => {
    const total = segmentPage(LONG).segment_total
    const page = segmentPage(LONG, { offset })
    expect(page.segment_offset).toBe(expectedOffset === -1 ? total : expectedOffset)
    if (expectedOffset === -1) {
      expect(page.segments).toHaveLength(0)
      expect(page.covered_range).toBeNull()
      expect(page.next_segment_offset).toBeNull()
    }
  })
})
