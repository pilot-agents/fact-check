import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { FactCheckError } from '../errors.js'
import { writeReport } from '../report/write-report.js'
import { loadLedger, loadSourceText } from '../session/ledger-store.js'
import { ledgerCoverage } from '../session/ledger-summary.js'
import { jsonResult, sessionIdInput } from './tool-context.js'

const DESCRIPTION = [
  'レポート (report.md / report.json / report.html) をセッションディレクトリに書き出す。',
  '網羅率が 100% 未満、または verdict 未設定の claim が 1 つでもあれば拒否し、何が足りないかを返す。',
  'レポートは台帳からツールが生成するので、AI の申告だけで「確認済み」と書かれることはない。',
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
      const ledger = await loadLedger(session_id)
      const sourceText = await loadSourceText(ledger)
      const coverage = ledgerCoverage(ledger)
      const pending = ledger.claims.filter((c) => c.verdict === null)

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
      if (ledger.claims.length === 0) {
        problems.push('claim が 1 件も登録されていない。元ネタに事実主張が本当に無いのかを確かめること。')
      }
      if (pending.length > 0) {
        problems.push(
          `verdict 未設定の claim が ${pending.length} 件: ${pending.map((c) => c.id).join(', ')}`,
        )
      }
      if (problems.length > 0) {
        throw new FactCheckError(
          [
            'finalize は通せない。足りないものは以下のとおり:',
            ...problems.map((p) => `  - ${p}`),
            '',
            'register_claim / mark_non_claim で範囲を埋め、set_verdict で判定を付けてから呼び直すこと。',
          ].join('\n'),
        )
      }

      const { paths, summary } = await writeReport(ledger, sourceText)
      return jsonResult({
        session_id,
        report: paths,
        summary,
        warning:
          summary.evidence.by_provenance.agent_captured > 0
            ? `証拠 ${summary.evidence.by_provenance.agent_captured} 件はツールが直接取得したものではない（AI が提出した内容）。レポートにもその旨が明記されている。`
            : null,
      })
    },
  )
}
