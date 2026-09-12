import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { FactCheckError } from '../errors.js'
import { loadSourceText, updateLedger } from '../session/ledger-store.js'
import { rangeProblem } from '../source-text/ranges.js'
import { addClaim, addNonClaim, coverageProgress } from './range-records.js'
import { jsonResult, sessionIdInput } from './tool-context.js'

/**
 * 範囲のまとめ登録。
 *
 * 1 件ずつのツールしか無かったとき、3853 文字の元ネタ 1 本で 85 回の呼び出しが要った。往復そのものが
 * 呼ぶ側の負担になるので、全件を 1 回で受ける口を足す。
 *
 * **全件検証してから全件登録する**。途中まで登録して止まると、呼ぶ側は「どこまで入ったか」を
 * 数えて続きを組み直さねばならず、数え違いがそのまま網羅率の穴になる。1 件でも不正なら 1 件も
 * 登録せず、不正な item を全部並べて返す。
 */

const DESCRIPTION = [
  '元ネタの範囲を claim / non_claim としてまとめて登録する。start_session が返した segments を',
  'そのまま全件渡すのが想定した使い方（1 件ずつの register_claim / mark_non_claim を何十回も呼ぶ必要はない）。',
  '**1 件でも不正な item があれば 1 件も登録せず、不正な item を全部列挙して拒否する**。',
  '途中まで登録された状態にはならないので、直して同じ配列をもう一度渡せばよい。',
  '次に呼ぶもの: 網羅率 100% になったら、各 claim について fetch_evidence → attach_evidence → set_verdict。',
].join('\n')

const claimItem = z.object({
  kind: z.literal('claim'),
  start: z.number().int().min(0).describe('開始文字オフセット（この位置を含む）'),
  end: z.number().int().min(0).describe('終了文字オフセット（この位置を含まない）'),
  claim: z.string().min(1).describe('この範囲が主張している内容を、単独で検証できる一文にしたもの'),
  claim_kind: z.string().optional().describe('主張の種別（数値・日付・引用・因果 など）。任意'),
})

const nonClaimItem = z.object({
  kind: z.literal('non_claim'),
  start: z.number().int().min(0).describe('開始文字オフセット（この位置を含む）'),
  end: z.number().int().min(0).describe('終了文字オフセット（この位置を含まない）'),
  reason: z.string().min(1).describe('なぜ裏取り対象でないのか（見出し・感想・接続句・空行 など）'),
})

const itemsInput = z
  .array(z.discriminatedUnion('kind', [claimItem, nonClaimItem]))
  .min(1, { message: 'items が空。登録する範囲を 1 件以上入れること' })
  .describe('登録する範囲の配列。並び順のまま登録される')

type SegmentItem = z.infer<typeof itemsInput>[number]

export function registerRegisterSegments(server: McpServer): void {
  server.registerTool(
    'register_segments',
    {
      title: '範囲をまとめて claim / non_claim に登録する',
      description: DESCRIPTION,
      inputSchema: { session_id: sessionIdInput, items: itemsInput },
    },
    async ({ session_id, items }) => {
      const result = await updateLedger(session_id, async (ledger) => {
        const sourceText = await loadSourceText(ledger)
        assertAllItemsValid(items, sourceText.length)
        const registered = items.map((item, index) =>
          item.kind === 'claim'
            ? {
                index,
                kind: 'claim' as const,
                id: addClaim(ledger, sourceText, {
                  start: item.start,
                  end: item.end,
                  claim: item.claim,
                  kind: item.claim_kind ?? null,
                }).id,
                range: { start: item.start, end: item.end },
              }
            : {
                index,
                kind: 'non_claim' as const,
                id: addNonClaim(ledger, sourceText, {
                  start: item.start,
                  end: item.end,
                  reason: item.reason,
                }).id,
                range: { start: item.start, end: item.end },
              },
        )
        return { registered, progress: coverageProgress(ledger) }
      })
      return jsonResult({
        registered: result.registered,
        registered_count: result.registered.length,
        ...result.progress,
        next_step:
          result.progress.uncovered_ranges === 0
            ? '網羅は埋まった。各 claim について fetch_evidence → attach_evidence → set_verdict を回すこと。'
            : `未処理の範囲がまだ ${result.progress.uncovered_ranges} 個ある。get_status で確認して埋めること。`,
      })
    },
  )
}

/** 全件見てから投げる。1 件目で投げると、呼ぶ側は不正を 1 つずつしか潰せない。 */
function assertAllItemsValid(items: readonly SegmentItem[], textLength: number): void {
  const problems: string[] = []
  items.forEach((item, index) => {
    const problem = rangeProblem(textLength, item.start, item.end)
    if (problem !== null) problems.push(`items[${index}] (kind=${item.kind}): ${problem}`)
  })
  if (problems.length === 0) return
  throw new FactCheckError(
    [
      `register_segments は ${items.length} 件のうち ${problems.length} 件が不正だったため、1 件も登録しなかった。`,
      ...problems.map((problem) => `  - ${problem}`),
      '',
      '不正な item を直して、同じ配列をもう一度渡すこと（途中まで登録された状態にはなっていない）。',
    ].join('\n'),
  )
}
