import { execFile } from 'node:child_process'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { buildSamplePdf } from './fixtures/build-sample-pdf.js'

/**
 * 「npm から入れたときに動くか」だけを見る end-to-end 検証。
 *
 * 通常の e2e（run-e2e.ts）はリポジトリの dist をそのまま起動するので、パッケージに入れ忘れた
 * ファイル・devDependency への実行時依存・npm の平坦な node_modules でのパス解決といった
 * 「公開して初めて壊れる」種類の失敗を 1 つも捕まえられない。ここでは npm pack で作った
 * tarball を空のディレクトリへ入れ直し、そこの bin だけを使って確かめる。
 *
 * 外部サイトには一切アクセスしない。証拠はローカルの HTTP サーバーとローカルファイルだけ。
 */

const execFileAsync = promisify(execFile)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const WORK_DIR = path.join(HERE, 'tmp', 'package-e2e')
const INSTALL_DIR = path.join(WORK_DIR, 'consumer')
const FACT_CHECK_DIR = path.join(WORK_DIR, 'sessions')
/** 空のままにしておくディレクトリ。ここを見に行かせて「ブラウザ未インストール」を作る。 */
const EMPTY_BROWSERS_DIR = path.join(WORK_DIR, 'no-browsers')

const EXPECTED_TOOLS = [
  'attach_evidence',
  'fetch_evidence',
  'finalize',
  'get_status',
  'mark_non_claim',
  'register_claim',
  'register_segments',
  'set_verdict',
  'start_session',
  'submit_agent_capture',
]

/** ブラウザ段階に落とすための、本文が短いページ。HTTP 取得の足切りに届かない長さにしてある。 */
const SHORT_PAGE =
  '<!doctype html><meta charset="utf-8"><title>短いページ</title><body><p>本文はここだけ。</p></body>'

/** 証拠にする PDF。文面は架空で、実在の組織とは関係しない。 */
const PDF_PAGES = [['Fictional Filing', 'The overseas shipment totalled 412 units in the quarter.']]

const SOURCE_TEXT = '海外向けの出荷は412台だった。'

let failures = 0

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

function check(label: string, condition: boolean, detail: string): void {
  if (condition) {
    log(`  [OK] ${label} — ${detail}`)
    return
  }
  failures += 1
  log(`  [NG] ${label} — ${detail}`)
}

type ToolOutcome = { ok: boolean; text: string; data: Record<string, unknown> }

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text: string }>
  const text = content.map((part) => part.text).join('\n')
  const ok = result.isError !== true
  return { ok, text, data: ok ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

async function run(command: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 })
    return stdout
  } catch (cause) {
    const stderr = (cause as { stderr?: string }).stderr ?? ''
    throw new Error(
      `${command} ${args.join(' ')} が失敗した (cwd=${cwd})${stderr === '' ? '' : `\n${stderr}`}`,
      { cause },
    )
  }
}

/** tarball を作り、空のディレクトリへ npm install する。戻り値はそこの bin のパス。 */
async function installFromTarball(): Promise<string> {
  const stdout = await run('npm', ['pack', '--json', '--pack-destination', WORK_DIR], ROOT)
  const packed = JSON.parse(stdout) as Array<{ filename?: unknown }>
  const filename = packed[0]?.filename
  if (typeof filename !== 'string') throw new Error(`npm pack の出力から tarball 名が読めない: ${stdout}`)
  const tarball = path.join(WORK_DIR, filename)
  log(`  tarball: ${path.relative(ROOT, tarball)}`)

  await mkdir(INSTALL_DIR, { recursive: true })
  await writeFile(
    path.join(INSTALL_DIR, 'package.json'),
    `${JSON.stringify({ name: 'fact-check-consumer', version: '1.0.0', private: true, type: 'module' }, null, 2)}\n`,
  )
  await run('npm', ['install', '--no-audit', '--no-fund', tarball], INSTALL_DIR)
  return path.join(INSTALL_DIR, 'node_modules', '.bin', 'fact-check-mcp')
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function startFixtureServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url === '/short') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(SHORT_PAGE)
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('固定ページ配信サーバーの待受アドレスが取れない')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  }
}

async function connect(bin: string, env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: bin,
    args: [],
    env: { ...process.env, FACT_CHECK_DIR, ...env } as Record<string, string>,
    stderr: 'inherit',
  })
  const client = new Client({ name: 'fact-check-package-e2e', version: '0.1.0' })
  await client.connect(transport)
  return client
}

async function main(): Promise<void> {
  await rm(WORK_DIR, { recursive: true, force: true })
  await mkdir(FACT_CHECK_DIR, { recursive: true })
  await mkdir(EMPTY_BROWSERS_DIR, { recursive: true })

  log('[1] npm pack した tarball を空のディレクトリへ入れる')
  const bin = await installFromTarball()
  check('インストール先に bin がある', await exists(bin), path.relative(ROOT, bin))
  check(
    '実行時に tsx（devDependency）を要求しない',
    !(await exists(path.join(INSTALL_DIR, 'node_modules', 'tsx'))),
    'node_modules に tsx が無い',
  )

  log('\n[2] インストールした bin を stdio で起動して全ツールが出る')
  const client = await connect(bin, {})
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort()
    check('ツール一覧', names.join(',') === EXPECTED_TOOLS.join(','), names.join(', '))

    log('\n[3] PDF の本文抽出が npm の node_modules でも動く（pdfjs の同梱データのパス解決）')
    const pdfPath = path.join(WORK_DIR, 'filing.pdf')
    await writeFile(pdfPath, buildSamplePdf(PDF_PAGES))
    const started = await callTool(client, 'start_session', {
      source: { type: 'text', text: SOURCE_TEXT },
      title: 'パッケージ e2e',
    })
    check('start_session が通る', started.ok, started.ok ? String(started.data.session_id) : started.text)
    const sessionId = String(started.data.session_id)
    const pdf = await callTool(client, 'fetch_evidence', {
      session_id: sessionId,
      source: { type: 'file', path: pdfPath },
      discovered_via: 'cited_in_source',
    })
    check('PDF をローカルファイルとして取得できる', pdf.ok, pdf.ok ? '' : pdf.text)
    check(
      'PDF の本文が抽出できている',
      pdf.ok && String(pdf.data.text ?? '').includes('412 units'),
      pdf.ok ? `pdf_pages=${String(pdf.data.pdf_pages)}` : pdf.text,
    )
  } finally {
    await client.close()
  }

  log('\n[4] Chromium が入っていない環境では、入れ方を案内して失敗する')
  const fixture = await startFixtureServer()
  const blind = await connect(bin, { PLAYWRIGHT_BROWSERS_PATH: EMPTY_BROWSERS_DIR })
  try {
    const started = await callTool(blind, 'start_session', {
      source: { type: 'text', text: SOURCE_TEXT },
      title: 'ブラウザ無し',
    })
    const failed = await callTool(blind, 'fetch_evidence', {
      session_id: String(started.data.session_id),
      source: { type: 'url', url: `${fixture.origin}/short` },
      discovered_via: 'agent_search',
      discovery_note: 'ブラウザ未インストールの確認',
    })
    check('本文が短いページはブラウザ段階に落ちて失敗する', !failed.ok, failed.ok ? '成功してしまった' : '')
    check(
      'エラー文に chromium の入れ方が載る',
      !failed.ok && failed.text.includes('npx playwright install chromium'),
      failed.ok ? '' : firstMatchingLine(failed.text, 'npx playwright install chromium'),
    )
    check(
      'どの段階で失敗したかが全部残る',
      !failed.ok && failed.text.includes('http:') && failed.text.includes('browser:'),
      failed.ok ? '' : 'http 段階と browser 段階の両方が attempts に出ている',
    )
  } finally {
    await blind.close()
    await fixture.close()
  }

  log(`\n成果物: ${WORK_DIR}`)
  if (failures > 0) {
    log(`\n失敗 ${failures} 件`)
    process.exitCode = 1
    return
  }
  log('\nすべての確認項目が通った')
}

function firstMatchingLine(text: string, needle: string): string {
  return (
    text
      .split('\n')
      .find((line) => line.includes(needle))
      ?.trim() ?? '（該当行なし）'
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
