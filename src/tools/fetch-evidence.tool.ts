import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { fetchEvidence, sha256 } from '../evidence/fetch-source.js'
import { findQuoteAll } from '../quote-matching/find-quote.js'
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
  effectiveTextLimit,
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
  'find に語を渡すと、その語が本文のどこに在るかを引用照合と同じ規則で探し、**一致箇所の周辺**を返す',
  '（数万文字のページを先頭から読み進めずに済む）。一致が何件あるかと、次の一致の位置も返す。',
  '窓は必ず一致の先頭を含み、一致が text_limit 以下なら一致全体が入る（text_limit を小さくしても',
  '一致が窓の外に出ることはない）。一致が text_limit より長いときは先頭だけを返す。その続きは',
  '**find を外して** text_offset で読むこと（find を付けたままだと次の一致へ飛ぶ）。',
  '見つからなかったときは黙って先頭を返さず、見つからなかったと明記する。全文の保存は今までどおり。',
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
        find: z
          .string()
          .min(1)
          .optional()
          .describe(
            '本文から探したい語。見つかればその周辺を返す（text_offset を渡すとその位置以降を探す）。' +
              '同じ語が複数あるときは件数と次の位置も返る',
          ),
      },
    },
    async ({ session_id, source, discovered_via, discovery_note, text_offset, text_limit, find }) => {
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
          // ツールが直接取った証拠は取得経路そのものが検証になっているので語の申告は取らない。
          term_check: null,
        }
        ledger.evidence.push(record)
        return { record, text: fetched.text, reused: false }
      })
      return jsonResult(
        describeEvidence(outcome.record, outcome.text, outcome.reused, {
          offset: text_offset ?? 0,
          limit: text_limit,
          find,
        }),
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

/**
 * 検索語の結果。
 *
 * 見つからなかったときに黙って先頭を返すと、呼ぶ側は「探した範囲にその語は無い」と
 * 「探していない」を区別できない。何件見つかったか・どこを返したか・次はどこかを必ず書く。
 */
function describeFind(text: string, term: string, searchFrom: number, limit: number) {
  const all = findQuoteAll(text, term)
  const hit = all.find((range) => range.start >= searchFrom) ?? null
  if (hit === null) {
    return {
      result: {
        term,
        found: false,
        occurrences: all.length,
        match: null,
        next_occurrence_offset: null,
        note:
          all.length === 0
            ? `「${term}」は本文に 1 件も無い（照合は空白を畳み NFKC 正規化した上での完全部分一致）。別の語で探すか、text_offset で読み進めること。下の text は検索結果ではなく text_offset からの窓。`
            : `「${term}」は本文に ${all.length} 件あるが、text_offset=${searchFrom} 以降には無い。text_offset を 0 に戻して探し直すこと。下の text は検索結果ではなく text_offset からの窓。`,
      },
      windowStart: null,
    }
  }
  const next = all.find((range) => range.start > hit.start) ?? null
  // 一致の原文での長さ。正規化（NFKC・空白の畳み込み）を挟むので、検索語の文字数とは一致しない
  // （全角で書いた語が半角の本文に当たる、本文側に余分な空白がある）。窓の計算には原文の長さを使う。
  const matched = hit.end - hit.start
  const margin = matched >= limit ? 0 : Math.min(FIND_WINDOW_MARGIN, limit - matched)
  // 本文の先頭近くで一致すると負になるが、0 への丸めは textWindow が持っている。
  // ここで重ねて丸めると同じ規則が 2 箇所になり、片方だけ直したときに食い違う。
  const windowStart = hit.start - margin
  return {
    result: {
      term,
      found: true,
      occurrences: all.length,
      match: { start: hit.start, end: hit.end },
      next_occurrence_offset: next === null ? null : next.start,
      note:
        `「${term}」は本文に ${all.length} 件あり、[${hit.start}, ${hit.end}) の周辺を返した。` +
        (matched > limit
          ? `一致は原文で ${matched} 文字あり、1 回に返せる ${limit} 文字を超えるので**先頭だけ**を返した。` +
            // 同じ find を付けたまま呼ぶと「その位置以降の最初の一致」＝次の一致へ飛んでしまい、
            // この一致の続きが読めない。続きを読むときは find を外す。
            `続きは find を付けずに text_offset=${hit.start + limit} を指定して読むこと` +
            '（同じ find を付けたままだと次の一致へ飛ぶ）。'
          : '') +
        (next === null
          ? 'これが最後の一致。'
          : `次の一致は ${next.start} 文字目。同じ find と text_offset=${next.start} でもう一度呼ぶと次の箇所を読める。`),
    },
    windowStart,
  }
}

/**
 * 一致箇所の手前に付ける文脈の文字数の**上限**。一致が窓の先頭に貼り付くと前後関係が読めない。
 *
 * 実際の余白は `min(この値, 1 回に返せる文字数 - 一致の長さ)`。固定値にすると `text_limit` を
 * 小さくしたときに一致そのものが窓の外へ出る（余白だけを返して「探した」と言うことになる）。
 * 一致が予算より長いときは余白 0 で一致の先頭から返し、一部しか見えていないことを note に書く。
 */
const FIND_WINDOW_MARGIN = 200

function describeEvidence(
  evidence: Evidence,
  text: string,
  reused: boolean,
  read: { offset: number; limit: number | undefined; find: string | undefined },
) {
  // 窓の位置は「1 回に返せる文字数」に依存するので、textWindow が使うのと同じ実効値で決める。
  const limit = effectiveTextLimit(read.limit)
  const found = read.find === undefined ? null : describeFind(text, read.find, read.offset, limit)
  const offset = found?.windowStart ?? read.offset
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
    find: found?.result ?? null,
    ...textWindow(
      text,
      offset,
      '同じ source と text_offset=<次の位置> を指定して fetch_evidence を呼ぶこと',
      read.limit,
    ),
    next_step:
      '本文に実在する箇所をそのまま引用文としてコピーし、attach_evidence に渡すこと。引用文は正規化した上で完全部分一致が取れなければ拒否される。',
  }
}
