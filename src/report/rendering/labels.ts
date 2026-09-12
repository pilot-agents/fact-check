import type { DiscoveredVia, Provenance, Relation, VerdictValue } from '../../session/ledger-types.js'

/**
 * レポートに出す日本語の文言。report.md・report.html（ビューア）の両方がここだけを見る。
 *
 * ビューアの描画はブラウザ側の JavaScript が行うが、文言はこの 1 箇所から HTML に埋めて渡す。
 * 同じ意味の言葉を TS 側とブラウザ側に 2 回書くと、片方だけ直したときに md と html で判定の
 * 呼び名が食い違う。読み手には同じレポートの中の矛盾にしか見えない。
 */

/** 判定の呼び名。'none' は verdict が付いていない claim（finalize 済みなら出ないが、rebuild では出る）。 */
export const VERDICT_LABEL: Record<VerdictValue | 'none', string> = {
  verified: '裏取り済み',
  contradicted: '矛盾',
  partially_verified: '一部のみ裏取り',
  unverifiable: '裏取り不能',
  none: '未判定',
}

/** 色が見えなくても判定が分かるようにする 1 文字の記号。塗りと必ず一緒に出す。 */
export const VERDICT_MARK: Record<VerdictValue | 'none', string> = {
  verified: '済',
  contradicted: '矛',
  partially_verified: '部',
  unverifiable: '不',
  none: '未',
}

export const RELATION_LABEL: Record<Relation, string> = {
  supports: '支持する',
  contradicts: '矛盾する',
  partial: '一部だけ支持する',
  irrelevant: '関係しない',
}

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  http: 'ツールが HTTP で取得',
  browser: 'ツールがヘッドレスブラウザで取得',
  file: 'ツールがローカルファイルから読み込み',
  agent_captured: 'AI が提出（ツールは直接取得していない）',
}

export const DISCOVERED_VIA_LABEL: Record<DiscoveredVia, string> = {
  cited_in_source: '元ネタが出典として示していた',
  agent_search: 'AI が検索などで見つけた',
  agent_knowledge: 'AI が自分の知識から当たった',
}

/** version 1 の台帳には出どころの記録が無い。「記録が無い」ことを空欄にせず言葉で出す。 */
export const UNRECORDED_LABEL = '旧版のため未記録'

export const AGENT_CAPTURED_WARNING =
  'この証拠はツールが直接取得したものではなく、AI が自分のブラウザ操作ツールで取得して提出した内容です。取得元の実在と内容の同一性はツールでは検証されていません。'

/** 「裏取り済み (verified)」の形。値そのものも出すのは、判定名の翻訳で元の値が消えないようにするため。 */
export function verdictText(value: VerdictValue | 'none'): string {
  return `${VERDICT_LABEL[value]} (${value})`
}

/** ビューアの JavaScript に渡す文言一式。 */
export function viewerLabels(): Record<string, unknown> {
  return {
    verdict: VERDICT_LABEL,
    mark: VERDICT_MARK,
    relation: RELATION_LABEL,
    provenance: PROVENANCE_LABEL,
    discovered_via: DISCOVERED_VIA_LABEL,
    unrecorded: UNRECORDED_LABEL,
    agent_captured_warning: AGENT_CAPTURED_WARNING,
  }
}
