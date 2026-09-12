/** 共有契約: セッション台帳のデータ表現。ツール・レポート・永続化がこの型だけを介して繋がる。 */

/**
 * 2: 証拠に discovered_via（出どころ）と PDF のスナップショットが加わった。1 の台帳は読めない
 * （読めたことにすると、必須の出どころが undefined のままレポートに出る）。
 */
export const LEDGER_VERSION = 2

/**
 * 証拠をどうやって手に入れたか。
 * - http/browser/file: ツール自身が取得した（信頼できる）
 * - agent_captured: AI が自分のブラウザ操作ツールで取ってきたものを提出した（ツールは未検証）
 *
 * 'file' は指示書の 3 値には無いが、ローカルファイルの読み込みを http と呼ぶのは嘘になるため足した。
 */
export type Provenance = 'http' | 'browser' | 'file' | 'agent_captured'

/**
 * その証拠に**誰が**当たったか。provenance（どうやって取ったか）とは別の軸。
 * - cited_in_source: 元ネタ自身が出典として示していた
 * - agent_search: AI が検索などで自分で見つけた
 * - agent_knowledge: AI が自分の知識から当たりを付けた
 *
 * 読み手にとっては「元ネタが示した裏付け」か「AI が後から探してきた裏付け」かで重みが違う。
 * ツールからは区別できないので AI に必ず申告させ、レポートに出す。
 */
export type DiscoveredVia = 'cited_in_source' | 'agent_search' | 'agent_knowledge'
export type Relation = 'supports' | 'contradicts' | 'partial' | 'irrelevant'
export type VerdictValue = 'verified' | 'contradicted' | 'partially_verified' | 'unverifiable'

export type SourceKind = 'text' | 'file' | 'url'

export type SourceRef = { type: 'url'; url: string } | { type: 'file'; path: string }

/** 証拠取得の各段階で何が起きたか。成否を 1 つの boolean に潰さないための記録。 */
export type FetchAttempt = {
  stage: 'http' | 'browser' | 'file'
  ok: boolean
  detail: string
  at: string
}

export type SourceRecord = {
  kind: SourceKind
  /** url なら URL、file なら絶対パス、text なら null */
  origin: string | null
  length: number
  /** セッションディレクトリからの相対パス */
  text_path: string
}

export type Claim = {
  id: string
  start: number
  end: number
  /** 元ネタの当該範囲の実テキスト */
  source_text: string
  /** AI が言語化した主張 */
  claim: string
  kind: string | null
  created_at: string
  verdict: { value: VerdictValue; rationale: string; decided_at: string } | null
}

export type NonClaim = {
  id: string
  start: number
  end: number
  source_text: string
  reason: string
  created_at: string
}

/** PDF 証拠のスナップショット。ページ境界は引用箇所のページ番号を出すために持つ。 */
export type PdfSnapshot = {
  /** セッションディレクトリからの相対パス。取得した PDF のバイト列そのもの */
  path: string
  pages: Array<{ page: number; start: number; end: number }>
}

export type Evidence = {
  id: string
  source: SourceRef
  provenance: Provenance
  discovered_via: DiscoveredVia
  /** どこに出典として書いてあったか、何で検索したか。任意 */
  discovery_note: string | null
  fetched_at: string
  /** 抽出本文テキスト (utf-8) の sha256 */
  text_sha256: string
  text_length: number
  text_path: string
  html_path: string | null
  screenshot_path: string | null
  pdf: PdfSnapshot | null
  attempts: FetchAttempt[]
  /** agent_captured のときに AI が添えた説明 */
  note: string | null
}

export type Attachment = {
  id: string
  claim_id: string
  evidence_id: string
  quote: string
  relation: Relation
  rationale: string
  created_at: string
  /** 引用文が証拠本文のどこに実在したか（原文オフセット） */
  match: { start: number; end: number }
  /** PDF 証拠のとき、引用箇所が何ページ目にあったか。PDF でなければ null */
  pdf_page: number | null
  screenshot_path: string | null
  /** スクショを撮れなかった・ハイライトできなかったときの理由。撮れていれば null */
  screenshot_note: string | null
}

export type Ledger = {
  version: number
  session_id: string
  title: string | null
  created_at: string
  source: SourceRecord
  claims: Claim[]
  non_claims: NonClaim[]
  evidence: Evidence[]
  attachments: Attachment[]
}
