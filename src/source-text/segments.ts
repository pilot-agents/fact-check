/**
 * 元ネタ本文を、AI が claim / non_claim を切るための候補範囲に割る。
 *
 * 設計上の不変条件: 返す候補は本文全体を**隙間なく敷き詰める**（先頭の候補は start=0、
 * 隣り合う候補は前の end == 次の start、最後の候補は end=本文長）。網羅率は全文字を
 * 分母に取るので、候補そのものに隙間があると、候補どおりに登録しても 100% に到達できず
 * finalize を永久に通せなくなる。段落の区切りの空行や行末の改行は、直前の候補に含める。
 */

export type SourceSegment = {
  index: number
  /** 何番目の段落ブロックに属するか */
  block: number
  start: number
  end: number
  text: string
}

/** 空行（改行 + 空白のみの行）の並び。段落の区切り。 */
const BLANK_LINE_RUN = /\n[ \t]*\n[ \t\n]*/g

/**
 * 文の終わり。和文の終止符・感嘆符、または直後に空白か終端が続くピリオド、
 * それに続く閉じ括弧・引用符・行末の空白と改行までを 1 つの区切りとして飲み込む。
 * ピリオドに後読み条件を付けているのは `example.com` を文境界にしないため。
 */
const SENTENCE_END = /(?:[。．！？!?]+|\.(?=\s|$))[」』）)\]】”’"']*[ \t]*\n*|\n+/g

function splitTiling(text: string, offset: number, pattern: RegExp): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  const regex = new RegExp(pattern.source, pattern.flags)
  let cursor = 0
  for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
    const end = match.index + match[0].length
    spans.push({ start: offset + cursor, end: offset + end })
    cursor = end
  }
  if (cursor < text.length) spans.push({ start: offset + cursor, end: offset + text.length })
  return spans
}

/**
 * 候補の粗さ。
 * - sentence: 文ごと（既定。初版からの挙動）
 * - paragraph: 段落（空行で区切られたブロック）ごと。件数が 1/6 程度になるので長い元ネタで使う
 *
 * どちらも本文を隙間なく敷き詰める性質は同じなので、どちらで登録しても網羅率 100% に到達できる。
 */
export type SegmentGranularity = 'sentence' | 'paragraph'

/**
 * 候補 1 件の文字数の上限。
 *
 * 終止符も改行も無い長い塊（生成物の 1 行、詰め込まれた表）は文でも段落でも割れない。上限を
 * 置かないと候補 1 件が数万文字になり、1 件しか載っていないページが応答を食い潰す。
 *
 * **割るのは `segmentPage`（ページング）ではなく候補を作るここ。** ページング時に割ると、
 * 同じ本文でも `max_segments` の値によって候補の index と件数が変わる。index は呼ぶ側が
 * ページを跨いで範囲を指すのに使うので、ページの切り方に依存してはいけない。
 */
export const MAX_SEGMENT_CHARS = 1_000

/**
 * 1 ページに載せる候補本文の合計文字数。
 *
 * 候補 1 件の上限の倍数で定義する。こう書いておけば「1 件が必ず 1 ページに収まる」ことが
 * 定数の関係だけで保証され、`segmentPage` に「1 件目だけは予算を超えても載せる」という
 * 例外分岐（＝予算が守られない穴）が要らなくなる。
 */
export const DEFAULT_PAGE_CHARS = MAX_SEGMENT_CHARS * 4

/** 書記素の区切り。絵文字の合字や結合文字の途中で割らないために使う。 */
const GRAPHEME_SEGMENTER = new Intl.Segmenter('und', { granularity: 'grapheme' })

/**
 * 上限以下に割ってよい単位を順に返す。
 *
 * 既定は書記素。ZWJ を延々と連ねた 1 書記素だけで上限を超える病的な入力に限り、その書記素の
 * 中をコードポイント単位に落とす（文字列の反復子はコードポイント単位なので、**どちらの場合も
 * サロゲートペアは割れない**）。合字が割れる見た目より、応答の大きさが青天井になるほうが害が大きい。
 */
function* boundedUnits(body: string): Generator<string> {
  for (const { segment } of GRAPHEME_SEGMENTER.segment(body)) {
    if (segment.length <= MAX_SEGMENT_CHARS) {
      yield segment
      continue
    }
    for (const codePoint of segment) yield codePoint
  }
}

/**
 * 1 つの範囲を、上限以下の範囲の列に割る。原文は 1 文字も変えない（返すのは範囲だけで、
 * 連結すると元の範囲に戻る）。上限以下ならそのまま 1 件で返す。
 */
function splitToLimit(offset: number, body: string): Array<{ start: number; end: number }> {
  if (body.length <= MAX_SEGMENT_CHARS) return [{ start: offset, end: offset + body.length }]
  const spans: Array<{ start: number; end: number }> = []
  let start = 0
  let end = 0
  for (const unit of boundedUnits(body)) {
    // 単位は必ず上限以下なので、start === end のときにここへ入ることはない（空の範囲を作らない）。
    if (end + unit.length - start > MAX_SEGMENT_CHARS) {
      spans.push({ start: offset + start, end: offset + end })
      start = end
    }
    end += unit.length
  }
  if (start < end) spans.push({ start: offset + start, end: offset + end })
  return spans
}

export function segmentSource(text: string, granularity: SegmentGranularity = 'sentence'): SourceSegment[] {
  const segments: SourceSegment[] = []
  const blocks = splitTiling(text, 0, BLANK_LINE_RUN)
  blocks.forEach((block, blockIndex) => {
    const spans =
      granularity === 'paragraph'
        ? [{ start: block.start, end: block.end }]
        : splitTiling(text.slice(block.start, block.end), block.start, SENTENCE_END)
    for (const span of spans) {
      for (const bounded of splitToLimit(span.start, text.slice(span.start, span.end))) {
        segments.push({
          index: segments.length,
          block: blockIndex,
          start: bounded.start,
          end: bounded.end,
          text: text.slice(bounded.start, bounded.end),
        })
      }
    }
  })
  return segments
}

/**
 * 候補のページング。
 *
 * 全件を一度に返していたとき、15,768 文字の元ネタが 503 件・約 3,500 行になり、応答が途中で
 * 切れて分類できなかった（実運用）。件数と合計文字数の**両方**に予算を置き、続きがあることを
 * 呼ぶ側に明示する。
 *
 * 予算は上限であって切り詰めではない。**候補の text を縮めない**。縮めると text と [start, end) が
 * 食い違い、呼ぶ側がその範囲を登録した瞬間に網羅の穴になる。長い塊は候補を作る段階で
 * `MAX_SEGMENT_CHARS` 以下に割ってあるので、ここでは窓を切るだけでよい。
 *
 * 守るべき不変条件は 2 つ。(1) ページを順に繋ぐと本文が 1 文字も欠けずに復元できる。
 * (2) 1 ページの text 合計は必ず `DEFAULT_PAGE_CHARS` 以下。
 */
export const DEFAULT_MAX_SEGMENTS = 100
export const MAX_MAX_SEGMENTS = 500

export type SegmentPage = {
  segments: SourceSegment[]
  granularity: SegmentGranularity
  /** このページの先頭が全体の何件目か */
  segment_offset: number
  /** この粒度での候補の総数 */
  segment_total: number
  /** このページが覆う本文の範囲。全ページを繋ぐと [0, 本文長) になる */
  covered_range: { start: number; end: number } | null
  truncated: boolean
  /** 続きの先頭の件目。無ければ null */
  next_segment_offset: number | null
  truncation_note: string | null
}

export function segmentPage(
  text: string,
  options: { granularity?: SegmentGranularity; offset?: number; maxSegments?: number } = {},
): SegmentPage {
  const granularity = options.granularity ?? 'sentence'
  const all = segmentSource(text, granularity)
  const limit = Math.min(
    Math.max(Math.trunc(options.maxSegments ?? DEFAULT_MAX_SEGMENTS), 1),
    MAX_MAX_SEGMENTS,
  )
  const offset = Math.min(Math.max(Math.trunc(options.offset ?? 0), 0), all.length)

  const segments: SourceSegment[] = []
  let chars = 0
  for (let index = offset; index < all.length && segments.length < limit; index += 1) {
    const segment = all[index]
    if (segment === undefined) break
    // 候補 1 件は必ず MAX_SEGMENT_CHARS 以下で、DEFAULT_PAGE_CHARS はその倍数なので、
    // 空のページのまま進まなくなることはない（1 件目は chars=0 で必ず通る）。
    if (chars + segment.text.length > DEFAULT_PAGE_CHARS) break
    segments.push(segment)
    chars += segment.text.length
  }

  const nextOffset = offset + segments.length
  const first = segments[0]
  const last = segments[segments.length - 1]
  const more = nextOffset < all.length
  return {
    segments,
    granularity,
    segment_offset: offset,
    segment_total: all.length,
    covered_range: first === undefined || last === undefined ? null : { start: first.start, end: last.end },
    truncated: more || offset > 0,
    next_segment_offset: more ? nextOffset : null,
    truncation_note: more
      ? `全 ${all.length} 件の候補（粒度 ${granularity}）のうち ${offset} 件目から ${segments.length} 件だけを返した。` +
        `残り ${all.length - nextOffset} 件は read_source_segments に segment_offset=${nextOffset} を渡して読むこと。` +
        'このページの候補だけで本文を全部分類したことにはならない。'
      : null,
  }
}
