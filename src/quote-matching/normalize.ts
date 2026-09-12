/**
 * 引用文の照合に使う正規化と、「正規化後の位置 → 原文の位置」の写像。
 *
 * 照合規則（指示どおり）: Unicode NFKC で正規化し、空白の連続を 1 つの半角空白に畳んだうえで
 * 完全部分一致を取る。先頭・末尾の空白は落とす。
 *
 * 空白の扱いには 2 つのモードがある。
 * - collapse: 上記の既定。引用文の実在判定（findQuote）はこちらしか使わない
 * - drop: 空白を 1 文字も残さない。ブラウザの DOM のように「ブロック境界に空白が有るか無いか」が
 *   スナップショット側と食い違う相手に対して、**位置だけ**を特定するために使う。実在判定に使うと
 *   「単語がくっついた別の文字列」まで一致してしまうため、判定には使わない
 *
 * なぜ書記素（grapheme）単位で NFKC をかけるか: 文字列全体に NFKC をかけると長さが変わり、
 * 「正規化後の何文字目が原文の何文字目か」が復元できなくなる。ハイライト用スクショの位置も
 * 「引用が実在した」ことの提示も原文オフセットが要るので、写像は捨てられない。合成
 * （基底文字 + 結合文字）は書記素の内側で閉じるため、書記素ごとの NFKC は全体 NFKC と
 * 一致する。1 書記素が複数文字に展開される場合（例: 合字）は、展開後の全文字が同じ原文
 * 範囲を指す。
 */

export type NormalizedText = {
  normalized: string
  /** normalized[i] の由来となる原文範囲の開始位置 */
  starts: number[]
  /** normalized[i] の由来となる原文範囲の終了位置（排他） */
  ends: number[]
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter('und', { granularity: 'grapheme' })

function isWhitespaceOnly(segment: string): boolean {
  return segment.trim().length === 0
}

export type WhitespaceMode = 'collapse' | 'drop'

export function normalizeWithIndex(text: string, whitespace: WhitespaceMode = 'collapse'): NormalizedText {
  let normalized = ''
  const starts: number[] = []
  const ends: number[] = []
  let pendingSpace: { start: number; end: number } | null = null

  for (const { segment, index } of GRAPHEME_SEGMENTER.segment(text)) {
    const origStart = index
    const origEnd = index + segment.length
    if (isWhitespaceOnly(segment)) {
      if (whitespace === 'drop') continue
      pendingSpace =
        pendingSpace === null
          ? { start: origStart, end: origEnd }
          : { start: pendingSpace.start, end: origEnd }
      continue
    }
    // 先頭の空白は落とす（normalized が空のうちは空白を積まない）。
    if (pendingSpace !== null && normalized.length > 0) {
      normalized += ' '
      starts.push(pendingSpace.start)
      ends.push(pendingSpace.end)
    }
    pendingSpace = null
    const folded = segment.normalize('NFKC')
    // 展開後の各文字は同じ原文範囲を指す（合字 1 文字 → 複数文字に化けるケース）。
    // 添字は UTF-16 コード単位で数える。照合に使う indexOf がコード単位で位置を返すため。
    for (let i = 0; i < folded.length; i += 1) {
      starts.push(origStart)
      ends.push(origEnd)
    }
    normalized += folded
  }
  // 末尾の空白は落とす（pendingSpace を積まずに終える）。
  return { normalized, starts, ends }
}

/** 照合対象（針）側の正規化。位置の写像は不要なので文字列だけ返す。 */
export function normalizeForMatch(text: string): string {
  return normalizeWithIndex(text).normalized
}
