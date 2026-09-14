import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { EXPORT_FORMATS, exportReport } from '../report/export-report.js'
import { jsonResult, sessionIdInput } from './tool-context.js'

const DESCRIPTION = [
  'レポートを 1 ファイルで持ち出せる形（html / pdf）にして、指定した絶対パスへ書き出す。',
  '画像は中身ごと埋め込むので、そのファイル 1 つを別の場所へ置いても同じに読める',
  '（finalize が書く report.html は画像を相対パスで参照するので、セッションディレクトリごと渡す必要がある）。',
  'pdf は html と同じ内容を印刷レイアウトにしたもの。ヘッドレスブラウザ (Chromium) が要る。',
  'finalize を通していない台帳でも書き出せるが、その内容には「暫定表示」の断りが焼き込まれ、応答にも警告が付く。',
  '台帳は変えない（読み取りだけ）。出力先に既にファイルがあれば overwrite=true が無い限り拒否する。',
].join('\n')

export function registerExportReport(server: McpServer): void {
  server.registerTool(
    'export_report',
    {
      title: 'レポートを HTML / PDF のファイルとして書き出す',
      description: DESCRIPTION,
      inputSchema: {
        session_id: sessionIdInput,
        format: z.enum(EXPORT_FORMATS).describe('html=単体で開けるビューア / pdf=印刷レイアウト'),
        output_path: z
          .string()
          .min(1)
          .describe(
            '書き出す先の絶対パス。拡張子は format に合わせる（.html / .htm / .pdf）。親ディレクトリは無ければ作る',
          ),
        overwrite: z.boolean().optional().describe('既にあるファイルを置き換えてよいなら true（既定 false）'),
      },
    },
    async ({ session_id, format, output_path, overwrite }) => {
      const exported = await exportReport({
        sessionId: session_id,
        format,
        outputPath: output_path,
        overwrite: overwrite ?? false,
      })
      return jsonResult({
        ...exported,
        warning:
          exported.reports_stale_since === null
            ? null
            : `この内容は finalize の検証を通していない暫定のもの（台帳が変わった時刻: ${exported.reports_stale_since}）。` +
              'ファイルにもその断りが入っている。正式なレポートにするなら finalize を通してから書き出し直すこと。',
      })
    },
  )
}
