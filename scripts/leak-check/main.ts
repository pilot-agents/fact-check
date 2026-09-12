import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinPatterns, denylistPatterns, type LeakPattern } from './patterns.js'
import {
  collectPackedFiles,
  collectVersionControlledFiles,
  type Finding,
  findPackagingViolations,
  looksBinary,
  scanPathName,
  scanText,
} from './scan.js'

/**
 * `pnpm check:leaks` の本体。
 *
 * 公開物（git のコミット対象 + npm パッケージの中身）に、ローカルの絶対パス・メールアドレス・
 * 実行しているマシンの利用者名、そしてリポジトリ外に置いた禁止語リストの語が混ざっていないかを
 * 機械的に確かめる。1 件でも見つかれば終了コード 1。
 *
 * 見つけたものは行番号まで出すが、当たった文字列はマスクして出す。検査の出力自体が
 * ログに残って二次的な漏洩になるのを避けるため。禁止語リストの置き場所も同じ理由で
 * 絶対パスを出さず、ファイル名だけを出す。
 *
 * 「検査していないのに通る」経路を作らないことを最優先にする。具体的には
 * (a) 使ったパターンの id を必ず全部出す、(b) 使えなかったパターンは理由を出す、
 * (c) 本文を読めなかったファイル（バイナリ）は許可リストに無ければ失敗させる、
 * (d) 公開経路では外部の禁止語リストが無いことを失敗にする（厳格モード）。
 */

/** リポジトリ外の禁止語リストの置き場所を渡す環境変数。 */
const DENYLIST_ENV = 'FACT_CHECK_LEAK_DENYLIST'
/** 厳格モードを環境変数で入れるときの名前。`1` のときだけ有効。 */
const STRICT_ENV = 'FACT_CHECK_LEAK_STRICT'
/** 本文を検査できないまま公開してよいファイルの許可リスト（カンマ区切りの相対パス）。 */
const ALLOW_BINARY_ENV = 'FACT_CHECK_LEAK_ALLOW_BINARY'
/** 厳格モードのフラグ。 */
const REQUIRE_DENYLIST_FLAG = '--require-denylist'

/** 実行しているマシンの利用者名が入り得る環境変数。先に見つかった非空の値を使う。 */
const USER_ENV_NAMES = ['USER', 'USERNAME', 'LOGNAME'] as const

const CHANNEL_GIT = 'git'
const CHANNEL_NPM = 'npm'

function out(message: string): void {
  process.stdout.write(`${message}\n`)
}

/** 厳格モードか。知らない引数は黙って捨てず落とす（フラグの綴り間違いで検査が緩むのを防ぐ）。 */
function isStrict(argv: readonly string[]): boolean {
  const unknown = argv.filter((arg) => arg !== REQUIRE_DENYLIST_FLAG)
  if (unknown.length > 0) {
    throw new Error(`知らない引数: ${unknown.join(' ')}（使えるのは ${REQUIRE_DENYLIST_FLAG} だけ）`)
  }
  return argv.includes(REQUIRE_DENYLIST_FLAG) || process.env[STRICT_ENV] === '1'
}

function machineUserName(): string | undefined {
  for (const name of USER_ENV_NAMES) {
    const value = process.env[name]
    if (value !== undefined && value.trim() !== '') return value
  }
  return undefined
}

async function loadDenylistPatterns(strict: boolean): Promise<LeakPattern[]> {
  const configured = process.env[DENYLIST_ENV]
  if (configured === undefined || configured.trim() === '') {
    if (strict) {
      throw new Error(
        `${DENYLIST_ENV} が未設定。${REQUIRE_DENYLIST_FLAG} を付けた検査は、` +
          '外部の禁止語リストを読まずに通してはいけない',
      )
    }
    out(`  外部の禁止語リスト: ${DENYLIST_ENV} が未設定のため、組み込みパターンだけで走る`)
    return []
  }
  const listPath = path.resolve(configured.trim())
  // 置き場所そのものがローカルのホームパスなので、出力にはファイル名だけを出す。
  const listName = path.basename(listPath)
  let content: string
  try {
    content = await readFile(listPath, 'utf8')
  } catch (cause) {
    // 設定されているのに読めないのは「検査したつもり」になる最悪の失敗なので、必ず落とす。
    throw new Error(`${DENYLIST_ENV} に指定された禁止語リストを読めない (${listName})`, { cause })
  }
  const patterns = denylistPatterns(content, listName)
  if (patterns.length === 0) {
    if (strict) {
      throw new Error(
        `${DENYLIST_ENV} に指定された禁止語リスト (${listName}) に語が 1 つも無い。` +
          `${REQUIRE_DENYLIST_FLAG} を付けた検査は、空のリストで通してはいけない`,
      )
    }
    out(`  外部の禁止語リスト: ${listName} は語が 0 件だった`)
    return []
  }
  out(`  外部の禁止語リスト: ${listName} から ${patterns.length} 語`)
  return patterns
}

/** 本文を検査できないまま通してよいファイル。 */
function allowedBinaryFiles(): Set<string> {
  const configured = process.env[ALLOW_BINARY_ENV] ?? ''
  return new Set(
    configured
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  )
}

type Target = { file: string; channels: string[] }

function mergeTargets(gitFiles: readonly string[], packedFiles: readonly string[]): Target[] {
  const byFile = new Map<string, string[]>()
  for (const file of gitFiles) byFile.set(file, [CHANNEL_GIT])
  for (const file of packedFiles) {
    const existing = byFile.get(file)
    if (existing === undefined) byFile.set(file, [CHANNEL_NPM])
    else existing.push(CHANNEL_NPM)
  }
  return [...byFile.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([file, channels]) => ({ file, channels }))
}

/** 一致箇所の出どころ。本文なら行と桁、ファイル名そのものなら「ファイル名」と分かる形で出す。 */
function locationOf(finding: Finding): string {
  if (finding.line === null) return `${finding.file} [ファイル名]`
  return `${finding.file}:${finding.line}:${finding.column}`
}

async function main(): Promise<void> {
  const strict = isStrict(process.argv.slice(2))
  const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
  out('check:leaks — 公開物の混入検査')
  out(
    strict
      ? `  モード: 厳格 (${REQUIRE_DENYLIST_FLAG}) — 外部の禁止語リストが無ければ失敗させる`
      : `  モード: 通常 — 外部の禁止語リストは任意（公開経路では ${REQUIRE_DENYLIST_FLAG} を付ける）`,
  )

  const builtin = builtinPatterns({ user: machineUserName(), home: process.env.HOME })
  const patterns = [...builtin.patterns, ...(await loadDenylistPatterns(strict))]
  out(`  照合に使うパターン ${patterns.length} 件: ${patterns.map((pattern) => pattern.id).join(', ')}`)
  for (const skipped of builtin.skipped) {
    out(`  使わなかったパターン ${skipped.id}: ${skipped.reason}`)
  }

  const [gitFiles, packedFiles] = await Promise.all([
    collectVersionControlledFiles(repoRoot),
    collectPackedFiles(repoRoot),
  ])
  const targets = mergeTargets(gitFiles, packedFiles)
  out(
    `  検査対象: git のコミット対象 ${gitFiles.length} ファイル / npm パッケージ ${packedFiles.length} ファイル` +
      `（重複を除いて ${targets.length} ファイル）`,
  )

  const findings: Finding[] = []
  const binaryFiles: string[] = []
  for (const target of targets) {
    // ファイル名は本文と同じだけ公開される。本文が読めるかに関わらず必ず照合する。
    for (const finding of scanPathName(target.file, patterns)) {
      findings.push({ ...finding, channels: target.channels })
    }
    const bytes = await readFile(path.join(repoRoot, target.file))
    if (looksBinary(bytes)) {
      binaryFiles.push(target.file)
      continue
    }
    for (const finding of scanText(target.file, bytes.toString('utf8'), patterns)) {
      findings.push({ ...finding, channels: target.channels })
    }
  }
  if (binaryFiles.length > 0) {
    out(`  バイナリとして本文を読まなかったファイル ${binaryFiles.length} 件: ${binaryFiles.join(', ')}`)
  }

  let failed = false

  const violations = findPackagingViolations(packedFiles)
  if (violations.length > 0) {
    out(`パッケージの形が期待と違う: ${violations.length} 件`)
    for (const violation of violations) out(`  ${violation}`)
    failed = true
  }

  const allowed = allowedBinaryFiles()
  const unexaminedBinary = binaryFiles.filter((file) => !allowed.has(file))
  if (unexaminedBinary.length > 0) {
    out(`本文を検査できなかったファイル: ${unexaminedBinary.length} 件`)
    for (const file of unexaminedBinary) out(`  ${file}`)
    out(`  本文を読まずに公開してよいと判断したものは ${ALLOW_BINARY_ENV} にカンマ区切りで並べる`)
    failed = true
  }

  if (findings.length === 0) {
    out('検出: 0 件')
  } else {
    out(`検出: ${findings.length} 件`)
    for (const finding of findings) {
      out(
        `  ${locationOf(finding)} [${finding.channels.join('+')}] ` +
          `${finding.patternLabel} — ${finding.masked}`,
      )
    }
    failed = true
  }

  if (failed) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
