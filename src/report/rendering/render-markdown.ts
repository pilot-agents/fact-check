import type { LedgerSummary } from '../../session/ledger-summary.js'
import type { Attachment, Evidence, Ledger } from '../../session/ledger-types.js'
import { type AttentionItem, buildAttention } from '../attention.js'
import {
  AGENT_CAPTURED_WARNING,
  DISCOVERED_VIA_LABEL,
  PROVENANCE_LABEL,
  UNRECORDED_LABEL,
  verdictText,
} from './labels.js'

/** report.md の本文。AI が申告した文言ではなく、台帳に残っている事実だけを並べる。 */

function sourceRefText(evidence: Evidence): string {
  return evidence.source.type === 'url' ? evidence.source.url : evidence.source.path
}

export function renderMarkdown(ledger: Ledger, summary: LedgerSummary): string {
  const lines: string[] = []
  lines.push(`# ファクトチェック結果: ${ledger.title ?? ledger.session_id}`)
  lines.push('')
  lines.push(`- セッション: \`${ledger.session_id}\``)
  lines.push(
    `- 元ネタ: ${ledger.source.kind}${ledger.source.origin === null ? '' : ` (${ledger.source.origin})`}`,
  )
  lines.push(`- 本文の長さ: ${ledger.source.length} 文字`)
  lines.push(
    `- 網羅率: ${summary.coverage.percent} (${summary.coverage.covered}/${summary.coverage.total} 文字)`,
  )
  lines.push(
    `- claim: ${summary.claims.total} 件 (verified ${summary.claims.verified} / contradicted ${summary.claims.contradicted} / partially_verified ${summary.claims.partially_verified} / unverifiable ${summary.claims.unverifiable})`,
  )
  lines.push(`- non_claim: ${summary.non_claims} 件`)
  lines.push(
    `- 証拠: ${summary.evidence.total} 件 (うち AI 提出 ${summary.evidence.by_provenance.agent_captured} 件)`,
  )
  lines.push('')

  lines.push(...attentionLines(buildAttention(ledger)))

  if (summary.evidence.by_provenance.agent_captured > 0) {
    lines.push(`> **注意**: ${AGENT_CAPTURED_WARNING}`)
    lines.push('')
  }

  lines.push('## 主張ごとの判定')
  lines.push('')
  for (const claim of ledger.claims) {
    const verdict = claim.verdict
    lines.push(`### ${claim.id}: ${claim.claim}`)
    lines.push('')
    lines.push(`- 元ネタの範囲: [${claim.start}, ${claim.end}) — 「${claim.source_text.trim()}」`)
    lines.push(`- 判定: **${verdict === null ? '未判定' : verdictText(verdict.value)}**`)
    if (verdict !== null) lines.push(`- 判定の理由: ${verdict.rationale}`)
    if (claim.kind !== null) lines.push(`- 種別: ${claim.kind}`)
    lines.push('')
    const attachments = ledger.attachments.filter((a) => a.claim_id === claim.id)
    if (attachments.length === 0) {
      lines.push('- 紐づいた証拠: なし')
      lines.push('')
      continue
    }
    for (const attachment of attachments) {
      const evidence = ledger.evidence.find((e) => e.id === attachment.evidence_id)
      lines.push(`#### ${attachment.id} (${attachment.relation}) → ${attachment.evidence_id}`)
      lines.push('')
      if (evidence !== undefined) {
        lines.push(`- 取得元: ${sourceRefText(evidence)}`)
        lines.push(`- 取得方法: ${PROVENANCE_LABEL[evidence.provenance]}`)
        lines.push(`- 出どころ: ${discoveryText(evidence)}`)
        lines.push(`- 取得時刻: ${evidence.fetched_at}`)
        lines.push(`- 本文 sha256: \`${evidence.text_sha256}\``)
        if (evidence.provenance === 'agent_captured') lines.push(`- ⚠️ ${AGENT_CAPTURED_WARNING}`)
      }
      const where = attachment.pdf_page === null ? '' : `・PDF ${attachment.pdf_page} ページ目`
      lines.push(
        `- 引用文（証拠本文の [${attachment.match.start}, ${attachment.match.end}) に実在${where}）:`,
      )
      lines.push('')
      lines.push(`  > ${attachment.quote.replace(/\n/g, '\n  > ')}`)
      lines.push('')
      lines.push(`- 根拠の説明: ${attachment.rationale}`)
      lines.push(...screenshotLines(attachment))
      lines.push('')
    }
  }

  if (ledger.non_claims.length > 0) {
    lines.push('## 対象外とした範囲')
    lines.push('')
    for (const nonClaim of ledger.non_claims) {
      lines.push(
        `- ${nonClaim.id} [${nonClaim.start}, ${nonClaim.end}): ${nonClaim.reason} — 「${nonClaim.source_text.trim()}」`,
      )
    }
    lines.push('')
  }

  lines.push('## 証拠の取得経緯')
  lines.push('')
  for (const evidence of ledger.evidence) {
    lines.push(`### ${evidence.id}`)
    lines.push('')
    lines.push(`- 取得元: ${sourceRefText(evidence)}`)
    lines.push(`- 取得方法: ${PROVENANCE_LABEL[evidence.provenance]}`)
    lines.push(`- 出どころ: ${discoveryText(evidence)}`)
    lines.push(
      `- 抽出本文: ${evidence.text_length} 文字 / sha256 \`${evidence.text_sha256}\` / \`${evidence.text_path}\``,
    )
    if (evidence.pdf !== null) {
      lines.push(`- PDF: \`${evidence.pdf.path}\` (${evidence.pdf.pages.length} ページ)`)
    }
    if (evidence.note !== null) lines.push(`- AI の説明: ${evidence.note}`)
    for (const a of evidence.attempts) {
      lines.push(`- 試行 ${a.stage}: ${a.ok ? '成功' : '失敗'} — ${a.detail}`)
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

/** 証拠の出どころ。version 1 の台帳には記録が無いので、その場合は無いと分かる言葉を返す。 */
export function discoveryText(evidence: Pick<Evidence, 'discovered_via' | 'discovery_note'>): string {
  if (evidence.discovered_via === null || evidence.discovered_via === undefined) return UNRECORDED_LABEL
  const label = DISCOVERED_VIA_LABEL[evidence.discovered_via]
  return evidence.discovery_note === null ? label : `${label} — ${evidence.discovery_note}`
}

function attentionLines(items: readonly AttentionItem[]): string[] {
  const lines = ['## 要確認一覧', '']
  if (items.length === 0) {
    lines.push('矛盾・一部のみ裏取り・裏取り不能と判定された主張はありません。', '')
    return lines
  }
  lines.push(`verified 以外の ${items.length} 件。上から重い順（矛盾 → 一部のみ → 裏取り不能）。`, '')
  lines.push('| claim | 判定 | 元ネタの該当文 | 判定の理由 |')
  lines.push('| --- | --- | --- | --- |')
  for (const item of items) {
    lines.push(
      `| ${item.claim_id} | ${verdictText(item.verdict)} | ${cell(item.source_text)} | ${cell(item.rationale)} |`,
    )
  }
  lines.push('')
  return lines
}

/** 表のセルに入れる。改行と縦棒は表を壊すので置き換える。 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ')
}

function screenshotLines(attachment: Attachment): string[] {
  if (attachment.screenshot_path !== null) {
    return [
      `- スクリーンショット: [${attachment.screenshot_path}](${attachment.screenshot_path})`,
      ...(attachment.screenshot_note === null ? [] : [`- スクショの但し書き: ${attachment.screenshot_note}`]),
    ]
  }
  return [`- スクリーンショット: なし — ${attachment.screenshot_note ?? '理由の記録なし'}`]
}
