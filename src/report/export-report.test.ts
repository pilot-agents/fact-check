import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createSession, saveLedger, writeSessionFile } from '../session/ledger-store.js'
import type { Ledger } from '../session/ledger-types.js'
import { assertExportTarget, exportReport } from './export-report.js'
import { readEmbeddedJson } from './rendering/embed-json.js'
import type { ViewerPayload } from './rendering/viewer-payload.js'

/**
 * HTML の持ち出しを、実際のセッションディレクトリで確かめる。PDF はブラウザが要るので
 * ここでは扱わず、e2e（`pnpm e2e`）が Chromium で通す。
 */

const SOURCE_TEXT = '架空社の売上は前年比130%だった。'
/** 1x1 の PNG。ビューアが読めることは e2e が見るので、ここでは中身の同一性だけを見る。 */
const PNG_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
const PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgo='

let baseDir = ''
let outDir = ''
let previousDir: string | undefined

beforeEach(async () => {
  previousDir = process.env.FACT_CHECK_DIR
  baseDir = await mkdtemp(path.join(tmpdir(), 'fact-check-export-'))
  outDir = path.join(baseDir, 'out')
  process.env.FACT_CHECK_DIR = path.join(baseDir, 'sessions')
})

afterEach(async () => {
  if (previousDir === undefined) delete process.env.FACT_CHECK_DIR
  else process.env.FACT_CHECK_DIR = previousDir
  await rm(baseDir, { recursive: true, force: true })
})

/** claim 1 件・証拠 1 件・画像つきの添付 1 件を持つセッション。画像は実体も置く。 */
async function sessionWithScreenshot(options: { writeImage: boolean }): Promise<Ledger> {
  const { ledger } = await createSession({
    title: '持ち出しの検証',
    kind: 'text',
    origin: null,
    text: SOURCE_TEXT,
  })
  ledger.claims.push({
    id: 'claim_1',
    start: 0,
    end: SOURCE_TEXT.length,
    source_text: SOURCE_TEXT,
    claim: '売上は前年比 130% だった',
    kind: null,
    created_at: '2026-01-02T03:01:00.000Z',
    verdict: { value: 'verified', rationale: '証拠の記述と一致する', decided_at: '2026-01-02T03:02:00.000Z' },
  })
  ledger.evidence.push({
    id: 'evidence_1',
    source: { type: 'file', path: '/kakuu/quarter.md' },
    provenance: 'file',
    discovered_via: 'cited_in_source',
    discovery_note: null,
    fetched_at: '2026-01-02T03:00:50.000Z',
    text_sha256: '0'.repeat(64),
    text_length: 20,
    text_path: 'evidence/evidence_1.txt',
    html_path: null,
    screenshot_path: null,
    pdf: null,
    attempts: [{ stage: 'file', ok: true, detail: '読み込み成功', at: '2026-01-02T03:00:50.000Z' }],
    note: null,
    term_check: null,
  })
  ledger.attachments.push({
    id: 'attachment_1',
    claim_id: 'claim_1',
    evidence_id: 'evidence_1',
    quote: '前年比130%',
    relation: 'supports',
    rationale: '同じ数値',
    created_at: '2026-01-02T03:01:30.000Z',
    match: { start: 5, end: 12 },
    pdf_page: null,
    screenshot_path: 'attachments/attachment_1-saved-text.png',
    screenshot_note: null,
    screenshot_source: 'saved_text',
    screenshot_attempts: [],
  })
  await saveLedger(ledger)
  if (options.writeImage) {
    await writeSessionFile(ledger.session_id, 'attachments/attachment_1-saved-text.png', PNG_BYTES)
  }
  return ledger
}

describe('assertExportTarget', () => {
  test.each([
    { name: 'html に .html', format: 'html', outputPath: '/abs/report.html' },
    { name: 'html に .htm', format: 'html', outputPath: '/abs/report.htm' },
    { name: 'html に大文字の .HTML', format: 'html', outputPath: '/abs/REPORT.HTML' },
    { name: 'pdf に .pdf', format: 'pdf', outputPath: '/abs/report.pdf' },
  ] as const)('通る: $name', ({ format, outputPath }) => {
    expect(() => assertExportTarget(format, outputPath)).not.toThrow()
  })

  test.each([
    { name: '相対パス', format: 'html', outputPath: 'report.html', expected: '絶対パスで指定すること' },
    {
      name: 'html に .pdf',
      format: 'html',
      outputPath: '/abs/report.pdf',
      expected: '拡張子 .html / .htm にすること',
    },
    {
      name: 'pdf に .html',
      format: 'pdf',
      outputPath: '/abs/report.html',
      expected: '拡張子 .pdf にすること',
    },
    { name: '拡張子なし', format: 'pdf', outputPath: '/abs/report', expected: '拡張子 .pdf にすること' },
    { name: 'ドットで終わる', format: 'pdf', outputPath: '/abs/report.', expected: '拡張子 .pdf にすること' },
  ] as const)('拒否: $name', ({ format, outputPath, expected }) => {
    expect(() => assertExportTarget(format, outputPath)).toThrow(expected)
  })

  test('相対パスかつ拡張子違いは、両方を 1 度に言う', () => {
    expect(() => assertExportTarget('pdf', 'report.html')).toThrow(
      /絶対パスで指定すること[\s\S]*拡張子 \.pdf にすること/,
    )
  })
})

describe('exportReport (html)', () => {
  test('画像を data URI で埋め込んだ HTML を、無いディレクトリを作って書く', async () => {
    const ledger = await sessionWithScreenshot({ writeImage: true })
    const outputPath = path.join(outDir, 'nested', 'report.html')

    const result = await exportReport({
      sessionId: ledger.session_id,
      format: 'html',
      outputPath,
      overwrite: false,
    })

    expect(result).toEqual({
      session_id: ledger.session_id,
      format: 'html',
      path: outputPath,
      bytes: (await stat(outputPath)).size,
      inlined_images: 1,
      reports_stale_since: null,
    })
    const html = await readFile(outputPath, 'utf8')
    const payload = readEmbeddedJson(html, 'fact-check-data') as ViewerPayload
    expect(payload.assets).toEqual({ 'attachments/attachment_1-saved-text.png': PNG_DATA_URI })
    // 台帳のパスは書き換えない（report.json との照合と「読み込めなかったパス」の表示を守る）
    expect(payload.ledger.attachments[0]?.screenshot_path).toBe('attachments/attachment_1-saved-text.png')
    expect(payload.source_text).toBe(SOURCE_TEXT)
  })

  test('finalize を通していない台帳の印をそのまま返す', async () => {
    const ledger = await sessionWithScreenshot({ writeImage: true })
    ledger.reports_stale_since = '2026-01-02T04:00:00.000Z'
    await saveLedger(ledger)
    const outputPath = path.join(outDir, 'report.html')

    const result = await exportReport({
      sessionId: ledger.session_id,
      format: 'html',
      outputPath,
      overwrite: false,
    })

    expect(result.reports_stale_since).toBe('2026-01-02T04:00:00.000Z')
    const payload = readEmbeddedJson(await readFile(outputPath, 'utf8'), 'fact-check-data') as ViewerPayload
    expect(payload.ledger.reports_stale_since).toBe('2026-01-02T04:00:00.000Z')
  })

  test('出力先に既にファイルがあれば拒否し、overwrite=true なら置き換える', async () => {
    const ledger = await sessionWithScreenshot({ writeImage: true })
    const outputPath = path.join(outDir, 'report.html')
    await mkdir(outDir, { recursive: true })
    await writeFile(outputPath, '前からある中身')

    await expect(
      exportReport({ sessionId: ledger.session_id, format: 'html', outputPath, overwrite: false }),
    ).rejects.toThrow('出力先に既にファイルがある')
    expect(await readFile(outputPath, 'utf8')).toBe('前からある中身')

    await exportReport({ sessionId: ledger.session_id, format: 'html', outputPath, overwrite: true })
    expect(await readFile(outputPath, 'utf8')).toContain('<!doctype html>')
  })

  test('台帳が参照する画像が無ければ、どれが無いかを言って書かない', async () => {
    const ledger = await sessionWithScreenshot({ writeImage: false })
    const outputPath = path.join(outDir, 'report.html')

    await expect(
      exportReport({ sessionId: ledger.session_id, format: 'html', outputPath, overwrite: false }),
    ).rejects.toThrow('attachments/attachment_1-saved-text.png')
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('入力の検査は台帳を読む前に済ませる（無いセッションでも拡張子違いを先に言う）', async () => {
    await expect(
      exportReport({
        sessionId: 'fc_nonexistent',
        format: 'pdf',
        outputPath: '/abs/report.html',
        overwrite: false,
      }),
    ).rejects.toThrow('拡張子 .pdf にすること')
  })
})
