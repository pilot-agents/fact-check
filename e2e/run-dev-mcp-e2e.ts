import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { McpError, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { CHILD_DOWN_CODE, RESTART_INTERRUPTED_CODE } from '../scripts/dev-mcp/shim-core.js'
import { startFixtureServer } from './fixtures/serve-fixtures.js'
import { callTool } from './mcp/call-tool.js'

/**
 * `pnpm dev:mcp`（ホットリロード用のシム）の end-to-end 検証。
 *
 * 前半は架空の小さな MCP サーバーを作業ディレクトリに書き出し、シムをそれに向けて MCP クライアント
 * SDK から起動する。返す文字列をソースに埋め込んであるので、書き換えが本当に反映されたかどうかを
 * 返り値だけで判定できる。後半は本物の src/index.ts に対して `pnpm --silent dev:mcp` を cwd 指定で
 * 起動し、MCP クライアントから全ツールが見えることを確かめる（.mcp.json の書き方の前提の確認）。
 *
 * 外部にはアクセスしない。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const WORK_DIR = path.join(HERE, 'tmp', 'dev-mcp')
const FIXTURE_SOURCE = path.join(WORK_DIR, 'server.ts')
const FACT_CHECK_DIR = path.join(HERE, 'tmp', 'dev-mcp-fact-check')

const FIRST_REPLY = '最初の返事'
const SECOND_REPLY = '書き換えた後の返事'
const THIRD_REPLY = 'もう一度書き換えた後の返事'
/** 稼働中に再起動を挟むための、返事を遅らせるツールの待ち時間。 */
const SLOW_TOOL_MS = 4000
/** 再起動の反映・失敗の反映を待つ上限。 */
const SETTLE_TIMEOUT_MS = 30_000

const EXPECTED_TOOLS = [
  'attach_evidence',
  'export_report',
  'fetch_evidence',
  'finalize',
  'get_status',
  'mark_non_claim',
  'read_source_segments',
  'register_claim',
  'register_segments',
  'revise_record',
  'set_verdict',
  'start_session',
  'submit_agent_capture',
]

/**
 * ハイライト画像の回帰確認に使う元ネタ。引用は固定ページ (sample-article.html) に実在する文にする。
 */
const IMAGE_SOURCE_TEXT = '営業利益は前年比 95% にとどまった。'
const IMAGE_QUOTE = '営業利益は前年比 95% にとどまり、前年を下回りました。'
const IMAGE_PDF_PAGES = [['Fixture page', 'This page is served from localhost only.']]

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

/** 架空のサーバーのソース。返す文字列がそのままここに埋まっているので、反映を返り値で確かめられる。 */
function fixtureSource(reply: string): string {
  return [
    "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'",
    "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'",
    "import { z } from 'zod'",
    '',
    `const REPLY = ${JSON.stringify(reply)}`,
    '',
    "const server = new McpServer({ name: 'dev-mcp-fixture', version: '0.0.0' }, { capabilities: { tools: {} } })",
    '',
    "server.registerTool('say', { title: 'say', description: '埋め込んだ文字列を返す', inputSchema: {} }, async () => ({",
    "  content: [{ type: 'text', text: REPLY }],",
    '}))',
    '',
    'server.registerTool(',
    "  'say_slowly',",
    "  { title: 'say slowly', description: '待ってから返す', inputSchema: { ms: z.number() } },",
    '  async ({ ms }) => {',
    '    await new Promise((resolve) => setTimeout(resolve, ms))',
    "    return { content: [{ type: 'text', text: REPLY }] }",
    '  },',
    ')',
    '',
    'await server.connect(new StdioServerTransport())',
    '',
  ].join('\n')
}

/** わざと構文を壊したソース。tsx が解釈できず、子プロセスが起動直後に落ちる。 */
function brokenFixtureSource(): string {
  return ["const REPLY = 'これは閉じていない文字列", ''].join('\n')
}

type Connected = {
  client: Client
  stderr: string[]
  close: () => Promise<void>
}

async function connect(
  name: string,
  command: string,
  args: readonly string[],
  onToolListChanged?: () => void,
): Promise<Connected> {
  const transport = new StdioClientTransport({
    command,
    args: [...args],
    cwd: ROOT,
    env: { ...process.env, FACT_CHECK_DIR } as Record<string, string>,
    stderr: 'pipe',
  })
  const client = new Client({ name, version: '0.0.0' })
  if (onToolListChanged !== undefined) {
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => onToolListChanged())
  }
  await client.connect(transport)
  const stderr: string[] = []
  const stream = transport.stderr
  if (stream === null) throw new Error('シムの stderr を受け取れなかった')
  stream.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')))
  return {
    client,
    stderr,
    close: async () => {
      await client.close()
    },
  }
}

async function callSay(
  client: Client,
): Promise<{ ok: true; text: string } | { ok: false; code: number; message: string }> {
  try {
    const result = await client.callTool({ name: 'say', arguments: {} })
    const content = result.content as Array<{ type: string; text: string }>
    return { ok: true, text: content.map((part) => part.text).join('\n') }
  } catch (error) {
    if (error instanceof McpError) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

/** 条件が満たされるまで繰り返し確かめる。固定の sleep で待たず、満たせなかった理由は残す。 */
async function waitUntil(label: string, attempt: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await attempt()) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  log(`  [待機] ${label} が ${SETTLE_TIMEOUT_MS}ms 以内に起きなかった`)
  return false
}

async function checkHotReload(): Promise<string[]> {
  await rm(WORK_DIR, { recursive: true, force: true })
  await mkdir(WORK_DIR, { recursive: true })
  await writeFile(FIXTURE_SOURCE, fixtureSource(FIRST_REPLY), 'utf8')

  let listChangedCount = 0
  const connection = await connect(
    'dev-mcp-e2e-fixture',
    path.join(ROOT, 'node_modules', '.bin', 'tsx'),
    [
      path.join('scripts', 'dev-mcp', 'main.ts'),
      '--server',
      `${path.join('node_modules', '.bin', 'tsx')} ${path.relative(ROOT, FIXTURE_SOURCE)}`,
      '--watch',
      path.relative(ROOT, WORK_DIR),
    ],
    () => {
      listChangedCount += 1
    },
  )
  const { client } = connection

  try {
    log('\n[1] シム越しに架空のサーバーへ繋ぐ')
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort()
    check('ツールが見える', tools.join(',') === 'say,say_slowly', tools.join(','))
    const first = await callSay(client)
    check('ソースに埋め込んだ文字列が返る', first.ok && first.text === FIRST_REPLY, JSON.stringify(first))

    log('\n[2] ソースを書き換えると、繋ぎ直さずに新しい文字列が返る')
    const before = listChangedCount
    await writeFile(FIXTURE_SOURCE, fixtureSource(SECOND_REPLY), 'utf8')
    const notified = await waitUntil(
      'notifications/tools/list_changed の受信',
      async () => listChangedCount > before,
    )
    check('クライアントが list_changed を受け取る', notified, `受信 ${listChangedCount} 回`)
    const reloaded = await waitUntil('書き換えの反映', async () => {
      const outcome = await callSay(client)
      return outcome.ok && outcome.text === SECOND_REPLY
    })
    const afterReload = await callSay(client)
    check(
      '同じツールが新しい文字列を返す',
      reloaded && afterReload.ok && afterReload.text === SECOND_REPLY,
      JSON.stringify(afterReload),
    )

    log('\n[3] 再起動を跨いだ呼び出しは中断のエラー応答になる')
    const inFlight = client.callTool({ name: 'say_slowly', arguments: { ms: SLOW_TOOL_MS } })
    const settled = inFlight.then(
      () => ({ interrupted: false, code: 0, message: '応答が返ってしまった' }),
      (error: unknown) =>
        error instanceof McpError
          ? { interrupted: true, code: error.code, message: error.message }
          : { interrupted: false, code: 0, message: String(error) },
    )
    // 呼び出しが子プロセスに届いてから書き換える（届く前だと溜められて中断にならない）。
    await new Promise((resolve) => setTimeout(resolve, 500))
    await writeFile(FIXTURE_SOURCE, fixtureSource(THIRD_REPLY), 'utf8')
    const interrupted = await settled
    check(
      `再起動中の呼び出しが ${RESTART_INTERRUPTED_CODE} で返る`,
      interrupted.interrupted && interrupted.code === RESTART_INTERRUPTED_CODE,
      `${String(interrupted.code)} / ${interrupted.message}`,
    )
    check(
      '中断のエラー本文にどの method だったかが出る',
      interrupted.message.includes('tools/call'),
      interrupted.message,
    )
    let afterInterrupt = await callSay(client)
    const swapped = await waitUntil('中断を挟んだ書き換えの反映', async () => {
      afterInterrupt = await callSay(client)
      return afterInterrupt.ok && afterInterrupt.text === THIRD_REPLY
    })
    check('投げ直すと新しい文字列が返る', swapped, JSON.stringify(afterInterrupt))

    log('\n[4] 構文エラーで保存すると、子が起動できない旨のエラー応答になる')
    await writeFile(FIXTURE_SOURCE, brokenFixtureSource(), 'utf8')
    let downOutcome = await callSay(client)
    const wentDown = await waitUntil('子プロセスの起動失敗', async () => {
      downOutcome = await callSay(client)
      return !downOutcome.ok && downOutcome.code === CHILD_DOWN_CODE
    })
    check(`子が起動していない間の呼び出しが ${CHILD_DOWN_CODE} で返る`, wentDown, JSON.stringify(downOutcome))
    check(
      'エラー本文が stderr を見るよう促す',
      !downOutcome.ok && downOutcome.message.includes('stderr'),
      JSON.stringify(downOutcome),
    )

    log('\n[5] ソースを直すと復帰する')
    await writeFile(FIXTURE_SOURCE, fixtureSource(FIRST_REPLY), 'utf8')
    let recovered = await callSay(client)
    const cameBack = await waitUntil('復帰', async () => {
      recovered = await callSay(client)
      return recovered.ok && recovered.text === FIRST_REPLY
    })
    check('直したソースの文字列が返る', cameBack, JSON.stringify(recovered))

    return connection.stderr
  } finally {
    await connection.close()
  }
}

async function checkRealServerThroughPnpm(): Promise<string[]> {
  log('\n[6] 本物の src/index.ts に pnpm --silent dev:mcp で繋ぐ')
  await rm(FACT_CHECK_DIR, { recursive: true, force: true })
  await mkdir(FACT_CHECK_DIR, { recursive: true })
  const connection = await connect('dev-mcp-e2e-real', 'pnpm', ['--silent', 'dev:mcp'])
  try {
    const tools = (await connection.client.listTools()).tools.map((tool) => tool.name).sort()
    check(
      'listTools に全ツールが出る',
      tools.join(',') === EXPECTED_TOOLS.join(','),
      `${tools.length} 件: ${tools.join(',')}`,
    )
    const status = await connection.client.callTool({
      name: 'get_status',
      arguments: { session_id: 'no-such' },
    })
    check(
      'ツール呼び出しがシム越しに実サーバーまで届く',
      status.isError === true,
      '存在しない session_id が実サーバーのエラーとして返る',
    )
    await checkHighlightImage(connection.client)
    return connection.stderr
  } finally {
    await connection.close()
  }
}

/**
 * ハイライト画像が tsx 実行下でも作れることを、実際の証拠取得と引用添付で確かめる。
 *
 * **これは dist を叩く run-e2e.ts では捕まえられない種類の壊れ方に対する回帰確認。**
 * tsx (esbuild の keepNames) は名前の付く関数式を `__name(...)` で包む。Playwright は
 * ページへ渡す関数を toString して eval するので、`__name` が未定義のページ側で
 * ReferenceError になる。tsc 出力にはこの包みが無いため、dist だけを叩く e2e は通ってしまい、
 * 実運用（.mcp.json は pnpm dev:mcp = tsx で起動する）でだけ画像が全滅した。
 *
 * ついでに「取得元を止めても画像が作れる」ことも見る。画像は取得時に保存したスナップショットから
 * 作るので、固定ページの配信を止めた後でも成功するのが正しい。
 */
async function checkHighlightImage(client: Client): Promise<void> {
  log('\n[7] tsx 実行下でハイライト画像が作れる')
  const fixture = await startFixtureServer(IMAGE_PDF_PAGES)
  try {
    const started = await callTool(client, 'start_session', {
      source: { type: 'text', text: IMAGE_SOURCE_TEXT },
      title: 'dev-mcp e2e',
    })
    check('start_session が通る', started.ok, started.ok ? '' : started.text)
    if (!started.ok) return
    const sessionId = started.data.session_id as string

    const claim = await callTool(client, 'register_claim', {
      session_id: sessionId,
      start: 0,
      end: IMAGE_SOURCE_TEXT.length,
      claim: '営業利益は前年比 95% にとどまった',
    })
    check('register_claim が通る', claim.ok, claim.ok ? '' : claim.text)

    const evidence = await callTool(client, 'fetch_evidence', {
      session_id: sessionId,
      source: { type: 'url', url: fixture.articleUrl },
      discovered_via: 'cited_in_source',
      find: '営業利益',
    })
    check('fetch_evidence が通る', evidence.ok, evidence.ok ? '' : evidence.text)
    if (!evidence.ok) return
    const found = evidence.data.find as { found: boolean; occurrences: number } | null
    check('find が一致箇所を返す', found?.found === true && found.occurrences > 0, JSON.stringify(found))

    // 取得が済んだら配信を止める。ここから先でネットワークに出ていたら失敗するはず。
    await fixture.close()
    log(`固定ページ配信サーバーを停止した: ${fixture.articleUrl}`)

    const attached = await callTool(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claim.data.claim_id,
      evidence_id: evidence.data.evidence_id,
      quote: IMAGE_QUOTE,
      relation: 'contradicts',
      rationale: '証拠は 95% で、元ネタの主張と照合するための引用',
    })
    check('attach_evidence が通る', attached.ok, attached.ok ? '' : attached.text)
    if (!attached.ok) return
    check(
      'tsx 実行下でもハイライト画像が作れる（__name の回帰確認）',
      typeof attached.data.screenshot_path === 'string' && attached.data.screenshot_note === null,
      `${String(attached.data.screenshot_path)} / 但し書き=${String(attached.data.screenshot_note)}`,
    )
    check(
      '取得元を止めた後でも保存済み HTML から描かれている',
      attached.data.screenshot_source === 'saved_html',
      String(attached.data.screenshot_source),
    )
    const shot = path.join(FACT_CHECK_DIR, sessionId, String(attached.data.screenshot_path))
    const bytes = await stat(shot).then(
      (info) => info.size,
      () => -1,
    )
    check('画像が実ファイルとして保存されている', bytes > 1000, `${shot} (${bytes} bytes)`)

    const page = await callTool(client, 'read_source_segments', { session_id: sessionId })
    check(
      'read_source_segments がシム越しに呼べる',
      page.ok && Array.isArray(page.data.segments),
      page.ok ? `候補 ${String(page.data.segment_total)} 件` : page.text,
    )
  } finally {
    await fixture.close()
  }
}

async function main(): Promise<void> {
  const fixtureStderr = await checkHotReload()
  const realStderr = await checkRealServerThroughPnpm()

  log('\n--- シムの stderr（架空のサーバー） ---')
  log(fixtureStderr.join(''))
  log('--- シムの stderr（本物のサーバー） ---')
  log(realStderr.join(''))

  if (failures > 0) {
    log(`\n失敗 ${failures} 件`)
    process.exitCode = 1
    return
  }
  log('\nすべての確認項目が通った')
}

main().catch((error: unknown) => {
  process.stdout.write(`e2e が例外で停止した:\n${String(error instanceof Error ? error.stack : error)}\n`)
  process.exitCode = 1
})
