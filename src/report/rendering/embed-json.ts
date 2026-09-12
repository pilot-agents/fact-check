import { FactCheckError } from '../../errors.js'

/**
 * HTML の中に JSON をそのまま埋める（`<script type="application/json">` の中身にする）。
 *
 * 元ネタや証拠の本文には HTML や JavaScript の断片が普通に入る。`</script>` が本文に 1 回でも
 * 現れれば、そこで script 要素が閉じてブラウザは残りを本文として描き始め、ビューアは黙って壊れる。
 * JSON としては正しいので、埋め込む側が escape しない限り誰も気づけない。
 *
 * `<` を `<` にすれば `</script>` も `<!--` も文字列リテラルの中で無害になる。JSON の文法上
 * `\uXXXX` は元の文字と同じ値に読み戻るので、受け取る側の JSON.parse は元の文字列を復元する。
 * U+2028 / U+2029 は JSON では生のまま許されるが、JavaScript の字句解析では行終端子として扱われる
 * 版があるため合わせて escape する。
 */
export function embedJson(value: unknown): string {
  const json = JSON.stringify(value)
  if (json === undefined) {
    throw new FactCheckError(
      'JSON にできない値を HTML に埋め込もうとした (JSON.stringify が undefined を返した)',
    )
  }
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * embedJson で埋めた JSON を HTML から読み戻す。ビューアのブラウザ側と同じ手順を
 * TypeScript からも踏めるようにしてあり、埋め込みの壊れ方をテストで押さえるのに使う。
 */
export function readEmbeddedJson(html: string, id: string): unknown {
  const opening = `<script type="application/json" id="${id}">`
  const start = html.indexOf(opening)
  if (start === -1) throw new FactCheckError(`埋め込みデータが無い (id=${id})`)
  const from = start + opening.length
  const end = html.indexOf('</script>', from)
  if (end === -1) throw new FactCheckError(`埋め込みデータが閉じていない (id=${id})`)
  const raw = html.slice(from, end)
  try {
    return JSON.parse(raw)
  } catch (cause) {
    throw FactCheckError.fromCause(`埋め込みデータが JSON として読めない (id=${id})`, cause)
  }
}
