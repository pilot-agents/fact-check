import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { describeCause, FactCheckError } from '../errors.js'
import { parseJsonFile, parseLedgerLike } from '../session/ledger-like.js'
import { type LedgerSummary, summarizeLedger } from '../session/ledger-summary.js'

/**
 * セッション一覧の材料集め。台帳を読むだけで、書き込みは一切しない。
 *
 * 読めなかったセッションを一覧から黙って外さない。外すと「そんなセッションは無い」ように
 * 見えて、壊れた台帳が誰にも気づかれないまま残る。行は必ず出して、読めなかった理由を添える。
 */

/** パス要素として扱う以上、ここでも session_id の形を英数と `_-` に限る。 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export type SessionRow = {
  id: string
  title: string | null
  created_at: string | null
  source: { kind: string; origin: string | null } | null
  ledger_version: number | null
  summary: LedgerSummary | null
  /** report.html が既にあるか（finalize 済みか report:rebuild 済みか） */
  finalized: boolean
  /** 台帳が読めなかったときの理由。読めていれば null */
  error: string | null
}

export async function listSessions(baseDir: string): Promise<SessionRow[]> {
  let entries: Dirent<string>[]
  try {
    entries = await readdir(baseDir, { withFileTypes: true })
  } catch (cause) {
    throw FactCheckError.fromCause(`セッションの保存先を読めない (dir=${baseDir})`, cause)
  }
  const ids = entries
    .filter((entry) => entry.isDirectory() && SESSION_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
  const rows = await Promise.all(ids.map((id) => readSession(baseDir, id)))
  return rows.sort(byNewestFirst)
}

function byNewestFirst(a: SessionRow, b: SessionRow): number {
  const left = a.created_at ?? ''
  const right = b.created_at ?? ''
  if (left !== right) return left < right ? 1 : -1
  return a.id < b.id ? 1 : -1
}

async function readSession(baseDir: string, id: string): Promise<SessionRow> {
  const directory = path.join(baseDir, id)
  const finalized = await exists(path.join(directory, 'report.html'))
  const ledgerPath = path.join(directory, 'ledger.json')
  try {
    const ledger = parseLedgerLike(parseJsonFile(await readFile(ledgerPath, 'utf8'), ledgerPath), ledgerPath)
    return {
      id,
      title: ledger.title,
      created_at: ledger.created_at,
      source: { kind: ledger.source.kind, origin: ledger.source.origin },
      ledger_version: ledger.version,
      summary: summarizeLedger(ledger),
      finalized,
      error: null,
    }
  } catch (cause) {
    return {
      id,
      title: null,
      created_at: null,
      source: null,
      ledger_version: null,
      summary: null,
      finalized,
      error: describeCause(cause),
    }
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}
