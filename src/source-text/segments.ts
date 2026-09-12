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

export function segmentSource(text: string): SourceSegment[] {
  const segments: SourceSegment[] = []
  const blocks = splitTiling(text, 0, BLANK_LINE_RUN)
  blocks.forEach((block, blockIndex) => {
    for (const span of splitTiling(text.slice(block.start, block.end), block.start, SENTENCE_END)) {
      segments.push({
        index: segments.length,
        block: blockIndex,
        start: span.start,
        end: span.end,
        text: text.slice(span.start, span.end),
      })
    }
  })
  return segments
}
