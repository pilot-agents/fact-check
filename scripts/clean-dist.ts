import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ビルドの前に `dist/` を消す。
 *
 * tsc は出力を上書きするだけなので、消さないと前のビルドの残骸が居座る。ソースから消した
 * ファイルや、`rootDir` を直す前に出た `dist/src/...` のような階層がそのまま残り、
 * 「手元では通るのに公開物には余計なものが入っている」状態になる。公開物の中身を
 * ビルドの結果だけで決めるために、毎回まっさらにしてから作る。
 *
 * OS 非依存にするため、シェルの `rm -rf` は使わない。
 */

async function main(): Promise<void> {
  const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
  const dist = path.join(repoRoot, 'dist')
  await rm(dist, { recursive: true, force: true })
  process.stdout.write(`ビルド前に消した: ${path.relative(repoRoot, dist)}\n`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
