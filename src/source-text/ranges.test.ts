import { describe, expect, test } from 'vitest'
import { FactCheckError } from '../errors.js'
import { assertValidRange, type Coverage, computeCoverage, mergeRanges, type Range } from './ranges.js'

describe('assertValidRange', () => {
  test.each([
    { name: '本文の先頭 1 文字', length: 10, start: 0, end: 1 },
    { name: '本文の末尾ちょうど', length: 10, start: 9, end: 10 },
    { name: '本文全体', length: 10, start: 0, end: 10 },
  ])('通る: $name', ({ length, start, end }) => {
    expect(() => assertValidRange(length, start, end, 'テスト')).not.toThrow()
  })

  test.each([
    {
      name: '範囲外: end が本文より 1 文字長い',
      length: 10,
      start: 0,
      end: 11,
      message: 'end が本文の長さを超えている',
    },
    { name: '範囲外: start が負', length: 10, start: -1, end: 5, message: 'start が負の値' },
    { name: 'start > end', length: 10, start: 6, end: 5, message: 'start が end より大きい' },
    { name: '空範囲: 先頭', length: 10, start: 0, end: 0, message: '空範囲は登録できない' },
    { name: '空範囲: 途中', length: 10, start: 4, end: 4, message: '空範囲は登録できない' },
    { name: '空範囲: 末尾', length: 10, start: 10, end: 10, message: '空範囲は登録できない' },
    { name: '整数でない start', length: 10, start: 1.5, end: 5, message: '整数でなければならない' },
    { name: '整数でない end', length: 10, start: 1, end: 5.5, message: '整数でなければならない' },
    { name: '長さ 0 の本文', length: 0, start: 0, end: 1, message: 'end が本文の長さを超えている' },
  ])('拒否する: $name', ({ length, start, end, message }) => {
    expect(() => assertValidRange(length, start, end, 'テスト')).toThrow(FactCheckError)
    expect(() => assertValidRange(length, start, end, 'テスト')).toThrow(message)
  })
})

describe('mergeRanges', () => {
  test.each([
    { name: '空', input: [], expected: [] },
    { name: '1 個', input: [{ start: 2, end: 5 }], expected: [{ start: 2, end: 5 }] },
    {
      name: '重なり: 部分的に重なる 2 個',
      input: [
        { start: 0, end: 5 },
        { start: 3, end: 8 },
      ],
      expected: [{ start: 0, end: 8 }],
    },
    {
      name: '重なり: 片方が完全に内側',
      input: [
        { start: 0, end: 10 },
        { start: 3, end: 5 },
      ],
      expected: [{ start: 0, end: 10 }],
    },
    {
      name: '隣接: 端が接する 2 個は 1 つに畳む',
      input: [
        { start: 0, end: 3 },
        { start: 3, end: 6 },
      ],
      expected: [{ start: 0, end: 6 }],
    },
    {
      name: '隙間: 離れた 2 個はそのまま',
      input: [
        { start: 0, end: 3 },
        { start: 4, end: 6 },
      ],
      expected: [
        { start: 0, end: 3 },
        { start: 4, end: 6 },
      ],
    },
    {
      name: '順不同で渡しても昇順で返る',
      input: [
        { start: 7, end: 9 },
        { start: 0, end: 2 },
      ],
      expected: [
        { start: 0, end: 2 },
        { start: 7, end: 9 },
      ],
    },
  ])('$name', ({ input, expected }) => {
    expect(mergeRanges(input)).toEqual(expected)
  })

  test('入力の配列と要素を書き換えない', () => {
    const input = [
      { start: 0, end: 5 },
      { start: 3, end: 8 },
    ]
    mergeRanges(input)
    expect(input).toEqual([
      { start: 0, end: 5 },
      { start: 3, end: 8 },
    ])
  })
})

describe('computeCoverage', () => {
  test.each([
    {
      name: '完全網羅: 1 個で全部',
      length: 10,
      ranges: [{ start: 0, end: 10 }],
      covered: 10,
      ratio: 1,
      gaps: [],
    },
    {
      name: '完全網羅: 隣接する 2 個で全部',
      length: 10,
      ranges: [
        { start: 0, end: 4 },
        { start: 4, end: 10 },
      ],
      covered: 10,
      ratio: 1,
      gaps: [],
    },
    {
      name: '重なり: 重複分は 1 回しか数えない',
      length: 10,
      ranges: [
        { start: 0, end: 6 },
        { start: 4, end: 10 },
      ],
      covered: 10,
      ratio: 1,
      gaps: [],
    },
    {
      name: '隙間: 真ん中が空く',
      length: 10,
      ranges: [
        { start: 0, end: 3 },
        { start: 7, end: 10 },
      ],
      covered: 6,
      ratio: 0.6,
      gaps: [{ start: 3, end: 7 }],
    },
    {
      name: '隙間: 先頭が空く',
      length: 10,
      ranges: [{ start: 2, end: 10 }],
      covered: 8,
      ratio: 0.8,
      gaps: [{ start: 0, end: 2 }],
    },
    {
      name: '隙間: 末尾が空く',
      length: 10,
      ranges: [{ start: 0, end: 8 }],
      covered: 8,
      ratio: 0.8,
      gaps: [{ start: 8, end: 10 }],
    },
    {
      name: '範囲が 1 つも無い',
      length: 10,
      ranges: [],
      covered: 0,
      ratio: 0,
      gaps: [{ start: 0, end: 10 }],
    },
    {
      name: '本文外にはみ出した範囲は本文内だけ数える',
      length: 10,
      ranges: [{ start: 5, end: 30 }],
      covered: 5,
      ratio: 0.5,
      gaps: [{ start: 0, end: 5 }],
    },
    { name: '本文の長さが 0', length: 0, ranges: [], covered: 0, ratio: 0, gaps: [] },
  ])('$name', ({ length, ranges, covered, ratio, gaps }) => {
    const result = computeCoverage(length, ranges)
    expect(result.covered).toBe(covered)
    expect(result.total).toBe(length)
    expect(result.ratio).toBeCloseTo(ratio, 10)
    expect(result.gaps).toEqual(gaps)
  })
})

/**
 * 規律 6（oracle 差分）: 「賢さゼロの実装」を別に書いて突き合わせる。
 * 人が思いつく表形式のケースだけでは、区間の畳み込みの取りこぼしは守れない。
 */
type CoverageImpl = (textLength: number, ranges: readonly Range[]) => Coverage

/** oracle: 1 文字ずつ真偽値の配列に塗るだけ。速度も優雅さも要らない。 */
function coverageOracle(textLength: number, ranges: readonly Range[]): { covered: number; gaps: Range[] } {
  const painted = new Array<boolean>(textLength).fill(false)
  for (const range of ranges) {
    for (let i = Math.max(0, range.start); i < Math.min(textLength, range.end); i += 1) painted[i] = true
  }
  const covered = painted.filter(Boolean).length
  const gaps: Range[] = []
  let runStart: number | null = null
  for (let i = 0; i < textLength; i += 1) {
    if (painted[i] === false && runStart === null) runStart = i
    if (painted[i] === true && runStart !== null) {
      gaps.push({ start: runStart, end: i })
      runStart = null
    }
  }
  if (runStart !== null) gaps.push({ start: runStart, end: textLength })
  return { covered, gaps }
}

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const BOUNDARY_CASES: Array<{ length: number; ranges: Range[] }> = [
  { length: 0, ranges: [] },
  { length: 1, ranges: [{ start: 0, end: 1 }] },
  { length: 5, ranges: [] },
  { length: 5, ranges: [{ start: 0, end: 5 }] },
  {
    length: 5,
    ranges: [
      { start: 0, end: 2 },
      { start: 2, end: 5 },
    ],
  },
  {
    length: 5,
    ranges: [
      { start: 0, end: 3 },
      { start: 1, end: 2 },
    ],
  },
  { length: 5, ranges: [{ start: 3, end: 99 }] },
  {
    length: 8,
    ranges: [
      { start: 6, end: 8 },
      { start: 0, end: 1 },
    ],
  },
]

function generateCases(count: number): Array<{ length: number; ranges: Range[] }> {
  const random = mulberry32(20260912)
  const cases: Array<{ length: number; ranges: Range[] }> = []
  for (let i = 0; i < count; i += 1) {
    const length = Math.floor(random() * 40)
    const ranges: Range[] = []
    const rangeCount = Math.floor(random() * 6)
    for (let r = 0; r < rangeCount; r += 1) {
      const start = Math.floor(random() * (length + 3))
      const end = start + Math.floor(random() * 12)
      ranges.push({ start, end })
    }
    cases.push({ length, ranges })
  }
  return cases
}

const ORACLE_CASES = [...BOUNDARY_CASES, ...generateCases(400)]

/** oracle と食い違った最初のケースを返す。一致すれば null。 */
function firstDisagreement(impl: CoverageImpl): string | null {
  for (const testCase of ORACLE_CASES) {
    const expected = coverageOracle(testCase.length, testCase.ranges)
    const actual = impl(testCase.length, testCase.ranges)
    if (
      actual.covered !== expected.covered ||
      JSON.stringify(actual.gaps) !== JSON.stringify(expected.gaps)
    ) {
      return JSON.stringify({ testCase, expected, actual })
    }
  }
  return null
}

describe('computeCoverage の oracle 差分', () => {
  test(`本実装は ${ORACLE_CASES.length} 件すべてで oracle と一致する`, () => {
    expect(firstDisagreement(computeCoverage)).toBeNull()
  })

  /**
   * 変異体: 本実装を 1 箇所だけ壊した写し。oracle 差分が全部を落とせて初めて、
   * 「テストが緑」が検出力の証明になる。
   *
   * 「隣接する区間を畳まない」変異はここには入れない。computeCoverage の被覆計算は
   * merged を左から舐めて cursor を進めるだけなので、隣接区間が畳まれていようといまいと
   * 出力が変わらない（等価変異）。この変異は mergeRanges 側の oracle 差分で落とす。
   */
  const mutants: Array<{ name: string; impl: CoverageImpl }> = [
    {
      name: '変異1: 被覆文字数を 1 多く数える (off-by-one)',
      impl: (textLength, ranges) => mutatedCoverage(textLength, ranges, { offByOne: true }),
    },
    {
      name: '変異2: 末尾の隙間を記録しない',
      impl: (textLength, ranges) => mutatedCoverage(textLength, ranges, { skipTailGap: true }),
    },
    {
      name: '変異3: 本文長でのクランプを外す',
      impl: (textLength, ranges) => mutatedCoverage(textLength, ranges, { noClamp: true }),
    },
    {
      name: '変異4: 区間をソートしない',
      impl: (textLength, ranges) => mutatedCoverage(textLength, ranges, { noSort: true }),
    },
  ]

  test.each(mutants)('$name は oracle 差分に落とされる', ({ impl }) => {
    expect(firstDisagreement(impl)).not.toBeNull()
  })
})

/** mergeRanges の oracle: 1 文字ずつ塗って、連続した塗り跡を区間に戻すだけ。 */
function mergeOracle(ranges: readonly Range[]): Range[] {
  const painted = new Set<number>()
  for (const range of ranges) {
    for (let i = range.start; i < range.end; i += 1) painted.add(i)
  }
  const sorted = [...painted].sort((a, b) => a - b)
  const merged: Range[] = []
  for (const position of sorted) {
    const last = merged.at(-1)
    if (last !== undefined && last.end === position) {
      last.end = position + 1
      continue
    }
    merged.push({ start: position, end: position + 1 })
  }
  return merged
}

type MergeImpl = (ranges: readonly Range[]) => Range[]

function firstMergeDisagreement(impl: MergeImpl): string | null {
  for (const testCase of ORACLE_CASES) {
    const expected = mergeOracle(testCase.ranges)
    const actual = impl(testCase.ranges)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return JSON.stringify({ testCase, expected, actual })
    }
  }
  return null
}

describe('mergeRanges の oracle 差分', () => {
  test(`本実装は ${ORACLE_CASES.length} 件すべてで oracle と一致する`, () => {
    expect(firstMergeDisagreement(mergeRanges)).toBeNull()
  })

  const mutants: Array<{ name: string; impl: MergeImpl }> = [
    {
      name: '変異1: 隣接する区間を畳まない (<= を < にする)',
      impl: (r) => mutatedMerge(r, { adjacentMerge: false }),
    },
    { name: '変異2: 区間をソートしない', impl: (r) => mutatedMerge(r, { noSort: true }) },
    { name: '変異3: 空区間を捨てない', impl: (r) => mutatedMerge(r, { keepEmpty: true }) },
  ]

  test.each(mutants)('$name は oracle 差分に落とされる', ({ impl }) => {
    expect(firstMergeDisagreement(impl)).not.toBeNull()
  })
})

type MergeMutation = { adjacentMerge?: boolean; noSort?: boolean; keepEmpty?: boolean }

function mutatedMerge(ranges: readonly Range[], mutation: MergeMutation): Range[] {
  const sorted =
    mutation.noSort === true ? [...ranges] : [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: Range[] = []
  for (const range of sorted) {
    if (mutation.keepEmpty !== true && range.start >= range.end) continue
    const last = merged.at(-1)
    const touching =
      mutation.adjacentMerge === false ? range.start < (last?.end ?? -1) : range.start <= (last?.end ?? -1)
    if (last !== undefined && touching) {
      if (range.end > last.end) last.end = range.end
      continue
    }
    merged.push({ start: range.start, end: range.end })
  }
  return merged
}

type Mutation = {
  offByOne?: boolean
  skipTailGap?: boolean
  noClamp?: boolean
  noSort?: boolean
}

/** 本実装の写しに、指定された 1 箇所の壊れ方だけを入れる。 */
function mutatedCoverage(textLength: number, ranges: readonly Range[], mutation: Mutation): Coverage {
  const merged = mutatedMerge(ranges, mutation.noSort === true ? { noSort: true } : {})
  let covered = 0
  const gaps: Range[] = []
  let cursor = 0
  for (const range of merged.filter((r) => r.start < textLength)) {
    const start = Math.max(range.start, 0)
    const end = mutation.noClamp === true ? range.end : Math.min(range.end, textLength)
    if (end <= start) continue
    if (start > cursor) gaps.push({ start: cursor, end: start })
    covered += end - start + (mutation.offByOne === true ? 1 : 0)
    cursor = Math.max(cursor, end)
  }
  if (mutation.skipTailGap !== true && cursor < textLength) gaps.push({ start: cursor, end: textLength })
  return { covered, total: textLength, ratio: textLength === 0 ? 0 : covered / textLength, gaps }
}
