import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { buildSamplePdf } from '../../e2e/fixtures/build-sample-pdf.js'
import { readEmbeddedJson } from '../report/rendering/embed-json.js'
import type { ViewerPayload } from '../report/rendering/viewer-payload.js'
import { registerTools } from './register-tools.js'

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

  test('report.html に要確認一覧と本文の塗り分けが埋め込まれる', async () => {
    const client = await connectClient()
    const report = await finalizeMixedSession(client)
    const html = await readFile(report.html, 'utf8')
    expect(html).toContain('<h2>要確認一覧</h2>')

    // 一覧と塗り分けはブラウザ側が埋め込みデータから描くので、データの中身で確かめる。
    const payload = readEmbeddedJson(html, 'fact-check-data') as ViewerPayload
    // 重い順に並び、verified の claim_1 は載らない
    expect(payload.attention.map((item) => item.claim_id)).toEqual(['claim_2', 'claim_3', 'claim_4'])
    expect(payload.attention[0]?.verdict).toBe('contradicted')
    const claimIds = payload.spans.flatMap((span) => span.claim_ids)
    expect(claimIds).toContain('claim_1')
    expect(claimIds).toContain('claim_2')
    expect(payload.source_text.length).toBe(payload.summary.coverage.total)
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
