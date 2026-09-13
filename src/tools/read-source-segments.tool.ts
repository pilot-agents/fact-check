import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { loadLedger, loadSourceText } from '../session/ledger-store.js'
import { segmentPage } from '../source-text/segments.js'
import { coverageProgress } from './range-records.js'
import {
  jsonResult,
  maxSegmentsInput,
  segmentGranularityInput,
  segmentOffsetInput,
  sessionIdInput,
} from './tool-context.js'

/**
 * 候補区間の続きを読むだけのツール。台帳も元ネタも書き換えない（get_status と同じ読み取り専用の口）。
 *
 * start_session は先頭 1 ページしか返さない。長い元ネタで全件を一度に返すと応答が途中で切れて、
 * 呼ぶ側が「見えた範囲が全部だ」と誤解したまま進んでしまう（実運用で 503 件・約 3,500 行になった）。
 * 続きを取る口を別に用意し、進捗（網羅率）も一緒に返して、ページ 1 枚で終わりだと思わせない。
 *
 * 候補は元ネタ本文から毎回作り直す。台帳には保存しない（本文が同じなら結果も同じで、保存すると
 * 「台帳の候補」と「本文から作った候補」が食い違う余地ができる）。index と [start, end) は
 * 粒度が同じなら何度呼んでも同じ値になるので、ページを繋げば本文を 1 文字も欠かさず復元できる。
 */

const DESCRIPTION = [
  '元ネタの候補区間を、指定した位置から 1 ページ分だけ返す（読み取り専用。台帳は変わらない）。',
  'start_session が長い元ネタで返しきれなかった続きはここで読む。segment_offset に前の応答の',
  'next_segment_offset をそのまま渡すこと。segment_granularity は start_session と同じ意味で、',
  'ページを跨いで同じ値を使うこと（途中で変えると index と件数の意味が変わる）。',
  '返す候補は本文を隙間なく敷き詰めているので、全ページを繋ぐと本文が 1 文字も欠けずに復元できる。',
  '終止符も改行も無い長い塊は、候補を作る段階で一定の文字数以下に割ってある（text は縮めないので',
  'text と [start, end) は常に一致し、index と [start, end) は max_segments を変えても同じ値になる）。',
  '次に呼ぶもの: 返ってきた候補を register_segments でまとめて claim / non_claim に振り分ける。',
].join('\n')

export function registerReadSourceSegments(server: McpServer): void {
  server.registerTool(
    'read_source_segments',
    {
      title: '候補区間の続きを読む',
      description: DESCRIPTION,
      inputSchema: {
        session_id: sessionIdInput,
        segment_offset: segmentOffsetInput,
        segment_granularity: segmentGranularityInput,
        max_segments: maxSegmentsInput,
      },
    },
    async ({ session_id, segment_offset, segment_granularity, max_segments }) => {
      const ledger = await loadLedger(session_id)
      const sourceText = await loadSourceText(ledger)
      const page = segmentPage(sourceText, {
        ...(segment_granularity === undefined ? {} : { granularity: segment_granularity }),
        ...(segment_offset === undefined ? {} : { offset: segment_offset }),
        ...(max_segments === undefined ? {} : { maxSegments: max_segments }),
      })
      const progress = coverageProgress(ledger)
      return jsonResult({
        session_id,
        source_length: sourceText.length,
        ...page,
        ...progress,
        next_step:
          page.next_segment_offset === null
            ? '候補はこれで最後まで読んだ。未処理の範囲が残っていれば get_status で確認して埋めること。'
            : `続きは segment_offset=${page.next_segment_offset} で読むこと（残り ${page.segment_total - page.next_segment_offset} 件）。`,
      })
    },
  )
}
