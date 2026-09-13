import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { FactCheckError } from '../errors.js'
import { activeExclusion, isSessionArchived } from '../session/ledger-effective.js'
import { fileExists, nextId, sessionDir, updateLedger } from '../session/ledger-store.js'
import { summarizeLedger } from '../session/ledger-summary.js'
import type { Exclusion, ExclusionTargetType, Ledger } from '../session/ledger-types.js'
import { jsonResult, sessionIdInput } from './tool-context.js'
import { verdictBasisProblem } from './verdict-basis.js'

/**
 * 誤登録の取り消しと、その取り消しの復元。
 *
 * **何も消さない。** 元の claim / non_claim / evidence / attachment のレコードも、取得した
 * 本文・HTML・PDF・画像も、そのまま残る。取り消しは exclusions への追記だけで表し、
 * 「今どれが有効か」は毎回そこから導く（ledger-effective.ts）。
 *
 * なぜ物理削除を作らないか: 証拠の取得は「その時点で確かにこれを見た」という記録で、
 * 紐づけを誤ったことと、取得した事実が偽になることは別。消せる口があると、
 * 都合の悪い記録を消してからレポートを出すことが技術的に可能になる。
 *
 * なぜ 1 つのツールに exclude と restore を入れるか: 対象の種類も検証も応答もまったく同じで、
 * 違うのは追記するか restored を埋めるかだけ。2 つに割ると、対象の解決と整合の確認を
 * 2 箇所に書くことになる。
 */

const TARGET_TYPES = ['claim', 'non_claim', 'evidence', 'attachment', 'session'] as const

const DESCRIPTION = [
  '誤って登録した記録を取り消す（論理的な無効化）。取り消したものは復元もできる。',
  '対象: claim / non_claim / evidence / attachment / session（session はセッション丸ごとの保管）。',
  '',
  '取り消しても元のレコードと取得済みのファイル（本文・HTML・PDF・画像）は 1 つも消えない。',
  '理由・時刻・対象 id が履歴に残り、レポートの「取り消し履歴」の節に全部出る。',
  '',
  '取り消したものは、その時点から:',
  '  - claim / non_claim: 網羅率の根拠にならない（その範囲は未処理に戻る）',
  '  - evidence / attachment: 判定の根拠にならない。親の claim か evidence を取り消すと、',
  '    ぶら下がる attachment も自動的に根拠でなくなる（attachment 側の記録は変えない）',
  '  - session: それ以上の裏取りを受け付けない。読み返しと report:rebuild はできる',
  '',
  '復元は、その取り消し 1 件だけを取り消す。親を復元しても、個別に取り消した子は取り消されたまま。',
  '根拠が無くなった判定は finalize が拒否するので、set_verdict で付け直すこと。',
  '次に呼ぶもの: get_status で残りを確認し、finalize でレポートを作り直すこと。',
].join('\n')

export function registerReviseRecord(server: McpServer): void {
  server.registerTool(
    'revise_record',
    {
      title: '誤登録を取り消す / 取り消しを戻す',
      description: DESCRIPTION,
      inputSchema: {
        session_id: sessionIdInput,
        action: z
          .enum(['exclude', 'restore'])
          .describe('exclude=取り消す / restore=取り消しを戻す。どちらも履歴に残る'),
        target_type: z.enum(TARGET_TYPES).describe('取り消す記録の種類。session はセッション丸ごとの保管'),
        target_id: z
          .string()
          .min(1)
          .describe(
            '対象の id（claim_1 / non_claim_2 / evidence_3 / attachment_4）。session なら session_id',
          ),
        reason: z
          .string()
          .min(1)
          .describe('なぜ取り消すのか / なぜ戻すのか。レポートにそのまま載るので、後から読んで分かる言葉で'),
      },
    },
    async ({ session_id, action, target_type, target_id, reason }) => {
      const outcome = await updateLedger(session_id, async (ledger) => {
        const resolvedId = resolveTargetId(ledger, target_type, target_id)
        assertAllowedWhileArchived(ledger, action, target_type)
        assertTargetExists(ledger, target_type, resolvedId)
        const record =
          action === 'exclude'
            ? exclude(ledger, target_type, resolvedId, reason)
            : restore(ledger, target_type, resolvedId, reason)
        return {
          record,
          summary: summarizeLedger(ledger),
          brokenVerdicts: brokenVerdicts(ledger),
          rewritten: await existingReports(ledger),
        }
      })
      return jsonResult({
        session_id,
        exclusion: outcome.record,
        summary: outcome.summary,
        verdicts_without_basis: outcome.brokenVerdicts,
        reports_rewritten: outcome.rewritten,
        reports_stale: true,
        next_step: nextStep(outcome.brokenVerdicts),
      })
    },
  )
}

function nextStep(broken: readonly { claim_id: string }[]): string {
  const rebuild =
    '書き出し済みのレポートは台帳より古い。finalize を呼び直して作り直すこと（呼ぶまで最新ではない）。'
  if (broken.length === 0) return `get_status で残りを確認すること。${rebuild}`
  return (
    `根拠が無くなった判定が ${broken.length} 件ある: ${broken.map((b) => b.claim_id).join(', ')}。` +
    `set_verdict で付け直すか、根拠を付け直すこと。finalize はそれまで拒否する。${rebuild}`
  )
}

/**
 * 保管中のセッションで許すのは「保管そのものを解除する」ことだけ。
 *
 * 他のツールは `assertSessionOpen` で一律に止まるが、このツールだけは保管を解除する口を
 * 兼ねているので同じ関門を通せない。通せないからといって素通しにすると、
 * 「保管中は台帳を変える操作を全部拒否する」という契約が、このツールにだけ効かなくなる。
 */
function assertAllowedWhileArchived(
  ledger: Ledger,
  action: 'exclude' | 'restore',
  targetType: ExclusionTargetType,
): void {
  if (!isSessionArchived(ledger)) return
  if (action === 'restore' && targetType === 'session') return
  const archived = activeExclusion(ledger.exclusions, 'session', ledger.session_id)
  throw new FactCheckError(
    `このセッションは保管されている (session_id=${ledger.session_id}` +
      (archived === null ? '' : `, ${archived.excluded_at}, 理由=「${archived.reason}」`) +
      `)。保管中にできるのは保管の解除だけで、` +
      `${targetType} の ${action} は受け付けない。` +
      `先に action=restore / target_type=session / target_id=${ledger.session_id} で解除すること。`,
  )
}

/** session だけは id を省略できるようにしない代わりに、session_id そのものを受け付ける。 */
function resolveTargetId(ledger: Ledger, targetType: ExclusionTargetType, targetId: string): string {
  if (targetType !== 'session') return targetId
  if (targetId === ledger.session_id) return targetId
  throw new FactCheckError(
    `target_type=session の target_id はこのセッションの session_id でなければならない ` +
      `(渡された値=${targetId}, このセッション=${ledger.session_id})`,
  )
}

function assertTargetExists(ledger: Ledger, targetType: ExclusionTargetType, targetId: string): void {
  if (targetType === 'session') return
  const pool: Record<Exclude<ExclusionTargetType, 'session'>, readonly { id: string }[]> = {
    claim: ledger.claims,
    non_claim: ledger.non_claims,
    evidence: ledger.evidence,
    attachment: ledger.attachments,
  }
  const records = pool[targetType]
  if (records.some((record) => record.id === targetId)) return
  throw new FactCheckError(
    `${targetType} に ${targetId} という id は無い ` +
      `(登録済み=[${records.map((record) => record.id).join(', ')}])`,
  )
}

function exclude(
  ledger: Ledger,
  targetType: ExclusionTargetType,
  targetId: string,
  reason: string,
): Exclusion {
  const existing = activeExclusion(ledger.exclusions, targetType, targetId)
  if (existing !== null) {
    throw new FactCheckError(
      `${targetType}=${targetId} はすでに取り消されている ` +
        `(${existing.id}, ${existing.excluded_at}, 理由=「${existing.reason}」)。` +
        '同じものを二重に取り消しても意味が変わらないので、何もしていない。' +
        '理由を書き直したいなら、いったん action=restore で戻してから取り消すこと。',
    )
  }
  const record: Exclusion = {
    id: nextId('exclusion', ledger.exclusions),
    target_type: targetType,
    target_id: targetId,
    reason,
    excluded_at: new Date().toISOString(),
    restored: null,
  }
  ledger.exclusions.push(record)
  return record
}

/**
 * 取り消しを戻す。**戻すのはその 1 件だけ。**
 *
 * claim を戻しても、その claim にぶら下がる添付のうち個別に取り消したものは取り消されたまま
 * （それらは自分の exclusion レコードを持っており、この復元はそれに触れない）。
 * 親の取り消しだけで無効になっていた添付は、親が戻った時点で自動的に有効へ戻る
 * （有効性を導出しているので、戻す処理を書く必要がない）。
 */
function restore(
  ledger: Ledger,
  targetType: ExclusionTargetType,
  targetId: string,
  reason: string,
): Exclusion {
  const existing = activeExclusion(ledger.exclusions, targetType, targetId)
  if (existing === null) {
    const past = ledger.exclusions.filter((e) => e.target_type === targetType && e.target_id === targetId)
    throw new FactCheckError(
      `${targetType}=${targetId} は今は取り消されていないので、戻すものが無い` +
        (past.length === 0
          ? '（この対象は一度も取り消されていない）。'
          : `（過去に ${past.length} 件の取り消しがあるが、すべて復元済み: ` +
            `${past.map((e) => `${e.id} は ${e.restored?.at} に復元`).join(' / ')}）。`),
    )
  }
  existing.restored = { reason, at: new Date().toISOString() }
  return existing
}

/**
 * 根拠が無くなった判定。取り消しの直後にここで一覧にして返す。
 *
 * 判定の検証は set_verdict と同じ関数を通す（verdict-basis.ts）。別々に書くと、
 * 付けたときの規則と、後から確かめる規則が静かにずれる。
 */
function brokenVerdicts(ledger: Ledger): Array<{ claim_id: string; problem: string }> {
  const broken: Array<{ claim_id: string; problem: string }> = []
  for (const claim of ledger.claims) {
    if (claim.verdict === null) continue
    if (activeExclusion(ledger.exclusions, 'claim', claim.id) !== null) continue
    const problem = verdictBasisProblem(ledger, claim.id, claim.verdict.value)
    if (problem !== null) broken.push({ claim_id: claim.id, problem })
  }
  return broken
}

/**
 * この時点で書き出し済みのレポートの一覧。**作り直しはここではしない。**
 *
 * 作り直すのは台帳を保存したあと（`updateLedger` の共有処理）。ここで作り直すと、
 * 台帳の保存より先にレポートが書かれ、保存が失敗したときにレポートだけが
 * 「保存されていない台帳の内容」を最新として見せることになる。
 * ここで数えるのは、応答に「どれが作り直されるか」を書くためだけ。
 */
async function existingReports(ledger: Ledger): Promise<string[]> {
  const directory = sessionDir(ledger.session_id)
  const existing: string[] = []
  for (const name of ['report.md', 'report.json', 'report.html']) {
    if (await fileExists(path.join(directory, name))) existing.push(name)
  }
  return existing
}
