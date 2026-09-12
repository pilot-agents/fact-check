import path from 'node:path'
import { sessionDir, writeSessionFile } from '../session/ledger-store.js'
import { type LedgerSummary, summarizeLedger } from '../session/ledger-summary.js'
import type { Ledger } from '../session/ledger-types.js'
import { type AttentionItem, buildAttention } from './attention.js'
import { renderHtml } from './rendering/render-html.js'
import { renderMarkdown } from './rendering/render-markdown.js'
import { buildViewerPayload } from './rendering/viewer-payload.js'

/**
 * 最終レポートの書き出し。AI の申告ではなく台帳そのものからしか作らない。
 * report.json には台帳を丸ごと入れる。レポートと台帳が食い違っていないことを、
 * 読み手が機械的に確かめられるようにするため。
 */

export type ReportPaths = { markdown: string; json: string; html: string; dir: string }

export type ReportJson = {
  generated_at: string
  summary: LedgerSummary
  /** verified 以外の claim を重い順に並べたもの。md / html の「要確認一覧」と同じ中身 */
  attention: AttentionItem[]
  ledger: Ledger
}

export async function writeReport(
  ledger: Ledger,
  sourceText: string,
): Promise<{ paths: ReportPaths; summary: LedgerSummary }> {
  const summary = summarizeLedger(ledger)
  const attention = buildAttention(ledger)
  const generatedAt = new Date().toISOString()
  const json: ReportJson = { generated_at: generatedAt, summary, attention, ledger }
  const markdown = await writeSessionFile(ledger.session_id, 'report.md', renderMarkdown(ledger, summary))
  const jsonPath = await writeSessionFile(
    ledger.session_id,
    'report.json',
    `${JSON.stringify(json, null, 2)}\n`,
  )
  const html = await writeSessionFile(
    ledger.session_id,
    'report.html',
    renderHtml(buildViewerPayload({ generatedAt, ledger, summary, attention, sourceText })),
  )
  const dir = sessionDir(ledger.session_id)
  return {
    paths: {
      dir,
      markdown: path.join(dir, markdown),
      json: path.join(dir, jsonPath),
      html: path.join(dir, html),
    },
    summary,
  }
}
