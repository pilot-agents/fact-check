import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { FactCheckError } from '../errors.js'
import { asRecord, type LedgerLike, parseJsonFile, parseLedgerLike } from '../session/ledger-like.js'
import { type LedgerSummary, summarizeLedger } from '../session/ledger-summary.js'
import { buildAttention } from './attention.js'
import { renderHtml } from './rendering/render-html.js'
import { buildViewerPayload } from './rendering/viewer-payload.js'

/**
 * 既にあるセッションの report.html を、今のビューアで作り直す。
 *
 * finalize をやり直さないのは、finalize が証拠の取り直しや台帳の書き換えを伴う入口だからで、
 * 済んだ裏取りをもう一度走らせずに見た目だけ新しくしたい、という用途に合わない。入力は
 * report.json と source.txt だけで、書き出すのも report.html だけ。台帳には触れない。
 *
 * version 1 の report.json も受け付ける。MCP ツール側は version 1 の台帳を拒否する（必須になった
 * discovered_via が undefined のままレポートに出るのを防ぐため）が、それは「これから裏取りを
 * 続ける」場合の話で、済んだ結果を読み返す経路まで閉じると、過去のセッションが二度と読めなくなる。
 * 記録が無い項目は「旧版のため未記録」と出す。
 */

const REPORT_JSON = 'report.json'
const REPORT_HTML = 'report.html'

export type RebuiltReport = {
  sessionId: string
  ledgerVersion: number
  htmlPath: string
  summary: LedgerSummary
  /** 出どころの記録が無い証拠の件数。version 1 の台帳では全件になる */
  evidenceWithoutDiscovery: number
}

export async function rebuildReportHtml(sessionDirectory: string): Promise<RebuiltReport> {
  const directory = path.resolve(sessionDirectory)
  const jsonPath = path.join(directory, REPORT_JSON)
  const raw = await readTextFile(jsonPath, 'report.json を読み込めない')
  const parsed = parseReportJson(raw, jsonPath)
  const sourcePath = path.join(directory, parsed.ledger.source.text_path)
  const sourceText = await readTextFile(sourcePath, '元ネタ本文を読み込めない')

  if (sourceText.length !== parsed.ledger.source.length) {
    throw new FactCheckError(
      `元ネタ本文の長さが台帳と合わない (path=${sourcePath}, 台帳=${parsed.ledger.source.length} 文字, ファイル=${sourceText.length} 文字)。` +
        '塗り分けは文字位置で行うので、食い違ったまま描くと別の場所を塗ることになる。',
    )
  }

  const summary = summarizeLedger(parsed.ledger)
  const payload = buildViewerPayload({
    generatedAt: parsed.generatedAt,
    ledger: parsed.ledger,
    summary,
    attention: buildAttention(parsed.ledger),
    sourceText,
  })
  const htmlPath = path.join(directory, REPORT_HTML)
  try {
    await writeFile(htmlPath, renderHtml(payload))
  } catch (cause) {
    throw FactCheckError.fromCause(`report.html を書き出せない (path=${htmlPath})`, cause)
  }
  return {
    sessionId: parsed.ledger.session_id,
    ledgerVersion: parsed.ledger.version,
    htmlPath,
    summary,
    evidenceWithoutDiscovery: payload.ledger.evidence.filter((e) => e.discovered_via === null).length,
  }
}

async function readTextFile(filePath: string, problem: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (cause) {
    throw FactCheckError.fromCause(`${problem} (path=${filePath})`, cause)
  }
}

export type ParsedReport = { generatedAt: string; ledger: LedgerLike }

/**
 * report.json から台帳を取り出す。version は問わない（読むだけの経路なので ledger-like を通す）。
 */
export function parseReportJson(raw: string, filePath: string): ParsedReport {
  const root = asRecord(parseJsonFile(raw, filePath), 'report.json 全体', filePath)
  const ledger = parseLedgerLike(root.ledger, filePath)
  const generatedAt = typeof root.generated_at === 'string' ? root.generated_at : '（生成時刻の記録なし）'
  return { generatedAt, ledger }
}
