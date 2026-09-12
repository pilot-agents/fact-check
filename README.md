# fact-check MCP サーバー

AI エージェントが文章の裏取りをするときに、**嘘をつけない・漏らせない**ようにするための MCP サーバーです。

裏取りの作業は、AI に任せると 2 通りの形で壊れます。

- **嘘**: 実際には確認していないのに「確認済み」と書く。存在しない引用文を書く
- **漏れ**: 元ネタの一部を見ないまま「全部確認した」と書く

このサーバーは、AI の判断を信用する箇所を「**この証拠はこの主張を支持するか**」の 1 点だけに絞ります。
それ以外はすべてツール側が機械的に検証・生成します。

| AI がやること | ツールが機械的にやること |
| --- | --- |
| 元ネタのどこが事実主張かを切り分ける | 範囲が本文の内側かを検証し、範囲の実テキストを返す |
| 証拠の取得元と、その**出どころ**（元ネタが示した出典か／自分で探したか）を申告する | 取得そのもの・スナップショット保存・取得経緯の記録 |
| 証拠本文から引用文を選ぶ | **引用文が証拠本文に実在するかの照合**（実在しなければ登録を拒否） |
| 証拠と主張の関係を判断する | 関係と判定の整合性チェック（supports が無い verified は拒否） |
| — | 網羅率の計算、ハイライト付きスクリーンショットの撮影、最終レポートの生成 |

AI が申告した内容をそのまま信じて記録する経路はありません。

## 必要なもの

- Node.js 22 以降
- ヘッドレスブラウザ（Chromium）。**同梱していません**。JS で描画するページの取得と、証拠の
  ハイライト付きスクリーンショットに要ります。HTTP 取得だけで済む証拠（ふつうの HTML ページ・
  PDF・ローカルファイル）はブラウザ無しでも扱えます

```bash
npx playwright install chromium   # 初回のみ。ブラウザが要る操作で必要になる
```

Chromium を入れずに使い始めても構いません。ブラウザが要る場面に来たときだけ失敗し、
エラー文にこのコマンドが出ます。

## MCP クライアントへの登録

npm から使う場合はビルド不要です。`npx` が起動のたびにパッケージを解決します。

### Claude Code

```bash
claude mcp add fact-check -- npx -y @pilot-agents/fact-check-mcp
```

保存先を指定する場合:

```bash
claude mcp add fact-check \
  --env FACT_CHECK_DIR=/absolute/path/to/fact-check-data \
  -- npx -y @pilot-agents/fact-check-mcp
```

登録後、`claude mcp list` に `fact-check` が出れば接続できています。

### `.mcp.json`（プロジェクトに置く場合）

```json
{
  "mcpServers": {
    "fact-check": {
      "command": "npx",
      "args": ["-y", "@pilot-agents/fact-check-mcp"],
      "env": { "FACT_CHECK_DIR": "/absolute/path/to/fact-check-data" }
    }
  }
}
```

### Codex

設定ファイル（`~/.codex/config.toml`）に追記します。

```toml
[mcp_servers.fact-check]
command = "npx"
args = ["-y", "@pilot-agents/fact-check-mcp"]

[mcp_servers.fact-check.env]
FACT_CHECK_DIR = "/absolute/path/to/fact-check-data"
```

### リポジトリをそのまま使う場合（開発・改造）

```bash
pnpm install
pnpm exec playwright install chromium   # ヘッドレスブラウザ（初回のみ）
pnpm build
```

`pnpm build` が `dist/index.js` を作ります。登録先のコマンドを `npx` の代わりにこのファイルにします。

```bash
claude mcp add fact-check -- node /absolute/path/to/fact-check/dist/index.js
```

```toml
[mcp_servers.fact-check]
command = "node"
args = ["/absolute/path/to/fact-check/dist/index.js"]
```

### 共通の注意

- MCP 接続（プロセス起動）でサーバーが立ち上がります。常駐サービスや別途起動するデーモンはありません
- ヘッドレスブラウザは **初回に必要になった時点** で起動します。ブラウザを使わないセッションでは起動しません
- ローカル利用が前提です

## ワークフロー

```
start_session
   ↓  返ってきた候補範囲を…
register_segments（まとめて）／ register_claim・mark_non_claim（1 件ずつ）  ←→  get_status（残りを確認）
   ↓  本文の全文字がどちらかに入る（網羅率 100%）
fetch_evidence  ──取得できないとき──▶  submit_agent_capture
   ↓
attach_evidence（引用文の実在をツールが照合）
   ↓
set_verdict
   ↓
finalize（網羅率 100% かつ全 claim 判定済みでなければ拒否）
```

### ツール一覧

| ツール | 役割 | 拒否する条件 |
| --- | --- | --- |
| `start_session` | 元ネタ（text / file / url）を取り込む。本文を隙間なく敷き詰めた候補範囲を返す | 本文テキストを抽出できない |
| `register_claim` | 範囲を「裏取りすべき事実主張」として登録する | 範囲が本文の外・`start > end`・空範囲 |
| `mark_non_claim` | 範囲を「裏取り対象外」として理由つきで登録する | 同上 |
| `register_segments` | 範囲を claim / non_claim として**まとめて**登録する | 1 件でも不正なら**全件**拒否（途中まで登録しない）・空配列 |
| `fetch_evidence` | 証拠（Web ページ・PDF・ローカルファイル）をツール自身が取得し、スナップショットを保存する | HTTP もブラウザも失敗（`submit_agent_capture` を促す） |
| `submit_agent_capture` | AI 自身のブラウザ操作ツールで取った内容を証拠として提出する | 本文テキストが空・`text` と `text_path` の同時指定／両方未指定・スクショのパスが読めない |
| `attach_evidence` | 引用文の実在を照合して claim と evidence を結ぶ | **引用文が証拠本文に実在しない**・自己参照 |
| `set_verdict` | claim に最終判定を付ける | `verified` に `supports` が無い / `contradicted` に `contradicts` が無い |
| `get_status` | 網羅率・未処理の範囲・未判定の claim を返す | — |
| `finalize` | `report.md` / `report.json` / `report.html` を書き出す | 網羅率 100% 未満・判定漏れ・claim が 0 件 |

### 引用文の照合規則

`attach_evidence` に渡した引用文は、次の規則で証拠本文と突き合わせます。

1. Unicode NFKC 正規化（全角英数 ↔ 半角、半角カナ ↔ 全角カナ などを吸収）
2. 空白の連続を 1 つの半角空白に畳む（改行・タブ・全角スペースを含む）
3. その上での**完全部分一致**

要約・言い換え・記憶からの復元は通りません。見つからなかった場合は、引用文と最も長く一致した箇所の抜粋を
添えてエラーを返すので、どこまで合っていてどこから違うかが分かります。

### 証拠の出どころ

`fetch_evidence` と `submit_agent_capture` は `discovered_via` を**必須**で要求します。

| 値 | 意味 |
| --- | --- |
| `cited_in_source` | 元ネタ自身が出典として示していた |
| `agent_search` | AI が検索などで自分で見つけた |
| `agent_knowledge` | AI が自分の知識から当たりを付けた |

任意の `discovery_note`（どこに書いてあったか、何で検索したか）も添えられます。どちらもレポートの
証拠ごとの表示と末尾の証拠一覧の両方に出ます。「元ネタが示した裏付け」と「AI が後から探してきた
裏付け」は読み手にとって重みが違いますが、ツールからは区別できないため AI に申告させています。

### 網羅率

網羅率は「元ネタ本文のうち、claim か non_claim のいずれかの範囲に含まれる文字の割合」です（範囲の重なりは
和集合で 1 回だけ数えます）。見出しも空行も分母に入るため、`start_session` が返す候補範囲は本文を**隙間なく
敷き詰めるように**割ってあります。候補をそのまま使えば 100% に到達できます。

### 取得できない URL に当たったとき

`fetch_evidence` は HTTP 取得 → ヘッドレスブラウザの順に試し、どの段階で何が起きたかを `attempts` に残します。
両方失敗した場合はエラーの中で「あなた自身のブラウザ操作ツールでこの URL を開き、本文テキストとスクリーン
ショットを取って `submit_agent_capture` を呼ぶこと」と指示します。

**本文が短すぎて失敗したとき**（表題と資料へのリンクしか置いていないページ）は、そのページの中の PDF への
リンクを最大 5 件、絶対 URL にしてエラー文に並べ、「本文がこの PDF にある可能性が高いので、その URL で
`fetch_evidence` を呼ぶこと」と指示します。`href` が `.pdf` で終わるもの（クエリやフラグメントが付いていても
可）と、`type="application/pdf"` を持つものを候補にします。PDF リンクが無ければ従来どおりの文面です。

この経路で登録した証拠は `provenance = agent_captured` として記録され、レポートには
「ツールが直接取得していない証拠」という警告が必ず付きます。

### PDF を証拠にする

`fetch_evidence` に PDF の URL やローカルパスを渡すと、ページ境界を保ったまま本文を抽出します。
判定は拡張子ではなく中身（先頭バイト列）で行うので、`.pdf` でない URL でも PDF なら PDF として扱います。

- 元の PDF バイト列 (`evidence/evidence_N.pdf`) と抽出テキスト (`.txt`) の両方を保存します
- `attach_evidence` は引用箇所が**何ページ目**かを台帳と `attach_evidence` の返り値に記録します
- そのページを描画し、引用箇所に枠を重ねた PNG を `attachments/` に保存します

描画は既に依存しているヘッドレスブラウザの中で pdf.js に行わせます（ネイティブ拡張も外部コマンドも
増やさないため）。枠の左右端は text item 内を文字数で按分するので、プロポーショナルフォントでは
1 文字ぶん程度ずれることがあります。テキストレイヤの無いスキャン PDF は「1 文字も抽出できなかった」
として失敗します（黙って空の証拠は作りません）。

### 本文の返し方

`fetch_evidence` が返す抽出本文は既定で先頭 12000 文字です。`text_limit`（上限 40000）で長さを、
`text_offset` で続きの位置を指定できます。切り詰めた場合は `truncated` と `next_offset` が付きます。

### 「取得成功」の判定

HTML は、記事領域（`main` / `article` / `#main` など）を選び、ナビゲーション・ヘッダ・フッタ・
cookie バナーを除いた上で、**リンクでない地の文**が 200 文字以上あることを成功の条件にします。
ページ全体の文字数で判定すると、ナビゲーションのリンク文字列だけで足切りを越えてしまい、
記事本文が 1 文字も無いページが「取得成功」として記録されるためです。足りなければヘッドレス
ブラウザで描画してから同じ規則で判定し直します。PDF とテキストには文字数の足切りを課しません
（次に試す段階が無く、短い一次資料を誤って捨てることになるため）。

## 保存先

セッションデータの保存先は環境変数 `FACT_CHECK_DIR` で指定します。未設定の場合は
**MCP サーバープロセスの作業ディレクトリ直下の `.fact-check/`** です。

1 セッション = 1 ディレクトリで、次の構成になります。

```
<FACT_CHECK_DIR>/<session_id>/
├── ledger.json          台帳（このセッションの事実の全部）
├── source.txt           元ネタ本文
├── evidence/
│   ├── evidence_1.txt   抽出した本文テキスト
│   ├── evidence_1.html  取得した HTML（あれば）
│   ├── evidence_1.pdf   取得した PDF そのもの（PDF 証拠のとき）
│   └── evidence_1.png   フルページスクリーンショット（ブラウザ取得時）
├── attachments/
│   └── attachment_1.png 引用箇所をハイライトしたスクリーンショット（PDF は該当ページの描画）
├── report.md
├── report.json          台帳を丸ごと含む（レポートと台帳の食い違いを機械的に確認できる）
└── report.html          人が読んで回るためのビューア（1 ファイル完結。下記「レポートの読み方」）
```

台帳はツール呼び出しのたびに読み直して書き戻すので、**プロセスを再起動しても `session_id` だけでセッションを
再開できます**。読み込みから書き戻しまではセッション単位で直列化してあるので、AI が複数のツール呼び出しを
1 度に送っても、後から書いた側が先の変更を消すことはありません。

台帳の形式は `version` で区別します。現在は version 2 です（version 1 の台帳は、必須になった
`discovered_via` を持たないため MCP ツールからの読み込みを拒否します）。version 1 で作った過去の
セッションを読み返したいときは `pnpm report:rebuild` を使ってください（下記「レポートの読み方」）。

## 開発

```bash
pnpm typecheck     # tsc --noEmit
pnpm lint          # biome check（混入検査は check:leaks で別に走らせる）
pnpm format        # biome の自動修正
pnpm check:leaks   # 公開物の混入検査（下記。pnpm build の後に走らせる）
pnpm test          # vitest（ユニットテスト）
pnpm e2e           # build して、子プロセスの MCP サーバーに stdio で繋いで一連の流れを通す
pnpm e2e:package   # npm pack した tarball を入れ直して、npm 経由でも動くかを見る
pnpm viewer        # セッション一覧のローカルサーバーを起動する
pnpm report:rebuild <session_dir>   # 既存セッションの report.html を今のビューアで作り直す
```

`pnpm e2e` / `pnpm e2e:package` は外部サイトには一切アクセスしません。ローカルの HTTP サーバーが配る
固定ページとローカルファイルだけを使います。

### 公開物の混入検査（`pnpm check:leaks`）

公開するのは 2 経路あります。git のコミット対象と、npm パッケージの中身です。両方を走査して、
ローカルの絶対パス・メールアドレス・実行しているマシンの利用者名が混ざっていないかを機械的に確かめます。
1 件でも見つかれば終了コード 1 で落ちます。

`pnpm lint`（biome）とは別のコマンドです。**`pnpm build` の後に走らせてください。** `dist/` が無いと
npm パッケージの中身がほとんど空になり、公開物の大部分を検査せずに 0 件で通ってしまいます。
`package.json` の `bin` が指すファイルがパッケージの一覧に無ければ、検査自体が「先に build せよ」と
言って落ちます（順序を間違えたまま通らないようにしてあります）。

本文だけを見るのではありません。

- **ファイル名そのもの**も照合します（利用者名がファイル名に入るのを防ぐため）
- 本文を読めなかったファイル（NUL を含むバイナリ）は**失敗扱い**です。中身を見ずに公開してよいと
  判断したものだけ、`FACT_CHECK_LEAK_ALLOW_BINARY` にカンマ区切りの相対パスで並べます
- パッケージの中身の**形**も見ます。`dist/src/` のような階層（`rootDir` のずれ）や `*.map`
  （ローカルの絶対パスを埋め込む）が入っていたら落とします
- 照合に**使ったパターンの id を全部出力**します。環境から作れなかったパターン（`env-user` /
  `env-home`）は使わなかった理由を出力します。「検査したつもりで実は何も見ていない」状態を
  出力だけで見分けられるようにするためです

当たった文字列は**マスクして**出します（先頭 2 文字だけを残します）。検査の出力がログに残って
二次的な漏洩になるのを避けるためです。同じ理由で、禁止語リストの置き場所は絶対パスではなく
ファイル名だけを出します。

利用者名（`$USER` / `$USERNAME` / `$LOGNAME`）は**単語として**照合します（`ab-name-cd` の一部には
当てません）。`root` や `node` のようなコンテナ・CI の汎用アカウント名は、誰のものでもないうえ普通の
コードに単語として現れるので照合に使いません（使わなかった理由が出力に出ます）。

組み込みで見るのは「形」だけです。固有の語（社名・サービス名・内部の呼び名など）を足したいときは、
**リポジトリの外**にリストを置いて環境変数で指す形にします。リポジトリの中に置くと、禁止語そのものが
公開されてしまいます。

```bash
# リストは各自のマシンに置く（1 行 1 語、# 以降はコメント）
export FACT_CHECK_LEAK_DENYLIST=~/.config/fact-check/leak-denylist.txt
pnpm build && pnpm check:leaks
```

指定しなければ、組み込みのパターンだけで走ります（その旨が出力に出ます）。

`--require-denylist` を付けると（環境変数 `FACT_CHECK_LEAK_STRICT=1` でも同じ）、外部の禁止語リストが
**未設定・読めない・語が 0 件**のときにエラーで落ちます。公開の経路（`prepublishOnly` と
`publish.yml`）はこのモードで呼びます。リストの設定を忘れたまま公開できる経路を残さないためです。

```bash
pnpm check:leaks --require-denylist   # 禁止語リストが無ければ落ちる
```

### 公開の手順

```bash
export FACT_CHECK_LEAK_DENYLIST=~/.config/fact-check/leak-denylist.txt   # 厳格モードで必要
npm pack --dry-run   # 何が入るかを確認する（dist / README.md / LICENSE / package.json だけ）
npm publish          # prepublishOnly が typecheck → lint → test → build → check:leaks --require-denylist を回す
```

`prepublishOnly` はこの 5 つを 1 回ずつ、この順で回します。混入検査はビルドの**後**に 1 回だけです。

### GitHub Actions

`.github/workflows/` に 2 つあります。

| ワークフロー | いつ動くか | 何をするか |
| --- | --- | --- |
| `ci.yml` | `main` への push と pull request | typecheck → lint → test → **build** → 混入検査（**組み込みパターンのみ**）→ e2e → e2e:package → `npm pack --dry-run` |
| `publish.yml` | `v0.1.0` のような `v*` タグの push | タグと `package.json` の version の一致を確認し、禁止語リストの secret を一時ファイルへ書き出して**厳格モードの混入検査**を通し、e2e を通してから `npm publish --provenance` |

混入検査はどちらも `pnpm build` の後に独立した step として置いてあります（ビルド前に走らせると
パッケージの中身を検査できないため）。`ci.yml` は pull request から secret に届かないので、
禁止語リストを使わず組み込みパターンだけで走ります。step 名にもそう書いてあります。固有の語まで見るのは
`publish.yml` の厳格モードです。

外部 action は commit SHA で固定してあります（タグは差し替えられるため）。pnpm の版は
`package.json` の `packageManager` が決めるので、ワークフロー側では指定しません。

`publish.yml` を使うには、リポジトリの Settings → Environments に `npm` を作り、そこに次の 2 つの
secret を登録します。

| secret | 中身 |
| --- | --- |
| `NPM_TOKEN` | npm の Granular Access Token（このパッケージへの publish 権限付き） |
| `FACT_CHECK_LEAK_DENYLIST_CONTENT` | 禁止語リストの**中身**（1 行 1 語）。ワークフローが一時ファイルへ書き出して厳格モードの検査に渡します。ログには出しません |

公開の手順は次のとおりです。

```bash
npm version patch          # package.json の version を上げてコミットとタグを作る
git push origin main --tags
```

## レポートの読み方

`finalize` はセッションディレクトリに 3 つの成果物を書きます。

| ファイル | 用途 |
| --- | --- |
| `report.html` | **人が読む**ためのビューア。ブラウザで開く |
| `report.md` | 差分を見る・引用する・別のツールに渡す |
| `report.json` | 台帳を丸ごと含む機械可読の記録（`attention` 配列付き） |

### report.html（ビューア）

`report.html` をブラウザで開くだけです（`file://` でそのまま動きます。サーバーは要りません）。
CSS も JavaScript も 1 ファイルに入っていて、外部 URL は一切読み込みません。スクリーンショットだけは
同じディレクトリからの相対パスで参照するので、**セッションディレクトリごと**渡してください。

画面は次の 3 段です。

- **上部**: 表題・元ネタの取得元・網羅率・判定ごとの件数・証拠の出どころ別の件数。
  判定の件数はボタンになっていて、クリックすると以降の表示をその判定だけに絞り込めます。
  AI が提出した証拠（`agent_captured`）があれば警告が出ます
- **要確認一覧**: `contradicted` → `partially_verified` → `unverifiable` の順。
  行をクリックすると、その主張の該当箇所と証拠に飛びます
- **左ペイン**: 元ネタ本文の全文。主張の範囲を判定色で塗り分けます。範囲が重なっていても崩れません。
  対象外 (`non_claim`) の範囲は薄く出て、hover で理由が出ます
- **右ペイン**: 選んだ主張の詳細。主張文・判定・判定の理由・種別と、証拠 1 件ごとの引用文（証拠本文内の
  位置・PDF のページ番号）・関係・根拠の説明・取得元 URL・取得方法・出どころ・取得時刻・本文 sha256、
  引用箇所をハイライトしたスクリーンショット（クリックで原寸表示）

判定は色だけでなく 1 文字の記号（**済** 裏取り済み / **部** 一部のみ / **不** 裏取り不能 / **矛** 矛盾 /
**未** 未判定）と下線の種類でも示します。色の違いが見えなくても読めます。
`j` / `k`（または `↑` `↓`）で前後の主張へ移動できます。
そのまま印刷（PDF 保存）すると、要確認一覧のあとに全主張の詳細が上から順に並びます。

### セッション一覧（`pnpm viewer`）

```bash
pnpm viewer              # 空いているポートで起動し、URL を表示する
pnpm viewer --port 8080  # ポートを指定する
```

`FACT_CHECK_DIR`（未設定なら `<cwd>/.fact-check`）配下のセッションを一覧します。表題・開始日時・
元ネタ・網羅率・判定ごとの件数が並び、`report.html` があればそこへのリンク、無ければ
「未完了（網羅率 xx%・未判定 n 件）」が出ます。台帳が読めないセッションも行は出して、理由を添えます。

待受は `127.0.0.1` だけで、配るのはセッションディレクトリ配下のファイル（`.html` / `.md` / `.json` /
`.txt` / `.png` / `.pdf`）に限ります。書き込み系の機能はありません。ブラウザは自動では開きません。

### 過去のセッションを新しいビューアで見直す（`pnpm report:rebuild`）

```bash
pnpm report:rebuild .fact-check/fc_20260101T000000_deadbeef
```

セッションディレクトリの `report.json` と `source.txt` から `report.html` だけを作り直します。
`finalize` はやり直さないので、証拠の取り直しも台帳の書き換えも起きません。

**version 1 の台帳で作られたセッションも読めます。** MCP のツールは version 1 の台帳を拒否しますが
（必須になった `discovered_via` を持たないまま裏取りを続けさせないため）、済んだ結果を読み返すだけの
この経路は受け付けます。記録が無い項目は「旧版のため未記録」と表示されます。

## 扱える範囲

- 証拠にできるのは **Web ページ**、**PDF**、**ローカルのファイル（`.txt` / `.md` / `.html` / `.pdf`）** です
- コマンド出力・別モデルによる再判定（監査）は含みません

## ライセンス

MIT License（`LICENSE`）。
