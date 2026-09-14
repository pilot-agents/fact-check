import path from 'node:path'
import { FactCheckError } from '../errors.js'
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

/** 書き出す 3 形式。順番はこのまま（失敗したときにどこまで進んだかを言うため）。 */
const REPORT_FILES = ['report.md', 'report.json', 'report.html'] as const

/**
 * このレポートが何なのか。
 * - `finalize` — finalize の検証を通した正式なもの
 * - `provisional` — 台帳が変わったので書き直しただけ。検証は通っていない
 */
export type ReportWriteMode = 'finalize' | 'provisional'

/** セッションディレクトリと 3 形式の絶対パス。書き出さずに知りたい側（finalize）も使う。 */
export function reportPaths(sessionId: string): ReportPaths {
  const dir = sessionDir(sessionId)
  return {
    dir,
    markdown: path.join(dir, 'report.md'),
    json: path.join(dir, 'report.json'),
    html: path.join(dir, 'report.html'),
  }
}

/**
 * 3 形式を書き出す。**途中で失敗したら、どこまで書けたかを言って投げる。**
 *
 * 3 形式を 1 つの原子的な操作にはしていない（そのための仕組みを新設していない）。
 * 代わりに、失敗を成功に化かさず、「どれが新しくてどれが古いか」と「どう戻すか」を
 * 元の cause 付きで残す。1 形式ずつは writeFileAtomic なので、半分書けたファイルは残らない。
 */
export async function writeReport(
  ledger: Ledger,
  sourceText: string,
  mode: ReportWriteMode,
): Promise<{ paths: ReportPaths; summary: LedgerSummary }> {
  const summary = summarizeLedger(ledger)
  const attention = buildAttention(ledger)
  const generatedAt = new Date().toISOString()
  // 「暫定表示か」はこのレポートの素性で決まる。**書き出す時点の台帳の印では決めない。**
  // 印は「書き出しに成功してから消す」ようにしたので、finalize の書き出し中はまだ立っている。
  // それをそのまま描くと、検証を通った正式なレポートに暫定の断りが焼き込まれる。
  const rendered: Ledger = mode === 'finalize' ? { ...ledger, reports_stale_since: null } : ledger
  const json: ReportJson = { generated_at: generatedAt, summary, attention, ledger: rendered }
  const contents: Record<(typeof REPORT_FILES)[number], string> = {
    'report.md': renderMarkdown(rendered, summary),
    'report.json': `${JSON.stringify(json, null, 2)}\n`,
    'report.html': renderHtml(
      // 画像は相対パスのまま。セッションディレクトリごと渡す前提のファイルで、単体で持ち出す
      // 形（画像を埋め込む）は export_report が別に作る。
      buildViewerPayload({ generatedAt, ledger: rendered, summary, attention, sourceText, assets: {} }),
    ),
  }
  const written: string[] = []
  for (const name of REPORT_FILES) {
    try {
      await writeSessionFile(ledger.session_id, name, contents[name])
    } catch (cause) {
      const remaining = REPORT_FILES.filter((other) => !written.includes(other))
      throw FactCheckError.fromCause(
        [
          `レポートの書き出しが途中で失敗した (session_id=${ledger.session_id}, 失敗したのは ${name})。`,
          `新しい内容になったのは [${written.join(', ') || 'なし'}]。`,
          `前の内容のままなのは [${remaining.join(', ')}]。`,
          '3 形式が食い違ったままなので、原因を直して finalize を呼び直すこと。',
        ].join('\n'),
        cause,
      )
    }
    written.push(name)
  }
  return { paths: reportPaths(ledger.session_id), summary }
}
