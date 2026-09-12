import { FactCheckError } from '../errors.js'

/** 元ネタ本文の半開区間 [start, end)。位置指定はこの表現だけで行い、本文を分解して持たない。 */
export type Range = { start: number; end: number }

/**
 * 範囲が本文の内側にある半開区間かを検証する。通らなければ理由つきで投げる。
 *
 * 空範囲 (start === end) を弾くのは意図的。「0 文字を claim にした」は網羅率に 1 文字も
 * 寄与しないので、通してしまうと AI が空範囲を大量に登録して「処理した」と言えてしまう。
 */
export function assertValidRange(textLength: number, start: number, end: number, label: string): void {
  const problem = rangeProblem(textLength, start, end)
  if (problem !== null) throw new FactCheckError(`${label}: ${problem}`)
}

/**
 * 範囲が不正な理由を返す（正しければ null）。
 *
 * 投げる版と別に用意しているのは、まとめ登録 (register_segments) が「1 件目で投げずに全件の理由を
 * 集める」ためで、規則そのものはここにしか無い。
 */
export function rangeProblem(textLength: number, start: number, end: number): string | null {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return `start と end は整数でなければならない (start=${start}, end=${end})`
  }
  if (start < 0) return `start が負の値 (start=${start})`
  if (start > end) return `start が end より大きい (start=${start}, end=${end})`
  if (start === end) return `空範囲は登録できない (start=${start}, end=${end})`
  if (end > textLength) return `end が本文の長さを超えている (end=${end}, 本文の長さ=${textLength})`
  return null
}

/** 重なり・隣接する区間を和集合に畳む。入力は破壊しない。 */
export function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: Range[] = []
  for (const range of sorted) {
    if (range.start >= range.end) continue
    const last = merged.at(-1)
    if (last !== undefined && range.start <= last.end) {
      if (range.end > last.end) last.end = range.end
      continue
    }
    merged.push({ start: range.start, end: range.end })
  }
  return merged
}

export type Coverage = {
  /** claim か non_claim のいずれかに含まれる文字数（重なりは 1 回だけ数える） */
  covered: number
  total: number
  /** covered / total。total が 0 のときは 0 */
  ratio: number
  /** まだどちらにも含まれていない範囲（昇順・非隣接） */
  gaps: Range[]
}

/** 網羅率 = 本文のうち claim か non_claim の和集合に含まれる文字の割合。 */
export function computeCoverage(textLength: number, ranges: readonly Range[]): Coverage {
  const merged = mergeRanges(ranges).filter((r) => r.start < textLength)
  let covered = 0
  const gaps: Range[] = []
  let cursor = 0
  for (const range of merged) {
    const start = Math.max(range.start, 0)
    const end = Math.min(range.end, textLength)
    if (end <= start) continue
    if (start > cursor) gaps.push({ start: cursor, end: start })
    covered += end - start
    cursor = Math.max(cursor, end)
  }
  if (cursor < textLength) gaps.push({ start: cursor, end: textLength })
  return { covered, total: textLength, ratio: textLength === 0 ? 0 : covered / textLength, gaps }
}
