import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAttachEvidence } from './attach-evidence.tool.js'
import { registerExportReport } from './export-report.tool.js'
import { registerFetchEvidence } from './fetch-evidence.tool.js'
import { registerFinalize } from './finalize.tool.js'
import { registerGetStatus } from './get-status.tool.js'
import { registerMarkNonClaim } from './mark-non-claim.tool.js'
import { registerReadSourceSegments } from './read-source-segments.tool.js'
import { registerRegisterClaim } from './register-claim.tool.js'
import { registerRegisterSegments } from './register-segments.tool.js'
import { registerReviseRecord } from './revise-record.tool.js'
import { registerSetVerdict } from './set-verdict.tool.js'
import { registerStartSession } from './start-session.tool.js'
import { registerSubmitAgentCapture } from './submit-agent-capture.tool.js'

/** tools/ のエントリ。ここに並んだ 13 個がこのサーバーの全機能。 */
export function registerTools(server: McpServer): void {
  registerStartSession(server)
  registerReadSourceSegments(server)
  registerRegisterClaim(server)
  registerMarkNonClaim(server)
  registerRegisterSegments(server)
  registerFetchEvidence(server)
  registerSubmitAgentCapture(server)
  registerAttachEvidence(server)
  registerSetVerdict(server)
  registerReviseRecord(server)
  registerGetStatus(server)
  registerFinalize(server)
  registerExportReport(server)
}
