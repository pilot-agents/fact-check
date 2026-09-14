import path from 'node:path'
import { FactCheckError } from '../../errors.js'
import type { AttachmentLike } from '../../session/ledger-like.js'
import { fileExists, readSessionBytes, sessionDir } from '../../session/ledger-store.js'

/**
 * セッションの外へ持ち出す HTML のために、画像を data URI にして持たせる。
 *
 * report.html は画像をセッションディレクトリからの相対パスで参照する（ディレクトリごと渡せば
 * file:// で開ける、という設計）。単体で持ち出す HTML や PDF ではその前提が無いので、
 * 画像の中身そのものを持たせる。
 *
 * 台帳の `screenshot_path` は**書き換えない**。写像（相対パス → data URI）を別に持ち、
 * ビューアが `img.src` を組むときだけ引く。パスを data URI に書き換えると、report.json との
 * 照合と「読み込めなかった画像のパス」の表示が両方壊れる。
 *
 * 埋め込むのは `<img>` に出る `screenshot_path` だけ。`screenshot_attempts[].path` は
 * ビューアが文字列として出すだけで画像にはしないので、持たせない。取り消し済みの添付も
 * 対象にする（取り消し履歴から辿れる以上、そこだけ画像が切れる形にしない）。
 */

/** 相対パス → data URI。空なら「相対パスのまま参照する」の意味。 */
export type InlineAssets = Record<string, string>

/** 保存する画像は PNG だけ。他の拡張子が出たら、推測で MIME を付けずに落とす。 */
const MIME_BY_EXTENSION: Record<string, string> = { '.png': 'image/png' }

/**
 * 埋め込み対象の相対パス。台帳に出た順で、同じパスは 1 回。
 * 順序を保つのは、失敗したときに「何件目のどれか」を台帳と突き合わせられるようにするため。
 */
export function screenshotPathsOf(attachments: readonly AttachmentLike[]): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const attachment of attachments) {
    const relativePath = attachment.screenshot_path
    if (relativePath === null || seen.has(relativePath)) continue
    seen.add(relativePath)
    paths.push(relativePath)
  }
  return paths
}

/** ファイルの中身を data URI にする。MIME はここ 1 箇所で決める。 */
export function toDataUri(relativePath: string, bytes: Uint8Array): string {
  const extension = path.posix.extname(relativePath).toLowerCase()
  const mime = MIME_BY_EXTENSION[extension]
  if (mime === undefined) {
    throw new FactCheckError(
      `画像の種類が分からないので埋め込めない (path=${relativePath}, 拡張子=${JSON.stringify(extension)}, ` +
        `扱えるのは ${Object.keys(MIME_BY_EXTENSION).join(', ')})`,
    )
  }
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * 添付の画像を全部読んで data URI にする。
 *
 * **欠けている画像は全件集めてから拒否する。** 1 件ずつ落とすと、1 つ直すたびに呼び直させる
 * ことになる（finalize の拒否と同じ考え）。欠けたまま黙って書き出すと、持ち出した先で
 * 「画像を読み込めませんでした」だけが残り、ここで分かったはずの原因が消える。
 */
export async function inlineScreenshots(
  sessionId: string,
  attachments: readonly AttachmentLike[],
): Promise<InlineAssets> {
  const paths = screenshotPathsOf(attachments)
  const missing: string[] = []
  for (const relativePath of paths) {
    if (!(await fileExists(path.join(sessionDir(sessionId), relativePath)))) missing.push(relativePath)
  }
  if (missing.length > 0) {
    throw new FactCheckError(
      `台帳が参照する画像が ${missing.length} 件見つからない (session_id=${sessionId}, dir=${sessionDir(sessionId)}): ` +
        missing.join(', ') +
        '。画像を元の場所に戻すか、対応する添付を revise_record で取り消してから呼び直すこと',
    )
  }
  const assets: InlineAssets = {}
  for (const relativePath of paths) {
    assets[relativePath] = toDataUri(relativePath, await readSessionBytes(sessionId, relativePath))
  }
  return assets
}
