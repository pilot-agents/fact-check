import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { fetchEvidence, sha256 } from '../evidence/fetch-source.js'
import {
  EVIDENCE_DIR,
  nextId,
  readSessionFile,
  updateLedger,
  writeSessionFile,
} from '../session/ledger-store.js'
import type { DiscoveredVia, Evidence, SourceRef } from '../session/ledger-types.js'
import {
  discoveredViaInput,
  discoveryNoteInput,
  jsonResult,
  sessionIdInput,
  textLimitInput,
  textWindow,
} from './tool-context.js'

const DESCRIPTION = [
  '証拠をツール自身が取りに行き、スナップショット（本文テキスト・HTML / PDF・スクショ）をセッション',
  'ディレクトリに保存する。URL は HTTP 取得 → 失敗したらヘッドレスブラウザ、の順で試し、どの段階で',
  '何が起きたかを attempts に全部残す。',
  'PDF（content-type が application/pdf、または中身が PDF）はページ境界を保ったまま本文を抽出し、',
  '元の PDF も保存する。attach_evidence では引用箇所のページ番号が記録され、そのページを描画した',
  'スクリーンショットが残る。',
  '取得に失敗した場合は「確認できなかった」で済ませず、あなた自身のブラウザ操作ツール（ブラウザ拡張・',
  'ブラウザ操作 MCP など）を積極的に使ってその URL を開き、ページ本文テキストとスクリーンショットを',
  '取得して submit_agent_capture ツールに提出すること。',
  '同じ session で同じ取得元を再指定した場合は取り直さず、保存済みのスナップショットを返す。',
  '長い本文は先頭だけ返し、text_length と next_offset を添える（text_offset で続き、text_limit で長さを変えられる）。',
  '次に呼ぶもの: 返ってきた evidence_id と、本文に実在する引用文を attach_evidence に渡すこと。',
].join('\n')

export function registerFetchEvidence(server: McpServer): void {
  server.registerTool(
    'fetch_evidence',
    {
      title: '証拠を取得してスナップショットを保存する',
      description: DESCRIPTION,
      inputSchema: {
        session_id: sessionIdInput,
        source: z
          .discriminatedUnion('type', [
            z.object({ type: z.literal('url'), url: z.url().describe('証拠ページ／PDF の URL') }),
            z.object({
              type: z.literal('file'),
              path: z.string().min(1).describe('証拠ファイルのローカルパス (.txt / .md / .html / .pdf)'),
            }),
          ])
          .describe('証拠の取得元'),
        discovered_via: discoveredViaInput,
        discovery_note: discoveryNoteInput,
        text_offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('抽出本文の何文字目から返すか。長い本文の続きを読むときに指定する'),
        text_limit: textLimitInput,
      },
    },
    async ({ session_id, source, discovered_via, discovery_note, text_offset, text_limit }) => {
      const outcome = await updateLedger(session_id, async (ledger) => {
        const existing = ledger.evidence.find((e) => sameSource(e.source, source))
        if (existing !== undefined) {
          const text = await readSessionFile(session_id, existing.text_path)
          return { record: existing, text, reused: true }
        }

        const evidenceId = nextId('evidence', ledger.evidence)
        const fetched = await fetchEvidence({ sessionId: session_id, evidenceId, source })
        const textPath = await writeSessionFile(
          session_id,
          path.posix.join(EVIDENCE_DIR, `${evidenceId}.txt`),
          fetched.text,
        )
        const record: Evidence = {
          id: evidenceId,
          source,
          provenance: fetched.provenance,
          discovered_via,
          discovery_note: discovery_note ?? null,
          fetched_at: new Date().toISOString(),
          text_sha256: sha256(fetched.text),
          text_length: fetched.text.length,
          text_path: textPath,
          html_path: fetched.htmlPath,
          screenshot_path: fetched.screenshotPath,
          pdf:
            fetched.pdfPath === null || fetched.pdfPages === null
              ? null
              : {
                  path: fetched.pdfPath,
                  pages: fetched.pdfPages.map((page) => ({
                    page: page.page,
                    start: page.start,
                    end: page.end,
                  })),
                },
          attempts: fetched.attempts,
          note: null,
        }
        ledger.evidence.push(record)
        return { record, text: fetched.text, reused: false }
      })
      return jsonResult(
        describeEvidence(outcome.record, outcome.text, text_offset ?? 0, outcome.reused, text_limit),
      )
    },
  )
}

function sameSource(a: SourceRef, b: SourceRef): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'url' && b.type === 'url') return a.url === b.url
  if (a.type === 'file' && b.type === 'file') return path.resolve(a.path) === path.resolve(b.path)
  return false
}

function describeEvidence(
  evidence: Evidence,
  text: string,
  offset: number,
  reused: boolean,
  limit: number | undefined,
) {
  return {
    evidence_id: evidence.id,
    provenance: evidence.provenance,
    discovered_via: evidence.discovered_via satisfies DiscoveredVia,
    discovery_note: evidence.discovery_note,
    reused_existing_snapshot: reused,
    reused_note: reused
      ? '同じ取得元が登録済みだったので取り直していない。discovered_via も最初に登録したときの値のまま。'
      : null,
    text_sha256: evidence.text_sha256,
    saved: {
      text_path: evidence.text_path,
      html_path: evidence.html_path,
      pdf_path: evidence.pdf?.path ?? null,
      screenshot_path: evidence.screenshot_path,
    },
    pdf_pages: evidence.pdf === null ? null : evidence.pdf.pages.length,
    attempts: evidence.attempts,
    ...textWindow(
      text,
      offset,
      '同じ source と text_offset=<次の位置> を指定して fetch_evidence を呼ぶこと',
      limit,
    ),
    next_step:
      '本文に実在する箇所をそのまま引用文としてコピーし、attach_evidence に渡すこと。引用文は正規化した上で完全部分一致が取れなければ拒否される。',
  }
}
