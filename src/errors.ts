/**
 * 共有契約: このサーバーが投げる唯一の例外型。
 *
 * なぜ 1 種類か: MCP のツール応答はエラーを 1 本の文字列に潰す。種類で分岐する側が
 * 居ない以上、型を増やしても情報は増えない。増やすべきなのは「どの入力の、どの操作が、
 * なぜ失敗したか」というメッセージ本文の情報量のほう。
 *
 * 外部（HTTP・ブラウザ・ファイルシステム）起因の失敗は `fromCause` で作る。元の例外は
 * `cause` に残したうえで、その本文をメッセージにも畳み込む（MCP 越しには cause チェーン
 * が伝わらないため、畳み込まないと呼び出した AI からは原因が消える）。
 */
export class FactCheckError extends Error {
  override name = 'FactCheckError'

  static fromCause(context: string, cause: unknown): FactCheckError {
    return new FactCheckError(`${context}: ${describeCause(cause)}`, { cause })
  }
}

/** 例外でない値が throw されることもあるため、型を問わず読める形にして返す。 */
export function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const nested = cause.cause === undefined ? '' : ` (cause: ${describeCause(cause.cause)})`
    return `${cause.name}: ${cause.message}${nested}`
  }
  return typeof cause === 'string' ? cause : JSON.stringify(cause)
}
