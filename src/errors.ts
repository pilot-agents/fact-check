import { inspect } from 'node:util'

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

  /**
   * 元の例外を `cause` に残したまま、その説明をメッセージへ畳み込む。
   *
   * メッセージと `cause` に同じ文字列が二重に出る。畳み込みをやめれば重複は消えるが、
   * MCP 越しに届くのはメッセージだけなので、呼び出した AI から原因が消える。逆に
   * `cause` を捨てれば重複は消えるが、プロセス内で cause チェーンを辿る側の情報が消える。
   * どちらも「別の経路で読む人が持っていた情報」を捨てる取引なので、重複を選ぶ。
   */
  static fromCause(context: string, cause: unknown): FactCheckError {
    return new FactCheckError(`${context}: ${describeCause(cause)}`, { cause })
  }
}

/**
 * 失敗を人が読める文字列にする。**このサーバーで失敗を文字列化する唯一の場所**。
 *
 * 中身は Node 標準の `util.inspect` に任せる。自前で組み立てていた頃は
 * `JSON.stringify` に落ちる経路があり、循環した cause で RangeError、BigInt と循環
 * オブジェクトで TypeError を投げ、`undefined` / Symbol / 関数では戻り値の型が
 * 実行時に破れていた（いずれも実測）。
 *
 * **inspect が失敗したときは投げる。** この関数は catch の中から呼ばれるので、
 * 投げれば呼び出し側の記録が別の例外に化ける。それでも投げるのは、代わりに型名だけの
 * 文字列を返すと**説明できなかった値そのものと、失敗した理由の両方が消える**ため。
 * 投げる例外は `AggregateError` で、`errors[0]` に元の値、`errors[1]` に記述の失敗を
 * 値のまま入れてある。呼び出し側は少なくとも両方を辿れる。
 * 実測した入力（取り消した Proxy を cause に持つ Error）でこの経路が起きることを確認している。
 *
 * inspect に渡すオプションの意味（すべて呼び出し回数を数えて実測してある）:
 * - `depth` / `maxArrayLength` / `maxStringLength` を外す — 情報を黙って切らない。
 *   代償として、cause が 2000 段あるような入力では出力が数 MB になる（実測 4.29 MB）。
 *   切り詰めた事実を書ける場所が無い以上、切るより長いほうを選ぶ。
 * - `getters: false` — **ふつうのプロパティの** getter を呼ばない（実測 0 回）。
 * - `customInspect: false` — 値が持つ inspect ハンドラを呼ばない（実測 0 回）。
 * - `showHidden: true` — 非 enumerable なプロパティも出す。これが無いと、
 *   `Object.defineProperty` で足した `code` / `details` が**黙って消える**（実測）。
 * - `showProxy: true` — Proxy を「対象 + ハンドラ」として出す。これが無いと、
 *   `ownKeys` が投げる Proxy が `{}` になり、**空のオブジェクトと見分けが付かない**（実測）。
 *
 * 循環は inspect が `<ref *1>` / `[Circular *1]` として明示する。AggregateError の
 * `errors` は全件出る。stack も落とさない（旧実装は落としていた）。
 *
 * **満たせていないこと（実測に基づく。既知の制約として残す）**: Node の Error 整形は
 * `name` / `message` / `stack` を読むので、これらが getter なら**呼ばれる**。
 * オブジェクト整形は `Symbol.toStringTag` を読む。回数は値の形と `showHidden` の有無で変わり、
 * このオプションでは実測で message 2 回・name 2 回・stack 1 回・toStringTag 1 回だった
 * （`src/errors.test.ts` が回数ごと固定している）。`getters: false` が止めるのはそれ以外の
 * プロパティで、この 4 つは止まらない。完全に止めるには記述子だけを読む自前の直列化が要るが、
 * それは「手書きの万能 serializer を増やさない」方針と衝突するので採っていない。
 * Proxy の trap と custom inspector は呼ばれない（実測 0 回）。
 */
const INSPECT_OPTIONS = {
  depth: Number.POSITIVE_INFINITY,
  maxArrayLength: Number.POSITIVE_INFINITY,
  maxStringLength: Number.POSITIVE_INFINITY,
  breakLength: 120,
  customInspect: false,
  getters: false,
  showHidden: true,
  showProxy: true,
  colors: false,
  compact: false,
} as const

/**
 * `name` か `message` を読み出せない Error に対して inspect が返す値の頭。
 * `showHidden` を付けてあるので、後ろにプロパティ記述子（`[message]: [Getter]` など）が続く。
 * 何が起きたのかを 1 行足す（読み手が「空のオブジェクトが来た」と誤解しないため）。
 */
const UNREADABLE_ERROR_PREFIX = '[object Error]'
const UNREADABLE_NOTE =
  '\n（この Error は name か message を読み出せない。Node の Error 整形はこの 2 つを読むので' +
  ' getter は呼ばれており、その呼び出しが失敗した。読める範囲の記述子は上に出ている）'

export function describeCause(cause: unknown): string {
  // 文字列はそのまま返す。throw された文字列を引用符で包み直しても読みやすくならない。
  if (typeof cause === 'string') return cause
  let described: string
  try {
    described = inspect(cause, INSPECT_OPTIONS)
  } catch (failure) {
    // **代替の文字列を返さない。** 型名だけを返していた頃は、記述できなかった値の中身も、
    // 記述が失敗した理由も、そこで消えていた（「必ず string を返す」を優先した結果）。
    // 原因を捨てないほうを優先し、**元の値と失敗の両方を値のまま持って**投げ直す。
    // ここで元の値を文字列にしようとすると同じ失敗を繰り返すので、何も触らずに包む。
    throw new AggregateError(
      [cause, failure],
      '失敗の説明を組み立てられなかった。errors[0] が説明できなかった元の値、' +
        'errors[1] が説明を組み立てるときに起きた失敗（どちらも値のまま保持している）',
    )
  }
  return described.startsWith(UNREADABLE_ERROR_PREFIX) ? `${described}${UNREADABLE_NOTE}` : described
}
