import { describe, expect, test } from 'vitest'
import { embedJson } from './embed-json.js'

const LINE_SEPARATOR = '\u2028'
const PARAGRAPH_SEPARATOR = '\u2029'

describe('embedJson', () => {
  test.each([
    { name: 'script の終了タグ', text: '本文に</script>が出てくる' },
    { name: '大文字の script 終了タグ', text: '</SCRIPT><img src=x>' },
    { name: 'HTML コメントの開始', text: '<!-- ここから隠す' },
    { name: 'HTML コメントの終了', text: '--> ここまで' },
    { name: 'アンパサンド', text: 'A&B &amp; C' },
    { name: 'U+2028 (行区切り)', text: `前${LINE_SEPARATOR}後` },
    { name: 'U+2029 (段落区切り)', text: `前${PARAGRAPH_SEPARATOR}後` },
  ])('$name を含む文字列は HTML を壊す生の文字を残さない', ({ text }) => {
    const embedded = embedJson({ text })
    expect(embedded).not.toContain('<')
    expect(embedded).not.toContain('>')
    expect(embedded).not.toContain('&')
    expect(embedded).not.toContain(LINE_SEPARATOR)
    expect(embedded).not.toContain(PARAGRAPH_SEPARATOR)
  })

  test.each([
    { name: 'script の終了タグ', text: '本文に</script>が出てくる' },
    { name: 'HTML コメント', text: '<!-- x --> & <div class="y">' },
    { name: 'U+2028 と U+2029', text: `a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c` },
    { name: '日本語と改行', text: '当期の売上は\n前年比 120% だった' },
    { name: '絵文字とサロゲートペア', text: '⚠️ 要確認 𩸽' },
  ])('$name は JSON.parse で元の文字列に戻る', ({ text }) => {
    expect(JSON.parse(embedJson({ text }))).toEqual({ text })
  })

  test('入れ子の構造もそのまま戻る', () => {
    const value = { a: [1, 2, { b: '</script>' }], c: null }
    expect(JSON.parse(embedJson(value))).toEqual(value)
  })

  test('JSON にできない値は黙って落とさず投げる', () => {
    expect(() => embedJson(undefined)).toThrow('JSON にできない値')
  })
})
