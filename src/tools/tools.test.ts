import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { buildSamplePdf } from '../../e2e/fixtures/build-sample-pdf.js'
import { rebuildReportHtml } from '../report/rebuild.js'
import { readEmbeddedJson } from '../report/rendering/embed-json.js'
import type { ViewerPayload } from '../report/rendering/viewer-payload.js'
import { LEDGER_VERSION } from '../session/ledger-types.js'
import { registerTools } from './register-tools.js'

/**
 * 書き込みを 1 回だけ失敗させるための門。**既定では素通し**で、実物と同じに振る舞う。
 *
 * これが要るのは、finalize の最後にある「レポートは最新」という印の保存だけを落としたいから。
 * finalize は 1 回の呼び出しでディスクへ 5 回書く（台帳 → md → json → html → 台帳）。
 * ディレクトリの権限を落とすと 1 回目で止まり、`ledger.json` をディレクトリに置き換えると
 * 読み込みで止まる。**5 回目だけ**を落とす手段はファイルシステム側には無い。
 *
 * 数え方は「n 回目」にしない。順序が変われば別の書き込みを壊してしまう。代わりに
 * **どのセッションの・どのパスへ・どんな中身を書くか**の 3 つで決める。
 * 完了印の保存だけが次を同時に満たす:
 *   - 対象がテストが指定したセッションのファイル（他のテストのセッションを巻き込まない）
 *   - 一時ファイルの名前が `ledger.json.<hex>.tmp`（レポート 3 形式はここが違う）
 *   - 中身に完了印 `"reports_stale_since": null` が入っている（変更を確定する
 *     1 回目の台帳保存は、ここが時刻の文字列になっている）
 *
 * セッションで絞るのが要るのは、**新しいセッションを作るときの台帳も
 * `reports_stale_since` が null** だから（実測して分かった）。門を張るのはセッションが
 * できたあとなので、作成時の保存は素通しになる。
 */
const writeGate = vi.hoisted(() => ({
  /** 失敗させる対象のセッション id。null なら何もしない。テストが立てて、必ず自分で下ろす */
  armedFor: null as string | null,
  /** 実際に落とした書き込みのパス。狙った 1 回だけを踏んだか確かめるために持つ */
  failedPaths: [] as string[],
  matches(target: unknown, data: unknown): boolean {
    if (this.armedFor === null) return false
    if (typeof target !== 'string' || typeof data !== 'string') return false
    if (!target.includes(this.armedFor)) return false
    if (!/ledger\.json\.[0-9a-f]+\.tmp$/.test(target)) return false
    return data.includes('"reports_stale_since": null')
  },
}))

/**
 * `node:fs/promises` の `writeFile` だけを包む。他の関数も、条件に合わない書き込みも、
 * すべて本物へ渡す（レポート 3 形式は実際にディスクへ書かれる）。
 *
 * Node の組み込みモジュールは Vitest では外部化されるので、名前空間に `vi.spyOn` を
 * 張れない。モジュールごと差し替えたうえで実物へ委譲する形にする。
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const writeFileGated: typeof actual.writeFile = async (target, data, options) => {
    if (writeGate.matches(target, data)) {
      writeGate.failedPaths.push(String(target))
      throw Object.assign(new Error(`ENOSPC: no space left on device, write '${String(target)}'`), {
        code: 'ENOSPC',
        errno: -28,
        syscall: 'write',
        path: String(target),
      })
    }
    return await actual.writeFile(target, data, options)
  }
  return { ...actual, default: actual, writeFile: writeFileGated }
})

// 門が開いたままになると、以降のテストが理由の分からない失敗をする。毎回必ず閉じる。
afterEach(() => {
  writeGate.armedFor = null
  writeGate.failedPaths = []
  vi.useRealTimers()
})

/**
 * ツール層の拒否条件は「AI が嘘をつけない」ことの本体なので、内部関数ではなく
 * MCP のツール呼び出しとして検証する。実行時は In-Memory トランスポートで繋ぐので、
 * 子プロセスもネットワークも要らない（ブラウザを起こさないよう、証拠はローカルファイルを使う）。
 */

const EVIDENCE_TEXT = [
  '# 四半期報告',
  '',
  '当期の売上は前年比 120% となった。',
  '営業利益は前年比 95% にとどまった。',
].join('\n')

const SOURCE_TEXT = '売上は前年比120%に達した。\n\nこれは素晴らしい成果だ。'

let baseDir: string
let evidenceFile: string
let previousDir: string | undefined

beforeAll(async () => {
  previousDir = process.env.FACT_CHECK_DIR
  baseDir = await mkdtemp(path.join(tmpdir(), 'fact-check-test-'))
  process.env.FACT_CHECK_DIR = path.join(baseDir, 'sessions')
  evidenceFile = path.join(baseDir, 'evidence.md')
  await writeFile(evidenceFile, EVIDENCE_TEXT, 'utf8')
})

afterAll(() => {
  if (previousDir === undefined) delete process.env.FACT_CHECK_DIR
  else process.env.FACT_CHECK_DIR = previousDir
})

type CallOutcome = { ok: boolean; text: string; data: Record<string, unknown> }

async function connectClient(): Promise<Client> {
  const server = new McpServer({ name: 'fact-check', version: '0.1.0-test' }, { capabilities: { tools: {} } })
  registerTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'fact-check-test', version: '0.1.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallOutcome> {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text: string }>
  const text = content.map((part) => part.text).join('\n')
  const ok = result.isError !== true
  return { ok, text, data: ok ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

/** 元ネタを取り込み、claim 1 件 + non_claim 1 件で網羅率 100% にしたセッションを作る。 */
async function startCoveredSession(client: Client): Promise<{ sessionId: string; claimId: string }> {
  const started = await call(client, 'start_session', {
    source: { type: 'text', text: SOURCE_TEXT },
    title: 'テスト',
  })
  expect(started.ok).toBe(true)
  const sessionId = started.data.session_id as string
  const boundary = SOURCE_TEXT.indexOf('これは')
  const claim = await call(client, 'register_claim', {
    session_id: sessionId,
    start: 0,
    end: boundary,
    claim: '売上は前年比 120% に達した',
  })
  expect(claim.ok).toBe(true)
  const nonClaim = await call(client, 'mark_non_claim', {
    session_id: sessionId,
    start: boundary,
    end: SOURCE_TEXT.length,
    reason: '感想',
  })
  expect(nonClaim.ok).toBe(true)
  return { sessionId, claimId: claim.data.claim_id as string }
}

async function attachLocalEvidence(
  client: Client,
  sessionId: string,
  claimId: string,
  quote: string,
  relation: string,
): Promise<CallOutcome> {
  const evidence = await call(client, 'fetch_evidence', {
    session_id: sessionId,
    source: { type: 'file', path: evidenceFile },
    discovered_via: 'cited_in_source',
  })
  expect(evidence.ok).toBe(true)
  return await call(client, 'attach_evidence', {
    session_id: sessionId,
    claim_id: claimId,
    evidence_id: evidence.data.evidence_id as string,
    quote,
    relation,
    rationale: 'テスト',
  })
}

describe('attach_evidence: 引用文の実在照合', () => {
  test('証拠本文に実在する引用は通り、原文の一致位置が返る', async () => {
    const client = await connectClient()
    const { sessionId, claimId } = await startCoveredSession(client)
    const attached = await attachLocalEvidence(
      client,
      sessionId,
      claimId,
      '売上は前年比 120% となった',
      'supports',
    )
    expect(attached.ok).toBe(true)
    expect(attached.data.quote_verified).toBe(true)
  })

  test('実在しない引用は拒否され、近い箇所の抜粋が返る', async () => {
    const client = await connectClient()
    const { sessionId, claimId } = await startCoveredSession(client)
    const attached = await attachLocalEvidence(
      client,
      sessionId,
      claimId,
      '売上は前年比 200% となった',
      'supports',
    )
    expect(attached.ok).toBe(false)
    expect(attached.text).toContain('引用文が証拠の本文テキストに見つからなかった')
    expect(attached.text).toContain('最も長く一致した前方部分')
  })
})

describe('set_verdict の拒否条件', () => {
  test.each([
    { name: 'verified は supports が無いと拒否', attach: null, verdict: 'verified', ok: false },
    { name: 'contradicted は contradicts が無いと拒否', attach: null, verdict: 'contradicted', ok: false },
    { name: 'verified は supports が 1 件あれば通る', attach: 'supports', verdict: 'verified', ok: true },
    {
      name: 'contradicted は contradicts が 1 件あれば通る',
      attach: 'contradicts',
      verdict: 'contradicted',
      ok: true,
    },
    {
      name: 'verified は contradicts しか無ければ拒否',
      attach: 'contradicts',
      verdict: 'verified',
      ok: false,
    },
    {
      name: 'contradicted は supports しか無ければ拒否',
      attach: 'supports',
      verdict: 'contradicted',
      ok: false,
    },
    {
      name: 'partially_verified は attachment 無しでも通る',
      attach: null,
      verdict: 'partially_verified',
      ok: true,
    },
    { name: 'unverifiable は attachment 無しでも通る', attach: null, verdict: 'unverifiable', ok: true },
  ])('$name', async ({ attach, verdict, ok }) => {
    const client = await connectClient()
    const { sessionId, claimId } = await startCoveredSession(client)
    if (attach !== null) {
      const attached = await attachLocalEvidence(
        client,
        sessionId,
        claimId,
        '売上は前年比 120% となった',
        attach,
      )
      expect(attached.ok).toBe(true)
    }
    const result = await call(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimId,
      verdict,
      rationale: 'テストの理由',
    })
    expect(result.ok).toBe(ok)
    if (!ok) expect(result.text).toContain('attachment が 1 件以上ないと付けられない')
  })
})

describe('finalize の拒否条件', () => {
  test('網羅率が 100% 未満なら拒否し、未処理の範囲を返す', async () => {
    const client = await connectClient()
    const started = await call(client, 'start_session', { source: { type: 'text', text: SOURCE_TEXT } })
    const sessionId = started.data.session_id as string
    const claim = await call(client, 'register_claim', {
      session_id: sessionId,
      start: 0,
      end: 5,
      claim: '売上の主張',
    })
    await call(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claim.data.claim_id as string,
      verdict: 'unverifiable',
      rationale: '理由',
    })
    const result = await call(client, 'finalize', { session_id: sessionId })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('網羅率が')
    expect(result.text).toContain('未処理の範囲')
  })

  test('verdict 未設定の claim があれば拒否し、その id を返す', async () => {
    const client = await connectClient()
    const { sessionId, claimId } = await startCoveredSession(client)
    const result = await call(client, 'finalize', { session_id: sessionId })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('verdict 未設定の claim')
    expect(result.text).toContain(claimId)
  })

  test('claim が 1 件も無ければ拒否する', async () => {
    const client = await connectClient()
    const started = await call(client, 'start_session', { source: { type: 'text', text: SOURCE_TEXT } })
    const sessionId = started.data.session_id as string
    await call(client, 'mark_non_claim', {
      session_id: sessionId,
      start: 0,
      end: SOURCE_TEXT.length,
      reason: '全部感想',
    })
    const result = await call(client, 'finalize', { session_id: sessionId })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('claim が 1 件も登録されていない')
  })

  test('網羅率 100% かつ全 claim 判定済みなら通り、レポート 3 種を書き出す', async () => {
    const client = await connectClient()
    const { sessionId, claimId } = await startCoveredSession(client)
    await attachLocalEvidence(client, sessionId, claimId, '売上は前年比 120% となった', 'supports')
    await call(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimId,
      verdict: 'verified',
      rationale: '証拠の引用どおり',
    })
    const status = await call(client, 'get_status', { session_id: sessionId })
    expect(status.data.finalize_ready).toBe(true)

    const result = await call(client, 'finalize', { session_id: sessionId })
    expect(result.ok).toBe(true)
    const report = result.data.report as { markdown: string; json: string; html: string }
    const json = JSON.parse(await readFile(report.json, 'utf8')) as { ledger: { session_id: string } }
    expect(json.ledger.session_id).toBe(sessionId)
    expect(await readFile(report.markdown, 'utf8')).toContain('売上は前年比 120% となった')
    expect(await readFile(report.html, 'utf8')).toContain('<!doctype html>')
  })
})

describe('export_report: レポートの持ち出し', () => {
  /** 判定まで済ませたセッション。finalize は呼ばない（呼ぶかどうかはテスト側で決める）。 */
  async function verifiedSession(client: Client): Promise<string> {
    const { sessionId, claimId } = await startCoveredSession(client)
    await attachLocalEvidence(client, sessionId, claimId, '売上は前年比 120% となった', 'supports')
    await call(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimId,
      verdict: 'verified',
      rationale: '証拠の引用どおり',
    })
    return sessionId
  }

  test('finalize 前でも書き出せるが、暫定である旨の警告が付き、台帳は変わらない', async () => {
    const client = await connectClient()
    const sessionId = await verifiedSession(client)
    const ledgerPath = path.join(process.env.FACT_CHECK_DIR ?? '', sessionId, 'ledger.json')
    const ledgerBefore = await readFile(ledgerPath, 'utf8')
    const outputPath = path.join(baseDir, 'exported', `${sessionId}-provisional.html`)

    const result = await call(client, 'export_report', {
      session_id: sessionId,
      format: 'html',
      output_path: outputPath,
    })

    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({
      session_id: sessionId,
      format: 'html',
      path: outputPath,
      inlined_images: 0,
    })
    expect(typeof result.data.reports_stale_since).toBe('string')
    expect(String(result.data.warning)).toContain('finalize の検証を通していない暫定のもの')
    const payload = readEmbeddedJson(await readFile(outputPath, 'utf8'), 'fact-check-data') as ViewerPayload
    expect(payload.ledger.reports_stale_since).toBe(result.data.reports_stale_since)
    expect(payload.assets).toEqual({})
    // 読み取りだけの操作。台帳ファイルは 1 バイトも変わらない
    expect(await readFile(ledgerPath, 'utf8')).toBe(ledgerBefore)
  })

  test('finalize 後は警告なしで書き出せる', async () => {
    const client = await connectClient()
    const sessionId = await verifiedSession(client)
    expect((await call(client, 'finalize', { session_id: sessionId })).ok).toBe(true)
    const outputPath = path.join(baseDir, 'exported', `${sessionId}.html`)

    const result = await call(client, 'export_report', {
      session_id: sessionId,
      format: 'html',
      output_path: outputPath,
    })

    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ reports_stale_since: null, warning: null })
    expect(await readFile(outputPath, 'utf8')).toContain('<!doctype html>')
  })

  test.each([
    { name: '相対パス', output_path: 'report.html', expected: '絶対パスで指定すること' },
    {
      name: '拡張子が形式と違う',
      output_path: '/tmp/report.pdf',
      expected: '拡張子 .html / .htm にすること',
    },
  ])('入力の不備は書き出す前に拒否する: $name', async ({ output_path, expected }) => {
    const client = await connectClient()
    const sessionId = await verifiedSession(client)
    const result = await call(client, 'export_report', { session_id: sessionId, format: 'html', output_path })
    expect(result.ok).toBe(false)
    expect(result.text).toContain(expected)
  })

  test('既にあるファイルは overwrite=true が無ければ置き換えない', async () => {
    const client = await connectClient()
    const sessionId = await verifiedSession(client)
    const outputPath = path.join(baseDir, 'exported', `${sessionId}-twice.html`)
    const first = await call(client, 'export_report', {
      session_id: sessionId,
      format: 'html',
      output_path: outputPath,
    })
    expect(first.ok).toBe(true)

    const refused = await call(client, 'export_report', {
      session_id: sessionId,
      format: 'html',
      output_path: outputPath,
    })
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain('出力先に既にファイルがある')

    const replaced = await call(client, 'export_report', {
      session_id: sessionId,
      format: 'html',
      output_path: outputPath,
      overwrite: true,
    })
    expect(replaced.ok).toBe(true)
  })
})

describe('submit_agent_capture', () => {
  test('provenance は agent_captured になり、レポートに警告が出る', async () => {
    const client = await connectClient()
    const { sessionId, claimId } = await startCoveredSession(client)
    const submitted = await call(client, 'submit_agent_capture', {
      session_id: sessionId,
      url: 'https://example.com/quarterly',
      text: EVIDENCE_TEXT,
      discovered_via: 'agent_search',
      note: '自分のブラウザ操作ツールで開いて本文をコピーした',
    })
    expect(submitted.ok).toBe(true)
    expect(submitted.data.provenance).toBe('agent_captured')

    const attached = await call(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claimId,
      evidence_id: submitted.data.evidence_id as string,
      quote: '売上は前年比 120% となった',
      relation: 'supports',
      rationale: 'AI が取得した本文に実在する',
    })
    expect(attached.ok).toBe(true)
    expect(attached.data.screenshot_note).toContain('スクリーンショットが添えられていなかった')

    await call(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimId,
      verdict: 'verified',
      rationale: '引用どおり',
    })
    const result = await call(client, 'finalize', { session_id: sessionId })
    expect(result.ok).toBe(true)
    expect(result.data.warning).toContain('ツールが直接取得したものではない')
    const report = result.data.report as { markdown: string; html: string }
    const markdown = await readFile(report.markdown, 'utf8')
    expect(markdown).toContain('AI が提出（ツールは直接取得していない）')
    expect(await readFile(report.html, 'utf8')).toContain('ツールが直接取得したものではなく')
  })
})

describe('自己参照の拒否', () => {
  test('証拠のファイルが元ネタのファイルと同じなら attach_evidence を拒否する', async () => {
    const client = await connectClient()
    const started = await call(client, 'start_session', { source: { type: 'file', path: evidenceFile } })
    expect(started.ok).toBe(true)
    const sessionId = started.data.session_id as string
    const length = (started.data.source as { length: number }).length
    const claim = await call(client, 'register_claim', {
      session_id: sessionId,
      start: 0,
      end: length,
      claim: '当期の売上は前年比 120% だった',
    })
    expect(claim.ok).toBe(true)
    const evidence = await call(client, 'fetch_evidence', {
      session_id: sessionId,
      source: { type: 'file', path: evidenceFile },
      discovered_via: 'cited_in_source',
    })
    expect(evidence.ok).toBe(true)
    const attached = await call(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claim.data.claim_id as string,
      evidence_id: evidence.data.evidence_id as string,
      quote: '売上は前年比 120% となった',
      relation: 'supports',
      rationale: '元ネタ自身を証拠にしようとしている',
    })
    expect(attached.ok).toBe(false)
    expect(attached.text).toContain('自己参照は証拠にできない')
  })
})

describe('submit_agent_capture のスクリーンショット', () => {
  test('提出されたスクショはセッションディレクトリに複製され、そのまま attachment に使われる', async () => {
    const client = await connectClient()
    const { sessionId, claimId } = await startCoveredSession(client)
    const shotPath = path.join(baseDir, 'agent-shot.png')
    await writeFile(shotPath, Buffer.from('89504e470d0a1a0a', 'hex'))

    const submitted = await call(client, 'submit_agent_capture', {
      session_id: sessionId,
      url: 'https://example.com/quarterly',
      text: EVIDENCE_TEXT,
      discovered_via: 'cited_in_source',
      screenshot_path: shotPath,
      note: 'ブラウザ操作ツールで開いて保存した',
    })
    expect(submitted.ok).toBe(true)
    const saved = submitted.data.saved as { screenshot_path: string }
    const copied = path.join(process.env.FACT_CHECK_DIR ?? '', sessionId, saved.screenshot_path)
    expect(await readFile(copied)).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'))

    const attached = await call(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claimId,
      evidence_id: submitted.data.evidence_id as string,
      quote: '売上は前年比 120% となった',
      relation: 'supports',
      rationale: '提出した本文に実在する',
    })
    expect(attached.ok).toBe(true)
    expect(attached.data.screenshot_path).toBe(saved.screenshot_path)
    expect(attached.data.screenshot_note).toContain('AI が提出したスクリーンショットをそのまま使っている')
  })

  test('読めないパスを渡したら理由つきで拒否される', async () => {
    const client = await connectClient()
    const { sessionId } = await startCoveredSession(client)
    const result = await call(client, 'submit_agent_capture', {
      session_id: sessionId,
      url: 'https://example.com/quarterly',
      text: EVIDENCE_TEXT,
      discovered_via: 'cited_in_source',
      screenshot_path: path.join(baseDir, 'does-not-exist.png'),
      note: '存在しないパス',
    })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('スクリーンショットを読めない')
  })
})

describe('register_segments: まとめ登録', () => {
  test('全件正しければ全件登録され、id と網羅率が返る', async () => {
    const client = await connectClient()
    const started = await call(client, 'start_session', { source: { type: 'text', text: SOURCE_TEXT } })
    const sessionId = started.data.session_id as string
    const boundary = SOURCE_TEXT.indexOf('これは')
    const result = await call(client, 'register_segments', {
      session_id: sessionId,
      items: [
        { kind: 'claim', start: 0, end: boundary, claim: '売上は前年比 120% に達した', claim_kind: '数値' },
        { kind: 'non_claim', start: boundary, end: SOURCE_TEXT.length, reason: '感想' },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.data.registered_count).toBe(2)
    expect(result.data.registered).toEqual([
      { index: 0, kind: 'claim', id: 'claim_1', range: { start: 0, end: boundary } },
      {
        index: 1,
        kind: 'non_claim',
        id: 'non_claim_1',
        range: { start: boundary, end: SOURCE_TEXT.length },
      },
    ])
    expect(result.data.uncovered_ranges).toBe(0)

    const status = await call(client, 'get_status', { session_id: sessionId })
    const summary = status.data.summary as { coverage: { complete: boolean }; claims: { total: number } }
    expect(summary.coverage.complete).toBe(true)
    expect(summary.claims.total).toBe(1)
  })

  test.each([
    {
      name: '範囲が本文の外',
      items: [{ kind: 'non_claim', start: 0, end: 9999, reason: '長すぎる範囲' }],
      expected: 'end が本文の長さを超えている',
    },
    {
      name: '空範囲',
      items: [{ kind: 'claim', start: 3, end: 3, claim: '空範囲の主張' }],
      expected: '空範囲は登録できない',
    },
    {
      name: 'start > end',
      items: [{ kind: 'claim', start: 5, end: 2, claim: '逆転した範囲' }],
      expected: 'start が end より大きい',
    },
  ])('$name の item があれば拒否される', async ({ items, expected }) => {
    const client = await connectClient()
    const started = await call(client, 'start_session', { source: { type: 'text', text: SOURCE_TEXT } })
    const sessionId = started.data.session_id as string
    const result = await call(client, 'register_segments', { session_id: sessionId, items })
    expect(result.ok).toBe(false)
    expect(result.text).toContain(expected)
  })

  test('1 件でも不正なら 1 件も登録せず、不正な item を全部列挙する', async () => {
    const client = await connectClient()
    const started = await call(client, 'start_session', { source: { type: 'text', text: SOURCE_TEXT } })
    const sessionId = started.data.session_id as string
    const boundary = SOURCE_TEXT.indexOf('これは')
    const result = await call(client, 'register_segments', {
      session_id: sessionId,
      items: [
        { kind: 'claim', start: 0, end: boundary, claim: '正しい item' },
        { kind: 'non_claim', start: boundary, end: 9999, reason: '本文の外' },
        { kind: 'claim', start: 4, end: 4, claim: '空範囲' },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('3 件のうち 2 件が不正')
    expect(result.text).toContain('items[1]')
    expect(result.text).toContain('items[2]')

    const status = await call(client, 'get_status', { session_id: sessionId })
    const summary = status.data.summary as { claims: { total: number }; non_claims: number }
    expect(summary.claims.total).toBe(0)
    expect(summary.non_claims).toBe(0)
  })

  test('空配列は拒否される', async () => {
    const client = await connectClient()
    const started = await call(client, 'start_session', { source: { type: 'text', text: SOURCE_TEXT } })
    const result = await call(client, 'register_segments', {
      session_id: started.data.session_id as string,
      items: [],
    })
    expect(result.ok).toBe(false)
  })
})

describe('台帳の同時更新', () => {
  /**
   * AI はツール呼び出しをまとめて送ってくる。直列化が外れると「読む → 変える → 書き戻す」が
   * 交差して、後から書いた側が先の変更を消す。50 件同時に投げて 50 件残ることを固定する。
   */
  test('同じセッションへの register_claim を 50 件同時に投げても全件残る', async () => {
    const client = await connectClient()
    const longText = 'あ'.repeat(200)
    const started = await call(client, 'start_session', { source: { type: 'text', text: longText } })
    const sessionId = started.data.session_id as string

    const results = await Promise.all(
      Array.from({ length: 50 }, (_unused, index) =>
        call(client, 'register_claim', {
          session_id: sessionId,
          start: index * 4,
          end: index * 4 + 4,
          claim: `${index} 番目の主張`,
        }),
      ),
    )
    expect(results.every((result) => result.ok)).toBe(true)

    const status = await call(client, 'get_status', { session_id: sessionId })
    const summary = status.data.summary as { claims: { total: number } }
    expect(summary.claims.total).toBe(50)
    const ids = new Set(results.map((result) => result.data.claim_id as string))
    expect(ids.size).toBe(50)
  })
})

describe('submit_agent_capture の本文の渡し方', () => {
  test.each([
    { name: 'text だけならそのまま登録される', withText: true, withPath: false, ok: true },
    { name: 'text_path だけならファイルの中身が登録される', withText: false, withPath: true, ok: true },
    { name: '両方指定は拒否される', withText: true, withPath: true, ok: false },
    { name: 'どちらも無ければ拒否される', withText: false, withPath: false, ok: false },
  ])('$name', async ({ withText, withPath, ok }) => {
    const client = await connectClient()
    const { sessionId } = await startCoveredSession(client)
    const bodyFile = path.join(baseDir, `capture-${String(withText)}-${String(withPath)}.txt`)
    await writeFile(bodyFile, EVIDENCE_TEXT, 'utf8')

    const result = await call(client, 'submit_agent_capture', {
      session_id: sessionId,
      url: 'https://example.com/quarterly',
      discovered_via: 'agent_knowledge',
      note: 'テスト',
      ...(withText ? { text: EVIDENCE_TEXT } : {}),
      ...(withPath ? { text_path: bodyFile } : {}),
    })
    expect(result.ok).toBe(ok)
    if (ok) {
      expect(result.data.text).toContain('売上は前年比 120% となった')
      expect(result.data.discovered_via).toBe('agent_knowledge')
      return
    }
    expect(result.text).toContain(
      withText && withPath ? 'text と text_path は同時に指定できない' : '本文テキストが無い',
    )
  })

  test('読めない text_path は理由つきで拒否される', async () => {
    const client = await connectClient()
    const { sessionId } = await startCoveredSession(client)
    const result = await call(client, 'submit_agent_capture', {
      session_id: sessionId,
      url: 'https://example.com/quarterly',
      text_path: path.join(baseDir, 'no-such-body.txt'),
      discovered_via: 'agent_search',
      note: 'テスト',
    })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('text_path のファイルを読めない')
  })
})

describe('本文の返却長 (text_limit)', () => {
  const LONG = 'あ'.repeat(20_000)

  test.each([
    { name: '既定は 12000 文字', limit: undefined, expected: 12_000, ok: true },
    { name: 'text_limit で短くできる', limit: 100, expected: 100, ok: true },
    { name: 'text_limit の上限 40000 は通る', limit: 40_000, expected: 20_000, ok: true },
    { name: '上限を越える text_limit は拒否される', limit: 40_001, expected: 0, ok: false },
    { name: '0 以下の text_limit は拒否される', limit: 0, expected: 0, ok: false },
  ])('$name', async ({ limit, expected, ok }) => {
    const client = await connectClient()
    const { sessionId } = await startCoveredSession(client)
    const longFile = path.join(baseDir, `long-${String(limit)}.md`)
    await writeFile(longFile, LONG, 'utf8')
    const args: Record<string, unknown> = {
      session_id: sessionId,
      source: { type: 'file', path: longFile },
      discovered_via: 'agent_search',
    }
    if (limit !== undefined) args.text_limit = limit
    const result = await call(client, 'fetch_evidence', args)
    expect(result.ok).toBe(ok)
    if (!ok) return
    expect((result.data.text as string).length).toBe(expected)
    expect(result.data.text_length).toBe(20_000)
    expect(result.data.truncated).toBe(expected < 20_000)
  })
})

/**
 * 数万文字のページから引用箇所を探すのに、先頭から窓を送っていくしかなかった。
 * find は「探した結果どこを返したか」を必ず添える — 見つからないのに先頭を返して
 * 「探したがこの窓に無かった」と読ませないため。
 */
describe('長い本文から検索語で読む (find)', () => {
  const HAYSTACK = [
    'a'.repeat(5_000),
    '北部の調査では 412 台だった。',
    'b'.repeat(5_000),
    '南部の調査では 412 台だった。',
    'c'.repeat(5_000),
  ].join('\n')

  async function fetchWithFind(args: Record<string, unknown>) {
    const client = await connectClient()
    const { sessionId } = await startCoveredSession(client)
    const file = path.join(baseDir, `find-${String(args.find)}-${String(args.text_offset)}.md`)
    await writeFile(file, HAYSTACK, 'utf8')
    return await call(client, 'fetch_evidence', {
      session_id: sessionId,
      source: { type: 'file', path: file },
      discovered_via: 'agent_search',
      ...args,
    })
  }

  test.each([
    {
      name: '一致 1 件: その周辺が返り、次の位置は無い',
      args: { find: '北部の調査' },
      found: true,
      occurrences: 1,
      hasNext: false,
      windowContains: '北部の調査では 412 台だった。',
    },
    {
      name: '一致 2 件: 件数と次の位置が返る',
      args: { find: '412 台' },
      found: true,
      occurrences: 2,
      hasNext: true,
      windowContains: '北部の調査では 412 台だった。',
    },
    {
      name: '一致 2 件 + text_offset: 2 件目から返る',
      args: { find: '412 台', text_offset: 6_000 },
      found: true,
      occurrences: 2,
      hasNext: false,
      windowContains: '南部の調査では 412 台だった。',
    },
    {
      name: '不一致: 見つからなかったと明記し、窓は検索結果ではないと書く',
      args: { find: '東部の調査' },
      found: false,
      occurrences: 0,
      hasNext: false,
      windowContains: null,
    },
    {
      name: 'text_offset より後ろに一致が無い: 件数は出すが found は false',
      args: { find: '北部の調査', text_offset: 12_000 },
      found: false,
      occurrences: 1,
      hasNext: false,
      windowContains: null,
    },
  ])('$name', async ({ args, found, occurrences, hasNext, windowContains }) => {
    const result = await fetchWithFind(args)
    expect(result.ok).toBe(true)
    const find = result.data.find as {
      found: boolean
      occurrences: number
      match: { start: number; end: number } | null
      next_occurrence_offset: number | null
      note: string
    }
    expect(find.found).toBe(found)
    expect(find.occurrences).toBe(occurrences)
    expect(find.next_occurrence_offset === null).toBe(!hasNext)
    if (windowContains === null) {
      expect(find.match).toBeNull()
      expect(find.note).toContain('検索結果ではなく')
      return
    }
    expect(find.match).not.toBeNull()
    expect(result.data.text as string).toContain(windowContains)
  })

  test('find を指定しなければ従来どおり text_offset の窓が返り、find は null', async () => {
    const result = await fetchWithFind({ text_offset: 5_000, text_limit: 40 })
    expect(result.ok).toBe(true)
    expect(result.data.find).toBeNull()
    expect(result.data.text_offset).toBe(5_000)
    expect((result.data.text as string).length).toBe(40)
  })

  test('find と text_limit は併用できる（窓の長さは text_limit に従う）', async () => {
    const result = await fetchWithFind({ find: '北部の調査', text_limit: 50 })
    expect(result.ok).toBe(true)
    expect((result.data.text as string).length).toBe(50)
  })

  /**
   * 窓の位置が固定余白（一致の 200 文字手前）だったとき、text_limit を 200 以下にすると
   * 一致が窓の外に出て、「探したがこの窓には無い」と読める応答になっていた。
   *
   * oracle: 実装の余白計算を使わず、返ってきた窓 [text_offset, text_offset + text.length) が
   * match.start を含むか、原文の長さ M が予算 L 以下なら match.end も含むかだけを見る。
   */
  const FIND_TERM = '北部の調査'
  /** 原文で 5 文字。全角混じりの語で正規化後の長さが変わる場合も別の行で見る。 */
  const CASES = [1, 2, 4, 5, 6, 10, 199, 200, 201, 12_000].flatMap((limit) =>
    [FIND_TERM, 'ｷﾞｶﾞ社の調査', '南部の調査では 412 台だった。'].map((term) => ({
      name: `text_limit=${limit} / 語=${term}`,
      limit,
      term,
    })),
  )

  test.each(CASES)('$name: 窓は必ず一致の先頭を含む', async ({ limit, term }) => {
    const client = await connectClient()
    const { sessionId } = await startCoveredSession(client)
    const file = path.join(baseDir, `find-window-${limit}-${term.length}.md`)
    // 全角半角の差を跨ぐ語も本文に置く（正規化で原文長が検索語と変わる）。
    const body = `${HAYSTACK}\nギガ社の調査は 3 件だった。`
    await writeFile(file, body, 'utf8')
    const result = await call(client, 'fetch_evidence', {
      session_id: sessionId,
      source: { type: 'file', path: file },
      discovered_via: 'agent_search',
      find: term,
      text_limit: limit,
    })
    expect(result.ok).toBe(true)
    const find = result.data.find as {
      found: boolean
      match: { start: number; end: number } | null
    }
    expect(find.found).toBe(true)
    if (find.match === null) return

    const windowStart = result.data.text_offset as number
    const windowEnd = windowStart + (result.data.text as string).length
    // ① 一致の先頭は必ず窓の中
    expect(windowStart).toBeLessThanOrEqual(find.match.start)
    expect(windowEnd).toBeGreaterThan(find.match.start)
    // ② 原文での一致長が予算以下なら、一致全体が窓の中
    const matched = find.match.end - find.match.start
    if (matched <= limit) expect(windowEnd).toBeGreaterThanOrEqual(find.match.end)
    // ③ 窓は原文のその位置の実テキスト（窓がずれていないことの独立確認）
    expect(result.data.text as string).toBe(body.slice(windowStart, windowEnd))
  })

  test.each([
    { name: '本文の先頭に一致（手前に余白を取れない）', term: 'a'.repeat(20), limit: 100 },
    { name: '本文の末尾に一致', term: 'c'.repeat(20), limit: 100 },
  ])('$name でも窓は一致の先頭を含む', async ({ term, limit }) => {
    const client = await connectClient()
    const { sessionId } = await startCoveredSession(client)
    const file = path.join(baseDir, `find-edge-${term[0] ?? 'x'}.md`)
    await writeFile(file, HAYSTACK, 'utf8')
    const result = await call(client, 'fetch_evidence', {
      session_id: sessionId,
      source: { type: 'file', path: file },
      discovered_via: 'agent_search',
      find: term,
      text_limit: limit,
    })
    expect(result.ok).toBe(true)
    const find = result.data.find as { found: boolean; match: { start: number; end: number } | null }
    expect(find.found).toBe(true)
    if (find.match === null) return
    const windowStart = result.data.text_offset as number
    const windowEnd = windowStart + (result.data.text as string).length
    expect(windowStart).toBeLessThanOrEqual(find.match.start)
    expect(windowEnd).toBeGreaterThan(find.match.start)
  })

  test('一致が予算より長いときは一部だけであることと続きの位置を書く', async () => {
    const client = await connectClient()
    const { sessionId } = await startCoveredSession(client)
    const file = path.join(baseDir, 'find-longer-than-limit.md')
    await writeFile(file, HAYSTACK, 'utf8')
    const result = await call(client, 'fetch_evidence', {
      session_id: sessionId,
      source: { type: 'file', path: file },
      discovered_via: 'agent_search',
      find: '北部の調査では 412 台だった。',
      text_limit: 5,
    })
    expect(result.ok).toBe(true)
    const find = result.data.find as { match: { start: number; end: number }; note: string }
    expect(find.note).toContain('先頭だけ')
    expect(find.note).toContain(`text_offset=${find.match.start + 5}`)
    // 窓は一致の先頭から始まる（余白 0）。
    expect(result.data.text_offset).toBe(find.match.start)
  })
})

/**
 * AI が提出した本文は、抽出に失敗していても登録できてしまう（CSS だけ・別ページ）。
 * expected_terms は意味を判定せず「申告した語が在るか」だけを見て、結果を警告として残す。
 */
describe('submit_agent_capture: expected_terms の照合', () => {
  const CAPTURED = '架空社の開示ページ（この文面はテストの作り物）。国内の新規契約は 37 件だった。'

  async function submit(expectedTerms: string[] | undefined) {
    const client = await connectClient()
    const { sessionId } = await startCoveredSession(client)
    const result = await call(client, 'submit_agent_capture', {
      session_id: sessionId,
      url: 'https://example.com/disclosure',
      text: CAPTURED,
      discovered_via: 'agent_search',
      note: 'テスト',
      ...(expectedTerms === undefined ? {} : { expected_terms: expectedTerms }),
    })
    return { client, sessionId, result }
  }

  test.each([
    {
      name: '全一致: checked=true、missing は空',
      terms: ['国内の新規契約', '37 件'],
      checked: true,
      missing: [],
    },
    {
      name: '一部不一致: 見つからない語だけが missing に出る',
      terms: ['国内の新規契約', '海外向けの出荷'],
      checked: true,
      missing: ['海外向けの出荷'],
    },
    {
      name: '全不一致: 全部 missing に出る',
      terms: ['海外向けの出荷', '営業利益'],
      checked: true,
      missing: ['海外向けの出荷', '営業利益'],
    },
    {
      name: '正規化は引用照合と同じ（全角で書いても当たる）',
      terms: ['３７ 件'],
      checked: true,
      missing: [],
    },
    { name: '未指定: checked=false（未検査）', terms: undefined, checked: false, missing: [] },
  ])('$name', async ({ terms, checked, missing }) => {
    const { result } = await submit(terms)
    expect(result.ok).toBe(true)
    const check = result.data.expected_terms as {
      checked: boolean
      terms?: string[]
      missing?: string[]
      note: string | null
    }
    expect(check.checked).toBe(checked)
    if (!checked) {
      expect(check.note).toContain('未指定')
      return
    }
    expect(check.missing).toEqual(missing)
    expect(check.terms).toEqual(terms)
  })

  test('語が見つからなくても登録はでき、警告が台帳とレポートに残る', async () => {
    const { client, sessionId, result } = await submit(['海外向けの出荷'])
    expect(result.ok).toBe(true)
    const evidenceId = result.data.evidence_id as string
    expect(evidenceId).toBe('evidence_1')

    const attached = await call(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: 'claim_1',
      evidence_id: evidenceId,
      quote: '国内の新規契約は 37 件だった。',
      relation: 'partial',
      rationale: 'テスト',
    })
    expect(attached.ok).toBe(true)

    await call(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: 'claim_1',
      verdict: 'partially_verified',
      rationale: 'テスト',
    })
    const finalized = await call(client, 'finalize', { session_id: sessionId })
    expect(finalized.ok).toBe(true)
    const markdown = await readFile(
      path.join(process.env.FACT_CHECK_DIR ?? '', sessionId, 'report.md'),
      'utf8',
    )
    expect(markdown).toContain('海外向けの出荷')
    expect(markdown).toContain('確認したい語の照合')
  })

  test('未指定の証拠はレポートに「未検査」と出る（検査して問題なしと区別する）', async () => {
    const { client, sessionId, result } = await submit(undefined)
    expect(result.ok).toBe(true)
    await call(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: 'claim_1',
      evidence_id: result.data.evidence_id as string,
      quote: '国内の新規契約は 37 件だった。',
      relation: 'partial',
      rationale: 'テスト',
    })
    await call(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: 'claim_1',
      verdict: 'partially_verified',
      rationale: 'テスト',
    })
    expect((await call(client, 'finalize', { session_id: sessionId })).ok).toBe(true)
    const markdown = await readFile(
      path.join(process.env.FACT_CHECK_DIR ?? '', sessionId, 'report.md'),
      'utf8',
    )
    expect(markdown).toContain('確認したい語の照合: 未検査')
  })
})

/**
 * start_session が全件を返していたとき、15,768 文字の元ネタが 503 件・約 3,500 行になり
 * 応答が途中で切れた。1 ページに区切ったうえで、続きを読む口と「まだ残っている」ことを返す。
 */
describe('候補区間のページング (read_source_segments)', () => {
  const LONG_SOURCE = Array.from({ length: 60 }, (_, block) =>
    Array.from({ length: 6 }, (_, i) => `第${block}段落の${i}文目は前年比 ${i}% だった。`).join(''),
  ).join('\n\n')

  async function startLongSession(args: Record<string, unknown> = {}) {
    const client = await connectClient()
    const started = await call(client, 'start_session', {
      source: { type: 'text', text: LONG_SOURCE },
      ...args,
    })
    expect(started.ok).toBe(true)
    return { client, started, sessionId: started.data.session_id as string }
  }

  type Page = {
    segments: Array<{ index: number; start: number; end: number; text: string }>
    segment_total: number
    next_segment_offset: number | null
    granularity: string
  }

  test.each([
    { name: '既定は文単位', args: {}, granularity: 'sentence' },
    {
      name: 'paragraph を指定すると段落単位',
      args: { segment_granularity: 'paragraph' },
      granularity: 'paragraph',
    },
  ])('$name: 全ページを繋ぐと本文が 1 文字も欠けずに復元できる', async ({ args, granularity }) => {
    const { client, started, sessionId } = await startLongSession(args)
    const pages: Page[] = [started.data as unknown as Page]
    expect(pages[0]?.granularity).toBe(granularity)
    expect(pages[0]?.next_segment_offset).not.toBeNull()

    let next = pages[0]?.next_segment_offset ?? null
    while (next !== null) {
      const page = await call(client, 'read_source_segments', {
        session_id: sessionId,
        segment_offset: next,
        ...args,
      })
      expect(page.ok).toBe(true)
      pages.push(page.data as unknown as Page)
      next = (page.data as unknown as Page).next_segment_offset
    }

    const segments = pages.flatMap((page) => page.segments)
    expect(segments).toHaveLength(pages[0]?.segment_total ?? -1)
    expect(segments.map((s) => s.index)).toEqual(segments.map((_, i) => i))
    expect(segments.map((s) => s.text).join('')).toBe(LONG_SOURCE)
    for (const segment of segments) {
      expect(segment.text).toBe(LONG_SOURCE.slice(segment.start, segment.end))
    }
  })

  test('段落単位のほうが候補の件数が少ない', async () => {
    const sentence = await startLongSession()
    const paragraph = await startLongSession({ segment_granularity: 'paragraph' })
    expect((paragraph.started.data as unknown as Page).segment_total).toBeLessThan(
      (sentence.started.data as unknown as Page).segment_total,
    )
  })

  test('ページを読んだだけでは網羅率は動かず、残りが返る', async () => {
    const { client, sessionId } = await startLongSession()
    const page = await call(client, 'read_source_segments', { session_id: sessionId })
    expect(page.ok).toBe(true)
    expect(page.data.coverage).toEqual({ covered: 0, total: LONG_SOURCE.length, ratio: 0 })
    expect(page.data.uncovered_ranges).toBe(1)
    expect(page.data.truncation_note as string).toContain('全部分類したことにはならない')
  })

  test('返ってきた候補はそのまま register_segments に渡せる', async () => {
    const { client, started, sessionId } = await startLongSession({
      segment_granularity: 'paragraph',
      max_segments: 3,
    })
    const page = started.data as unknown as Page
    const registered = await call(client, 'register_segments', {
      session_id: sessionId,
      items: page.segments.map((segment) => ({
        kind: 'non_claim',
        start: segment.start,
        end: segment.end,
        reason: 'テスト',
      })),
    })
    expect(registered.ok).toBe(true)
    expect(registered.data.registered_count).toBe(3)
  })

  test.each([
    { name: '存在しない session_id は拒否される', args: { session_id: 'no-such-session' }, ok: false },
    { name: 'segment_offset が負なら拒否される', args: { segment_offset: -1 }, ok: false },
    { name: 'max_segments が 0 なら拒否される', args: { max_segments: 0 }, ok: false },
    { name: 'max_segments が上限超なら拒否される', args: { max_segments: 501 }, ok: false },
    { name: '知らない granularity は拒否される', args: { segment_granularity: 'word' }, ok: false },
    { name: 'offset が総数を超えたら空ページを返す', args: { segment_offset: 99_999 }, ok: true },
  ])('$name', async ({ args, ok }) => {
    const { client, sessionId } = await startLongSession()
    const page = await call(client, 'read_source_segments', { session_id: sessionId, ...args })
    expect(page.ok).toBe(ok)
    if (!ok) return
    expect(page.data.segments).toEqual([])
    expect(page.data.next_segment_offset).toBeNull()
  })
})

describe('レポートの要確認一覧', () => {
  /** verdict の違う claim を 4 件持つセッションを作り、finalize まで通す。 */
  async function finalizeMixedSession(client: Client) {
    const text = ['一つ目の主張。', '二つ目の主張。', '三つ目の主張。', '四つ目の主張。'].join('')
    const started = await call(client, 'start_session', { source: { type: 'text', text } })
    const sessionId = started.data.session_id as string
    const size = '一つ目の主張。'.length
    const registered = await call(client, 'register_segments', {
      session_id: sessionId,
      items: [0, 1, 2, 3].map((index) => ({
        kind: 'claim',
        start: index * size,
        end: (index + 1) * size,
        claim: `${index} 番目の主張`,
      })),
    })
    expect(registered.ok).toBe(true)

    await attachLocalEvidence(client, sessionId, 'claim_1', '売上は前年比 120% となった', 'supports')
    await attachLocalEvidence(
      client,
      sessionId,
      'claim_2',
      '営業利益は前年比 95% にとどまった',
      'contradicts',
    )
    const verdicts = [
      { claimId: 'claim_1', verdict: 'verified', rationale: '証拠どおり' },
      { claimId: 'claim_2', verdict: 'contradicted', rationale: '証拠は 95% で矛盾する' },
      { claimId: 'claim_3', verdict: 'partially_verified', rationale: '一部しか確認できない' },
      { claimId: 'claim_4', verdict: 'unverifiable', rationale: '出典に当たれなかった' },
    ]
    for (const item of verdicts) {
      const result = await call(client, 'set_verdict', {
        session_id: sessionId,
        claim_id: item.claimId,
        verdict: item.verdict,
        rationale: item.rationale,
      })
      expect(result.ok).toBe(true)
    }
    const finalized = await call(client, 'finalize', { session_id: sessionId })
    expect(finalized.ok).toBe(true)
    return finalized.data.report as { markdown: string; json: string; html: string }
  }

  test('report.json の attention は重い順に並び、verified を含まない', async () => {
    const client = await connectClient()
    const report = await finalizeMixedSession(client)
    const json = JSON.parse(await readFile(report.json, 'utf8')) as {
      attention: Array<{ claim_id: string; verdict: string; rationale: string; source_text: string }>
    }
    expect(json.attention.map((item) => item.verdict)).toEqual([
      'contradicted',
      'partially_verified',
      'unverifiable',
    ])
    expect(json.attention.map((item) => item.claim_id)).toEqual(['claim_2', 'claim_3', 'claim_4'])
    expect(json.attention.some((item) => item.claim_id === 'claim_1')).toBe(false)
    expect(json.attention[0]?.rationale).toBe('証拠は 95% で矛盾する')
    expect(json.attention[0]?.source_text).toBe('二つ目の主張。')
  })

  test('report.md の要確認一覧は集計の直後に出て、順序も件数も json と揃う', async () => {
    const client = await connectClient()
    const report = await finalizeMixedSession(client)
    const markdown = await readFile(report.markdown, 'utf8')
    const attentionAt = markdown.indexOf('## 要確認一覧')
    expect(attentionAt).toBeGreaterThan(0)
    expect(attentionAt).toBeLessThan(markdown.indexOf('## 主張ごとの判定'))
    expect(markdown).toContain('verified 以外の 3 件')

    const table = markdown.slice(attentionAt, markdown.indexOf('## 主張ごとの判定'))
    expect(table.indexOf('claim_2')).toBeLessThan(table.indexOf('claim_3'))
    expect(table.indexOf('claim_3')).toBeLessThan(table.indexOf('claim_4'))
    expect(table).not.toContain('claim_1')
  })

  test('report.html に要確認の並びと本文の塗り分けが埋め込まれる', async () => {
    const client = await connectClient()
    const report = await finalizeMixedSession(client)
    const html = await readFile(report.html, 'utf8')

    // 画面の見出し文字列では確かめない（UI の作りを変えるたびに落ちるだけで、何も守らない）。
    // ブラウザ側は埋め込みデータから描くので、守るべき契約はデータの中身と器の有無。
    const payload = readEmbeddedJson(html, 'fact-check-data') as ViewerPayload
    // 重い順に並び、verified の claim_1 は載らない
    expect(payload.attention.map((item) => item.claim_id)).toEqual(['claim_2', 'claim_3', 'claim_4'])
    expect(payload.attention[0]?.verdict).toBe('contradicted')
    const claimIds = payload.spans.flatMap((span) => span.claim_ids)
    expect(claimIds).toContain('claim_1')
    expect(claimIds).toContain('claim_2')
    expect(payload.source_text.length).toBe(payload.summary.coverage.total)
  })

  /**
   * ブラウザ側が描き込む器が HTML に在ることだけを見る（中身は e2e が実ブラウザで確かめる）。
   * 器の id が消えると画面は白紙になるが、埋め込みデータは正しいままなので上のテストは通ってしまう。
   */
  test.each([
    { name: '主張一覧', id: 'nav-body' },
    { name: '主張一覧の件数', id: 'nav-count' },
    { name: '元ネタ本文', id: 'source-body' },
    { name: '詳細', id: 'detail-body' },
    { name: '前の主張へ', id: 'prev-claim' },
    { name: '次の主張へ', id: 'next-claim' },
    { name: '位置表示', id: 'claim-position' },
    { name: '判定フィルター', id: 'chips' },
    { name: '警告', id: 'global-warn' },
    { name: '印刷用', id: 'printAll' },
    { name: '画像の原寸表示', id: 'lightbox' },
    { name: '原寸表示を閉じる', id: 'lightbox-close' },
  ])('report.html に $name の器がある (id=$id)', async ({ id }) => {
    const client = await connectClient()
    const report = await finalizeMixedSession(client)
    const html = await readFile(report.html, 'utf8')
    expect(html).toContain(`id="${id}"`)
  })

  test('画像の原寸表示はブラウザ標準の dialog で、閉じるボタンを持つ', async () => {
    const client = await connectClient()
    const report = await finalizeMixedSession(client)
    const html = await readFile(report.html, 'utf8')
    // 自前のオーバーレイに戻すと Escape とフォーカス復帰を自分で書くことになる。
    expect(html).toContain('<dialog id="lightbox"')
    expect(html).toContain('id="lightbox-close"')
  })

  test('要確認の claim が無ければ、その旨が出る', async () => {
    const client = await connectClient()
    const { sessionId, claimId } = await startCoveredSession(client)
    await attachLocalEvidence(client, sessionId, claimId, '売上は前年比 120% となった', 'supports')
    await call(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimId,
      verdict: 'verified',
      rationale: '証拠どおり',
    })
    const finalized = await call(client, 'finalize', { session_id: sessionId })
    expect(finalized.ok).toBe(true)
    const report = finalized.data.report as { markdown: string; json: string }
    expect(await readFile(report.markdown, 'utf8')).toContain(
      '矛盾・一部のみ裏取り・裏取り不能と判定された主張はありません。',
    )
    const json = JSON.parse(await readFile(report.json, 'utf8')) as { attention: unknown[] }
    expect(json.attention).toEqual([])
  })
})

describe('証拠の出どころ (discovered_via)', () => {
  test.each([
    { value: 'cited_in_source', label: '元ネタが出典として示していた' },
    { value: 'agent_search', label: 'AI が検索などで見つけた' },
    { value: 'agent_knowledge', label: 'AI が自分の知識から当たった' },
  ])('$value は台帳とレポートに残る', async ({ value, label }) => {
    const client = await connectClient()
    const { sessionId, claimId } = await startCoveredSession(client)
    const evidence = await call(client, 'fetch_evidence', {
      session_id: sessionId,
      source: { type: 'file', path: evidenceFile },
      discovered_via: value,
      discovery_note: '出どころの補足',
    })
    expect(evidence.ok).toBe(true)
    expect(evidence.data.discovered_via).toBe(value)

    const attached = await call(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claimId,
      evidence_id: evidence.data.evidence_id as string,
      quote: '売上は前年比 120% となった',
      relation: 'supports',
      rationale: 'テスト',
    })
    expect(attached.ok).toBe(true)
    await call(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimId,
      verdict: 'verified',
      rationale: '証拠どおり',
    })
    const finalized = await call(client, 'finalize', { session_id: sessionId })
    expect(finalized.ok).toBe(true)
    const report = finalized.data.report as { markdown: string; json: string; html: string }

    const json = JSON.parse(await readFile(report.json, 'utf8')) as {
      ledger: { evidence: Array<{ discovered_via: string; discovery_note: string | null }> }
    }
    expect(json.ledger.evidence[0]?.discovered_via).toBe(value)
    expect(json.ledger.evidence[0]?.discovery_note).toBe('出どころの補足')

    // 証拠ごとの表示と末尾の証拠一覧の両方に出ること（2 箇所以上に現れる）。
    const markdown = await readFile(report.markdown, 'utf8')
    expect(markdown.split(`出どころ: ${label} — 出どころの補足`).length - 1).toBeGreaterThanOrEqual(2)
    // html は埋め込んだ台帳から描くので、台帳の値と、その値に対応する文言の両方を確かめる。
    const html = await readFile(report.html, 'utf8')
    const payload = readEmbeddedJson(html, 'fact-check-data') as ViewerPayload
    expect(payload.ledger.evidence[0]?.discovered_via).toBe(value)
    expect(payload.ledger.evidence[0]?.discovery_note).toBe('出どころの補足')
    const labels = readEmbeddedJson(html, 'fact-check-labels') as {
      discovered_via: Record<string, string>
    }
    expect(labels.discovered_via[value]).toBe(label)
  })

  test('discovered_via を渡さなければ拒否される', async () => {
    const client = await connectClient()
    const { sessionId } = await startCoveredSession(client)
    const result = await call(client, 'fetch_evidence', {
      session_id: sessionId,
      source: { type: 'file', path: evidenceFile },
    })
    expect(result.ok).toBe(false)
  })
})

describe('ローカルの PDF を証拠にする', () => {
  test('本文が抽出され、元の PDF とページ境界が保存される', async () => {
    const client = await connectClient()
    const { sessionId } = await startCoveredSession(client)
    const pdfPath = path.join(baseDir, 'filing.pdf')
    await writeFile(
      pdfPath,
      buildSamplePdf([
        ['Fictional filing page one', 'This fixture is generated by the test.'],
        ['Page two heading', 'The northern survey counted 412 units in total.'],
      ]),
    )

    const evidence = await call(client, 'fetch_evidence', {
      session_id: sessionId,
      source: { type: 'file', path: pdfPath },
      discovered_via: 'cited_in_source',
    })
    expect(evidence.ok).toBe(true)
    expect(evidence.data.provenance).toBe('file')
    expect(evidence.data.pdf_pages).toBe(2)
    expect(evidence.data.text).toContain('The northern survey counted 412 units in total.')

    const saved = evidence.data.saved as { pdf_path: string | null; text_path: string }
    expect(saved.pdf_path).toMatch(/\.pdf$/)
    const savedPdf = await readFile(
      path.join(process.env.FACT_CHECK_DIR ?? '', sessionId, saved.pdf_path ?? ''),
    )
    expect(savedPdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  test('PDF でないファイルには pdf の記録が付かない', async () => {
    const client = await connectClient()
    const { sessionId } = await startCoveredSession(client)
    const evidence = await call(client, 'fetch_evidence', {
      session_id: sessionId,
      source: { type: 'file', path: evidenceFile },
      discovered_via: 'cited_in_source',
    })
    expect(evidence.ok).toBe(true)
    expect(evidence.data.pdf_pages).toBeNull()
    expect((evidence.data.saved as { pdf_path: string | null }).pdf_path).toBeNull()
  })
})

/**
 * 取り消し・復元。
 *
 * ここで守りたい不変条件は 4 つで、どれも「取り消しが見せかけになっていない」ことに帰着する:
 *   (1) 取り消した範囲は網羅率の根拠にならない
 *   (2) 取り消した証拠・添付・その親は判定の根拠にならない
 *   (3) 根拠が無くなった判定のまま finalize が通らない
 *   (4) 何も消えない。履歴と元レコードとファイルは残る
 */
describe('revise_record: 取り消しと復元', () => {
  /** claim 1 + non_claim 1 + supports の添付 1 + verified の判定、という finalize 直前の状態。 */
  async function readySession(client: Client) {
    const { sessionId, claimId } = await startCoveredSession(client)
    const attached = await attachLocalEvidence(
      client,
      sessionId,
      claimId,
      '当期の売上は前年比 120% となった。',
      'supports',
    )
    expect(attached.ok).toBe(true)
    const verdict = await call(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimId,
      verdict: 'verified',
      rationale: '引用が一致',
    })
    expect(verdict.ok).toBe(true)
    const status = await call(client, 'get_status', { session_id: sessionId })
    return {
      sessionId,
      claimId,
      attachmentId: attached.data.attachment_id as string,
      evidenceId: (attached.data as { attachment_id: string }) && (status.data.summary as never),
    }
  }

  async function statusOf(client: Client, sessionId: string) {
    const status = await call(client, 'get_status', { session_id: sessionId })
    expect(status.ok).toBe(true)
    return status.data as {
      summary: {
        coverage: { complete: boolean; covered: number }
        claims: { total: number }
        non_claims: number
        evidence: { total: number }
        attachments: { total: number }
        exclusions: { active: number; restored: number; total: number }
      }
      finalize_ready: boolean
      archived: boolean
      exclusions: Array<{ id: string; target_id: string; restored: unknown }>
      verdicts_without_basis: Array<{ claim_id: string }>
    }
  }

  test('取り消した claim は網羅率にも件数にも入らない（復元で戻る）', async () => {
    const client = await connectClient()
    const { sessionId, claimId } = await readySession(client)
    const before = await statusOf(client, sessionId)
    expect(before.summary.coverage.complete).toBe(true)
    expect(before.summary.claims.total).toBe(1)

    const excluded = await call(client, 'revise_record', {
      session_id: sessionId,
      action: 'exclude',
      target_type: 'claim',
      target_id: claimId,
      reason: '範囲を取り違えた',
    })
    expect(excluded.ok).toBe(true)

    const after = await statusOf(client, sessionId)
    expect(after.summary.claims.total).toBe(0)
    expect(after.summary.coverage.complete).toBe(false)
    expect(after.summary.attachments.total).toBe(0)
    expect(after.summary.exclusions).toEqual({ active: 1, restored: 0, total: 1 })
    expect(after.finalize_ready).toBe(false)

    const restored = await call(client, 'revise_record', {
      session_id: sessionId,
      action: 'restore',
      target_type: 'claim',
      target_id: claimId,
      reason: 'やはり必要だった',
    })
    expect(restored.ok).toBe(true)
    const back = await statusOf(client, sessionId)
    expect(back.summary.claims.total).toBe(1)
    expect(back.summary.coverage.complete).toBe(true)
    expect(back.summary.attachments.total).toBe(1)
    expect(back.summary.exclusions).toEqual({ active: 0, restored: 1, total: 1 })
    expect(back.finalize_ready).toBe(true)
  })

  test('根拠を取り消すと判定が宙に浮き、finalize が拒否する', async () => {
    const client = await connectClient()
    const { sessionId, attachmentId } = await readySession(client)
    const excluded = await call(client, 'revise_record', {
      session_id: sessionId,
      action: 'exclude',
      target_type: 'attachment',
      target_id: attachmentId,
      reason: '引用の関係を取り違えた',
    })
    expect(excluded.ok).toBe(true)
    expect((excluded.data.verdicts_without_basis as unknown[]).length).toBe(1)

    const status = await statusOf(client, sessionId)
    expect(status.verdicts_without_basis.length).toBe(1)
    expect(status.finalize_ready).toBe(false)

    const finalized = await call(client, 'finalize', { session_id: sessionId })
    expect(finalized.ok).toBe(false)
    expect(finalized.text).toContain('根拠が無くなっている')
  })

  test('親の claim を取り消すと、その添付は判定の根拠にならない', async () => {
    const client = await connectClient()
    const { sessionId, claimId } = await readySession(client)
    await call(client, 'revise_record', {
      session_id: sessionId,
      action: 'exclude',
      target_type: 'claim',
      target_id: claimId,
      reason: '主張の切り方が誤り',
    })
    // 親が取り消されている間は、その claim を相手にする操作そのものを受け付けない。
    const reverdict = await call(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimId,
      verdict: 'verified',
      rationale: '取り消し中',
    })
    expect(reverdict.ok).toBe(false)
    expect(reverdict.text).toContain('取り消されている')
  })

  test('親を復元しても、個別に取り消した子は取り消されたまま', async () => {
    const client = await connectClient()
    const { sessionId, claimId, attachmentId } = await readySession(client)
    // 子（添付）を先に個別に取り消し、そのあと親（主張）も取り消す。
    for (const target of [
      { type: 'attachment', id: attachmentId, reason: 'この引用は関係なかった' },
      { type: 'claim', id: claimId, reason: '主張ごと作り直す' },
    ]) {
      const done = await call(client, 'revise_record', {
        session_id: sessionId,
        action: 'exclude',
        target_type: target.type,
        target_id: target.id,
        reason: target.reason,
      })
      expect(done.ok).toBe(true)
    }
    await call(client, 'revise_record', {
      session_id: sessionId,
      action: 'restore',
      target_type: 'claim',
      target_id: claimId,
      reason: '主張は残す',
    })
    const status = await statusOf(client, sessionId)
    expect(status.summary.claims.total).toBe(1)
    // 親は戻ったが、自分で取り消した添付は戻らない。
    expect(status.summary.attachments.total).toBe(0)
    expect(status.summary.exclusions).toEqual({ active: 1, restored: 1, total: 2 })
  })

  test.each([
    {
      name: '同じものを 2 回取り消すと、既存の取り消しを示して拒否する',
      first: 'exclude',
      second: 'exclude',
      expected: 'すでに取り消されている',
    },
    {
      name: '取り消していないものを復元しようとすると、戻すものが無いと言う',
      first: 'restore',
      second: 'restore',
      expected: '取り消されていないので',
    },
  ])('$name', async ({ first, second, expected }) => {
    const client = await connectClient()
    const { sessionId, claimId } = await readySession(client)
    if (first === 'exclude') {
      const done = await call(client, 'revise_record', {
        session_id: sessionId,
        action: 'exclude',
        target_type: 'claim',
        target_id: claimId,
        reason: '1 回目',
      })
      expect(done.ok).toBe(true)
    }
    const again = await call(client, 'revise_record', {
      session_id: sessionId,
      action: second,
      target_type: 'claim',
      target_id: claimId,
      reason: '2 回目',
    })
    expect(again.ok).toBe(false)
    expect(again.text).toContain(expected)
  })

  test('存在しない id は、登録済みの id を並べて拒否する', async () => {
    const client = await connectClient()
    const { sessionId } = await readySession(client)
    const missing = await call(client, 'revise_record', {
      session_id: sessionId,
      action: 'exclude',
      target_type: 'claim',
      target_id: 'claim_999',
      reason: '打ち間違い',
    })
    expect(missing.ok).toBe(false)
    expect(missing.text).toContain('claim_999')
    expect(missing.text).toContain('claim_1')
  })

  test('session を取り消すと台帳を変える操作を受け付けず、復元で戻る', async () => {
    const client = await connectClient()
    const { sessionId } = await readySession(client)
    const archived = await call(client, 'revise_record', {
      session_id: sessionId,
      action: 'exclude',
      target_type: 'session',
      target_id: sessionId,
      reason: '別のセッションでやり直す',
    })
    expect(archived.ok).toBe(true)
    expect((await statusOf(client, sessionId)).archived).toBe(true)

    const blocked = await call(client, 'register_claim', {
      session_id: sessionId,
      start: 0,
      end: 3,
      claim: '保管中の追加',
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.text).toContain('保管されている')

    const back = await call(client, 'revise_record', {
      session_id: sessionId,
      action: 'restore',
      target_type: 'session',
      target_id: sessionId,
      reason: '続きをやる',
    })
    expect(back.ok).toBe(true)
    expect((await statusOf(client, sessionId)).archived).toBe(false)
  })

  test('取り消しても元のレコードと保存ファイルは消えない（履歴に理由と時刻が残る）', async () => {
    const client = await connectClient()
    const { sessionId, attachmentId } = await readySession(client)
    await call(client, 'revise_record', {
      session_id: sessionId,
      action: 'exclude',
      target_type: 'attachment',
      target_id: attachmentId,
      reason: '関係の取り違え',
    })
    const ledgerPath = path.join(process.env.FACT_CHECK_DIR ?? '', sessionId, 'ledger.json')
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      attachments: Array<{ id: string }>
      evidence: Array<{ text_path: string }>
      exclusions: Array<{ target_id: string; reason: string; excluded_at: string; restored: unknown }>
    }
    expect(ledger.attachments.map((a) => a.id)).toContain(attachmentId)
    expect(ledger.exclusions).toHaveLength(1)
    expect(ledger.exclusions[0]?.reason).toBe('関係の取り違え')
    expect(ledger.exclusions[0]?.excluded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(ledger.exclusions[0]?.restored).toBeNull()
    // 証拠として保存した本文も残っている。
    const savedText = await readFile(
      path.join(process.env.FACT_CHECK_DIR ?? '', sessionId, ledger.evidence[0]?.text_path ?? ''),
      'utf8',
    )
    expect(savedText).toContain('当期の売上は前年比 120% となった。')
  })

  test('取り消し後は 3 形式すべてが同じ集計になり、履歴が全部に出る', async () => {
    const client = await connectClient()
    const { sessionId, claimId } = await readySession(client)
    const finalized = await call(client, 'finalize', { session_id: sessionId })
    expect(finalized.ok).toBe(true)

    const excluded = await call(client, 'revise_record', {
      session_id: sessionId,
      action: 'exclude',
      target_type: 'claim',
      target_id: claimId,
      reason: '主張の切り方が誤り',
    })
    expect(excluded.ok).toBe(true)
    // finalize 済みだったので、3 形式とも書き直されている（古い内容が残らない）。
    expect(excluded.data.reports_rewritten).toEqual(['report.md', 'report.json', 'report.html'])

    const dir = path.join(process.env.FACT_CHECK_DIR ?? '', sessionId)
    const markdown = await readFile(path.join(dir, 'report.md'), 'utf8')
    const reportJson = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8')) as {
      summary: { claims: { total: number }; exclusions: { active: number } }
      ledger: { exclusions: Array<{ reason: string }> }
    }
    const html = await readFile(path.join(dir, 'report.html'), 'utf8')
    const payload = readEmbeddedJson(html, 'fact-check-data') as ViewerPayload

    const status = await statusOf(client, sessionId)
    expect(reportJson.summary.claims.total).toBe(status.summary.claims.total)
    expect(payload.summary.claims.total).toBe(status.summary.claims.total)
    expect(reportJson.summary.exclusions.active).toBe(1)
    expect(payload.summary.exclusions.active).toBe(1)
    // 履歴と理由は 3 形式すべてから読める。
    expect(markdown).toContain('## 取り消し履歴')
    expect(markdown).toContain('主張の切り方が誤り')
    expect(reportJson.ledger.exclusions[0]?.reason).toBe('主張の切り方が誤り')
    expect(payload.ledger.exclusions[0]?.reason).toBe('主張の切り方が誤り')
    // finalize を通していないことが、どの形式でも分かる。
    expect(markdown).toContain('finalize を通していない暫定表示')
    expect(payload.ledger.reports_stale_since).not.toBeNull()
  })

  test('finalize すると暫定表示の印が消える', async () => {
    const client = await connectClient()
    const { sessionId } = await readySession(client)
    const finalized = await call(client, 'finalize', { session_id: sessionId })
    expect(finalized.ok).toBe(true)
    const dir = path.join(process.env.FACT_CHECK_DIR ?? '', sessionId)
    const markdown = await readFile(path.join(dir, 'report.md'), 'utf8')
    expect(markdown).not.toContain('finalize を通していない暫定表示')
    const status = await statusOf(client, sessionId)
    expect(status).toMatchObject({ finalize_ready: true })
  })
})

/**
 * 台帳の保存形式の版。
 *
 * 版を 3 に上げた理由: 取り消し (`exclusions`) を知らない 0.1.1 は、取り消した記録まで
 * 集計に入れてしまう。版が 2 のままだと 0.1.1 が黙って読んでしまうので、**読めないことを
 * 版で示す**。一方こちらは version 2 のセッションを読み続ける（利用者の途中の仕事を捨てない）。
 *
 * ここで固定するのは 4 つ:
 *   1. 読める版と読めない版（version 1 / 不明 / 型違い / 欠落は既定値で救わない）
 *   2. 保存したら必ず今の版になる（version 2 のセッションを更新すると 3 になる）
 *   3. **読むだけならファイルを 1 バイトも変えない**（利用者が旧版へ戻す道を、読んだだけで塞がない）
 *   4. 読むだけの経路（report:rebuild / セッション一覧）は今までどおり版を問わない
 */
describe('台帳の保存形式の版', () => {
  const ledgerPathOf = (sessionId: string): string =>
    path.join(process.env.FACT_CHECK_DIR ?? '', sessionId, 'ledger.json')

  /** 台帳の version だけを差し替える。ほかの項目は触らない。 */
  async function setLedgerVersion(sessionId: string, version: unknown): Promise<string> {
    const ledgerPath = ledgerPathOf(sessionId)
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Record<string, unknown>
    if (version === undefined) delete ledger.version
    else ledger.version = version
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`)
    return ledgerPath
  }

  test('新しく作った台帳は今の版で保存される', async () => {
    const client = await connectClient()
    const { sessionId } = await startCoveredSession(client)
    const ledger = JSON.parse(await readFile(ledgerPathOf(sessionId), 'utf8')) as { version: number }
    expect(ledger.version).toBe(LEDGER_VERSION)
    expect(LEDGER_VERSION).toBe(3)
  })

  // 受入と拒否は見るものが違う（拒否は文面まで見る）ので、表を分ける。
  test.each([
    { name: '今の版 (3)', version: 3 },
    { name: '1 つ前の版 (2)', version: 2 },
  ])('$name の台帳は読める', async ({ version }) => {
    const client = await connectClient()
    const { sessionId } = await startCoveredSession(client)
    await setLedgerVersion(sessionId, version)

    const status = await call(client, 'get_status', { session_id: sessionId })
    expect(status.ok).toBe(true)
  })

  test.each([
    { name: '古すぎる版 (1)', version: 1, shown: '1' },
    { name: '知らない版 (99)', version: 99, shown: '99' },
    { name: '版が文字列', version: '3', shown: '3' },
    { name: '版が欠落', version: undefined, shown: 'undefined' },
  ])('$name の台帳は拒否され、読める版と実際の版が出る', async ({ version, shown }) => {
    const client = await connectClient()
    const { sessionId } = await startCoveredSession(client)
    const ledgerPath = await setLedgerVersion(sessionId, version)

    const status = await call(client, 'get_status', { session_id: sessionId })
    expect(status.ok).toBe(false)
    expect(status.text).toContain('読めるのは version=')
    expect(status.text).toContain('2, 3')
    expect(status.text).toContain(`実際=${shown}`)
    expect(status.text).toContain(ledgerPath)
  })

  test('version 2 のセッションは読めて、更新すると今の版で保存される', async () => {
    const client = await connectClient()
    const { sessionId, claimId } = await startCoveredSession(client)
    const ledgerPath = await setLedgerVersion(sessionId, 2)

    // 読める。
    const status = await call(client, 'get_status', { session_id: sessionId })
    expect(status.ok).toBe(true)

    // 更新すると版が上がる（保存のときだけ）。
    const excluded = await call(client, 'revise_record', {
      session_id: sessionId,
      action: 'exclude',
      target_type: 'claim',
      target_id: claimId,
      reason: '版が上がることの確認',
    })
    expect(excluded.ok).toBe(true)
    const after = JSON.parse(await readFile(ledgerPath, 'utf8')) as { version: number }
    expect(after.version).toBe(LEDGER_VERSION)
  })

  test('読むだけの操作は、古い版の台帳を書き換えない', async () => {
    const client = await connectClient()
    const { sessionId } = await startCoveredSession(client)
    const ledgerPath = await setLedgerVersion(sessionId, 2)
    const before = await readFile(ledgerPath, 'utf8')

    for (const [name, args] of [
      ['get_status', { session_id: sessionId }],
      ['read_source_segments', { session_id: sessionId }],
    ] as const) {
      const result = await call(client, name, args)
      expect(result.ok).toBe(true)
    }
    // 読んだだけで版が上がると、利用者が旧版へ戻す道を勝手に塞ぐことになる。
    expect(await readFile(ledgerPath, 'utf8')).toBe(before)
  })

  test('読むだけの経路（report:rebuild）は今までどおり版を問わない', async () => {
    const client = await connectClient()
    const { sessionId, claimId } = await startCoveredSession(client)
    const attached = await attachLocalEvidence(
      client,
      sessionId,
      claimId,
      '当期の売上は前年比 120% となった。',
      'supports',
    )
    expect(attached.ok).toBe(true)
    expect(
      (
        await call(client, 'set_verdict', {
          session_id: sessionId,
          claim_id: claimId,
          verdict: 'verified',
          rationale: '引用が一致',
        })
      ).ok,
    ).toBe(true)
    expect((await call(client, 'finalize', { session_id: sessionId })).ok).toBe(true)

    const directory = path.join(process.env.FACT_CHECK_DIR ?? '', sessionId)
    const reportPath = path.join(directory, 'report.json')
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      ledger: { version: number }
    }
    // finalize が書いた report.json の台帳も今の版。
    expect(report.ledger.version).toBe(LEDGER_VERSION)

    // 版を 1 に落としても、読むだけの経路は読める（過去のセッションを二度と開けなくしない）。
    report.ledger.version = 1
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    const rebuilt = await rebuildReportHtml(directory)
    expect(rebuilt.ledgerVersion).toBe(1)
  })
})

/**
 * 後から足した項目（取り消し履歴・レポートの鮮度・画像の試行記録）の検証。
 *
 * 直す前は `!Array.isArray(...)` で判定して既定値を入れていたので、履歴が壊れた台帳を読むと
 * **取り消し履歴が空になり、取り消したはずの全レコードが復活した状態**として通っていた。
 * 「無い」（旧台帳）と「壊れている」を必ず分ける。
 */
describe('壊れた台帳を空として読まない', () => {
  /** 1 件目の添付。壊す対象がいることは呼び出し側が保証している。 */
  function firstAttachment(ledger: Record<string, unknown>): Record<string, unknown> {
    const attachments = ledger.attachments as Array<Record<string, unknown>>
    const first = attachments[0]
    if (first === undefined) throw new Error('壊す対象の添付がない（テストの前提が崩れている）')
    return first
  }

  async function writeLedgerFile(sessionId: string, mutate: (ledger: Record<string, unknown>) => void) {
    const ledgerPath = path.join(process.env.FACT_CHECK_DIR ?? '', sessionId, 'ledger.json')
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Record<string, unknown>
    mutate(ledger)
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`)
    return ledgerPath
  }

  test.each([
    {
      name: 'exclusions が文字列',
      break: (l: Record<string, unknown>) => {
        l.exclusions = '壊れた'
      },
      expect: ['exclusions が配列でない', 'string'],
    },
    {
      name: 'exclusions が null',
      break: (l: Record<string, unknown>) => {
        l.exclusions = null
      },
      expect: ['exclusions が配列でない', 'null'],
    },
    {
      name: '履歴の要素の target_type が知らない値',
      break: (l: Record<string, unknown>) => {
        l.exclusions = [
          {
            id: 'exclusion_1',
            target_type: 'なにか',
            target_id: 'claim_1',
            reason: 'r',
            excluded_at: 'now',
            restored: null,
          },
        ]
      },
      expect: ['exclusions[0].target_type', 'なにか'],
    },
    {
      name: '履歴の要素の restored が無い',
      break: (l: Record<string, unknown>) => {
        l.exclusions = [
          { id: 'exclusion_1', target_type: 'claim', target_id: 'claim_1', reason: 'r', excluded_at: 'now' },
        ]
      },
      expect: ['exclusions[0].restored が無い'],
    },
    {
      name: '履歴の要素の restored の形が違う',
      break: (l: Record<string, unknown>) => {
        l.exclusions = [
          {
            id: 'exclusion_1',
            target_type: 'claim',
            target_id: 'claim_1',
            reason: 'r',
            excluded_at: 'now',
            restored: { reason: 1 },
          },
        ]
      },
      expect: ['exclusions[0].restored.reason', 'exclusions[0].restored.at'],
    },
    {
      name: 'reports_stale_since が数値',
      break: (l: Record<string, unknown>) => {
        l.reports_stale_since = 12345
      },
      expect: ['reports_stale_since', 'number'],
    },
    {
      name: 'screenshot_attempts が文字列',
      break: (l: Record<string, unknown>) => {
        firstAttachment(l).screenshot_attempts = 'こわれ'
      },
      expect: ['attachments[0].screenshot_attempts が配列でない', 'string'],
    },
    {
      name: 'screenshot_attempts の要素の形が違う',
      break: (l: Record<string, unknown>) => {
        firstAttachment(l).screenshot_attempts = [
          { source: 'なにか', path: 1, highlighted: 'yes', note: 2, adopted: 'no' },
        ]
      },
      expect: [
        'attachments[0].screenshot_attempts[0].source',
        'attachments[0].screenshot_attempts[0].highlighted',
        'attachments[0].screenshot_attempts[0].adopted',
      ],
    },
    {
      name: 'screenshot_source が知らない値',
      break: (l: Record<string, unknown>) => {
        firstAttachment(l).screenshot_source = 'live_page'
      },
      expect: ['attachments[0].screenshot_source', 'live_page'],
    },
  ])(
    '$name は、どの項目がどう壊れているかを言って拒否する',
    async ({ break: breakIt, expect: fragments }) => {
      const client = await connectClient()
      const { sessionId, claimId } = await startCoveredSession(client)
      const attached = await attachLocalEvidence(
        client,
        sessionId,
        claimId,
        '当期の売上は前年比 120% となった。',
        'supports',
      )
      expect(attached.ok).toBe(true)
      const ledgerPath = await writeLedgerFile(sessionId, breakIt)
      const broken = await readFile(ledgerPath, 'utf8')

      const status = await call(client, 'get_status', { session_id: sessionId })
      expect(status.ok).toBe(false)
      for (const fragment of fragments) expect(status.text).toContain(fragment)
      expect(status.text).toContain(ledgerPath)

      // 壊れた台帳を上書きしない。書き込む側のツールも拒否し、ファイルは 1 バイトも変わらない。
      const write = await call(client, 'revise_record', {
        session_id: sessionId,
        action: 'exclude',
        target_type: 'claim',
        target_id: claimId,
        reason: '壊れた台帳への書き込み',
      })
      expect(write.ok).toBe(false)
      expect(await readFile(ledgerPath, 'utf8')).toBe(broken)
    },
  )

  test('項目が「無い」だけの旧台帳は今までどおり読める', async () => {
    const client = await connectClient()
    const { sessionId } = await startCoveredSession(client)
    const ledgerPath = await writeLedgerFile(sessionId, (ledger) => {
      delete ledger.exclusions
      delete ledger.reports_stale_since
      for (const attachment of ledger.attachments as Array<Record<string, unknown>>) {
        delete attachment.screenshot_attempts
      }
    })
    expect(ledgerPath).toContain(sessionId)
    const status = await call(client, 'get_status', { session_id: sessionId })
    expect(status.ok).toBe(true)
    expect(status.data.exclusions).toEqual([])
  })
})

/**
 * 保存の順序。**台帳が先、レポートが後。**
 * 逆にすると、レポートの書き出しが成功して台帳の保存が失敗したとき、
 * レポートが「保存されていない台帳の内容」を最新の結果として見せる。
 */
describe('台帳の保存とレポートの書き出しの順序', () => {
  /** report.json の位置にディレクトリを置いて、2 形式目の書き出しだけを確実に失敗させる。 */
  async function blockReportJson(sessionId: string) {
    const target = path.join(process.env.FACT_CHECK_DIR ?? '', sessionId, 'report.json')
    await rm(target, { force: true })
    await mkdir(target, { recursive: true })
    return target
  }

  async function readySession(client: Client) {
    const { sessionId, claimId } = await startCoveredSession(client)
    const attached = await attachLocalEvidence(
      client,
      sessionId,
      claimId,
      '当期の売上は前年比 120% となった。',
      'supports',
    )
    expect(attached.ok).toBe(true)
    const verdict = await call(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimId,
      verdict: 'verified',
      rationale: '引用が一致',
    })
    expect(verdict.ok).toBe(true)
    return { sessionId, claimId }
  }

  /**
   * 書き込みが起きる 5 か所を 1 つずつ確実に失敗させる。
   *
   * 失敗の作り方は「そのパスにディレクトリを置く」で統一する（rename も mkdir も EISDIR /
   * EEXIST / ENOTDIR で必ず落ちる）。ディスクを本当に埋めるより再現性が高く、後片付けも効く。
   */
  test.each([
    {
      // 台帳そのものを書けない状況。セッションディレクトリを読み取り専用にすると、
      // 読み込みは通るのに writeFileAtomic の一時ファイル作成だけが落ちる
      // （ledger.json をディレクトリに置き換えると、書き込みより先に読み込みが落ちてしまう）。
      name: '台帳の保存',
      block: null,
      readonlyDir: true,
      finalizeFirst: false,
      // 台帳が書けないなら、変更そのものが確定していない。
      expectText: ['ファイルの書き込みに失敗した'],
      ledgerChanged: false,
      staleAfter: null,
    },
    {
      name: 'report.md の書き出し',
      block: 'report.md',
      readonlyDir: false,
      finalizeFirst: true,
      expectText: ['台帳の変更は保存できたが', '新しい内容になったのは [なし]', '古い内容の可能性がある'],
      ledgerChanged: true,
      staleAfter: 'stale',
    },
    {
      name: 'report.json の書き出し',
      block: 'report.json',
      readonlyDir: false,
      finalizeFirst: true,
      expectText: ['台帳の変更は保存できたが', '新しい内容になったのは [report.md]'],
      ledgerChanged: true,
      staleAfter: 'stale',
    },
    {
      name: 'report.html の書き出し',
      block: 'report.html',
      readonlyDir: false,
      finalizeFirst: true,
      expectText: ['台帳の変更は保存できたが', '新しい内容になったのは [report.md, report.json]'],
      ledgerChanged: true,
      staleAfter: 'stale',
    },
  ])('$name が失敗しても、確定した状態と原因と回復手順が残る', async (row) => {
    const client = await connectClient()
    const { sessionId, claimId } = await readySession(client)
    if (row.finalizeFirst) expect((await call(client, 'finalize', { session_id: sessionId })).ok).toBe(true)

    const directory = path.join(process.env.FACT_CHECK_DIR ?? '', sessionId)
    const blocked = row.block === null ? null : path.join(directory, row.block)
    if (blocked !== null) {
      await rm(blocked, { recursive: true, force: true })
      await mkdir(blocked, { recursive: true })
    }
    if (row.readonlyDir) await chmod(directory, 0o500)

    const excluded = await call(client, 'revise_record', {
      session_id: sessionId,
      action: 'exclude',
      target_type: 'claim',
      target_id: claimId,
      reason: `${row.name} の失敗注入`,
    })
    expect(excluded.ok).toBe(false)
    for (const fragment of row.expectText) expect(excluded.text).toContain(fragment)
    // 元の原因（cause）が必ず残る。
    expect(excluded.text).toMatch(/EISDIR|EEXIST|ENOTDIR|EACCES|EPERM|illegal operation|permission denied/i)

    if (row.readonlyDir) await chmod(directory, 0o700)
    if (blocked !== null) await rm(blocked, { recursive: true, force: true })

    // 台帳の状態が、成功したところまでを正しく表している。
    const status = await call(client, 'get_status', { session_id: sessionId })
    expect(status.ok).toBe(true)
    const exclusions = status.data.exclusions as Array<{ target_id: string }>
    expect(exclusions.some((e) => e.target_id === claimId)).toBe(row.ledgerChanged)
    if (row.staleAfter === 'stale') expect(status.data.reports_stale_since).not.toBeNull()

    // 再試行で回復する（ロックも壊れていない）。
    if (row.ledgerChanged) {
      const restored = await call(client, 'revise_record', {
        session_id: sessionId,
        action: 'restore',
        target_type: 'claim',
        target_id: claimId,
        reason: '再試行',
      })
      expect(restored.ok).toBe(true)
    }
    const again = await call(client, 'finalize', { session_id: sessionId })
    expect(again.ok).toBe(true)
    expect(
      JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8')).reports_stale_since,
    ).toBeNull()
  })

  test('完了の印は、レポートを書き出せてから台帳に書く', async () => {
    const client = await connectClient()
    const { sessionId } = await readySession(client)
    const directory = path.join(process.env.FACT_CHECK_DIR ?? '', sessionId)

    // 1 回目の finalize を report.html で失敗させる。
    const blocked = path.join(directory, 'report.html')
    await mkdir(blocked, { recursive: true })
    const failed = await call(client, 'finalize', { session_id: sessionId })
    expect(failed.ok).toBe(false)
    expect(failed.text).toContain('「レポートは最新」の印は付けていない')

    // **ここが本題**: 書き出しに失敗したのだから、台帳は「未完了」のままでなければならない。
    const ledger = JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8')) as {
      reports_stale_since: string | null
    }
    expect(ledger.reports_stale_since).not.toBeNull()
    const status = await call(client, 'get_status', { session_id: sessionId })
    expect(status.data.reports_stale_since).not.toBeNull()

    // 直せば完了する。
    await rm(blocked, { recursive: true, force: true })
    expect((await call(client, 'finalize', { session_id: sessionId })).ok).toBe(true)
    expect(
      JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8')).reports_stale_since,
    ).toBeNull()
  })

  /**
   * finalize の 5 回目の書き込み（完了印の保存）だけを落とす。
   *
   * ここは長く未検証で残っていた箇所。ファイルシステムの権限やパスでは 5 回目だけを狙えないが、
   * 書き込み先のパスと中身の組を見れば 1 回に絞れる（`writeGate` の説明を参照）。
   *
   * この 1 件で見るのは 4 つ:
   *   1. finalize がエラーを返し、元の原因・対象パス・書けた分・回復方法を落とさない
   *   2. 台帳と get_status は「未完了」のまま
   *   3. **すでに書けたレポート 3 形式は新しい内容で実在する**（差し替えが広すぎないことの確認も兼ねる）
   *   4. 失敗条件を外して同じセッションで呼び直すと通り、未完了の印が消える
   */
  test('完了印の保存だけが失敗しても、状態と原因と回復手順が残り、解除すれば完了する', async () => {
    // Dateだけを固定し、生成時刻の比較を実時計の進み方に依存させない。
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const client = await connectClient()
    const { sessionId, claimId } = await readySession(client)
    const directory = path.join(process.env.FACT_CHECK_DIR ?? '', sessionId)
    const ledgerPath = path.join(directory, 'ledger.json')

    // 先に 1 度 finalize を通し、レポート 3 形式がある状態にしておく。
    expect((await call(client, 'finalize', { session_id: sessionId })).ok).toBe(true)
    const generatedAtOf = async (): Promise<string> =>
      (
        JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')) as {
          generated_at: string
        }
      ).generated_at
    expect(await generatedAtOf()).toBe('2026-01-01T00:00:00.000Z')

    // finalize は毎回 5 回書く（台帳 → md → json → html → 台帳）。2 回目の finalize で、
    // **5 回目（完了印の保存）だけ**を落とす。台帳を変える必要はない。
    let failed: CallOutcome
    vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'))
    writeGate.armedFor = sessionId
    try {
      failed = await call(client, 'finalize', { session_id: sessionId })
    } finally {
      // 例外で抜けても必ず閉じる（afterEach でも閉じるが、ここでの取りこぼしを残さない）。
      writeGate.armedFor = null
    }

    // 狙った 1 回だけを落としたことを、落としたパスで確かめる。
    expect(writeGate.failedPaths).toHaveLength(1)
    expect(writeGate.failedPaths[0]).toMatch(/ledger\.json\.[0-9a-f]+\.tmp$/)

    // 1. エラーの中身。
    expect(failed.ok).toBe(false)
    expect(failed.text).toContain('レポート 3 形式は書けたが、完了の印を台帳に書けなかった')
    expect(failed.text).toContain('get_status は未完了のままになる')
    expect(failed.text).toContain('finalize を呼び直す')
    expect(failed.text).toContain('ENOSPC') // 元の原因
    expect(failed.text).toContain('ledger.json') // 対象パス

    // 2. 台帳と get_status は未完了のまま。
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      reports_stale_since: string | null
    }
    expect(ledger.reports_stale_since).not.toBeNull()
    const status = await call(client, 'get_status', { session_id: sessionId })
    expect(status.ok).toBe(true)
    expect(status.data.reports_stale_since).not.toBeNull()

    // 3. すでに書けたレポート 3 形式は実在し、**この失敗した finalize で書き直されている**。
    //    report.json の生成時刻が進んでいることが、5 回目より前の 4 回が通った証拠になる。
    //    （差し替えの条件が広すぎてレポートまで落としていたら、ここで気づける。）
    const after = await Promise.all(
      ['report.md', 'report.json', 'report.html'].map((name) => readFile(path.join(directory, name), 'utf8')),
    )
    for (const text of after) expect(text.length).toBeGreaterThan(0)
    expect(await generatedAtOf()).toBe('2026-01-01T00:01:00.000Z')
    expect(after[0]).toContain(claimId)

    // 4. 解除して同じセッションで呼び直すと通り、未完了の印が消える。
    const again = await call(client, 'finalize', { session_id: sessionId })
    expect(again.ok).toBe(true)
    expect(again.data.reports_stale).toBe(false)
    expect(
      (JSON.parse(await readFile(ledgerPath, 'utf8')) as { reports_stale_since: string | null })
        .reports_stale_since,
    ).toBeNull()
  })

  test('門を張っても、対象外のセッションと対象外の書き込みは実物へ素通しする', async () => {
    // 差し替えが広すぎないことの確認。別のセッションを狙って門を張ったまま、
    // ふつうの登録から finalize まで一通り通ること。
    // ここが通らないと、上のテストの「3 形式は書けている」が差し替えの副作用で崩れる。
    const client = await connectClient()
    writeGate.armedFor = 'fc_00000000T000000_deadbeef'
    try {
      const { sessionId } = await readySession(client)
      const finalized = await call(client, 'finalize', { session_id: sessionId })
      expect(finalized.ok).toBe(true)
      const directory = path.join(process.env.FACT_CHECK_DIR ?? '', sessionId)
      expect(
        (
          JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8')) as {
            reports_stale_since: string | null
          }
        ).reports_stale_since,
      ).toBeNull()
    } finally {
      writeGate.armedFor = null
    }
    expect(writeGate.failedPaths).toHaveLength(0)
  })

  test('回復手順に、根拠不足があれば先に直すことが書いてある', async () => {
    const client = await connectClient()
    const { sessionId, claimId } = await readySession(client)
    expect((await call(client, 'finalize', { session_id: sessionId })).ok).toBe(true)
    const blocked = path.join(process.env.FACT_CHECK_DIR ?? '', sessionId, 'report.json')
    await rm(blocked, { force: true })
    await mkdir(blocked, { recursive: true })
    const excluded = await call(client, 'revise_record', {
      session_id: sessionId,
      action: 'exclude',
      target_type: 'claim',
      target_id: claimId,
      reason: '回復手順の確認',
    })
    expect(excluded.ok).toBe(false)
    expect(excluded.text).toContain('finalize は先に拒否する')
    expect(excluded.text).toContain('verdicts_without_basis')
    await rm(blocked, { recursive: true, force: true })
  })

  test('レポートの書き出しが途中で失敗しても、台帳の変更は残り、どこまで書けたかが分かる', async () => {
    const client = await connectClient()
    const { sessionId, claimId } = await readySession(client)
    expect((await call(client, 'finalize', { session_id: sessionId })).ok).toBe(true)

    const blocked = await blockReportJson(sessionId)
    const excluded = await call(client, 'revise_record', {
      session_id: sessionId,
      action: 'exclude',
      target_type: 'claim',
      target_id: claimId,
      reason: '書き出し失敗の注入',
    })
    expect(excluded.ok).toBe(false)
    // 台帳は保存済み・どのファイルが新しくてどれが古いか・次に何をするかが全部書いてある。
    expect(excluded.text).toContain('台帳の変更は保存できたが')
    expect(excluded.text).toContain('新しい内容になったのは [report.md]')
    expect(excluded.text).toContain('前の内容のままなのは [report.json, report.html]')
    expect(excluded.text).toContain('finalize を呼び直す')
    // 元の失敗（cause）も残っている。
    expect(excluded.text).toMatch(/EISDIR|illegal operation on a directory/i)

    // 台帳のほうは確定している（未保存の取り消しが「無かったこと」にならない）。
    const ledger = JSON.parse(
      await readFile(path.join(process.env.FACT_CHECK_DIR ?? '', sessionId, 'ledger.json'), 'utf8'),
    ) as { exclusions: Array<{ target_id: string }> }
    expect(ledger.exclusions.map((e) => e.target_id)).toContain(claimId)

    await rm(blocked, { recursive: true, force: true })
  })

  test('ふつうの変更でも、すでにあるレポートに暫定表示の断りが入る', async () => {
    const client = await connectClient()
    const { sessionId } = await readySession(client)
    expect((await call(client, 'finalize', { session_id: sessionId })).ok).toBe(true)
    const markdownPath = path.join(process.env.FACT_CHECK_DIR ?? '', sessionId, 'report.md')
    expect(await readFile(markdownPath, 'utf8')).not.toContain('finalize を通していない暫定表示')

    // 取り消しではない、ふつうの登録。これでもレポートは古くなる。
    const added = await call(client, 'mark_non_claim', {
      session_id: sessionId,
      start: 0,
      end: 3,
      reason: '重ねて対象外にする',
    })
    expect(added.ok).toBe(true)
    expect(await readFile(markdownPath, 'utf8')).toContain('finalize を通していない暫定表示')
  })

  test('まだ finalize していないセッションでは、勝手にレポートを作らない', async () => {
    const client = await connectClient()
    const { sessionId } = await startCoveredSession(client)
    const directory = path.join(process.env.FACT_CHECK_DIR ?? '', sessionId)
    const names = await readdir(directory)
    expect(names).not.toContain('report.md')
    expect(names).not.toContain('report.html')
  })
})

/** 保管中に何ができて何ができないか。ツールごとに書くと必ずどれかが抜けるので表で確かめる。 */
describe('保管中のセッションで受け付ける操作', () => {
  async function archivedSession(client: Client) {
    const { sessionId, claimId } = await startCoveredSession(client)
    const archived = await call(client, 'revise_record', {
      session_id: sessionId,
      action: 'exclude',
      target_type: 'session',
      target_id: sessionId,
      reason: '保管する',
    })
    expect(archived.ok).toBe(true)
    return { sessionId, claimId }
  }

  test.each([
    { name: 'claim の取り消し', action: 'exclude', targetType: 'claim', allowed: false },
    { name: 'claim の復元', action: 'restore', targetType: 'claim', allowed: false },
    { name: 'non_claim の取り消し', action: 'exclude', targetType: 'non_claim', allowed: false },
    { name: 'セッションの二重保管', action: 'exclude', targetType: 'session', allowed: false },
    { name: 'セッションの保管解除', action: 'restore', targetType: 'session', allowed: true },
  ])('$name: 受け付ける=$allowed', async ({ action, targetType, allowed }) => {
    const client = await connectClient()
    const { sessionId, claimId } = await archivedSession(client)
    const result = await call(client, 'revise_record', {
      session_id: sessionId,
      action,
      target_type: targetType,
      target_id: targetType === 'session' ? sessionId : claimId,
      reason: '保管中の操作',
    })
    expect(result.ok).toBe(allowed)
    if (!allowed) expect(result.text).toContain('保管されている')
  })
})
