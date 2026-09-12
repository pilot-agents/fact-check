import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { FactCheckError } from '../errors.js'
import { withSessionLock } from './ledger-lock.js'
import { LEDGER_VERSION, type Ledger, type SourceRecord } from './ledger-types.js'

/**
 * セッション台帳の置き場所と読み書き。
 *
 * 1 セッション = 1 ディレクトリ、台帳は 1 枚の JSON。DB を持たないのは、プロセス再起動後に
 * session_id だけで再開できればよく、それ以上の同時実行性を要求しないため（ローカル 1 プロセス
 * 前提）。ツール呼び出しのたびに読み直して書き戻すので、再起動が状態を壊さない。
 *
 * 台帳を変えるツールは必ず updateLedger を通す。読み込みから書き戻しまでをセッション単位で
 * 直列化しないと、同時に届いた呼び出しが互いの変更を消す（ledger-lock.ts）。
 */

const LEDGER_FILE = 'ledger.json'
const SOURCE_FILE = 'source.txt'
export const EVIDENCE_DIR = 'evidence'
export const ATTACHMENT_DIR = 'attachments'

/** パス要素として使う以上、session_id は英数と `_-` だけに限る（パス遡上を構造的に不能にする）。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export function resolveBaseDir(): string {
  const configured = process.env.FACT_CHECK_DIR
  if (configured !== undefined && configured.trim() !== '') return path.resolve(configured)
  return path.resolve(process.cwd(), '.fact-check')
}

export function sessionDir(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new FactCheckError(`session_id の形式が不正 (session_id=${JSON.stringify(sessionId)})`)
  }
  return path.join(resolveBaseDir(), sessionId)
}

function newSessionId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  return `fc_${stamp}_${randomBytes(4).toString('hex')}`
}

async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${filePath}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, data)
    await rename(tmp, filePath)
  } catch (cause) {
    throw FactCheckError.fromCause(`ファイルの書き込みに失敗した (path=${filePath})`, cause)
  }
}

export type CreatedSession = { ledger: Ledger; dir: string }

export async function createSession(args: {
  title: string | null
  kind: SourceRecord['kind']
  origin: string | null
  text: string
}): Promise<CreatedSession> {
  const now = new Date()
  const sessionId = newSessionId(now)
  const dir = sessionDir(sessionId)
  try {
    await mkdir(path.join(dir, EVIDENCE_DIR), { recursive: true })
    await mkdir(path.join(dir, ATTACHMENT_DIR), { recursive: true })
  } catch (cause) {
    throw FactCheckError.fromCause(`セッションディレクトリを作成できない (dir=${dir})`, cause)
  }
  await writeFileAtomic(path.join(dir, SOURCE_FILE), args.text)
  const ledger: Ledger = {
    version: LEDGER_VERSION,
    session_id: sessionId,
    title: args.title,
    created_at: now.toISOString(),
    source: { kind: args.kind, origin: args.origin, length: args.text.length, text_path: SOURCE_FILE },
    claims: [],
    non_claims: [],
    evidence: [],
    attachments: [],
  }
  await saveLedger(ledger)
  return { ledger, dir }
}

export async function loadLedger(sessionId: string): Promise<Ledger> {
  const dir = sessionDir(sessionId)
  const filePath = path.join(dir, LEDGER_FILE)
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (cause) {
    throw FactCheckError.fromCause(
      `セッションを読み込めない (session_id=${sessionId}, path=${filePath}). start_session で作った session_id か、FACT_CHECK_DIR の指す先が同じかを確認すること`,
      cause,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw FactCheckError.fromCause(`台帳の JSON が壊れている (path=${filePath})`, cause)
  }
  const ledger = parsed as Ledger
  if (ledger.version !== LEDGER_VERSION) {
    throw new FactCheckError(
      `台帳のバージョンが違う (path=${filePath}, 読めるのは version=${LEDGER_VERSION}, 実際=${String(ledger.version)})`,
    )
  }
  return ledger
}

/**
 * 台帳を読み、変更し、書き戻す。この一連をセッション単位で直列化する唯一の入口。
 *
 * 変更の中で外部取得（HTTP・ブラウザ）まで行うツールがあるので、ロックは呼び出し全体で保持する。
 * 同じセッションへの同時呼び出しはその間待たされるが、台帳の後勝ち消失より待ち時間を選ぶ。
 * mutate の中から updateLedger を再び呼んではいけない（自分のロックを待つことになる）。
 */
export async function updateLedger<T>(sessionId: string, mutate: (ledger: Ledger) => Promise<T>): Promise<T> {
  return await withSessionLock(sessionId, async () => {
    const ledger = await loadLedger(sessionId)
    const result = await mutate(ledger)
    await saveLedger(ledger)
    return result
  })
}

export async function saveLedger(ledger: Ledger): Promise<void> {
  await writeFileAtomic(
    path.join(sessionDir(ledger.session_id), LEDGER_FILE),
    `${JSON.stringify(ledger, null, 2)}\n`,
  )
}

export async function loadSourceText(ledger: Ledger): Promise<string> {
  const filePath = path.join(sessionDir(ledger.session_id), ledger.source.text_path)
  try {
    return await readFile(filePath, 'utf8')
  } catch (cause) {
    throw FactCheckError.fromCause(`元ネタ本文を読み込めない (path=${filePath})`, cause)
  }
}

export async function writeSessionFile(
  sessionId: string,
  relativePath: string,
  data: string | Uint8Array,
): Promise<string> {
  const target = path.join(sessionDir(sessionId), relativePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFileAtomic(target, data)
  return relativePath
}

export async function readSessionFile(sessionId: string, relativePath: string): Promise<string> {
  return (await readSessionBytes(sessionId, relativePath)).toString('utf8')
}

/** バイト列のまま読む（PDF のように復号してはいけない保存物）。 */
export async function readSessionBytes(sessionId: string, relativePath: string): Promise<Buffer> {
  const target = path.join(sessionDir(sessionId), relativePath)
  try {
    return await readFile(target)
  } catch (cause) {
    throw FactCheckError.fromCause(`セッション内のファイルを読み込めない (path=${target})`, cause)
  }
}

export function nextId(prefix: string, existing: readonly { id: string }[]): string {
  return `${prefix}_${existing.length + 1}`
}
