import ts from 'typescript'

/**
 * 生成した JavaScript の構文検査。**位置つきで**壊れ方を出す。
 *
 * なぜ要るか: ビューアの JS は TypeScript のテンプレート文字列として持っているので、
 * tsc も lint も中身を見ない。閉じ括弧を 1 つ落としたまま両方が通り、ブラウザで開いて
 * 初めて画面が真っ白になった。
 *
 * なぜブラウザの `pageerror` だけでは足りないか: 実測すると、インライン script の構文
 * エラーで飛んでくる Error は `Unexpected token ')'` の 1 行だけで、**stack が空**だった。
 * どの行かが分からない。パーサに掛ければ行と桁が出る。
 *
 * なぜ自前で括弧を数えないか: 正規表現リテラル・テンプレート文字列・文字列の中の括弧を
 * 数え間違える。既存依存の TypeScript のパーサに任せれば、その 3 つを正しく扱える。
 *
 * なぜ `createSourceFile` の `parseDiagnostics` でなく `transpileModule` か: 前者の
 * `parseDiagnostics` は公開の型に無く、内部の形へキャストしないと読めない。
 * `transpileModule` の `reportDiagnostics` は公開 API で、同じ入力に対して同じ診断
 * （同じ TS コード・同じ行桁）が出ることを実測で確かめてある。
 */
export function jsSyntaxDiagnostics(code: string, fileName: string): string[] {
  const output = ts.transpileModule(code, {
    reportDiagnostics: true,
    compilerOptions: { allowJs: true, target: ts.ScriptTarget.ES2015 },
    fileName,
  })
  return (output.diagnostics ?? []).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    if (diagnostic.file === undefined || diagnostic.start === undefined) {
      return `TS${diagnostic.code} (位置なし) ${message}`
    }
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    return `TS${diagnostic.code} ${fileName}:${position.line + 1}:${position.character + 1} ${message}`
  })
}

/**
 * 1 ファイルで完結する HTML から、最後のインライン `<script>`（描画コード本体）を取り出す。
 * 埋め込みデータの `<script type="application/json">` は属性付きなので拾わない。
 */
export function extractInlineScript(html: string): string | null {
  const marker = '<script>'
  const start = html.lastIndexOf(marker)
  if (start === -1) return null
  const end = html.indexOf('</script>', start)
  if (end === -1) return null
  return html.slice(start + marker.length, end)
}
