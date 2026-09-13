import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { FactCheckError } from '../errors.js'
import { normalizeAddedFields } from './ledger-added-fields.js'
import { withSessionLock } from './ledger-lock.js'
import { LEDGER_VERSION, type Ledger, READABLE_LEDGER_VERSIONS, type SourceRecord } from './ledger-types.js'

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
    exclusions: [],
    reports_stale_since: null,
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
  // 読めるのは複数の版。書くのは常に今の版（saveLedger）。読んだだけでは版を上げない
  // ——「読んだら勝手に新しい版になって古いツールで開けなくなる」を避けるため。
  if (!READABLE_LEDGER_VERSIONS.includes(ledger.version)) {
    throw new FactCheckError(
      `台帳のバージョンが違う (path=${filePath}, ` +
        `読めるのは version=${READABLE_LEDGER_VERSIONS.join(', ')}, ` +
        `実際=${String(ledger.version)})。` +
        `このセッションを更新すると version=${LEDGER_VERSION} で保存され、古い版のツールでは開けなくなる。`,
    )
  }
  // 後から足した項目は、**無いときだけ**既定値を補う。あって形が違うなら拒否する
  // （空として読むと、取り消したはずの記録が復活した状態に見える）。
  // 読むだけの経路（report:rebuild / セッション一覧）も同じ関数を通す。
  normalizeAddedFields(ledger, filePath)
  return ledger
}

/**
 * 台帳が変わったので、書き出し済みのレポートはもう最新ではない、と記録する。
 * 消すのは finalize だけ（レポートを作り直した瞬間だけ「最新」に戻る）。
 */
export function markReportsStale(ledger: Ledger): void {
  ledger.reports_stale_since = new Date().toISOString()
}

/**
 * 台帳を読み、変更し、書き戻す。この一連をセッション単位で直列化する唯一の入口。
 *
 * 変更の中で外部取得（HTTP・ブラウザ）まで行うツールがあるので、ロックは呼び出し全体で保持する。
 * 同じセッションへの同時呼び出しはその間待たされるが、台帳の後勝ち消失より待ち時間を選ぶ。
 * mutate の中から updateLedger を再び呼んではいけない（自分のロックを待つことになる）。
 */
/**
 * 台帳を変えたあとに、書き出し済みのレポートをどう扱うか。
 *
 * - `refresh`（既定）— すでにレポートがあれば書き直す。無ければ何もしない
 * - `finalize` — 検証を通したので 3 形式を書き出し、**書き出しが成功してから**
 *   「レポートは最新」の印を台帳に書く
 */
export type ReportSyncMode = 'refresh' | 'finalize'

export async function updateLedger<T>(
  sessionId: string,
  mutate: (ledger: Ledger) => Promise<T>,
  reportSync: ReportSyncMode = 'refresh',
): Promise<T> {
  return await withSessionLock(sessionId, async () => {
    const ledger = await loadLedger(sessionId)
    // 台帳を変える経路はここしかないので、「書き出し済みのレポートはもう古い」の印も
    // ここで付ける。ツールごとに書くと、新しいツールを足した人が忘れる。
    markReportsStale(ledger)
    const result = await mutate(ledger)
    // **台帳が先、レポートが後。** 逆にすると、レポートの書き出しは成功したのに台帳の保存が
    // 失敗したとき、レポートが「保存されていない台帳の内容」を最新の結果として見せる。
    await saveLedger(ledger)
    await syncReports(ledger, reportSync)
    return result
  })
}

/** 書き出し済みのレポート。無いものは並ばない。 */
async function presentReports(directory: string): Promise<string[]> {
  const present: string[] = []
  for (const name of REPORT_FILE_NAMES) {
    if (await fileExists(path.join(directory, name))) present.push(name)
  }
  return present
}

const REPORT_FILE_NAMES = ['report.md', 'report.json', 'report.html'] as const

/**
 * 台帳を保存したあとに、書き出し済みのレポートを合わせる。**必ず台帳の保存より後に呼ぶ。**
 *
 * ここに置く理由: 取り消しだけでなく register_claim / attach_evidence / set_verdict などの
 * ふつうの変更でも、すでにある report.html は古くなる。ツールごとに書くと必ず抜ける。
 *
 * **「レポートは最新」の印は、書き出しが成功してから台帳へ書く。**
 * 以前は finalize が mutate の中で印を消し、その台帳を保存してから書き出していた。
 * 書き出しが失敗しても印は消えたままなので、`get_status` は「最新」に見えていた。
 *
 * この関数の中の失敗は**すべて台帳を保存したあとの失敗**なので、その文脈ごと包んで投げる
 * （stat・動的 import・元ネタ本文の読み込みも含む。どれも保存後に起きる）。
 *
 * 静的 import にしないのは、レポート層がこのファイルの `writeSessionFile` / `sessionDir` を
 * 使っており、静的に相互参照すると読み込み順に依存する形になるため。
 */
async function syncReports(ledger: Ledger, mode: ReportSyncMode): Promise<void> {
  const directory = sessionDir(ledger.session_id)
  let present: string[] | null = null
  try {
    present = await presentReports(directory)
    if (mode === 'refresh' && present.length === 0) return
    const { writeReport } = await import('../report/write-report.js')
    await writeReport(ledger, await loadSourceText(ledger), mode === 'finalize' ? 'finalize' : 'provisional')
  } catch (cause) {
    throw FactCheckError.fromCause(afterSaveFailure(ledger, present, mode), cause)
  }
  if (mode !== 'finalize') return
  // ここまで来て初めて「書き出したレポートは台帳と一致している」と言える。
  ledger.reports_stale_since = null
  try {
    await saveLedger(ledger)
  } catch (cause) {
    throw FactCheckError.fromCause(
      [
        `レポート 3 形式は書けたが、完了の印を台帳に書けなかった (session_id=${ledger.session_id})。`,
        `${LEDGER_FILE} には「レポート未完了」が残っているので、get_status は未完了のままになる。`,
        'ディスクに書ける状態に直してから finalize を呼び直すと、同じ内容で書き直して印を消せる。',
        '書けなかった原因はこの下の cause に入っている。',
      ].join('\n'),
      cause,
    )
  }
}

/** 台帳を保存したあとに失敗したときの説明。どこまで確定していて、次に何をするかを書く。 */
function afterSaveFailure(ledger: Ledger, present: string[] | null, mode: ReportSyncMode): string {
  return [
    `台帳の変更は保存できたが、そのあとのレポート処理に失敗した (session_id=${ledger.session_id})。`,
    `${LEDGER_FILE} は新しい内容で確定している。`,
    mode === 'finalize'
      ? '「レポートは最新」の印は付けていないので、get_status は未完了のままになる。'
      : '「レポートは古い」の印が付いたままになる。',
    present === null
      ? 'どのレポートが残っていたかは、その確認より前に失敗したため分からない。'
      : `失敗する前にあったレポート: [${present.join(', ') || 'なし'}]。`,
    '**残っているレポートファイルは古い内容の可能性がある。** ディスクに書けない状態では、',
    'その古いファイル自体に警告を書き込むこともできない。台帳と get_status のほうを見ること。',
    '',
    '回復の手順: 原因を直してから finalize を呼び直すと、3 形式を作り直せる。',
    'ただし取り消しなどで判定の根拠が足りなくなっている場合、finalize は先に拒否する。',
    'その場合は get_status の verdicts_without_basis を片付けてから finalize を呼ぶこと。',
    '失敗の原因はこの下の cause に入っている。',
  ].join('\n')
}

/**
 * ファイルがあるか。**「無い」と言ってよいのは ENOENT だけ**。
 *
 * 以前はあらゆる stat の失敗を「無い」に畳んでいた。権限が無い・パスの途中がファイル・
 * I/O エラーのどれも「finalize していないセッション」に見えてしまい、原因が消えていた。
 * ENOENT 以外は原因を持ったまま投げる。
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false
    throw FactCheckError.fromCause(`ファイルの有無を確かめられない (path=${filePath})`, cause)
  }
}

/**
 * 台帳を書き戻す。**書いた瞬間に版は今の版になる。**
 *
 * 1 つ前の版のセッションでも、更新したらこの版で保存する。読める版のまま書き戻すと、
 * 新しい項目（取り消し履歴など）が入った台帳を古い版のツールが「自分が読める版だ」と
 * 判断して開き、取り消しを無視して集計してしまう。
 *
 * 逆に、**読んだだけでは版は上がらない**（loadLedger は版を書き換えない）。
 * 読み返しただけで古い版へ戻す道を塞がないため。
 */
export async function saveLedger(ledger: Ledger): Promise<void> {
  ledger.version = LEDGER_VERSION
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
