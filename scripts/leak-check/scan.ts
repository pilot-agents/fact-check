import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { type IgnoreRule, isIgnored, parseGitignore } from './gitignore.js'
import { isExempt, type LeakPattern, maskMatch } from './patterns.js'

/**
 * 走査。検査対象の集め方と、集めたテキストへのパターン当てを分けて持つ。
 *
 * 対象は 2 系統。(a) git のコミット対象になるファイル、(b) `npm pack` が実際にパッケージへ
 * 入れるファイル。片方だけでは足りない: `dist/` は gitignore されているのでパッケージにしか
 * 現れず、`pnpm-lock.yaml` はコミットされるがパッケージには入らない。
 *
 * 出力に入る値は、この層でもリポジトリの絶対パスを含めない（ルートからの相対パスだけを使う）。
 * 検査の出力が二次的な漏洩になるのを避けるため。
 */

const execFileAsync = promisify(execFile)

export type Finding = {
  /** リポジトリルートからの相対パス (posix) */
  file: string
  /** どちらの経路で公開されるか */
  channels: string[]
  /** 本文の何行目か (1 始まり)。ファイル名そのものへの一致なら null */
  line: number | null
  /** 1 始まり。ファイル名そのものへの一致なら null */
  column: number | null
  patternId: string
  patternLabel: string
  /** 一致した文字列。機微な部分はマスク済み */
  masked: string
}

export function scanText(file: string, text: string, patterns: readonly LeakPattern[]): Finding[] {
  const findings: Finding[] = []
  const lines = text.split('\n')
  lines.forEach((lineText, lineIndex) => {
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0
      for (let match = pattern.regex.exec(lineText); match !== null; match = pattern.regex.exec(lineText)) {
        if (!isExempt(pattern, match)) {
          findings.push({
            file,
            channels: [],
            line: lineIndex + 1,
            column: match.index + 1,
            patternId: pattern.id,
            patternLabel: pattern.label,
            masked: maskMatch(match),
          })
        }
        // 長さ 0 の一致で止まらないようにする。
        if (match.index === pattern.regex.lastIndex) pattern.regex.lastIndex += 1
      }
    }
  })
  return findings
}

/**
 * ファイル名そのものへの照合。本文が読めるかに関わらず（バイナリでも）必ず通す。
 * ファイル名は本文と同じだけ公開されるので、本文しか見ないと利用者名を含むファイル名を見逃す。
 */
export function scanPathName(file: string, patterns: readonly LeakPattern[]): Finding[] {
  return scanText(file, file, patterns).map((finding) => ({ ...finding, line: null, column: null }))
}

/** バイナリとみなす判定。NUL バイトを含むファイルはテキストとして読まない。 */
export function looksBinary(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8000)
  return head.includes(0)
}

/** 期待するパッケージの形から外れたファイル。1 件でもあれば公開してはいけない。 */
const MISPLACED_DIST_ENTRY = /^dist\/(?:src|e2e|scripts)\//
const SOURCE_MAP_ENTRY = /\.map$/

/**
 * パッケージの中身が期待する形になっているか。
 *
 * `tsconfig.build.json` の `rootDir` がずれると `dist/src/index.js` のような階層が出て、`bin` の
 * 指す `dist/index.js` が消える。ソースマップはローカルの絶対パスを埋め込むので公開しない。
 * どちらも「テストは通るのに公開物だけが壊れている」型の事故なので、中身の一覧で機械的に見る。
 */
export function findPackagingViolations(packedFiles: readonly string[]): string[] {
  const violations: string[] = []
  for (const file of packedFiles) {
    if (MISPLACED_DIST_ENTRY.test(file)) {
      violations.push(`${file} — dist/ の直下に出るはずの階層がずれている (tsconfig.build.json の rootDir)`)
      continue
    }
    if (SOURCE_MAP_ENTRY.test(file)) {
      violations.push(`${file} — ソースマップはローカルの絶対パスを含むので公開しない`)
    }
  }
  return violations
}

/** git がコミット対象にするファイル。ルートの `.gitignore` を適用し、`.git` 自体は見ない。 */
export async function collectVersionControlledFiles(repoRoot: string): Promise<string[]> {
  const rules = parseGitignore(await readGitignore(repoRoot))
  const files: string[] = []
  await walk(repoRoot, '', rules, files)
  return files.sort()
}

async function readGitignore(repoRoot: string): Promise<string> {
  try {
    return await readFile(path.join(repoRoot, '.gitignore'), 'utf8')
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    // 無いのは正常（除外規則ゼロ）。読めないのは検査対象が変わるので隠さず落とす。
    if (code === 'ENOENT') return ''
    throw new Error('リポジトリルートの .gitignore を読めない', { cause })
  }
}

async function walk(
  repoRoot: string,
  relative: string,
  rules: readonly IgnoreRule[],
  out: string[],
): Promise<void> {
  const absolute = relative === '' ? repoRoot : path.join(repoRoot, relative)
  const entries = await readdir(absolute, { withFileTypes: true })
  for (const entry of entries) {
    if (relative === '' && entry.name === '.git') continue
    const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`
    const isDirectory = entry.isDirectory()
    if (isIgnored(rules, childRelative, isDirectory)) continue
    if (isDirectory) {
      await walk(repoRoot, childRelative, rules, out)
      continue
    }
    if (entry.isFile()) out.push(childRelative)
  }
}

/**
 * `npm pack` が実際にパッケージへ入れるファイル。列挙は npm 自身にやらせる。
 *
 * `dist/` が無い状態でも `npm pack` は README などを返して成功するので、`bin` の指す
 * ファイルが一覧に無ければ落とす。そうしないと「ビルド前に検査して 0 件」で通ってしまう。
 */
export async function collectPackedFiles(repoRoot: string): Promise<string[]> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync('npm', ['pack', '--dry-run', '--json'], {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
    }))
  } catch (cause) {
    const stderr = (cause as { stderr?: string }).stderr ?? ''
    throw new Error(`npm pack --dry-run が失敗した${stderr === '' ? '' : `\n${stderr}`}`, { cause })
  }
  const parsed = JSON.parse(stdout) as Array<{ files?: Array<{ path?: unknown }> }>
  const files = parsed
    .flatMap((entry) => entry.files ?? [])
    .map((file) => file.path)
    .filter((file): file is string => typeof file === 'string')
  if (files.length === 0) {
    throw new Error(`npm pack --dry-run がファイルを 1 件も返さなかった: ${stdout}`)
  }
  const packed = [...new Set(files)].sort()
  const missingBins = (await declaredBinFiles(repoRoot)).filter((bin) => !packed.includes(bin))
  if (missingBins.length > 0) {
    throw new Error(
      `npm pack の一覧に package.json の bin (${missingBins.join(', ')}) が無い。` +
        '先に pnpm build を実行してから検査する（ビルド前だと公開物の大部分を検査せずに通ってしまう）',
    )
  }
  return packed
}

/** `package.json` の `bin` が指すパッケージ内のパス。 */
async function declaredBinFiles(repoRoot: string): Promise<string[]> {
  const raw = await readFile(path.join(repoRoot, 'package.json'), 'utf8')
  const bin = (JSON.parse(raw) as { bin?: unknown }).bin
  if (typeof bin === 'string') return [normalizePackedPath(bin)]
  if (typeof bin === 'object' && bin !== null) {
    return Object.values(bin)
      .filter((value): value is string => typeof value === 'string')
      .map(normalizePackedPath)
  }
  return []
}

/** `npm pack --json` が返す形（`./` なし・posix 区切り）に揃える。 */
function normalizePackedPath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '')
}
