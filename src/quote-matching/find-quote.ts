import { type NormalizedText, normalizeWithIndex } from './normalize.js'

/**
 * 引用文が証拠本文に実在するかの照合。
 *
 * この関数がこのサーバーの中核。AI が申告した引用文をそのまま台帳に書かず、
 * 「正規化して完全部分一致するか」を機械的に確かめ、通らなければ登録を拒否する。
 * 見つからなかったときは黙って false を返さず、最も長く一致した前方部分とその周辺を
 * 返す（AI が「どこまで合っていてどこから違うか」を直せるようにするため）。
 */

export type QuoteMatch =
  | { found: true; start: number; end: number; matchedText: string }
  | { found: false; nearest: NearestMatch | null }

export type NearestMatch = {
  /** 一致した引用文の前方部分の長さ（正規化後の文字数） */
  matchedChars: number
  start: number
  end: number
  /** 原文中の該当箇所の周辺抜粋 */
  excerpt: string
}

const EXCERPT_MARGIN = 60
/** 「近い箇所」を探す足がかりの長さ。短すぎると助詞 1 つで偶然当たって雑音になる。 */
const ANCHOR_CHARS = 6
/** これ未満しか一致しない箇所は「近い箇所」として提示しない。 */
const MIN_NEAREST_CHARS = 4

/**
 * 正規化後の一致位置を原文の [start, end) に戻す。写し戻しの規則と、その前提の検証は
 * **この 1 箇所が持つ**（呼ぶ側で重ねて確かめない）。
 *
 * 「見つからなかった」は `indexOf` が -1 を返す時点で既に表せている。ここへ来るのは
 * 一致が在ると分かった後だけなので、写像に穴があるのは normalizeWithIndex の破綻であって
 * 入力の問題ではない。`null` で返すと呼ぶ側がそれを「不一致」と取り違え、原因不明のまま
 * 「本文に無かった」と報告されてしまうので、位置を添えて投げる。
 */
function toSourceRange(
  hay: NormalizedText,
  hit: number,
  needleLength: number,
): { start: number; end: number } {
  const start = hay.starts[hit]
  const end = hay.ends[hit + needleLength - 1]
  if (start === undefined || end === undefined) {
    throw new Error(
      `内部エラー: 正規化位置の写像が壊れている (hit=${hit}, needleLength=${needleLength}, ` +
        `mapLength=${hay.starts.length}, normalizedLength=${hay.normalized.length}, ` +
        `start=${String(start)}, end=${String(end)})`,
    )
  }
  return { start, end }
}

export function findQuote(haystack: string, quote: string): QuoteMatch {
  const hay = normalizeWithIndex(haystack)
  const needle = normalizeWithIndex(quote).normalized
  if (needle.length === 0) {
    return { found: false, nearest: null }
  }

  const hit = hay.normalized.indexOf(needle)
  if (hit >= 0) {
    const range = toSourceRange(hay, hit, needle.length)
    return {
      found: true,
      start: range.start,
      end: range.end,
      matchedText: haystack.slice(range.start, range.end),
    }
  }
  return { found: false, nearest: findNearest(haystack, hay, needle) }
}

/**
 * 同じ照合規則で、本文中の一致箇所を**全部**返す（重なりは数えない）。
 *
 * fetch_evidence の検索語 (find) が使う。「何件あるか」を返さないと、呼ぶ側は先頭の 1 件を見て
 * 「これが唯一の記述だ」と誤解する。判定に使うのは findQuote のままで、この関数は読む位置を
 * 決めるためだけに使う。
 */
export function findQuoteAll(haystack: string, quote: string): Array<{ start: number; end: number }> {
  const hay = normalizeWithIndex(haystack)
  const needle = normalizeWithIndex(quote).normalized
  if (needle.length === 0) return []
  const ranges: Array<{ start: number; end: number }> = []
  for (
    let hit = hay.normalized.indexOf(needle);
    hit >= 0;
    hit = hay.normalized.indexOf(needle, hit + needle.length)
  ) {
    ranges.push(toSourceRange(hay, hit, needle.length))
  }
  return ranges
}

/**
 * 「引用文が本文のどこに在るか」だけを、空白の有無に左右されずに特定する。
 *
 * findQuote の代わりではない。実在判定は findQuote（空白を 1 つに畳む規則）だけが行い、
 * この関数は**すでに実在が確認された引用文**を、別の表現に写した同じ本文（ブラウザで開いた DOM、
 * PDF のテキストレイヤ）の上で指し直すためだけに使う。空白を全部落として比較するので
 * 「ブロック境界に改行が入る／入らない」「インライン要素の継ぎ目に空白が入る／入らない」の
 * どちらのずれも吸収する。判定に使えば `売上 は` と `売上は` を区別できなくなるため、判定には使わない。
 *
 * 返す `null` の意味は「その本文には無かった」の 1 つだけ。写像の破損は toSourceRange が投げる。
 */
export function locateQuoteIgnoringWhitespace(
  haystack: string,
  quote: string,
): { start: number; end: number } | null {
  const hay = normalizeWithIndex(haystack, 'drop')
  const needle = normalizeWithIndex(quote, 'drop').normalized
  if (needle.length === 0) return null
  const hit = hay.normalized.indexOf(needle)
  if (hit < 0) return null
  return toSourceRange(hay, hit, needle.length)
}

/**
 * 引用文と証拠本文が最も長く一致している箇所を探す。
 *
 * 前方一致だけを見るやり方は採らない。引用の食い違いは真ん中で起きることが多く（数値の
 * 取り違え・助詞の差）、そのとき前方一致は数文字で尽きて「近い箇所なし」になってしまう。
 * 引用文の各位置から ANCHOR_CHARS 文字の足がかりを本文に探し、当たったら左右へ伸ばして
 * 最長の一致を採る。
 */
function findNearest(
  haystack: string,
  hay: ReturnType<typeof normalizeWithIndex>,
  needle: string,
): NearestMatch | null {
  const anchorLength = Math.min(ANCHOR_CHARS, needle.length)
  if (anchorLength < MIN_NEAREST_CHARS) return null

  let best: { length: number; hayStart: number; hayEnd: number } | null = null
  for (let i = 0; i + anchorLength <= needle.length; i += 1) {
    const anchor = hay.normalized.indexOf(needle.slice(i, i + anchorLength))
    if (anchor < 0) continue
    let left = i
    let hayLeft = anchor
    while (left > 0 && hayLeft > 0 && needle[left - 1] === hay.normalized[hayLeft - 1]) {
      left -= 1
      hayLeft -= 1
    }
    let right = i + anchorLength
    let hayRight = anchor + anchorLength
    while (
      right < needle.length &&
      hayRight < hay.normalized.length &&
      needle[right] === hay.normalized[hayRight]
    ) {
      right += 1
      hayRight += 1
    }
    const length = right - left
    if (best === null || length > best.length) best = { length, hayStart: hayLeft, hayEnd: hayRight }
  }
  if (best === null) return null

  const start = hay.starts[best.hayStart]
  const end = hay.ends[best.hayEnd - 1]
  if (start === undefined || end === undefined) return null
  return {
    matchedChars: best.length,
    start,
    end,
    excerpt: haystack.slice(
      Math.max(0, start - EXCERPT_MARGIN),
      Math.min(haystack.length, end + EXCERPT_MARGIN),
    ),
  }
}
