/** 共有契約: セッション台帳のデータ表現。ツール・レポート・永続化がこの型だけを介して繋がる。 */

/**
 * **新しく書く**台帳の版。保存するときは必ずこの値になる（ledger-store.ts の saveLedger）。
 *
 * 2: 証拠に discovered_via（出どころ）と PDF のスナップショットが加わった。
 * 3: 取り消し履歴 (`exclusions`)、レポートの鮮度 (`reports_stale_since`)、
 *    画像の試行記録 (`screenshot_attempts`) が加わった。
 *
 * なぜ 3 に上げるか: **古い版のツールに読ませてはいけない**ため。取り消しを知らない版は
 * `exclusions` を無視して集計するので、利用者が取り消したはずの記録まで数え直してしまう。
 * 項目が増えただけなら黙って読めてしまうので、版で拒否させる。
 */
export const LEDGER_VERSION = 3

/**
 * **読める**台帳の版。書くのは常に `LEDGER_VERSION` だが、読むのはこれらすべて。
 *
 * 2 を読み続けるのは、途中まで進めた利用者のセッションを捨てないため。2 を読んだあと
 * 保存すると 3 になる（そこから先は古い版で開けない）。1 は入れない —— 必須になった
 * 出どころ (`discovered_via`) を持たず、読めたことにすると記録の無い項目が
 * undefined のままレポートに出る。
 *
 * 済んだ結果を読み返すだけの経路（report:rebuild とセッション一覧）は、ここを通らず
 * ledger-like.ts の緩い読み取りを使う。過去のセッションを二度と開けなくしないため。
 */
export const READABLE_LEDGER_VERSIONS: readonly number[] = [2, 3]

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
/**
 * 添付の画像を何から描いたか。
 * - saved_html / saved_text: 取得時に保存したスナップショットを描いた（ライブページではない）
 * - pdf_page: 保存した PDF の該当ページを描いた
 * - agent_captured: AI が提出した画像をそのまま使った（ツールは撮影していない）
 */
export type ScreenshotSource = 'saved_html' | 'saved_text' | 'pdf_page' | 'agent_captured'

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

/**
 * AI が「このページで確かめたい語」として申告した語の照合結果。
 *
 * AI 提出の証拠は、本文抽出に失敗した内容（CSS だけ・別ページ）でも登録できてしまう。
 * 意味の判定はせず、申告した語が抽出本文に実在するかだけを引用照合と同じ規則で見る。
 * 未申告なら null（= 未検査。「検査して問題なし」と区別する）。
 */
export type TermCheck = {
  terms: string[]
  /** 本文に見つからなかった語。空なら全部見つかった */
  missing: string[]
  /** 語をどこから受け取ったか（入力名）。後から読む人が申告者を取り違えないため */
  declared_by: 'agent'
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
  /** expected_terms の照合結果。申告が無ければ null（未検査） */
  term_check: TermCheck | null
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
  /**
   * 画像を何から作ったか。成功した画像の但し書きを screenshot_note に相乗りさせると
   * 「失敗理由」と「出どころの説明」が同じ欄に混ざるので、別の欄に持つ。
   * この欄を持たない旧台帳では null（読み取り経路は ledger-like.ts が補う）。
   */
  screenshot_source: ScreenshotSource | null
  /**
   * 画像を作るために試したこと全部。採用した 1 件だけでなく、採用しなかった試行も残す。
   *
   * 保存 HTML で撮れなかったときに抽出本文へ切り替えるようになった以上、「採用された画像」
   * だけを残すと**なぜ HTML では撮れなかったか**が消える。FetchAttempt と同じ考えで、
   * 成否を 1 つの boolean に潰さない。旧台帳には無い（= 記録なし）ので空配列で読む。
   */
  screenshot_attempts: ScreenshotAttempt[]
}

/** 画像 1 回ぶんの試行。失敗しても撮れた画像があれば path に残す（別パスに保存する）。 */
export type ScreenshotAttempt = {
  source: ScreenshotSource
  /** この試行で保存できた画像。撮れなかったら null */
  path: string | null
  /** ハイライトまで載せられたか */
  highlighted: boolean
  /** うまくいかなかった理由の全文。成功していれば null */
  note: string | null
  /** この試行の画像を添付の本体として採用したか */
  adopted: boolean
}

/**
 * 取り消しの対象。session はセッション丸ごとの保管（それ以上の裏取りを止め、
 * 読み返しだけできる状態にする）で、target_id には session_id が入る。
 */
export type ExclusionTargetType = 'claim' | 'non_claim' | 'evidence' | 'attachment' | 'session'

/**
 * 誤登録を「無かったこと」にせずに無効化した記録。**追記しかしない**。
 *
 * なぜ元レコードに `excluded: true` を立てないか: 立てると「今どうなっているか」を持つ場所が
 * 台帳に 2 つ（フラグと履歴）できて、片方だけ直したときに静かに食い違う。さらに、除外した
 * claim にぶら下がる添付まで一括で立てて回ると、復元のときに「元から個別に除外されていた
 * 添付」と「連鎖で無効になっただけの添付」の区別が付かなくなる。
 * 有効かどうかは exclusions から**その都度導く**（ledger-effective.ts）。
 *
 * なぜファイルを消さないか: 証拠の本文・HTML・画像は「その時点で確かにこれを見た」という
 * 記録そのもので、誤って紐づけたことと、取得した事実が偽になることは別。
 */
export type Exclusion = {
  id: string
  target_type: ExclusionTargetType
  target_id: string
  /** なぜ取り消したか。空文字は入らない（ツールが要求する） */
  reason: string
  excluded_at: string
  /** 復元されたら記録が入る。null なら今も除外中 */
  restored: { reason: string; at: string } | null
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
  /** 取り消し・復元の全履歴。古い台帳には無い（= 取り消し無し） */
  exclusions: Exclusion[]
  /**
   * 台帳が変わってから finalize していない場合の、変わった時刻。
   * これが非 null の間、書き出し済みのレポートは「最新の有効な結果」ではない。
   * finalize が null に戻す。
   */
  reports_stale_since: string | null
}
