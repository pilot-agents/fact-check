import type { Range } from './ranges.js'

/**
 * 元ネタ本文を「塗り分けの最小単位」に割る。
 *
 * ビューアは本文全文を表示して claim の範囲を判定色で塗るが、claim と non_claim は重なることが
 * あり（同じ文を別の粒度で 2 回登録した、見出しを含めて claim にした、など）、範囲をそのまま
 * 入れ子の要素にすると DOM が交差して壊れる。先に本文を「重なりの状態が変わらない区間」へ
 * 割っておけば、あとは平坦な列を順に並べるだけで済む。
 *
 * 区間は本文を隙間なく敷き詰める。どの claim にも non_claim にも入らない範囲（網羅率 100% に
 * 満たないセッションで出る）も、id を 1 つも持たない区間として必ず返す。落とすと本文の文字が
 * 消えて、読み手からは「元ネタにそう書いてあった」ように見えてしまう。
 */

/** 塗り分けの最小単位。[start, end) と、そこに重なっている claim / non_claim の id。 */
export type TextSpan = {
  start: number
  end: number
  /** この区間に重なっている claim の id。入力の並び順を保つ */
  claim_ids: string[]
  /** この区間に重なっている non_claim の id。入力の並び順を保つ */
  non_claim_ids: string[]
}

export type IdRange = Range & { id: string }

export function buildTextSpans(
  textLength: number,
  claims: readonly IdRange[],
  nonClaims: readonly IdRange[],
): TextSpan[] {
  if (textLength <= 0) return []
  const usableClaims = clampAll(claims, textLength)
  const usableNonClaims = clampAll(nonClaims, textLength)

  const boundaries = new Set<number>([0, textLength])
  for (const range of [...usableClaims, ...usableNonClaims]) {
    boundaries.add(range.start)
    boundaries.add(range.end)
  }
  const points = [...boundaries].sort((a, b) => a - b)

  const spans: TextSpan[] = []
  for (let index = 0; index + 1 < points.length; index += 1) {
    const start = points[index] ?? 0
    const end = points[index + 1] ?? 0
    if (end <= start) continue
    spans.push({
      start,
      end,
      claim_ids: idsCovering(usableClaims, start, end),
      non_claim_ids: idsCovering(usableNonClaims, start, end),
    })
  }
  return spans
}

/** 本文の外にはみ出した範囲は本文の中に切り詰める。切り詰めて空になったものは持たない。 */
function clampAll(ranges: readonly IdRange[], textLength: number): IdRange[] {
  const clamped: IdRange[] = []
  for (const range of ranges) {
    const start = Math.max(range.start, 0)
    const end = Math.min(range.end, textLength)
    if (end <= start) continue
    clamped.push({ id: range.id, start, end })
  }
  return clamped
}

/** [start, end) を丸ごと含む範囲の id。区間は境界で割ってあるので、部分的な重なりは起きない。 */
function idsCovering(ranges: readonly IdRange[], start: number, end: number): string[] {
  return ranges.filter((range) => range.start <= start && end <= range.end).map((range) => range.id)
}
