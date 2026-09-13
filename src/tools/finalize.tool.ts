import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { FactCheckError } from '../errors.js'
import { reportPaths } from '../report/write-report.js'
import { effectiveRecords } from '../session/ledger-effective.js'
import { loadSourceText, updateLedger } from '../session/ledger-store.js'
import { ledgerCoverage, summarizeLedger } from '../session/ledger-summary.js'
import type { Ledger } from '../session/ledger-types.js'
import { jsonResult, sessionIdInput } from './tool-context.js'
import { verdictBasisProblem } from './verdict-basis.js'

const DESCRIPTION = [
  'レポート (report.md / report.json / report.html) をセッションディレクトリに書き出す。',
  '網羅率が 100% 未満、または verdict 未設定の claim が 1 つでもあれば拒否し、何が足りないかを返す。',
  'revise_record で根拠を取り消した結果、判定を支える有効な証拠が無くなった claim があるときも拒否する',
  '（set_verdict と同じ規則で確かめる）。取り消した claim / non_claim は網羅率に数えない。',
  'レポートは台帳からツールが生成するので、AI の申告だけで「確認済み」と書かれることはない。',
  'ツールが確かめるのは引用の実在・網羅範囲・根拠の形であって、主張の真偽ではない。',
  'agent_captured の証拠には「ツールが直接取得していない証拠」という警告が付く。',
].join('\n')

export function registerFinalize(server: McpServer): void {
  server.registerTool(
    'finalize',
    {
      title: 'レポートを出力する（不足があれば拒否）',
      description: DESCRIPTION,
      inputSchema: { session_id: sessionIdInput },
    },
    async ({ session_id }) => {
      // 保管中のセッションでもレポートは出せる（台帳の内容は変えないため）。
      // updateLedger を通すのは、書き出した瞬間だけ「レポートは最新」に戻す印を
      // ロックの中で消すため（同時に走った別のツールの印を消さない）。
      // レポートを書き出すのは updateLedger の共有処理（台帳を保存した後）。ここでやると
      // 台帳の保存より先にレポートが書かれ、保存が失敗したときにレポートだけが
      // 「保存されていない台帳の内容」を最新として見せる。
      //
      // **「レポートは最新」の印もここでは消さない。** 消した台帳を先に保存すると、
      // 書き出しが失敗しても印だけが消えて get_status が「最新」に見える。
      // 印を消すのは共有処理が書き出しに成功したあと。ここでするのは検証と、
      // 3 形式を書き出す約束（reportSync='finalize'）を渡すことだけ。
      const summary = await updateLedger(
        session_id,
        async (ledger) => {
          assertFinalizable(ledger, await loadSourceText(ledger))
          return summarizeLedger(ledger)
        },
        'finalize',
      )
      return jsonResult({
        session_id,
        report: reportPaths(session_id),
        summary,
        reports_stale: false,
        warning:
          summary.evidence.by_provenance.agent_captured > 0
            ? `証拠 ${summary.evidence.by_provenance.agent_captured} 件はツールが直接取得したものではない（AI が提出した内容）。レポートにもその旨が明記されている。`
            : null,
      })
    },
  )
}

/**
 * 書き出してよいか。足りないものは全部集めてから 1 度に返す（1 つ直すたびに呼び直させない）。
 *
 * 数えるのは有効な記録だけ。取り消した claim に判定を要求すると、誤登録を消す唯一の方法が
 * 「間違いに判定を付けてレポートに載せる」ことになってしまう。
 */
function assertFinalizable(ledger: Ledger, sourceText: string): void {
  const coverage = ledgerCoverage(ledger)
  const liveClaims = effectiveRecords(ledger.exclusions, 'claim', ledger.claims)
  const pending = liveClaims.filter((c) => c.verdict === null)

  const problems: string[] = []
  if (coverage.covered !== coverage.total) {
    problems.push(
      `網羅率が ${(coverage.ratio * 100).toFixed(2)}% (${coverage.covered}/${coverage.total} 文字)。` +
        `未処理の範囲 ${coverage.gaps.length} 個: ` +
        coverage.gaps
          .map((gap) => `[${gap.start}, ${gap.end}) 「${sourceText.slice(gap.start, gap.end)}」`)
          .join(' / '),
    )
  }
  if (liveClaims.length === 0) {
    problems.push('claim が 1 件も登録されていない。元ネタに事実主張が本当に無いのかを確かめること。')
  }
  if (pending.length > 0) {
    problems.push(`verdict 未設定の claim が ${pending.length} 件: ${pending.map((c) => c.id).join(', ')}`)
  }
  // 根拠を取り消したあとの判定を、そのままレポートへ載せない。付けたときと同じ規則で確かめる。
  for (const claim of liveClaims) {
    if (claim.verdict === null) continue
    const problem = verdictBasisProblem(ledger, claim.id, claim.verdict.value)
    if (problem !== null) problems.push(`${claim.id} の判定を支える根拠が無くなっている。${problem}`)
  }
  if (problems.length === 0) return
  throw new FactCheckError(
    [
      'finalize は通せない。足りないものは以下のとおり:',
      ...problems.map((p) => `  - ${p}`),
      '',
      'register_claim / mark_non_claim で範囲を埋め、attach_evidence と set_verdict で',
      '判定と根拠を揃えてから呼び直すこと。誤登録は revise_record で取り消せる。',
    ].join('\n'),
  )
}
