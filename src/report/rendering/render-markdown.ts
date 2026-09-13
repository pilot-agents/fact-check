import { effectiveAttachments, effectiveRecords } from '../../session/ledger-effective.js'
import type { LedgerSummary } from '../../session/ledger-summary.js'
import type { Attachment, Evidence, Exclusion, Ledger } from '../../session/ledger-types.js'
import { type AttentionItem, buildAttention } from '../attention.js'
import {
  AGENT_CAPTURED_WARNING,
  DISCOVERED_VIA_LABEL,
  EXCLUSION_TARGET_LABEL,
  PROVENANCE_LABEL,
  SCREENSHOT_SOURCE_LABEL,
  STALE_REPORT_WARNING,
  UNRECORDED_LABEL,
  verdictText,
} from './labels.js'

/**
 * report.md の本文。AI が申告した文言ではなく、台帳に残っている事実だけを並べる。
 *
 * 取り消された記録は主要な節から外れるが、末尾の「取り消し履歴」に理由と時刻つきで全件出る。
 * 外して終わりにすると、誤登録があったこと自体が紙から消えて追えなくなる。
 */

function sourceRefText(evidence: Evidence): string {
  return evidence.source.type === 'url' ? evidence.source.url : evidence.source.path
}

export function renderMarkdown(ledger: Ledger, summary: LedgerSummary): string {
  const claims = effectiveRecords(ledger.exclusions, 'claim', ledger.claims)
  const nonClaims = effectiveRecords(ledger.exclusions, 'non_claim', ledger.non_claims)
  const evidenceList = effectiveRecords(ledger.exclusions, 'evidence', ledger.evidence)
  const attachments = effectiveAttachments(ledger)

  const lines: string[] = []
  lines.push(`# ファクトチェック結果: ${ledger.title ?? ledger.session_id}`)
  lines.push('')
  if (ledger.reports_stale_since !== null) {
    lines.push(`> **⚠️ ${STALE_REPORT_WARNING}**（台帳が変わった時刻: ${ledger.reports_stale_since}）`)
    lines.push('')
  }
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
  if (summary.exclusions.total > 0) {
    lines.push(
      `- 取り消し: ${summary.exclusions.active} 件が有効（復元済み ${summary.exclusions.restored} 件 / 履歴 ${summary.exclusions.total} 件）。詳細は末尾の「取り消し履歴」`,
    )
  }
  lines.push('')

  lines.push(...attentionLines(buildAttention(ledger)))

  if (summary.evidence.by_provenance.agent_captured > 0) {
    lines.push(`> **注意**: ${AGENT_CAPTURED_WARNING}`)
    lines.push('')
  }

  lines.push('## 主張ごとの判定')
  lines.push('')
  for (const claim of claims) {
    const verdict = claim.verdict
    lines.push(`### ${claim.id}: ${claim.claim}`)
    lines.push('')
    lines.push(`- 元ネタの範囲: [${claim.start}, ${claim.end}) — 「${claim.source_text.trim()}」`)
    lines.push(`- 判定: **${verdict === null ? '未判定' : verdictText(verdict.value)}**`)
    if (verdict !== null) lines.push(`- 判定の理由: ${verdict.rationale}`)
    if (claim.kind !== null) lines.push(`- 種別: ${claim.kind}`)
    lines.push('')
    const mine = attachments.filter((a) => a.claim_id === claim.id)
    if (mine.length === 0) {
      lines.push('- 紐づいた証拠: なし')
      lines.push('')
      continue
    }
    for (const attachment of mine) {
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

  if (nonClaims.length > 0) {
    lines.push('## 対象外とした範囲')
    lines.push('')
    for (const nonClaim of nonClaims) {
      lines.push(
        `- ${nonClaim.id} [${nonClaim.start}, ${nonClaim.end}): ${nonClaim.reason} — 「${nonClaim.source_text.trim()}」`,
      )
    }
    lines.push('')
  }

  lines.push('## 証拠の取得経緯')
  lines.push('')
  for (const evidence of evidenceList) {
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
    lines.push(...termCheckLines(evidence))
    for (const a of evidence.attempts) {
      lines.push(`- 試行 ${a.stage}: ${a.ok ? '成功' : '失敗'} — ${a.detail}`)
    }
    lines.push('')
  }

  lines.push(...exclusionLines(ledger))
  return `${lines.join('\n')}\n`
}

/**
 * 取り消し履歴。**取り消したものが何だったかを、紙の上で復元できるようにする。**
 *
 * 有効な節から外すだけだと、誤登録があった事実と、その範囲に何が書いてあったかが消える。
 * 対象の実体（主張の文・対象外の理由・証拠の取得元・引用文）もここに並べる。
 */
function exclusionLines(ledger: Ledger): string[] {
  const exclusions = ledger.exclusions
  if (exclusions.length === 0) return []
  const lines = ['## 取り消し履歴', '']
  lines.push(
    `全 ${exclusions.length} 件（今も取り消されているもの ${exclusions.filter((e) => e.restored === null).length} 件 / ` +
      `復元されたもの ${exclusions.filter((e) => e.restored !== null).length} 件）。` +
      '取り消しても元の記録と取得済みのファイルは消えていない。',
  )
  lines.push('')
  for (const exclusion of exclusions) {
    lines.push(`### ${exclusion.id}: ${EXCLUSION_TARGET_LABEL[exclusion.target_type]} ${exclusion.target_id}`)
    lines.push('')
    lines.push(`- 状態: ${exclusion.restored === null ? '**取り消し中**' : '復元済み'}`)
    lines.push(`- 取り消した時刻: ${exclusion.excluded_at}`)
    lines.push(`- 取り消した理由: ${exclusion.reason}`)
    if (exclusion.restored !== null) {
      lines.push(`- 復元した時刻: ${exclusion.restored.at}`)
      lines.push(`- 復元した理由: ${exclusion.restored.reason}`)
    }
    for (const line of excludedTargetLines(ledger, exclusion)) lines.push(line)
    lines.push('')
  }
  return lines
}

/** 取り消された対象そのものの中身。id だけでは何を取り消したのか紙から読めない。 */
function excludedTargetLines(ledger: Ledger, exclusion: Exclusion): string[] {
  if (exclusion.target_type === 'claim') {
    const claim = ledger.claims.find((c) => c.id === exclusion.target_id)
    if (claim === undefined) return []
    return [
      `- 対象の主張: ${claim.claim}`,
      `- 元ネタの範囲: [${claim.start}, ${claim.end}) — 「${claim.source_text.trim()}」`,
      ...(claim.verdict === null ? [] : [`- 取り消し時点の判定: ${verdictText(claim.verdict.value)}`]),
    ]
  }
  if (exclusion.target_type === 'non_claim') {
    const nonClaim = ledger.non_claims.find((n) => n.id === exclusion.target_id)
    if (nonClaim === undefined) return []
    return [
      `- 対象外とした理由: ${nonClaim.reason}`,
      `- 元ネタの範囲: [${nonClaim.start}, ${nonClaim.end}) — 「${nonClaim.source_text.trim()}」`,
    ]
  }
  if (exclusion.target_type === 'evidence') {
    const evidence = ledger.evidence.find((e) => e.id === exclusion.target_id)
    if (evidence === undefined) return []
    return [
      `- 対象の取得元: ${sourceRefText(evidence)}`,
      `- 取得方法: ${PROVENANCE_LABEL[evidence.provenance]} / 取得時刻: ${evidence.fetched_at}`,
      `- 保存された抽出本文: \`${evidence.text_path}\`（消していない）`,
    ]
  }
  if (exclusion.target_type === 'attachment') {
    const attachment = ledger.attachments.find((a) => a.id === exclusion.target_id)
    if (attachment === undefined) return []
    return [
      `- 対象の紐づけ: ${attachment.claim_id} ← ${attachment.evidence_id} (${attachment.relation})`,
      `- 引用文: 「${attachment.quote.replace(/\n/g, ' ')}」`,
      `- 根拠の説明: ${attachment.rationale}`,
    ]
  }
  return ['- セッション全体を保管した。台帳を変える操作は受け付けない状態になっている。']
}

/** 証拠の出どころ。version 1 の台帳には記録が無いので、その場合は無いと分かる言葉を返す。 */
export function discoveryText(evidence: Pick<Evidence, 'discovered_via' | 'discovery_note'>): string {
  if (evidence.discovered_via === null || evidence.discovered_via === undefined) return UNRECORDED_LABEL
  const label = DISCOVERED_VIA_LABEL[evidence.discovered_via]
  return evidence.discovery_note === null ? label : `${label} — ${evidence.discovery_note}`
}

/**
 * AI 提出証拠の語の照合結果。AI 提出以外は申告の口が無いので何も出さない。
 * 未検査を黙って空欄にすると「検査して問題なし」と読まれるため、未検査だと書く。
 */
function termCheckLines(evidence: Evidence): string[] {
  if (evidence.provenance !== 'agent_captured') return []
  const check = evidence.term_check
  if (check === null || check === undefined) {
    return ['- 確認したい語の照合: 未検査（expected_terms の申告なし）']
  }
  if (check.missing.length === 0) {
    return [`- 確認したい語の照合: 申告された ${check.terms.length} 語すべてが提出本文に実在した`]
  }
  return [
    `- ⚠️ 確認したい語の照合: 申告された ${check.terms.length} 語のうち ${check.missing.length} 語が提出本文に見つからなかった — ` +
      check.missing.map((term) => `「${term}」`).join(' / '),
  ]
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

/**
 * 画像の記録。**採用した 1 枚だけでなく、採用しなかった試行も出す。**
 * 保存 HTML で撮れずに抽出本文へ切り替えた場合、その理由と HTML 側の画像が
 * ここに残らないと「なぜ元ページの見た目で撮れなかったか」が紙から消える。
 */
function screenshotLines(attachment: Attachment): string[] {
  const lines: string[] = []
  if (attachment.screenshot_path !== null) {
    const source = attachment.screenshot_source
    lines.push(`- スクリーンショット: [${attachment.screenshot_path}](${attachment.screenshot_path})`)
    lines.push(
      source === null || source === undefined
        ? `- 画像の出どころ: ${UNRECORDED_LABEL}`
        : `- 画像の出どころ: ${SCREENSHOT_SOURCE_LABEL[source]}`,
    )
    if (attachment.screenshot_note !== null) {
      lines.push(`- スクショの但し書き: ${attachment.screenshot_note.replace(/\n/g, '\n  ')}`)
    }
  } else {
    lines.push(
      `- スクリーンショット: なし — ${(attachment.screenshot_note ?? '理由の記録なし').replace(/\n/g, '\n  ')}`,
    )
  }
  const attempts = attachment.screenshot_attempts ?? []
  // 1 回で決まったときは、採用の 1 行と同じことしか書けないので出さない。
  if (attempts.length > 1) {
    lines.push('- 画像を作るために試したこと:')
    for (const attempt of attempts) {
      const state = attempt.highlighted
        ? 'ハイライト付きで撮れた'
        : attempt.path === null
          ? '画像を撮れなかった'
          : 'ハイライト無しの画像だけ撮れた'
      lines.push(
        `  - ${SCREENSHOT_SOURCE_LABEL[attempt.source]}: ${state}` +
          (attempt.adopted ? '（これを採用）' : '（採用せず）') +
          (attempt.path === null ? '' : ` — [${attempt.path}](${attempt.path})`),
      )
      if (attempt.note !== null) lines.push(`    - 記録: ${attempt.note.replace(/\n/g, '\n      ')}`)
    }
  }
  return lines
}
