import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chromium } from 'playwright'
import { readEmbeddedJson } from '../src/report/rendering/embed-json.js'
import type { ViewerPayload } from '../src/report/rendering/viewer-payload.js'
import { buildSamplePdf } from './fixtures/build-sample-pdf.js'

/**
 * end-to-end 検証。MCP サーバーを子プロセスとして stdio で起動し、実際のツール呼び出しだけで
 * 一連のワークフローを通す。外部サイトには一切アクセスせず、証拠はローカルの HTTP サーバーが配る
 * 固定ページだけを使う。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const WORK_DIR = path.join(HERE, 'tmp')

const SOURCE_TEXT = [
  '四半期業績メモ',
  '',
  '当期の売上は前年比120%に達した。営業利益は前年比150%に伸びた。海外向けの出荷は412台だった。',
  '国内の新規契約は37件だった。',
].join('\n')

/**
 * AI が自分のブラウザ操作ツールで取ってきたことにする本文。文面は架空で、実在の組織とは関係しない。
 * これを提出することで agent_captured の警告と partially_verified の判定がレポートに出る。
 */
const AGENT_CAPTURED_TEXT = [
  '架空社の開示ページ（この文面は e2e の作り物）。',
  '国内の新規契約は37件と発表した。',
  'なお対象期間の記載は無い。',
].join('\n')

/** 証拠にする PDF。文面は架空で、実在の組織とは関係しない。 */
const PDF_PAGES = [
  ['Fictional Quarterly Filing', 'This page is a fixture served from localhost only.'],
  ['Overseas shipment summary', 'The overseas shipment totalled 412 units in the quarter.'],
]

type ToolOutcome = { ok: boolean; text: string; data: Record<string, unknown> }

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

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text: string }>
  const text = content.map((part) => part.text).join('\n')
  const ok = result.isError !== true
  return { ok, text, data: ok ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

async function startFixtureServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const html = await readFile(path.join(HERE, 'fixtures', 'sample-article.html'), 'utf8')
  const pdf = buildSamplePdf(PDF_PAGES)
  const server = createServer((request, response) => {
    if (request.url === '/article') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
      return
    }
    if (request.url === '/filing.pdf') {
      response.writeHead(200, { 'content-type': 'application/pdf' })
      response.end(pdf)
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

/**
 * report.html を file:// から開いて、人が使う操作をそのまま踏む。
 *
 * 生成した HTML の文字列を見るだけでは、描画の壊れ方（埋め込みデータが読めない、
 * クリックで何も起きない、絞り込みが塗りに効かない）が通り抜ける。
 */
async function checkViewerPage(
  htmlPath: string,
  expected: {
    partiallyVerifiedClaim: string
    verifiedClaim: string
    screenshotPath: string
    claimCount: number
  },
): Promise<void> {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    const page = await context.newPage()
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })

    const attentionRow = page.locator(`.attention-row[data-claim="${expected.partiallyVerifiedClaim}"]`)
    check(
      '要確認一覧に partially_verified の claim が出る',
      (await attentionRow.count()) === 1 && (await attentionRow.innerText()).includes('一部のみ裏取り'),
      `${expected.partiallyVerifiedClaim} / 一覧 ${await page.locator('.attention-row').count()} 行`,
    )
    check(
      '要確認一覧に verified の claim は出ない',
      (await page.locator(`.attention-row[data-claim="${expected.verifiedClaim}"]`).count()) === 0,
      expected.verifiedClaim,
    )

    await page.click(`#source-body .seg-claim[data-claim="${expected.verifiedClaim}"]`)
    const detailClaim = await page.getAttribute('#detail-body .claim-detail', 'data-claim')
    const shotSrc = await page.getAttribute('#detail-body img.shot', 'src')
    // 読み込みは非同期なので、クリック直後に見ると間に合わない。待って、待てなかった理由は残す。
    let shotLoadProblem: string | null = null
    try {
      await page.waitForFunction(
        () => {
          const image = document.querySelector('#detail-body img.shot')
          return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
        },
        undefined,
        { timeout: 15_000 },
      )
    } catch (cause) {
      shotLoadProblem = cause instanceof Error ? cause.message : String(cause)
    }
    check(
      '本文の claim をクリックすると右ペインにその claim の詳細が出る',
      detailClaim === expected.verifiedClaim,
      `data-claim=${String(detailClaim)}`,
    )
    check(
      '詳細に相対パスのスクショが出て、実際に読み込める',
      shotSrc === expected.screenshotPath && shotLoadProblem === null,
      `src=${String(shotSrc)} / 読み込み=${shotLoadProblem ?? '成功'}`,
    )
    check(
      '詳細に証拠の出どころと sha256 が出る',
      (await page.innerText('#detail-body')).includes('本文 sha256'),
      '出どころ・取得時刻・sha256 の欄がある',
    )

    const coloredBefore = await page.locator('#source-body .seg-claim:not(.dim)').count()
    await page.click('.chip[data-verdict="verified"]')
    const coloredAfter = await page.locator('#source-body .seg-claim:not(.dim)').count()
    const dimmed = await page.locator('#source-body .seg-claim.dim').count()
    check(
      '判定で絞り込むと左ペインの塗りが変わる',
      coloredBefore === expected.claimCount && coloredAfter < coloredBefore && dimmed > 0,
      `塗り ${coloredBefore} → ${coloredAfter} 件（薄くした範囲 ${dimmed} 件）`,
    )
    const rowsBefore = await page.locator('.attention-row').count()
    await page.click('.chip[data-verdict="partially_verified"]')
    const rowsAfter = await page.locator('.attention-row').count()
    check(
      '絞り込みは要確認一覧にも効く',
      rowsBefore === 2 &&
        rowsAfter === 1 &&
        (await page.locator(`.attention-row[data-claim="${expected.partiallyVerifiedClaim}"]`).count()) === 0,
      `${rowsBefore} 行 → ${rowsAfter} 行`,
    )
    await page.click('#chip-all')
    check(
      '「すべて表示」で絞り込みが元に戻る',
      (await page.locator('.attention-row').count()) === 2 &&
        (await page.locator('#source-body .seg-claim.dim').count()) === 0,
      `${await page.locator('.attention-row').count()} 行`,
    )

    await page.click(`#source-body .seg-claim[data-claim="${expected.verifiedClaim}"]`)
    await page.keyboard.press('j')
    const afterKey = await page.getAttribute('#detail-body .claim-detail', 'data-claim')
    check(
      'j キーで次の claim に移動する',
      afterKey !== null && afterKey !== expected.verifiedClaim,
      `${expected.verifiedClaim} → ${String(afterKey)}`,
    )

    check(
      'AI 提出の証拠に警告が出る',
      (await page.innerText('#global-warn')).includes('AI が提出した証拠が 1 件あります'),
      await page.innerText('#global-warn'),
    )
    check(
      '印刷用に全 claim の詳細が並ぶ',
      (await page.locator('#printAll .print-claim').count()) === expected.claimCount,
      `${await page.locator('#printAll .print-claim').count()} 件`,
    )
    check('ブラウザのコンソールにエラーが出ない', consoleErrors.length === 0, consoleErrors.join(' / '))
    await context.close()
  } finally {
    await browser.close()
  }
}

/** `pnpm viewer` を実際に起動して、一覧とレポートが配られることを確かめる。 */
async function checkViewerServer(sessionId: string): Promise<void> {
  const viewer = spawn('pnpm', ['viewer', '--port', '0'], {
    cwd: ROOT,
    env: { ...process.env, FACT_CHECK_DIR: WORK_DIR } as Record<string, string>,
    // プロセスグループごと終わらせるため（pnpm が起こす子まで残さない）。
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  viewer.stdout.setEncoding('utf8')
  viewer.stderr.setEncoding('utf8')
  viewer.stdout.on('data', (chunk: string) => {
    output += chunk
  })
  viewer.stderr.on('data', (chunk: string) => {
    output += chunk
  })
  try {
    const url = await waitForUrl(() => output)
    if (url === null) {
      check('pnpm viewer が URL を表示して起動する', false, output.trim())
      return
    }
    check('pnpm viewer が URL を表示して起動する', true, url)

    const list = await fetch(url)
    const listHtml = await list.text()
    check(
      'セッション一覧に e2e のセッションが出る',
      list.status === 200 && listHtml.includes(sessionId) && listHtml.includes('e2e テスト'),
      `status=${list.status}`,
    )
    const reportLink = `${url}s/${sessionId}/report.html`
    check(
      '一覧が指す report.html のリンクが載っている',
      listHtml.includes(`/s/${sessionId}/report.html`),
      reportLink,
    )
    const reportResponse = await fetch(reportLink)
    const reportBody = await reportResponse.text()
    check(
      'report.html へのリンクが 200 を返す',
      reportResponse.status === 200 && reportBody.includes('fact-check-data'),
      `status=${reportResponse.status} / ${reportBody.length} バイト`,
    )
    const outside = await fetch(`${url}s/${sessionId}/%2e%2e%2f%2e%2e%2fpackage.json`)
    check('セッションディレクトリの外は配らない', outside.status === 403, `status=${outside.status}`)
  } finally {
    if (viewer.pid !== undefined) {
      try {
        process.kill(-viewer.pid, 'SIGTERM')
      } catch (cause) {
        log(`  [注意] pnpm viewer を終了できなかった: ${String(cause)}`)
      }
    }
  }
}

/** 起動の完了は「URL が出たこと」で判断する。出るまで待ち、出なければ null を返す。 */
async function waitForUrl(read: () => string): Promise<string | null> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const found = /http:\/\/127\.0\.0\.1:\d+\//.exec(read())
    if (found !== null) return found[0]
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return null
}

async function main(): Promise<void> {
  await rm(WORK_DIR, { recursive: true, force: true })
  await mkdir(WORK_DIR, { recursive: true })

  const fixture = await startFixtureServer()
  const articleUrl = `${fixture.origin}/article`
  const pdfUrl = `${fixture.origin}/filing.pdf`
  log(`固定ページ配信サーバー: ${articleUrl} / ${pdfUrl}`)

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'dist', 'index.js')],
    env: { ...process.env, FACT_CHECK_DIR: WORK_DIR } as Record<string, string>,
    stderr: 'inherit',
  })
  const client = new Client({ name: 'fact-check-e2e', version: '0.1.0' })
  await client.connect(transport)
  log('MCP サーバーに stdio で接続した')

  try {
    const tools = await client.listTools()
    const names = tools.tools.map((tool) => tool.name).sort()
    check(
      'ツール一覧',
      names.join(',') ===
        [
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
        ].join(','),
      names.join(', '),
    )
    check(
      '入力スキーマが公開されている',
      tools.tools.every((tool) => typeof tool.inputSchema === 'object'),
      `${tools.tools.length} 件すべてに inputSchema がある`,
    )

    log('\n[1] start_session')
    const started = await callTool(client, 'start_session', {
      source: { type: 'text', text: SOURCE_TEXT },
      title: 'e2e テスト',
    })
    check('start_session が通る', started.ok, started.ok ? '' : started.text)
    const sessionId = started.data.session_id as string
    const segments = started.data.segments as Array<{ start: number; end: number }>
    check('session_id が返る', typeof sessionId === 'string' && sessionId.length > 0, sessionId)
    check(
      '候補範囲が本文を隙間なく敷き詰める',
      segments[0]?.start === 0 && segments.at(-1)?.end === SOURCE_TEXT.length,
      `${segments.length} 個`,
    )

    log('\n[2] register_segments でまとめて登録する')
    const salesEnd = SOURCE_TEXT.indexOf('営業利益')
    const profitEnd = SOURCE_TEXT.indexOf('海外向け')
    const contractStart = SOURCE_TEXT.indexOf('国内の新規契約')
    const bulkRejected = await callTool(client, 'register_segments', {
      session_id: sessionId,
      items: [
        {
          kind: 'claim',
          start: SOURCE_TEXT.indexOf('当期の売上'),
          end: salesEnd,
          claim: '当期の売上は前年比 120% に達した',
          claim_kind: '数値',
        },
        { kind: 'claim', start: salesEnd, end: 99_999, claim: '本文の外にはみ出した範囲' },
      ],
    })
    check('1 件でも不正なら拒否される', !bulkRejected.ok, bulkRejected.text.split('\n')[0] ?? '')
    check(
      '拒否時にどの item が不正かが分かる',
      bulkRejected.text.includes('items[1]'),
      '不正な item の位置が示されている',
    )
    const afterReject = await callTool(client, 'get_status', { session_id: sessionId })
    check(
      '拒否されたときは 1 件も登録されていない',
      (afterReject.data.summary as { claims: { total: number } }).claims.total === 0,
      'claim 0 件',
    )

    const bulk = await callTool(client, 'register_segments', {
      session_id: sessionId,
      items: [
        {
          kind: 'claim',
          start: SOURCE_TEXT.indexOf('当期の売上'),
          end: salesEnd,
          claim: '当期の売上は前年比 120% に達した',
          claim_kind: '数値',
        },
        {
          kind: 'claim',
          start: salesEnd,
          end: profitEnd,
          claim: '営業利益は前年比 150% に伸びた',
          claim_kind: '数値',
        },
        {
          kind: 'claim',
          start: profitEnd,
          end: contractStart,
          claim: '海外向けの出荷は 412 台だった',
          claim_kind: '数値',
        },
        {
          kind: 'claim',
          start: contractStart,
          end: SOURCE_TEXT.length,
          claim: '国内の新規契約は 37 件だった',
          claim_kind: '数値',
        },
      ],
    })
    check('まとめ登録が通る', bulk.ok, bulk.ok ? '' : bulk.text)
    const registered = (bulk.data.registered ?? []) as Array<{ id: string; kind: string }>
    check('4 件とも登録される', registered.length === 4, `${registered.length} 件`)
    const claimA = { data: { claim_id: registered[0]?.id } }
    const claimB = { data: { claim_id: registered[1]?.id } }
    const claimC = { data: { claim_id: registered[2]?.id } }
    const claimD = { data: { claim_id: registered[3]?.id } }

    log('\n[3] 網羅率不足の状態で finalize を呼ぶ')
    const earlyFinalize = await callTool(client, 'finalize', { session_id: sessionId })
    check('finalize が拒否される', !earlyFinalize.ok, earlyFinalize.text.split('\n')[0] ?? '')
    check('拒否理由に網羅率が出る', earlyFinalize.text.includes('網羅率が'), '網羅率の不足が明示されている')

    log('\n[4] mark_non_claim（1 件ずつの登録）で見出しと空行を埋める')
    const nonClaim = await callTool(client, 'mark_non_claim', {
      session_id: sessionId,
      start: 0,
      end: SOURCE_TEXT.indexOf('当期の売上'),
      reason: '見出しと空行',
    })
    check(
      'non_claim が登録できる',
      nonClaim.ok,
      nonClaim.ok ? String(nonClaim.data.non_claim_id) : nonClaim.text,
    )
    const covered = await callTool(client, 'get_status', { session_id: sessionId })
    const summary = covered.data.summary as { coverage: { percent: string; complete: boolean } }
    check('網羅率が 100% になる', summary.coverage.complete, summary.coverage.percent)

    log('\n[5] fetch_evidence（ローカル HTTP）')
    const evidence = await callTool(client, 'fetch_evidence', {
      session_id: sessionId,
      source: { type: 'url', url: articleUrl },
      discovered_via: 'cited_in_source',
      discovery_note: '元ネタの概要欄に出典として書かれていた',
    })
    check('fetch_evidence が通る', evidence.ok, evidence.ok ? '' : evidence.text)
    check('provenance が http', evidence.data.provenance === 'http', String(evidence.data.provenance))
    check(
      'discovered_via が記録される',
      evidence.data.discovered_via === 'cited_in_source',
      String(evidence.data.discovered_via),
    )
    check(
      'ナビゲーションとフッターは本文から除かれる',
      !String(evidence.data.text).includes('トップ / 業績 / お問い合わせ') &&
        !String(evidence.data.text).includes('実在の組織の業績を示すものではありません'),
      '記事領域だけが抽出されている',
    )
    check(
      '本文からスクリプトの中身が除かれている',
      !String(evidence.data.text).includes('本文テキストに含まれてはいけない'),
      'script 要素の中身は抽出本文に入っていない',
    )
    const evidenceId = evidence.data.evidence_id as string

    log('\n[6] attach_evidence（実在する引用 / 実在しない引用）')
    const goodAttach = await callTool(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claimA.data.claim_id,
      evidence_id: evidenceId,
      quote: '当期の売上は前年比    120%    となり、期初計画をわずかに上回りました。',
      relation: 'supports',
      rationale: '同じ数値が証拠ページに書かれている（空白差は正規化して照合される）',
    })
    check('実在する引用は通る', goodAttach.ok, goodAttach.ok ? '' : goodAttach.text)
    check('引用の実在がツール側で確認される', goodAttach.data.quote_verified === true, 'quote_verified=true')
    const highlightShot = goodAttach.data.screenshot_path as string | null
    check(
      'ハイライト付きスクショが保存される',
      typeof highlightShot === 'string' && highlightShot.endsWith('.png'),
      `${String(highlightShot)} / 但し書き=${String(goodAttach.data.screenshot_note)}`,
    )

    const badAttach = await callTool(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claimB.data.claim_id,
      evidence_id: evidenceId,
      quote: '営業利益は前年比 150% に伸びました。',
      relation: 'supports',
      rationale: '捏造した引用文',
    })
    check('実在しない引用は拒否される', !badAttach.ok, badAttach.text.split('\n')[0] ?? '')
    check(
      '拒否時に近い箇所が示される',
      badAttach.text.includes('最も長く一致した前方部分'),
      '近い箇所の抜粋が添えられている',
    )

    const contradictAttach = await callTool(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claimB.data.claim_id,
      evidence_id: evidenceId,
      quote: '営業利益は前年比 95% にとどまり、前年を下回りました。',
      relation: 'contradicts',
      rationale: '証拠は 95% であり、元ネタの 150% と矛盾する',
    })
    check('矛盾する証拠は通る', contradictAttach.ok, contradictAttach.ok ? '' : contradictAttach.text)
    check(
      '単一ブロック内の引用はハイライト付きで撮れる',
      goodAttach.data.screenshot_note === null,
      `但し書き=${String(goodAttach.data.screenshot_note)}`,
    )

    log('\n[6b] ブロック要素をまたぐ引用でもハイライトが付く')
    const crossBlockAttach = await callTool(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claimA.data.claim_id,
      evidence_id: evidenceId,
      quote: '最大積載量は 2,500 kg to LEO までを想定しています。',
      relation: 'partial',
      rationale: '引用文が 2 つの段落にまたがっている（DOM 側では改行が無い）',
    })
    check(
      'ブロックをまたぐ引用が照合に通る',
      crossBlockAttach.ok,
      crossBlockAttach.ok ? '' : crossBlockAttach.text,
    )
    check(
      'ブロックまたぎでもハイライト付きになる',
      crossBlockAttach.data.screenshot_note === null &&
        typeof crossBlockAttach.data.screenshot_path === 'string',
      `但し書き=${String(crossBlockAttach.data.screenshot_note)} / ${String(crossBlockAttach.data.screenshot_path)}`,
    )

    log('\n[6c] PDF を証拠として取得し、引用箇所のページを描画する')
    const pdfEvidence = await callTool(client, 'fetch_evidence', {
      session_id: sessionId,
      source: { type: 'url', url: pdfUrl },
      discovered_via: 'agent_search',
      discovery_note: '元ネタには無い出典。「overseas shipment 412」で検索して見つけた',
    })
    check('PDF の fetch_evidence が通る', pdfEvidence.ok, pdfEvidence.ok ? '' : pdfEvidence.text)
    check(
      'PDF は HTTP 取得として記録される',
      pdfEvidence.data.provenance === 'http',
      String(pdfEvidence.data.provenance),
    )
    check('PDF のページ数が返る', pdfEvidence.data.pdf_pages === 2, String(pdfEvidence.data.pdf_pages))
    const pdfSaved = pdfEvidence.data.saved as { pdf_path: string | null; text_path: string }
    check(
      '元の PDF バイト列が保存される',
      typeof pdfSaved.pdf_path === 'string' && pdfSaved.pdf_path.endsWith('.pdf'),
      String(pdfSaved.pdf_path),
    )
    check(
      'PDF の本文が抽出される',
      String(pdfEvidence.data.text).includes('The overseas shipment totalled 412 units'),
      '2 ページ目の文が抽出本文に入っている',
    )

    const pdfAttach = await callTool(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claimC.data.claim_id,
      evidence_id: pdfEvidence.data.evidence_id,
      quote: 'The overseas shipment totalled 412 units in the quarter.',
      relation: 'supports',
      rationale: 'PDF の 2 ページ目に同じ数値がある',
    })
    check('PDF の引用が照合に通る', pdfAttach.ok, pdfAttach.ok ? '' : pdfAttach.text)
    check('引用箇所のページ番号が記録される', pdfAttach.data.pdf_page === 2, String(pdfAttach.data.pdf_page))
    check(
      'PDF のページを描画したハイライト付きスクショが保存される',
      pdfAttach.data.screenshot_note === null && typeof pdfAttach.data.screenshot_path === 'string',
      `但し書き=${String(pdfAttach.data.screenshot_note)} / ${String(pdfAttach.data.screenshot_path)}`,
    )
    const pdfShot = pdfAttach.data.screenshot_path as string | null

    log('\n[6d] AI が自分で取得した証拠を submit_agent_capture で提出する')
    const captured = await callTool(client, 'submit_agent_capture', {
      session_id: sessionId,
      url: `${fixture.origin}/agent-only`,
      text: AGENT_CAPTURED_TEXT,
      discovered_via: 'agent_knowledge',
      discovery_note: '元ネタには出典が無く、自分の知識から当たりを付けた（架空）',
      note: 'fetch_evidence では取得できなかったので、自分のブラウザ操作ツールで開いて本文をコピーした（架空）',
    })
    check('submit_agent_capture が通る', captured.ok, captured.ok ? '' : captured.text)
    check(
      'provenance が agent_captured になる',
      captured.data.provenance === 'agent_captured',
      String(captured.data.provenance),
    )
    const capturedAttach = await callTool(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claimD.data.claim_id,
      evidence_id: captured.data.evidence_id,
      quote: '国内の新規契約は37件と発表した。',
      relation: 'partial',
      rationale: '件数は一致するが、対象期間が書かれていない',
    })
    check(
      'AI 提出の証拠にも引用の照合が効く',
      capturedAttach.ok,
      capturedAttach.ok ? '' : capturedAttach.text,
    )

    log('\n[7] set_verdict')
    const badVerdict = await callTool(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimB.data.claim_id,
      verdict: 'verified',
      rationale: 'supports が無いのに verified にしようとする',
    })
    check('supports が無ければ verified は拒否される', !badVerdict.ok, badVerdict.text.split('\n')[0] ?? '')

    const verdictA = await callTool(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimA.data.claim_id,
      verdict: 'verified',
      rationale: '証拠ページの記述と一致する',
    })
    check('claim 1 を verified にできる', verdictA.ok, verdictA.ok ? '' : verdictA.text)

    log('\n[8] verdict 未設定のまま finalize を呼ぶ')
    const pendingFinalize = await callTool(client, 'finalize', { session_id: sessionId })
    check('finalize が拒否される', !pendingFinalize.ok, pendingFinalize.text.split('\n')[0] ?? '')
    check(
      '未判定の claim_id が示される',
      pendingFinalize.text.includes(String(claimB.data.claim_id)),
      String(claimB.data.claim_id),
    )

    const verdictB = await callTool(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimB.data.claim_id,
      verdict: 'contradicted',
      rationale: '証拠は 95% で、元ネタの 150% とは矛盾する',
    })
    check('claim 2 を contradicted にできる', verdictB.ok, verdictB.ok ? '' : verdictB.text)

    const verdictC = await callTool(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimC.data.claim_id,
      verdict: 'verified',
      rationale: 'PDF の 2 ページ目の記述と一致する',
    })
    check('claim 3 を verified にできる', verdictC.ok, verdictC.ok ? '' : verdictC.text)

    const verdictD = await callTool(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimD.data.claim_id,
      verdict: 'partially_verified',
      rationale: '件数は AI が提出した証拠と一致するが、対象期間が確認できない',
    })
    check('claim 4 を partially_verified にできる', verdictD.ok, verdictD.ok ? '' : verdictD.text)

    log('\n[9] finalize')
    const finalized = await callTool(client, 'finalize', { session_id: sessionId })
    check('finalize が通る', finalized.ok, finalized.ok ? '' : finalized.text)
    const report = finalized.data.report as { markdown: string; json: string; html: string; dir: string }

    log('\n[10] 生成物の確認')
    const reportHtml = await readFile(report.html, 'utf8')
    const reportJson = JSON.parse(await readFile(report.json, 'utf8')) as { ledger: unknown }
    const ledgerOnDisk = JSON.parse(await readFile(path.join(report.dir, 'ledger.json'), 'utf8')) as unknown
    check(
      'report.json の内容が台帳と一致する',
      JSON.stringify(reportJson.ledger) === JSON.stringify(ledgerOnDisk),
      'report.json の ledger と ledger.json が同一',
    )
    const payload = readEmbeddedJson(reportHtml, 'fact-check-data') as ViewerPayload
    const embeddedShots = payload.ledger.attachments.map((a) => a.screenshot_path)
    check(
      'report.html がスクショを相対パスで参照する',
      typeof highlightShot === 'string' &&
        embeddedShots.includes(highlightShot) &&
        embeddedShots.every((shot) => shot === null || (!shot.startsWith('/') && !shot.includes('://'))),
      `${String(highlightShot)} / 参照 ${embeddedShots.filter((shot) => shot !== null).length} 件`,
    )
    check(
      'report.html に元ネタ本文と塗り分けの区間が埋め込まれる',
      payload.source_text === SOURCE_TEXT &&
        payload.spans[0]?.start === 0 &&
        payload.spans.at(-1)?.end === SOURCE_TEXT.length,
      `${payload.spans.length} 区間 / 本文 ${payload.source_text.length} 文字`,
    )
    if (typeof highlightShot === 'string') {
      const shotPath = path.join(report.dir, highlightShot)
      const info = await stat(shotPath)
      const head = await readFile(shotPath)
      check(
        'スクショが PNG として実在する',
        info.size > 0 && head.subarray(1, 4).toString('ascii') === 'PNG',
        `${info.size} バイト`,
      )
    }
    if (typeof pdfShot === 'string') {
      const shotPath = path.join(report.dir, pdfShot)
      const head = await readFile(shotPath)
      check(
        'PDF ページのスクショが PNG として実在する',
        head.length > 0 && head.subarray(1, 4).toString('ascii') === 'PNG',
        `${head.length} バイト`,
      )
    }
    const savedPdf = await readFile(path.join(report.dir, pdfSaved.pdf_path ?? ''))
    check(
      '保存された PDF が PDF として実在する',
      savedPdf.subarray(0, 5).toString('latin1') === '%PDF-',
      `${savedPdf.length} バイト`,
    )

    const reportMarkdown = await readFile(report.markdown, 'utf8')
    check('report.md に判定が出る', reportMarkdown.includes('裏取り済み (verified)'), 'verified が本文にある')
    const attentionSection = reportMarkdown.slice(
      reportMarkdown.indexOf('## 要確認一覧'),
      reportMarkdown.indexOf('## 主張ごとの判定'),
    )
    check(
      'report.md の先頭に要確認一覧が出る',
      reportMarkdown.indexOf('## 要確認一覧') > 0 &&
        reportMarkdown.indexOf('## 要確認一覧') < reportMarkdown.indexOf('## 主張ごとの判定'),
      '集計の直後に一覧がある',
    )
    check(
      '要確認一覧に verified 以外の claim だけが載る',
      attentionSection.includes(String(claimB.data.claim_id)) &&
        attentionSection.includes(String(claimD.data.claim_id)) &&
        !attentionSection.includes(String(claimA.data.claim_id)),
      `${String(claimB.data.claim_id)} と ${String(claimD.data.claim_id)} が載り、${String(claimA.data.claim_id)} は載らない`,
    )
    check(
      'レポートに証拠の出どころが出る',
      reportMarkdown.includes('出どころ: 元ネタが出典として示していた') &&
        reportMarkdown.includes('出どころ: AI が検索などで見つけた'),
      'cited_in_source と agent_search の両方が区別できる',
    )
    check(
      'レポートに引用箇所のページ番号が出る',
      reportMarkdown.includes('PDF 2 ページ目'),
      'PDF のページ番号が本文にある',
    )
    check(
      'report.html の要確認一覧に verified 以外だけが重い順で入る',
      payload.attention.map((item) => item.claim_id).join(',') ===
        [claimB.data.claim_id, claimD.data.claim_id].join(','),
      payload.attention.map((item) => `${item.claim_id}(${item.verdict})`).join(', '),
    )
    check(
      'report.md に矛盾判定が出る',
      reportMarkdown.includes('矛盾 (contradicted)'),
      'contradicted が本文にある',
    )

    log('\n[11] report.html をブラウザで開いて操作する')
    await checkViewerPage(report.html, {
      partiallyVerifiedClaim: String(claimD.data.claim_id),
      verifiedClaim: String(claimA.data.claim_id),
      screenshotPath: String(highlightShot),
      claimCount: 4,
    })

    log('\n[12] pnpm viewer でセッション一覧を配る')
    await checkViewerServer(sessionId)

    log('\n[13] プロセスを再起動してもセッションを再開できる')
    await client.close()
    const transport2 = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'dist', 'index.js')],
      env: { ...process.env, FACT_CHECK_DIR: WORK_DIR } as Record<string, string>,
      stderr: 'inherit',
    })
    const client2 = new Client({ name: 'fact-check-e2e-resume', version: '0.1.0' })
    await client2.connect(transport2)
    const resumed = await callTool(client2, 'get_status', { session_id: sessionId })
    check('別プロセスから同じ session_id で状態が読める', resumed.ok, resumed.ok ? '' : resumed.text)
    check(
      '再開後も網羅率と判定が保たれている',
      (resumed.data.summary as { coverage: { complete: boolean } }).coverage.complete &&
        (resumed.data.claims_without_verdict as unknown[]).length === 0,
      '網羅率 100% / 未判定 0 件',
    )
    await client2.close()
  } finally {
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

main().catch((error: unknown) => {
  process.stdout.write(`e2e が例外で停止した:\n${String(error instanceof Error ? error.stack : error)}\n`)
  process.exitCode = 1
})
