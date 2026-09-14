#!/usr/bin/env node
import path from 'node:path'
import { closeBrowser } from '../browser/browser-pool.js'
import { describeCause } from '../errors.js'
import { EXPORT_FORMATS, type ExportFormat, exportReport } from './export-report.js'

/**
 * `pnpm report:export <session_dir> <output_path>` の入口。
 * セッションディレクトリのレポートを、画像ごと 1 ファイルにして持ち出す（MCP の export_report と同じ本体）。
 * 形式は出力先の拡張子で決める（.html / .htm → html、.pdf → pdf）。
 */

const USAGE = [
  '使い方: pnpm report:export <session_dir> <output_path> [--overwrite]',
  '  <session_dir>  ledger.json があるセッションディレクトリ',
  '  <output_path>  書き出す先。拡張子で形式を決める（.html / .htm → html、.pdf → pdf）',
  '  --overwrite    既にあるファイルを置き換える',
  '  例: pnpm report:export .fact-check/fc_20260101T000000_deadbeef ~/Desktop/fact-check.pdf',
].join('\n')

const EXTENSION_TO_FORMAT: Record<string, ExportFormat> = { '.html': 'html', '.htm': 'html', '.pdf': 'pdf' }

type ParsedArgs = { sessionDirectory: string; outputPath: string; overwrite: boolean }

/** 引数の読み取り。知らないフラグは黙って捨てず、使い方を出して止める。 */
function parseArgs(argv: readonly string[]): ParsedArgs | null {
  const flags = argv.filter((arg) => arg.startsWith('-'))
  const positional = argv.filter((arg) => !arg.startsWith('-'))
  const unknown = flags.filter((flag) => flag !== '--overwrite')
  if (unknown.length > 0 || positional.length !== 2) return null
  const [sessionDirectory, outputPath] = positional
  if (sessionDirectory === undefined || outputPath === undefined) return null
  return { sessionDirectory, outputPath, overwrite: flags.includes('--overwrite') }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed === null) {
    process.stderr.write(`${USAGE}\n`)
    process.exitCode = 1
    return
  }
  const outputPath = path.resolve(parsed.outputPath)
  const format = EXTENSION_TO_FORMAT[path.extname(outputPath).toLowerCase()]
  if (format === undefined) {
    process.stderr.write(
      `出力先の拡張子から形式を決められない (path=${outputPath})。使えるのは ${Object.keys(EXTENSION_TO_FORMAT).join(' / ')}（形式: ${EXPORT_FORMATS.join(' / ')}）\n`,
    )
    process.exitCode = 1
    return
  }
  // 本体は「保存先 + session_id」でセッションを引く（MCP ツールと同じ経路）。
  // ディレクトリで受けた指定をその形に直す。session_id の形式検査は本体側にある。
  const sessionDirectory = path.resolve(parsed.sessionDirectory)
  process.env.FACT_CHECK_DIR = path.dirname(sessionDirectory)
  try {
    const result = await exportReport({
      sessionId: path.basename(sessionDirectory),
      format,
      outputPath,
      overwrite: parsed.overwrite,
    })
    process.stdout.write(
      [
        `${result.format} を書き出した: ${result.path} (${result.bytes} バイト, 画像 ${result.inlined_images} 件を埋め込み)`,
        result.reports_stale_since === null
          ? ''
          : `  注意: この内容は finalize の検証を通していない暫定のもの（台帳が変わった時刻: ${result.reports_stale_since}）`,
        '',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    )
  } finally {
    await closeBrowser()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`report:export が失敗した: ${describeCause(error)}\n`)
  if (error instanceof Error && error.stack !== undefined) process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
