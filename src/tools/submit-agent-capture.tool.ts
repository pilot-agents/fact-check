import { copyFile, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { FactCheckError } from '../errors.js'
import { sha256 } from '../evidence/fetch-source.js'
import { collapseWhitespace } from '../evidence/html-to-text.js'
import { findQuote } from '../quote-matching/find-quote.js'
import { EVIDENCE_DIR, nextId, sessionDir, updateLedger, writeSessionFile } from '../session/ledger-store.js'
import type { Evidence, TermCheck } from '../session/ledger-types.js'
import {
  discoveredViaInput,
  discoveryNoteInput,
  jsonResult,
  sessionIdInput,
  textWindow,
} from './tool-context.js'

const DESCRIPTION = [
  'fetch_evidence がどうしても取得できなかった URL について、あなた自身のブラウザ操作ツールで取得した',
  'ページ本文テキストとスクリーンショットを、証拠として登録する逃げ道。',
  '本文は text にそのまま渡すか、長い場合はローカルのテキストファイルに保存して text_path で渡す',
  '（どちらか一方だけ。両方指定・両方未指定は拒否する）。',
  'この経路で登録した証拠は provenance=agent_captured として記録され、レポートには「ツールが直接',
  '取得していない証拠」という警告が必ず付く。取得できる URL でこの経路を使ってはいけない。',
  'expected_terms に「そのページで確かめたい語」を並べると、引用照合と同じ規則で実在を照合し、',
  '見つからなかった語を警告として応答と台帳に残す（本文の抽出に失敗した内容を出したことに気づける）。',
  '警告が出ても登録はできる。未指定なら「未検査」と記録される（本文は書き換えない）。',
  '次に呼ぶもの: 返ってきた evidence_id を attach_evidence に渡すこと（引用文の実在照合は同じように行われる）。',
].join('\n')

export function registerSubmitAgentCapture(server: McpServer): void {
  server.registerTool(
    'submit_agent_capture',
    {
      title: 'AI が自分で取得した内容を証拠として提出する',
      description: DESCRIPTION,
      inputSchema: {
        session_id: sessionIdInput,
        url: z.url().describe('あなたが実際に開いた URL'),
        text: z
          .string()
          .min(1)
          .optional()
          .describe('そのページの本文テキスト（あなたのツールで抽出したもの）。text_path と排他'),
        text_path: z
          .string()
          .min(1)
          .optional()
          .describe('本文テキストを保存したローカルファイルのパス（utf-8）。text と排他'),
        discovered_via: discoveredViaInput,
        discovery_note: discoveryNoteInput,
        screenshot_path: z
          .string()
          .optional()
          .describe('あなたが保存したスクリーンショットのローカルパス。セッションディレクトリに複製される'),
        expected_terms: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            'そのページに在るはずの語（見出し・数値・固有名など）。提出した本文に実在するかを照合し、' +
              '見つからない語は警告として残す。未指定なら「未検査」と記録される',
          ),
        note: z.string().min(1).describe('どのツールでどう取得したか、fetch_evidence がなぜ使えなかったか'),
      },
    },
    async ({
      session_id,
      url,
      text,
      text_path,
      discovered_via,
      discovery_note,
      screenshot_path,
      expected_terms,
      note,
    }) => {
      const submitted = await loadSubmittedText(text, text_path, url)
      const normalized = collapseWhitespace(submitted.text)
      if (normalized.length === 0) {
        throw new FactCheckError(`提出された本文テキストが空だった (url=${url}, 入力=${submitted.from})`)
      }
      const termCheck = checkExpectedTerms(normalized, expected_terms)
      const record = await updateLedger(session_id, async (ledger) => {
        const evidenceId = nextId('evidence', ledger.evidence)
        const textPath = await writeSessionFile(
          session_id,
          path.posix.join(EVIDENCE_DIR, `${evidenceId}.txt`),
          normalized,
        )
        const screenshotPath =
          screenshot_path === undefined ? null : await copyScreenshot(session_id, evidenceId, screenshot_path)

        const created: Evidence = {
          id: evidenceId,
          source: { type: 'url', url },
          provenance: 'agent_captured',
          discovered_via,
          discovery_note: discovery_note ?? null,
          fetched_at: new Date().toISOString(),
          text_sha256: sha256(normalized),
          text_length: normalized.length,
          text_path: textPath,
          html_path: null,
          screenshot_path: screenshotPath,
          pdf: null,
          attempts: [
            {
              stage: 'browser',
              ok: true,
              detail: `AI のブラウザ操作ツールによる取得を提出 (url=${url}, 本文の渡し方=${submitted.from}): ${note}`,
              at: new Date().toISOString(),
            },
          ],
          note,
          term_check: termCheck,
        }
        ledger.evidence.push(created)
        return created
      })
      return jsonResult({
        evidence_id: record.id,
        provenance: record.provenance,
        discovered_via: record.discovered_via,
        discovery_note: record.discovery_note,
        warning:
          'この証拠はツールが直接取得していない。取得元の実在も内容の同一性もツールでは検証されていない旨がレポートに明記される。',
        expected_terms: termCheckResult(termCheck),
        text_sha256: record.text_sha256,
        saved: { text_path: record.text_path, screenshot_path: record.screenshot_path },
        ...textWindow(
          normalized,
          0,
          'この証拠のテキストはセッションディレクトリの text_path に保存されている',
        ),
        next_step: 'この evidence_id と、上の本文に実在する引用文を attach_evidence に渡すこと。',
      })
    },
  )
}

/**
 * 申告された語が提出本文に実在するかを、引用照合と同じ規則で見る。
 *
 * 意味は判定しない（CSS の密度のような未検証の目安で拒否すると、体裁の崩れた本物まで締め出す）。
 * 判定するのは「申告した語が在るか」だけで、結果は拒否ではなく警告として残す。
 * 未申告は空の結果ではなく null で残す — 「検査していない」と「検査して問題なし」は別の事実。
 */
function checkExpectedTerms(text: string, terms: readonly string[] | undefined): TermCheck | null {
  if (terms === undefined) return null
  return {
    terms: [...terms],
    missing: terms.filter((term) => !findQuote(text, term).found),
    declared_by: 'agent',
  }
}

/** 応答に載せる照合結果。未検査であることを空欄で済ませず言葉にする。 */
function termCheckResult(check: TermCheck | null): Record<string, unknown> {
  if (check === null) {
    return {
      checked: false,
      note: 'expected_terms が未指定のため、提出本文が目的のページの内容かどうかは検査していない。',
    }
  }
  if (check.missing.length === 0) {
    return { checked: true, terms: check.terms, missing: [], note: null }
  }
  return {
    checked: true,
    terms: check.terms,
    missing: check.missing,
    note:
      `申告した ${check.terms.length} 語のうち ${check.missing.length} 語が提出本文に見つからなかった: ` +
      `${check.missing.map((term) => `「${term}」`).join(' / ')}。` +
      '本文の抽出に失敗している（CSS や別ページを拾った）可能性がある。登録はしたが、' +
      '引用を添付する前に本文を読み直すこと。この警告は台帳とレポートに残る。',
  }
}

/**
 * 本文を text か text_path のどちらか一方から読む。
 * どちらでもよいことにすると「両方渡したが片方しか使われていない」ことに気づけないので、排他にする。
 */
async function loadSubmittedText(
  text: string | undefined,
  textPath: string | undefined,
  url: string,
): Promise<{ text: string; from: string }> {
  if (text !== undefined && textPath !== undefined) {
    throw new FactCheckError(
      `text と text_path は同時に指定できない (url=${url})。本文の渡し方はどちらか一方にすること。`,
    )
  }
  if (text !== undefined) return { text, from: 'text' }
  if (textPath === undefined) {
    throw new FactCheckError(
      `本文テキストが無い (url=${url})。text にそのまま渡すか、text_path にローカルファイルのパスを渡すこと。`,
    )
  }
  const absolute = path.resolve(textPath)
  try {
    return { text: await readFile(absolute, 'utf8'), from: `text_path=${absolute}` }
  } catch (cause) {
    throw FactCheckError.fromCause(`text_path のファイルを読めない (path=${absolute})`, cause)
  }
}

async function copyScreenshot(sessionId: string, evidenceId: string, sourcePath: string): Promise<string> {
  const absolute = path.resolve(sourcePath)
  try {
    const info = await stat(absolute)
    if (!info.isFile()) throw new FactCheckError(`スクリーンショットがファイルではない (path=${absolute})`)
  } catch (cause) {
    if (cause instanceof FactCheckError) throw cause
    throw FactCheckError.fromCause(`スクリーンショットを読めない (path=${absolute})`, cause)
  }
  const relative = path.posix.join(EVIDENCE_DIR, `${evidenceId}${path.extname(absolute) || '.png'}`)
  try {
    await copyFile(absolute, path.join(sessionDir(sessionId), relative))
  } catch (cause) {
    throw FactCheckError.fromCause(`スクリーンショットを複製できない (from=${absolute})`, cause)
  }
  return relative
}
