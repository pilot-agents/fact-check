#!/usr/bin/env node
import { describeCause, FactCheckError } from '../errors.js'
import { resolveBaseDir } from '../session/ledger-store.js'
import { startViewerServer } from './server.js'

/**
 * `pnpm viewer` の入口。URL を出すだけで、ブラウザは自分では開かない
 * （どのブラウザで開くかは読み手が決めることなので、勝手に起動しない）。
 */

const USAGE = [
  '使い方: pnpm viewer [--port <番号>]',
  '  FACT_CHECK_DIR（未設定なら <cwd>/.fact-check）配下のセッションを一覧するローカルサーバーを起動する',
  '  --port を省いたときは空いているポートを使う',
].join('\n')

function parsePort(argv: readonly string[]): number {
  const index = argv.indexOf('--port')
  if (index === -1) return 0
  const raw = argv[index + 1]
  if (raw === undefined) throw new FactCheckError('--port に番号が無い')
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new FactCheckError(`--port が番号として読めない (--port ${raw})`)
  }
  return port
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  const baseDir = resolveBaseDir()
  const server = await startViewerServer({ baseDir, port: parsePort(argv) })
  process.stdout.write(
    [`セッション一覧: ${server.url}`, `保存先: ${baseDir}`, '終了するには Ctrl-C を押す。', ''].join('\n'),
  )
  const shutdown = (): void => {
    void server.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error: unknown) => {
  process.stderr.write(`pnpm viewer が起動できなかった: ${describeCause(error)}\n${USAGE}\n`)
  process.exitCode = 1
})
