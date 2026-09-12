#!/usr/bin/env node
import { describeCause } from '../errors.js'
import { rebuildReportHtml } from './rebuild.js'

/**
 * `pnpm report:rebuild <session_dir>` の入口。
 * 過去のセッションの report.html を、今のビューアで作り直す（report.md / report.json は触らない）。
 */

const USAGE = [
  '使い方: pnpm report:rebuild <session_dir>',
  '  <session_dir> は report.json と source.txt があるセッションディレクトリ',
  '  例: pnpm report:rebuild .fact-check/fc_20260101T000000_deadbeef',
].join('\n')

async function main(): Promise<void> {
  const target = process.argv[2]
  if (target === undefined || target === '' || target.startsWith('-')) {
    process.stderr.write(`${USAGE}\n`)
    process.exitCode = 1
    return
  }
  const result = await rebuildReportHtml(target)
  const claims = result.summary.claims
  process.stdout.write(
    [
      `report.html を作り直した: ${result.htmlPath}`,
      `  セッション: ${result.sessionId} (台帳 version ${result.ledgerVersion})`,
      `  網羅率: ${result.summary.coverage.percent} / 主張 ${claims.total} 件` +
        ` (矛盾 ${claims.contradicted} / 一部 ${claims.partially_verified} / 不能 ${claims.unverifiable}` +
        ` / 済 ${claims.verified} / 未判定 ${claims.without_verdict})`,
      result.evidenceWithoutDiscovery > 0
        ? `  出どころの記録が無い証拠が ${result.evidenceWithoutDiscovery} 件ある（旧版の台帳。ビューアには「旧版のため未記録」と出る）`
        : '',
      '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  )
}

main().catch((error: unknown) => {
  process.stderr.write(`report:rebuild が失敗した: ${describeCause(error)}\n`)
  if (error instanceof Error && error.stack !== undefined) process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
