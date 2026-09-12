import { describe, expect, test } from 'vitest'
import { segmentSource } from './segments.js'

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
]

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
})
