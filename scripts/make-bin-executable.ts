import { chmod } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ビルド後に bin へ実行権限を付ける。
 *
 * shebang はソースの先頭にあり tsc がそのまま出力に残すが、権限までは面倒を見ない。npm は
 * インストール時に bin へ実行権限を付けるので `npx` 経由では動くが、tarball の中身が 644 のままだと
 * 「リポジトリで直接 `./dist/index.js` を叩くと動かない」という差が出る。ビルドの一部として揃える。
 */

const BIN_MODE = 0o755

async function main(): Promise<void> {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
  const bin = path.join(root, 'dist', 'index.js')
  await chmod(bin, BIN_MODE)
  process.stdout.write(`bin に実行権限を付けた: ${path.relative(root, bin)} (mode=${BIN_MODE.toString(8)})\n`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
