import type {
  DiscoveredVia,
  ExclusionTargetType,
  Provenance,
  Relation,
  ScreenshotSource,
  VerdictValue,
} from '../../session/ledger-types.js'

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

/**
 * 画像の出どころ。保存内容を描いた画像を「元ページのスクショ」と読み違えられると、
 * 見た目の違いが不具合に見え、逆に「元ページが今もこう見える」と誤解される。
 */
export const SCREENSHOT_SOURCE_LABEL: Record<ScreenshotSource, string> = {
  saved_html: '取得時に保存した HTML を描画（元ページの外観の再現ではない）',
  saved_text: '取得時に保存した抽出本文を描画（元ページの外観の再現ではない）',
  pdf_page: '取得した PDF の該当ページを描画',
  agent_captured: 'AI が提出した画像（ツールが撮影したものではない）',
}

/** 取り消しの対象の呼び名。id の接頭辞をそのまま出すより、何を取り消したかが伝わる。 */
export const EXCLUSION_TARGET_LABEL: Record<ExclusionTargetType, string> = {
  claim: '主張',
  non_claim: '対象外とした範囲',
  evidence: '証拠',
  attachment: '証拠の紐づけ',
  session: 'セッション全体（保管）',
}

/**
 * 台帳より古いレポートを「最新の結果」と読ませないための断り書き。
 * finalize を通っていない = 判定の根拠が揃っているかの確認をしていない、という意味。
 */
export const STALE_REPORT_WARNING =
  'これは finalize を通していない暫定表示です。' +
  '取り消しや登録で台帳が変わったあと、レポートだけが古いまま残らないように書き直しました。' +
  '判定を支える根拠が揃っているかの確認（finalize の検証）は済んでいません。' +
  'MCP の finalize を呼び直すと、検証を通した正式なレポートになります。'

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
    screenshot_source: SCREENSHOT_SOURCE_LABEL,
    exclusion_target: EXCLUSION_TARGET_LABEL,
    unrecorded: UNRECORDED_LABEL,
    agent_captured_warning: AGENT_CAPTURED_WARNING,
    stale_report_warning: STALE_REPORT_WARNING,
  }
}
