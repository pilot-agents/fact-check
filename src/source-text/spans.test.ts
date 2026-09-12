import { describe, expect, test } from 'vitest'
import { buildTextSpans, type IdRange, type TextSpan } from './spans.js'

/** 期待値を読める長さにするための省略記法。[start, end, claim_ids, non_claim_ids] */
type Expected = [number, number, string[], string[]]

function toTuples(spans: readonly TextSpan[]): Expected[] {
  return spans.map((span) => [span.start, span.end, span.claim_ids, span.non_claim_ids])
}

describe('buildTextSpans', () => {
  test.each<{ name: string; length: number; claims: IdRange[]; nonClaims: IdRange[]; expected: Expected[] }>([
    {
      name: '登録が 1 件も無いとき、本文全体が id を持たない 1 区間になる',
      length: 10,
      claims: [],
      nonClaims: [],
      expected: [[0, 10, [], []]],
    },
    {
      name: '本文全体がひとつの claim',
      length: 10,
      claims: [{ id: 'c1', start: 0, end: 10 }],
      nonClaims: [],
      expected: [[0, 10, ['c1'], []]],
    },
    {
      name: '隣接: 端が接する 2 つの claim は別々の区間のまま',
      length: 10,
      claims: [
        { id: 'c1', start: 0, end: 5 },
        { id: 'c2', start: 5, end: 10 },
      ],
      nonClaims: [],
      expected: [
        [0, 5, ['c1'], []],
        [5, 10, ['c2'], []],
      ],
    },
    {
      name: '重なり: 部分的に重なる 2 つの claim は 3 区間になり、重なりが両方の id を持つ',
      length: 10,
      claims: [
        { id: 'c1', start: 0, end: 6 },
        { id: 'c2', start: 4, end: 10 },
      ],
      nonClaims: [],
      expected: [
        [0, 4, ['c1'], []],
        [4, 6, ['c1', 'c2'], []],
        [6, 10, ['c2'], []],
      ],
    },
    {
      name: '重なり: 片方が完全に内側にある',
      length: 10,
      claims: [
        { id: 'c1', start: 0, end: 10 },
        { id: 'c2', start: 3, end: 5 },
      ],
      nonClaims: [],
      expected: [
        [0, 3, ['c1'], []],
        [3, 5, ['c1', 'c2'], []],
        [5, 10, ['c1'], []],
      ],
    },
    {
      name: '重なり: 同じ範囲を 2 件が占める',
      length: 6,
      claims: [
        { id: 'c1', start: 0, end: 6 },
        { id: 'c2', start: 0, end: 6 },
      ],
      nonClaims: [],
      expected: [[0, 6, ['c1', 'c2'], []]],
    },
    {
      name: '重なり: 3 件が重なる区間では 3 件とも id に出る',
      length: 9,
      claims: [
        { id: 'c1', start: 0, end: 9 },
        { id: 'c2', start: 2, end: 9 },
        { id: 'c3', start: 4, end: 6 },
      ],
      nonClaims: [],
      expected: [
        [0, 2, ['c1'], []],
        [2, 4, ['c1', 'c2'], []],
        [4, 6, ['c1', 'c2', 'c3'], []],
        [6, 9, ['c1', 'c2'], []],
      ],
    },
    {
      name: 'non_claim 混在: claim と non_claim が隣接する',
      length: 10,
      claims: [{ id: 'c1', start: 4, end: 10 }],
      nonClaims: [{ id: 'n1', start: 0, end: 4 }],
      expected: [
        [0, 4, [], ['n1']],
        [4, 10, ['c1'], []],
      ],
    },
    {
      name: 'non_claim 混在: claim と non_claim が重なる区間は両方の id を持つ',
      length: 10,
      claims: [{ id: 'c1', start: 2, end: 8 }],
      nonClaims: [{ id: 'n1', start: 0, end: 5 }],
      expected: [
        [0, 2, [], ['n1']],
        [2, 5, ['c1'], ['n1']],
        [5, 8, ['c1'], []],
        [8, 10, [], []],
      ],
    },
    {
      name: '未処理の範囲: 前後と間の隙間が id を持たない区間として残る',
      length: 12,
      claims: [
        { id: 'c1', start: 2, end: 4 },
        { id: 'c2', start: 8, end: 10 },
      ],
      nonClaims: [],
      expected: [
        [0, 2, [], []],
        [2, 4, ['c1'], []],
        [4, 8, [], []],
        [8, 10, ['c2'], []],
        [10, 12, [], []],
      ],
    },
    {
      name: '並び順: 入力が本文順でなくても区間は昇順に並ぶ',
      length: 9,
      claims: [
        { id: 'c2', start: 6, end: 9 },
        { id: 'c1', start: 0, end: 3 },
      ],
      nonClaims: [{ id: 'n1', start: 3, end: 6 }],
      expected: [
        [0, 3, ['c1'], []],
        [3, 6, [], ['n1']],
        [6, 9, ['c2'], []],
      ],
    },
    {
      name: '本文の外へはみ出した範囲は本文の中に切り詰められる',
      length: 5,
      claims: [{ id: 'c1', start: 0, end: 99 }],
      nonClaims: [{ id: 'n1', start: 7, end: 9 }],
      expected: [[0, 5, ['c1'], []]],
    },
    {
      name: '長さ 0 の本文では区間を返さない',
      length: 0,
      claims: [{ id: 'c1', start: 0, end: 3 }],
      nonClaims: [],
      expected: [],
    },
  ])('$name', ({ length, claims, nonClaims, expected }) => {
    expect(toTuples(buildTextSpans(length, claims, nonClaims))).toEqual(expected)
  })

  test('区間は本文を隙間なく敷き詰める', () => {
    const spans = buildTextSpans(
      20,
      [
        { id: 'c1', start: 3, end: 9 },
        { id: 'c2', start: 7, end: 12 },
      ],
      [{ id: 'n1', start: 15, end: 18 }],
    )
    expect(spans[0]?.start).toBe(0)
    expect(spans.at(-1)?.end).toBe(20)
    for (let index = 1; index < spans.length; index += 1) {
      expect(spans[index]?.start).toBe(spans[index - 1]?.end)
    }
  })
})
