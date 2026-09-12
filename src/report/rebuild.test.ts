import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { rebuildReportHtml } from './rebuild.js'
import { readEmbeddedJson } from './rendering/embed-json.js'
import type { ViewerPayload } from './rendering/viewer-payload.js'

/**
 * version 1 の report.json（架空データ）から report.html を作り直せることの確認。
 *
 * 本文には `</script>` と `<!--` を混ぜてある。埋め込み起因の壊れ方はページを開くまで
 * 気づけないので、作り直したページから埋め込みデータを読み戻せることまで見る。
 */

const SOURCE_TEXT = [
  '架空社の四半期メモ',
  '',
  '当社の売上は前年比130%だった。海外出荷は512台だった。',
  '注記: 本文に </script> と <!-- コメント --> が入っている行。',
].join('\n')

const SALES_START = SOURCE_TEXT.indexOf('当社の売上')
const SHIPMENT_START = SOURCE_TEXT.indexOf('海外出荷')
const NOTE_START = SOURCE_TEXT.indexOf('注記:')

/** version 1 の台帳。discovered_via / discovery_note / pdf / pdf_page を持たない。 */
function legacyReportJson(): string {
  return `${JSON.stringify(
    {
      generated_at: '2026-01-02T03:04:05.000Z',
      summary: { 古い集計: '再計算するので中身は見ない' },
      ledger: {
        version: 1,
        session_id: 'fc_20260102T030405_0badc0de',
        title: '架空社メモのファクトチェック',
        created_at: '2026-01-02T03:00:00.000Z',
        source: {
          kind: 'file',
          origin: '/tmp/kakuu-memo.md',
          length: SOURCE_TEXT.length,
          text_path: 'source.txt',
        },
        claims: [
          {
            id: 'claim_1',
            start: SALES_START,
            end: SHIPMENT_START,
            source_text: SOURCE_TEXT.slice(SALES_START, SHIPMENT_START),
            claim: '当社の売上は前年比 130% だった',
            kind: '数値',
            created_at: '2026-01-02T03:01:00.000Z',
            verdict: {
              value: 'partially_verified',
              rationale: '証拠は 130% を示すが、対象期間が書かれていない',
              decided_at: '2026-01-02T03:02:00.000Z',
            },
          },
          {
            id: 'claim_2',
            start: SHIPMENT_START,
            end: NOTE_START,
            source_text: SOURCE_TEXT.slice(SHIPMENT_START, NOTE_START),
            claim: '海外出荷は 512 台だった',
            kind: null,
            created_at: '2026-01-02T03:01:10.000Z',
            verdict: {
              value: 'verified',
              rationale: '証拠の記述と一致する',
              decided_at: '2026-01-02T03:02:10.000Z',
            },
          },
        ],
        non_claims: [
          {
            id: 'non_claim_1',
            start: 0,
            end: SALES_START,
            source_text: SOURCE_TEXT.slice(0, SALES_START),
            reason: '見出しと空行',
            created_at: '2026-01-02T03:00:30.000Z',
          },
          {
            id: 'non_claim_2',
            start: NOTE_START,
            end: SOURCE_TEXT.length,
            source_text: SOURCE_TEXT.slice(NOTE_START),
            reason: '注記であり事実主張ではない',
            created_at: '2026-01-02T03:00:40.000Z',
          },
        ],
        evidence: [
          {
            id: 'evidence_1',
            source: { type: 'url', url: 'https://example.test/kakuu/quarter' },
            provenance: 'http',
            fetched_at: '2026-01-02T03:00:50.000Z',
            text_sha256: '0'.repeat(64),
            text_length: 120,
            text_path: 'evidence/evidence_1.txt',
            html_path: 'evidence/evidence_1.html',
            screenshot_path: null,
            attempts: [{ stage: 'http', ok: true, detail: 'HTTP 取得成功', at: '2026-01-02T03:00:50.000Z' }],
            note: null,
          },
        ],
        attachments: [
          {
            id: 'attachment_1',
            claim_id: 'claim_1',
            evidence_id: 'evidence_1',
            quote: '売上は前年比130%',
            relation: 'partial',
            rationale: '同じ数値はあるが期間の記述が無い',
            created_at: '2026-01-02T03:01:30.000Z',
            match: { start: 10, end: 24 },
            screenshot_path: 'attachments/attachment_1.png',
            screenshot_note: null,
          },
        ],
      },
    },
    null,
    2,
  )}\n`
}

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'fact-check-rebuild-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('rebuildReportHtml', () => {
  test('version 1 の report.json から report.html を作り直せる', async () => {
    await writeFile(path.join(directory, 'report.json'), legacyReportJson())
    await writeFile(path.join(directory, 'source.txt'), SOURCE_TEXT)

    const result = await rebuildReportHtml(directory)
    expect(result.sessionId).toBe('fc_20260102T030405_0badc0de')
    expect(result.ledgerVersion).toBe(1)
    expect(result.htmlPath).toBe(path.join(directory, 'report.html'))
    expect(result.summary.coverage.complete).toBe(true)
    expect(result.summary.claims).toMatchObject({ total: 2, verified: 1, partially_verified: 1 })

    const html = await readFile(result.htmlPath, 'utf8')
    const payload = readEmbeddedJson(html, 'fact-check-data') as ViewerPayload

    // 記録の無い項目は null に正規化され、ビューアは「旧版のため未記録」と出せる
    expect(result.evidenceWithoutDiscovery).toBe(1)
    expect(payload.ledger.evidence[0]?.discovered_via).toBeNull()
    expect(payload.ledger.evidence[0]?.discovery_note).toBeNull()
    expect(payload.ledger.evidence[0]?.pdf).toBeNull()
    expect(payload.ledger.attachments[0]?.pdf_page).toBeNull()
    const labels = readEmbeddedJson(html, 'fact-check-labels') as { unrecorded: string }
    expect(labels.unrecorded).toBe('旧版のため未記録')

    // version 1 の report.json は attention を持たないので、台帳から作り直す
    expect(payload.attention.map((item) => item.claim_id)).toEqual(['claim_1'])
    expect(payload.attention[0]?.verdict).toBe('partially_verified')

    // 本文と塗り分けの区間がそのまま読み戻せる（埋め込みが壊れていない）
    expect(payload.source_text).toBe(SOURCE_TEXT)
    expect(payload.spans[0]?.start).toBe(0)
    expect(payload.spans.at(-1)?.end).toBe(SOURCE_TEXT.length)
    expect(payload.spans.map((span) => span.claim_ids)).toEqual([[], ['claim_1'], ['claim_2'], []])

    // 生の `</script>` が本文として残っていない（残っていればここで script が閉じる）
    expect(html.split('</script>')).toHaveLength(4)
  })

  test('report.json が無ければ理由を言って失敗する', async () => {
    await expect(rebuildReportHtml(directory)).rejects.toThrow('report.json を読み込めない')
  })

  test('台帳の形でない report.json は、どの項目がおかしいかを言って失敗する', async () => {
    await writeFile(
      path.join(directory, 'report.json'),
      JSON.stringify({ generated_at: 'x', ledger: { version: 1, session_id: 'fc_1', source: {} } }),
    )
    await expect(rebuildReportHtml(directory)).rejects.toThrow('source.length が数値でない')
  })

  test('本文の長さが台帳と合わなければ、黙って別の場所を塗らずに失敗する', async () => {
    await writeFile(path.join(directory, 'report.json'), legacyReportJson())
    await writeFile(path.join(directory, 'source.txt'), `${SOURCE_TEXT}余計な追記`)
    await expect(rebuildReportHtml(directory)).rejects.toThrow('元ネタ本文の長さが台帳と合わない')
  })
})
