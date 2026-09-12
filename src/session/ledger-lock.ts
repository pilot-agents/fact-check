/**
 * セッションごとの直列化。
 *
 * なぜ要るか: MCP クライアント（AI）はツール呼び出しを **1 回のターンでまとめて** 送ってくる
 * （実運用で 60 件以上が 1 度に来た）。台帳は「読む → 変える → 書き戻す」で更新するので、
 * この間に別の呼び出しが割り込むと、後から書いた側が先の変更を丸ごと消す。消えても例外は出ず、
 * 「登録したはずの claim が台帳に無い」という気づけない欠落になる。
 *
 * プロセスをまたぐロックは持たない。1 セッションを複数プロセスから同時に更新する使い方は
 * 想定しない（MCP サーバーはクライアントごとに 1 プロセス）。ここで守るのは同一プロセス内の
 * 並行実行だけ。
 */

/** セッション ID ごとの「最後に積んだ仕事」。次の仕事はこれの完了を待ってから走る。 */
const tails = new Map<string, Promise<unknown>>()

export async function withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(sessionId) ?? Promise.resolve()
  // 前の仕事の失敗はその呼び出し元に返っている。ここで握り潰しているのは「待ち合わせ用の複製」だけで、
  // 失敗そのものを消しているわけではない（消すと後続が永久に走らなくなる）。
  const started = previous.then(task, task)
  tails.set(
    sessionId,
    started.catch(() => undefined),
  )
  try {
    return await started
  } finally {
    // 自分が最後尾なら地図から消す。セッションが増え続けても Map が太らないようにする。
    if (tails.get(sessionId) === started) tails.delete(sessionId)
  }
}
