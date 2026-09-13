import { FactCheckError } from '../errors.js'
import type { ExclusionTargetType, ScreenshotSource } from './ledger-types.js'

/**
 * 共有契約: **後から足した項目**（取り消し履歴・レポートの鮮度・画像の試行記録）の検証。
 *
 * MCP の本流（loadLedger）と、読むだけの経路（report:rebuild とセッション一覧）が
 * **同じこの関数を通る**。片方だけが緩いと、ツールが拒否した台帳をビューアが平気で描く。
 *
 * 「無い」と「壊れている」を必ず分ける:
 * - **無い** = 取り消し機能より前に作った台帳。既定値（`[]` / `null`）を補って読む
 * - **壊れている** = 項目はあるが形が違う。**拒否する。**
 *
 * なぜ拒否が要るか（これを直す前は握りつぶしていた）: 以前は `!Array.isArray(...)` で
 * 判定して既定値を入れていたので、`exclusions` が文字列や null に化けた台帳を読むと
 * **取り消し履歴が空になり、取り消したはずの全レコードが復活した状態**として解釈された。
 * 網羅率も判定も、消えたはずの誤登録を含んだまま「正常」に見える。
 *
 * 拒否のメッセージには「どのファイルの・どの項目の・何番目が・実際にはどんな型か」を入れる。
 * 直す人がファイルを開いて該当箇所へ行けなければ、拒否した意味がない。
 */

const EXCLUSION_TARGET_TYPES: readonly ExclusionTargetType[] = [
  'claim',
  'non_claim',
  'evidence',
  'attachment',
  'session',
]

const SCREENSHOT_SOURCES: readonly ScreenshotSource[] = [
  'saved_html',
  'saved_text',
  'pdf_page',
  'agent_captured',
]

/** 値の「実際の型」を、読む人が原因に辿り着ける粒度で言う。 */
function actualType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `配列(${value.length} 件)`
  return typeof value
}

/**
 * 後から足した項目を検証し、無いものだけ既定値で埋める。
 *
 * 引数の `ledger` は書き換える（読み込み直後の 1 回だけ呼ぶ前提）。壊れていれば投げるので、
 * **呼び出し側が台帳を保存する前に必ず止まる**（壊れた台帳を上書きしない）。
 */
export function normalizeAddedFields(value: unknown, filePath: string): void {
  const ledger = value as Record<string, unknown>
  const problems: string[] = []

  // --- exclusions ---
  if (ledger.exclusions === undefined) {
    ledger.exclusions = []
  } else if (!Array.isArray(ledger.exclusions)) {
    problems.push(`exclusions が配列でない (実際=${actualType(ledger.exclusions)})`)
  } else {
    ledger.exclusions.forEach((record: unknown, index: number) => {
      problems.push(...exclusionProblems(record, index))
    })
  }

  // --- reports_stale_since ---
  if (ledger.reports_stale_since === undefined) {
    ledger.reports_stale_since = null
  } else if (ledger.reports_stale_since !== null && typeof ledger.reports_stale_since !== 'string') {
    problems.push(
      `reports_stale_since が文字列でも null でもない (実際=${actualType(ledger.reports_stale_since)})`,
    )
  }

  // --- attachments[].screenshot_attempts / screenshot_source / pdf_page ---
  if (Array.isArray(ledger.attachments)) {
    ledger.attachments.forEach((value: unknown, index: number) => {
      problems.push(...attachmentProblems(value, index))
    })
  }

  if (problems.length === 0) return
  throw new FactCheckError(
    [
      `台帳の後から足した項目が壊れている (path=${filePath}):`,
      ...problems.map((problem) => `  - ${problem}`),
      '',
      'これらは「無ければ既定値」だが、あって形が違う場合は読まない。空として読むと、',
      '取り消したはずの記録が復活した状態に見えてしまう。ファイルを直してから開き直すこと。',
    ].join('\n'),
  )
}

function exclusionProblems(record: unknown, index: number): string[] {
  const where = `exclusions[${index}]`
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return [`${where} がオブジェクトでない (実際=${actualType(record)})`]
  }
  const exclusion = record as Record<string, unknown>
  const problems: string[] = []
  if (typeof exclusion.id !== 'string' || exclusion.id === '') {
    problems.push(`${where}.id が空でない文字列でない (実際=${actualType(exclusion.id)})`)
  }
  if (!EXCLUSION_TARGET_TYPES.includes(exclusion.target_type as ExclusionTargetType)) {
    problems.push(
      `${where}.target_type が ${EXCLUSION_TARGET_TYPES.join(' / ')} のどれでもない ` +
        `(実際=${JSON.stringify(exclusion.target_type)})`,
    )
  }
  if (typeof exclusion.target_id !== 'string' || exclusion.target_id === '') {
    problems.push(`${where}.target_id が空でない文字列でない (実際=${actualType(exclusion.target_id)})`)
  }
  if (typeof exclusion.reason !== 'string') {
    problems.push(`${where}.reason が文字列でない (実際=${actualType(exclusion.reason)})`)
  }
  if (typeof exclusion.excluded_at !== 'string') {
    problems.push(`${where}.excluded_at が文字列でない (実際=${actualType(exclusion.excluded_at)})`)
  }
  // restored は「まだ復元していない」を null で表す。undefined を null と同じに読むと、
  // 項目ごと欠けた壊れた履歴が「取り消し中」として通ってしまうので分ける。
  if (exclusion.restored === undefined) {
    problems.push(`${where}.restored が無い（復元していないなら null を入れる）`)
  } else if (exclusion.restored !== null) {
    if (typeof exclusion.restored !== 'object' || Array.isArray(exclusion.restored)) {
      problems.push(
        `${where}.restored が null でもオブジェクトでもない (実際=${actualType(exclusion.restored)})`,
      )
    } else {
      const restored = exclusion.restored as Record<string, unknown>
      if (typeof restored.reason !== 'string') {
        problems.push(`${where}.restored.reason が文字列でない (実際=${actualType(restored.reason)})`)
      }
      if (typeof restored.at !== 'string') {
        problems.push(`${where}.restored.at が文字列でない (実際=${actualType(restored.at)})`)
      }
    }
  }
  return problems
}

function attachmentProblems(value: unknown, index: number): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const attachment = value as Record<string, unknown>
  const where = `attachments[${index}]`
  const problems: string[] = []

  if (attachment.screenshot_attempts === undefined) {
    attachment.screenshot_attempts = []
  } else if (!Array.isArray(attachment.screenshot_attempts)) {
    problems.push(
      `${where}.screenshot_attempts が配列でない (実際=${actualType(attachment.screenshot_attempts)})`,
    )
  } else {
    attachment.screenshot_attempts.forEach((attempt: unknown, at: number) => {
      problems.push(...attemptProblems(attempt, `${where}.screenshot_attempts[${at}]`))
    })
  }

  if (attachment.screenshot_source === undefined) {
    attachment.screenshot_source = null
  } else if (
    attachment.screenshot_source !== null &&
    !SCREENSHOT_SOURCES.includes(attachment.screenshot_source as ScreenshotSource)
  ) {
    problems.push(
      `${where}.screenshot_source が ${SCREENSHOT_SOURCES.join(' / ')} のどれでもない ` +
        `(実際=${JSON.stringify(attachment.screenshot_source)})`,
    )
  }

  if (attachment.pdf_page === undefined) {
    attachment.pdf_page = null
  } else if (attachment.pdf_page !== null && typeof attachment.pdf_page !== 'number') {
    problems.push(`${where}.pdf_page が数値でも null でもない (実際=${actualType(attachment.pdf_page)})`)
  }
  return problems
}

function attemptProblems(value: unknown, where: string): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [`${where} がオブジェクトでない (実際=${actualType(value)})`]
  }
  const attempt = value as Record<string, unknown>
  const problems: string[] = []
  if (!SCREENSHOT_SOURCES.includes(attempt.source as ScreenshotSource)) {
    problems.push(
      `${where}.source が ${SCREENSHOT_SOURCES.join(' / ')} のどれでもない ` +
        `(実際=${JSON.stringify(attempt.source)})`,
    )
  }
  if (attempt.path !== null && typeof attempt.path !== 'string') {
    problems.push(`${where}.path が文字列でも null でもない (実際=${actualType(attempt.path)})`)
  }
  if (typeof attempt.highlighted !== 'boolean') {
    problems.push(`${where}.highlighted が真偽値でない (実際=${actualType(attempt.highlighted)})`)
  }
  if (attempt.note !== null && typeof attempt.note !== 'string') {
    problems.push(`${where}.note が文字列でも null でもない (実際=${actualType(attempt.note)})`)
  }
  if (typeof attempt.adopted !== 'boolean') {
    problems.push(`${where}.adopted が真偽値でない (実際=${actualType(attempt.adopted)})`)
  }
  return problems
}
