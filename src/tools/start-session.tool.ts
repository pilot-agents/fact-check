import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { FactCheckError } from '../errors.js'
import { loadLocalTextFile, loadUrlText } from '../evidence/load-text.js'
import { createSession } from '../session/ledger-store.js'
import type { SourceRecord } from '../session/ledger-types.js'
import { segmentSource } from '../source-text/segments.js'
import { jsonResult } from './tool-context.js'

const DESCRIPTION = [
  'ファクトチェックを開始し、元ネタ（裏取り対象の文章）を取り込む。すべてのツールの起点。',
  '返り値の segments は本文を隙間なく敷き詰めた候補範囲で、これをそのまま register_claim /',
  'mark_non_claim に渡していけば網羅率 100% に到達できる（segments に隙間は無い）。',
  '次に呼ぶもの: segments を上から順に見て、事実主張なら register_claim、見出し・感想・接続句など',
  '裏取り対象でない範囲なら mark_non_claim。まとめて登録するなら register_segments に全件を 1 回で',
  '渡すほうが速い（1 件でも不正なら 1 件も登録せずに全部の理由を返す）。',
  '本文の全文字がどちらかに入るまで続けること。',
].join('\n')

export function registerStartSession(server: McpServer): void {
  server.registerTool(
    'start_session',
    {
      title: '元ネタを取り込んでセッションを開始する',
      description: DESCRIPTION,
      inputSchema: {
        source: z
          .discriminatedUnion('type', [
            z.object({
              type: z.literal('text'),
              text: z.string().min(1).describe('元ネタの本文そのもの'),
            }),
            z.object({
              type: z.literal('file'),
              path: z.string().min(1).describe('元ネタのローカルファイルパス (.txt / .md / .html / .pdf)'),
            }),
            z.object({ type: z.literal('url'), url: z.url().describe('元ネタの URL') }),
          ])
          .describe('元ネタの取り込み元'),
        title: z.string().optional().describe('レポートに出す表題'),
      },
    },
    async ({ source, title }) => {
      const loaded = await loadSource(source)
      if (loaded.text.trim().length === 0) {
        throw new FactCheckError(`元ネタから本文テキストを抽出できなかった (type=${source.type})`)
      }
      const created = await createSession({
        title: title ?? null,
        kind: loaded.kind,
        origin: loaded.origin,
        text: loaded.text,
      })
      const segments = segmentSource(loaded.text)
      return jsonResult({
        session_id: created.ledger.session_id,
        session_dir: created.dir,
        source: { kind: loaded.kind, origin: loaded.origin, length: loaded.text.length },
        segments,
        next_step:
          'segments を 1 つ残らず claim か non_claim で埋めること。まとめて登録するなら register_segments に ' +
          '全件を 1 回で渡す（1 件ずつなら register_claim / mark_non_claim）。get_status でいつでも残りを確認できる。',
      })
    },
  )
}

type LoadedSource = { kind: SourceRecord['kind']; origin: string | null; text: string }

async function loadSource(
  source: { type: 'text'; text: string } | { type: 'file'; path: string } | { type: 'url'; url: string },
): Promise<LoadedSource> {
  if (source.type === 'text') return { kind: 'text', origin: null, text: source.text }
  if (source.type === 'file') {
    const loaded = await loadLocalTextFile(source.path)
    return { kind: 'file', origin: loaded.absolute, text: loaded.body.text }
  }
  const loaded = await loadUrlText(source.url)
  if (!loaded.ok) {
    throw new FactCheckError(
      `元ネタの URL を取得できなかった (url=${source.url}): ${loaded.detail}. ` +
        'あなたのブラウザ操作ツールでページ本文を取得し、source を {type:"text", text:"..."} にして呼び直すこと。',
    )
  }
  return { kind: 'url', origin: source.url, text: loaded.body.text }
}
