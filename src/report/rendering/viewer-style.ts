/**
 * report.html のスタイル。外部 CSS も Web フォントも読み込まない（file:// で開いても同じに見せるため）。
 *
 * 判定は色だけで示さない。塗りと一緒に 1 文字の記号（済・部・不・矛・未）と下線の種類を変える。
 * 色の差が見えない読み手にも、どの範囲がどの判定かが分かる必要がある。
 *
 * 画面は幅いっぱいを使う（外枠の max-width を置かない）。代わりに**本文カラムの中だけ**行長を
 * 抑える。行長の上限を外枠に置くと、広い画面で左右が余るだけで本文も証拠も狭いままになる。
 *
 * 裏取り済みの範囲に地色を敷かない。67 件の主張のうち大半が verified というのが普通の結果で、
 * 全部塗ると画面が緑一色になり、**問題のある数件が沈む**。verified は下線だけにして、
 * 矛盾・一部のみ・裏取り不能・未判定にだけ薄い地色を残す。
 */
export const VIEWER_STYLE = `
:root {
  --ink: #16181c;
  --sub: #5b6169;
  --faint: #868d96;
  --line: #dfe3e8;
  --line-soft: #edf0f3;
  --bg: #ffffff;
  --panel: #f6f7f9;
  --panel-2: #eef1f4;
  --link: #14538a;
  --focus: #1f6feb;
  --verified-ink: #17643c; --verified-bg: #eaf5ee; --verified-line: #4c9d6d;
  --partially_verified-ink: #8a5b00; --partially_verified-bg: #fdf3d9; --partially_verified-line: #d0a02a;
  --unverifiable-ink: #454b52; --unverifiable-bg: #eceef0; --unverifiable-line: #9aa2a8;
  --contradicted-ink: #9f1f17; --contradicted-bg: #fce7e5; --contradicted-line: #d2564b;
  --none-ink: #55585c; --none-bg: #f1f2f3; --none-line: #b4b4b4;
  --warn-bg: #fff6e8; --warn-line: #e0932e; --warn-ink: #8a4b00;
  --head-h: 1px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  color: var(--ink);
  background: var(--panel-2);
  font-family: system-ui, -apple-system, 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', Meiryo, sans-serif;
  font-size: 15px;
  line-height: 1.7;
}
a { color: var(--link); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .86em; word-break: break-all; }
h1 { font-size: 1.12rem; margin: 0; font-weight: 650; line-height: 1.35; }
h2 { font-size: 1.02rem; margin: 0 0 .5rem; }
h3 { font-size: 1rem; margin: .2rem 0 .6rem; }
h4 { font-size: .9rem; margin: 1.1rem 0 .4rem; color: var(--sub); }
button { font: inherit; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 4px; }

/*
 * 画面の高さは「上部の実高を引き算する」のではなく、flex に分けさせる。
 * 固定値（旧: calc(100vh - 8.5rem)）は上部の実高と必ずずれる。長い表題・警告の有無・
 * セッションの詳細の開閉で上部の高さは変わるので、実測では枠の下端が 49px 画面の外へ出ていた。
 */
.wrap { width: 100%; padding: 0; display: flex; flex-direction: column; height: 100vh; }

/* ---- 上部 ---- */
.topbar {
  flex: 0 0 auto;
  background: var(--bg); border-bottom: 1px solid var(--line);
  padding: .7rem clamp(.7rem, 1.4vw, 1.3rem) .6rem;
}
.topbar-main { display: flex; flex-wrap: wrap; align-items: baseline; gap: .35rem 1.2rem; }
.title-block { min-width: 0; flex: 1 1 24rem; }
.app-title { margin: 0; font-size: .74rem; letter-spacing: .08em; color: var(--faint); text-transform: uppercase; }
/* 長い文書タイトルで上部が潰れないよう 1 行に抑える。全文はセッションの詳細で読める。 */
#title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stats { display: flex; flex-wrap: wrap; gap: .3rem .55rem; align-items: center; }
.stat {
  display: inline-flex; align-items: baseline; gap: .3rem; white-space: nowrap;
  background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: .1rem .5rem;
  font-size: .8rem; color: var(--sub);
}
.stat b { font-size: .95rem; font-weight: 650; color: var(--ink); }
.stat.attention-stat { background: var(--partially_verified-bg); border-color: var(--partially_verified-line); color: var(--partially_verified-ink); }
.stat.attention-stat b { color: var(--partially_verified-ink); }
.stat.incomplete { background: var(--contradicted-bg); border-color: var(--contradicted-line); color: var(--contradicted-ink); }
.stat.incomplete b { color: var(--contradicted-ink); }

.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem 1rem; margin-top: .55rem; }
.chips { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; }
.chips .chips-label { color: var(--sub); font-size: .8rem; margin-right: .1rem; }
.chip {
  font-size: .82rem; cursor: pointer;
  border: 1px solid var(--line); border-radius: 999px; padding: .12rem .62rem;
  background: var(--bg); color: var(--sub); display: inline-flex; align-items: center; gap: .3rem;
}
.chip .mark { font-size: .76rem; }
.chip[aria-pressed='true'] { color: var(--ink); border-color: currentColor; }
.chip[aria-pressed='true'][data-verdict='verified'] { background: var(--verified-bg); color: var(--verified-ink); }
.chip[aria-pressed='true'][data-verdict='partially_verified'] { background: var(--partially_verified-bg); color: var(--partially_verified-ink); }
.chip[aria-pressed='true'][data-verdict='unverifiable'] { background: var(--unverifiable-bg); color: var(--unverifiable-ink); }
.chip[aria-pressed='true'][data-verdict='contradicted'] { background: var(--contradicted-bg); color: var(--contradicted-ink); }
.chip[aria-pressed='true'][data-verdict='none'] { background: var(--none-bg); color: var(--none-ink); }
.chip[aria-pressed='false'] { opacity: .5; text-decoration: line-through; }
.chip-all { border-radius: 6px; background: var(--panel); }

details.session-details { font-size: .82rem; color: var(--sub); }
details.session-details > summary { cursor: pointer; color: var(--link); padding: .1rem .2rem; border-radius: 4px; }
.session-details-body {
  margin-top: .4rem; padding: .6rem .8rem; background: var(--panel);
  border: 1px solid var(--line); border-radius: 8px;
}
.provenance { margin-top: .5rem; display: flex; flex-wrap: wrap; gap: .1rem 1.1rem; }

.warn {
  background: var(--warn-bg); border: 1px solid var(--warn-line); border-left-width: 4px;
  border-radius: 6px; padding: .5rem .7rem; margin: .55rem 0 0; font-size: .86rem;
}
.warn strong { color: var(--warn-ink); }
.warn.warn-compact { margin: .5rem 0; }

/* ---- 3 領域 ---- */
.layout {
  /* 残りの高さを全部受け取る。min-height:0 が無いと中身の高さで押し広げられて枠が画面外へ出る。 */
  flex: 1 1 auto; min-height: 0;
  display: grid;
  grid-template-columns: minmax(15rem, 19rem) minmax(0, 1.35fr) minmax(24rem, 1fr);
  gap: .55rem; align-items: stretch;
  padding: .55rem clamp(.5rem, 1.2vw, 1rem) .55rem;
}
.pane {
  border: 1px solid var(--line); border-radius: 10px; background: var(--bg);
  min-width: 0; min-height: 0; display: flex; flex-direction: column;
}
.pane > .pane-head {
  flex: 0 0 auto; background: var(--panel); border-bottom: 1px solid var(--line);
  border-radius: 10px 10px 0 0; padding: .4rem .75rem; font-size: .82rem; color: var(--sub);
  display: flex; justify-content: space-between; align-items: center; gap: .6rem; flex-wrap: wrap;
}
.pane > .pane-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: .8rem .95rem 1.1rem; }
/* 領域の見出しは h2 にした（読み上げの見出し移動で 3 領域を渡り歩けるようにするため）。
   見た目はこれまでの帯のままにしておく。 */
.pane > .pane-head > h2 { margin: 0; font-size: inherit; font-weight: 650; color: inherit; }
.pane > .pane-body:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
.pane-head-note { color: var(--faint); }
.stepper { display: inline-flex; align-items: center; gap: .3rem; }
.stepper button {
  border: 1px solid var(--line); background: var(--bg); color: var(--sub);
  border-radius: 6px; padding: .05rem .45rem; font-size: .8rem; cursor: pointer;
}
.stepper button:disabled { opacity: .4; cursor: default; }
.position { font-variant-numeric: tabular-nums; color: var(--sub); min-width: 3.4em; text-align: center; }

/* ---- 主張一覧 ---- */
#nav-body { padding: .4rem .4rem .8rem; }
.nav-item {
  display: block; width: 100%; text-align: left; cursor: pointer;
  background: var(--bg); border: 1px solid transparent; border-left: 3px solid var(--line);
  border-radius: 6px; padding: .35rem .5rem; margin-bottom: .18rem; color: inherit;
}
.nav-item:hover { background: var(--panel); }
.nav-item[aria-current='true'] { background: #e9f1fc; border-color: #bcd4f2; border-left-color: var(--focus); }
.nav-item.v-verified { border-left-color: var(--verified-line); }
.nav-item.v-partially_verified { border-left-color: var(--partially_verified-line); }
.nav-item.v-unverifiable { border-left-color: var(--unverifiable-line); }
.nav-item.v-contradicted { border-left-color: var(--contradicted-line); }
.nav-item.v-none { border-left-color: var(--none-line); }
.nav-item-top { display: flex; align-items: center; gap: .35rem; font-size: .74rem; color: var(--sub); }
.nav-num { font-variant-numeric: tabular-nums; color: var(--faint); }
.nav-item-text {
  font-size: .84rem; line-height: 1.45; margin-top: .1rem; color: var(--ink);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.nav-flag { color: var(--partially_verified-ink); font-weight: 700; }

/* ---- 元ネタ本文 ---- */
#source-body {
  white-space: pre-wrap; word-break: break-word;
  font-size: 16px; line-height: 1.85;
}
#source-body > .source-inner { max-width: 68ch; }
.seg { border-radius: 3px; padding: .04em 0; }
.seg-claim { cursor: pointer; border-bottom: 2px solid transparent; }
/* 裏取り済みは下線だけ。地色を敷くと問題のある数件が緑の海に沈む。 */
.seg-claim.v-verified { border-bottom-color: var(--verified-line); }
.seg-claim.v-partially_verified { background: var(--partially_verified-bg); border-bottom-color: var(--partially_verified-line); border-bottom-style: dashed; }
.seg-claim.v-unverifiable { background: var(--unverifiable-bg); border-bottom-color: var(--unverifiable-line); border-bottom-style: dotted; }
.seg-claim.v-contradicted { background: var(--contradicted-bg); border-bottom-color: var(--contradicted-line); border-bottom-style: double; }
.seg-claim.v-none { background: var(--none-bg); border-bottom-color: var(--none-line); border-bottom-style: dotted; }
.seg-claim.selected { background: #dcebfd; outline: 2px solid var(--focus); outline-offset: 1px; border-radius: 2px; }
.seg-claim.dim { background: transparent; border-bottom-color: transparent; opacity: .45; }
.seg-claim.dim .mark { display: none; }
.seg-nonclaim { color: #8b9096; }
.seg-gap { background: repeating-linear-gradient(135deg, #fff 0 6px, #ffe9e9 6px 12px); }
.mark {
  font-size: .62em; vertical-align: .45em; margin-left: .1em; padding: 0 .15em;
  border-radius: 2px; font-weight: 700; letter-spacing: 0;
}
.v-verified .mark, .badge.v-verified { color: var(--verified-ink); }
.v-partially_verified .mark { color: var(--partially_verified-ink); }
.v-unverifiable .mark { color: var(--unverifiable-ink); }
.v-contradicted .mark { color: var(--contradicted-ink); }
.v-none .mark { color: var(--none-ink); }
.overlap-mark { font-size: .62em; vertical-align: .45em; color: var(--focus); font-weight: 700; }
.legend { display: flex; flex-wrap: wrap; gap: .1rem .7rem; font-size: .76rem; color: var(--sub); }
.legend b { font-weight: 700; }

/* ---- 詳細 ---- */
.badge {
  display: inline-block; border-radius: 4px; padding: .03rem .42rem; font-size: .8rem;
  font-weight: 600; border: 1px solid currentColor;
}
.badge.v-verified { background: var(--verified-bg); color: var(--verified-ink); }
.badge.v-partially_verified { background: var(--partially_verified-bg); color: var(--partially_verified-ink); }
.badge.v-unverifiable { background: var(--unverifiable-bg); color: var(--unverifiable-ink); }
.badge.v-contradicted { background: var(--contradicted-bg); color: var(--contradicted-ink); }
.badge.v-none { background: var(--none-bg); color: var(--none-ink); }
.badge.rel { background: var(--panel); color: var(--sub); font-weight: 500; border-color: var(--line); }
.badge.rel-supports { background: var(--verified-bg); color: var(--verified-ink); border-color: var(--verified-line); }
.badge.rel-contradicts { background: var(--contradicted-bg); color: var(--contradicted-ink); border-color: var(--contradicted-line); }
.badge.rel-partial { background: var(--partially_verified-bg); color: var(--partially_verified-ink); border-color: var(--partially_verified-line); }

.claim-detail { max-width: 62ch; }
.detail-head { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin: 0 0 .4rem; font-size: .8rem; color: var(--sub); }
.claim-text { font-size: 1.05rem; line-height: 1.6; margin: .1rem 0 .7rem; font-weight: 650; }
.field { margin: .55rem 0; }
.field > .label { display: block; color: var(--sub); font-size: .78rem; margin-bottom: .12rem; }
.rationale { margin: 0; }
blockquote {
  margin: .15rem 0; padding: .45rem .7rem; background: var(--panel);
  border-left: 3px solid #9db4cd; white-space: pre-wrap; word-break: break-word;
}
blockquote.quote { border-left-color: #6f96c0; background: #f4f7fb; }
details.more { margin: .45rem 0; font-size: .84rem; }
details.more > summary { cursor: pointer; color: var(--link); }
details.more[open] > summary { margin-bottom: .3rem; }
.attachment { border: 1px solid var(--line); border-radius: 8px; padding: .6rem .75rem; margin: .6rem 0; background: var(--bg); }
.att-head { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; font-size: .8rem; color: var(--sub); margin-bottom: .35rem; }
.att-origin { font-size: .8rem; color: var(--sub); margin: .35rem 0 0; overflow-wrap: anywhere; }
/* 見出しを行として出す。長い URL に巻き込まれて同じ行の箱に重なるのを避ける（.field の label と同じ形）。 */
.att-origin > .label { display: block; color: var(--sub); font-size: .78rem; }
.where { color: var(--faint); font-size: .78rem; margin: .15rem 0 .45rem; }
dl.kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .1rem .7rem; margin: .4rem 0 0; font-size: .82rem; }
dl.kv dt { color: var(--sub); }
dl.kv dd { margin: 0; word-break: break-word; }
.missing { color: var(--contradicted-ink); font-size: .86rem; }
.unrecorded { color: var(--sub); }
.empty { color: var(--sub); }

/* 失敗は見出しを常時出し、保存された全文は開いて読む。1 文字も削らない。 */
details.failure { margin: .5rem 0 0; border: 1px solid var(--contradicted-line); border-radius: 6px; background: #fdf2f1; }
details.failure > summary { cursor: pointer; padding: .35rem .6rem; color: var(--contradicted-ink); font-size: .82rem; font-weight: 600; }
/*
 * 保存したエラー本文には空白の無い長い列（URL・スタックの 1 行）が入る。
 * word-break: break-word では折り返さず、pre が箱からはみ出す（実測 mobile で +337px）。
 * overflow-wrap: anywhere なら切れ目が無くても折り返す。文字は 1 つも削らない。
 */
details.failure pre, details.notice pre {
  margin: 0; padding: .5rem .6rem;
  white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal;
  font-size: .78rem; line-height: 1.55;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
details.failure pre { border-top: 1px solid var(--contradicted-line); }
details.notice { margin: .5rem 0 0; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
details.notice > summary { cursor: pointer; padding: .35rem .6rem; color: var(--sub); font-size: .82rem; }
details.notice pre { border-top: 1px solid var(--line); }

figure.shot { margin: .55rem 0 0; }
img.shot { max-width: 100%; border: 1px solid var(--line); border-radius: 6px; display: block; }
figure.shot figcaption { color: var(--sub); font-size: .76rem; margin-top: .25rem; }
.shot-actions { margin-top: .3rem; }
.shot-zoom {
  border: 1px solid var(--line); background: var(--panel); color: var(--sub);
  border-radius: 6px; padding: .1rem .55rem; font-size: .78rem; cursor: pointer;
}

/* ---- 画像の原寸表示（ブラウザ標準の dialog。Escape とフォーカス管理は標準に任せる） ---- */
#lightbox {
  border: none; border-radius: 10px; padding: 0; max-width: 96vw; max-height: 94vh;
  background: var(--bg); color: var(--ink); overflow: auto;
}
#lightbox::backdrop { background: rgba(0, 0, 0, .72); }
.lightbox-bar {
  position: sticky; top: 0; display: flex; justify-content: space-between; align-items: center;
  gap: 1rem; padding: .45rem .7rem; background: var(--panel); border-bottom: 1px solid var(--line);
}
.lightbox-hint { font-size: .8rem; color: var(--sub); }
#lightbox-close {
  border: 1px solid var(--line); background: var(--bg); color: var(--ink);
  border-radius: 6px; padding: .12rem .6rem; font-size: .82rem; cursor: pointer;
}
#lightbox img { display: block; max-width: none; background: #fff; }

/*
 * スキップリンク。Tab の 1 つ目と 2 つ目で本文・詳細へ飛べるようにする
 * （そうしないと、詳細へ行くのに一覧のボタンを全部通る）。
 * 普段は見えないが、フォーカスが乗った瞬間だけ左上に出す。display:none にはしない
 * （消すとフォーカスが当たらず、リンクとして機能しない）。
 */
.skip-link {
  position: absolute; left: .5rem; top: -3rem; z-index: 50;
  background: var(--bg); color: var(--ink); border: 1px solid var(--focus);
  border-radius: 6px; padding: .35rem .7rem; font-size: .85rem; text-decoration: none;
  transition: top .1s;
}
.skip-link:focus { top: .5rem; }

/*
 * 読み上げ専用。画面には出さないが、読み上げソフトからは読める形で残す。
 * display:none や visibility:hidden は読み上げからも消えるので使えない。
 */
.visually-hidden {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}

/* 取り消し履歴。復元済みは薄くして、今も効いている取り消しと見分ける。 */
#exclusions { width: 100%; }
.exclusion { border-left: 3px solid var(--warn-line); padding-left: .6rem; margin: .5rem 0; }
.exclusion-restored { border-left-color: var(--line); opacity: .8; }
.warn.warn-stale { border-left-width: 4px; }

.print-only { display: none; }

/* ---- 画面が狭いとき ---- */
@media (max-width: 1240px) {
  /* 一覧を上の帯にして、本文と詳細に横幅を回す。帯の高さは固定し、残りを 2 列が受け取る。 */
  .layout { grid-template-columns: minmax(0, 1fr) minmax(22rem, .9fr); grid-template-rows: 11rem minmax(0, 1fr); }
  #nav-pane { grid-column: 1 / -1; }
  #nav-body { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: .18rem; align-content: start; }
}
@media (max-width: 860px) {
  /* 狭い画面は画面の高さに詰め込まず、普通に縦へ流す。 */
  .wrap { display: block; height: auto; }
  .layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: none; padding-bottom: 2rem; }
  .pane { max-height: none; }
  #nav-pane { max-height: 13rem; }
  #nav-pane .pane-body { max-height: 10rem; }
  /* 一覧を延々スクロールしないと詳細へ行けない配置にしない: 詳細を本文より前に出す。 */
  #detail-pane { order: 2; }
  #source-pane { order: 3; }
  #source-body > .source-inner { max-width: none; }
  .claim-detail { max-width: none; }
}

@media print {
  body { font-size: 10.5pt; background: #fff; }
  /* 画面の高さに詰め込む指定を解く。紙は 1 画面ではない。 */
  .wrap { padding: 0; display: block; height: auto; }
  .chips, .layout, #lightbox, .legend, .stepper, .toolbar { display: none !important; }
  .topbar { border: none; padding: 0; }
  #title { white-space: normal; overflow: visible; }
  .print-only { display: block; }
  /* 印刷は画面の絞り込みを引き継がない。紙は「全部」が要る。 */
  .print-claim { border-top: 1px solid var(--line); padding-top: .5rem; margin-top: .8rem; }
  /*
   * 主張 1 件は紙 1 枚より高いことが多い（画像だけで 9cm × 証拠の件数）。主張ごと改ページを
   * 抑止すると、入りきらない主張が次のページへ送られて 1 ページ目が見出しだけで終わる（実測）。
   * 証拠 1 件ごとの抑止でも、カードが紙の 3/4 を占めるので毎ページ下 1/4 が空く（実測、8 ページ）。
   * 抑止は「見出しが単独で紙の末尾に残らない」「引用文・管理情報の表・画像 1 枚が途中で切れない」の
   * 単位にかけ、証拠カード自体は途中で切れてよいことにする。
   */
  #printAll h2, .print-claim .detail-head, .print-claim .claim-text, .print-claim h4 { break-after: avoid; }
  .print-claim blockquote, .print-claim dl.kv, figure.shot { break-inside: avoid; }
  .print-nonclaim { break-inside: avoid; border-top: 1px dotted var(--line); padding-top: .35rem; margin-top: .5rem; }
  .print-nonclaim h3 { font-size: 1rem; margin: 0 0 .2rem; }
  .exclusion { break-inside: avoid; }
  /* スキップリンクは紙に出さない（画面外に置いてあるだけなので、印刷では消す）。 */
  .skip-link, .visually-hidden { display: none !important; }
  /*
   * 閉じた details の中身は CSS では紙に出せない（display:block も content-visibility:visible も
   * 効かないことを実測で確認した）。印刷用の複製は最初から開いた状態で作ってあるので、
   * ここでは三角の印を消すだけにする。画面側の details には触らない。
   */
  details > summary { list-style: none; }
  details.more, details.failure, details.notice, details.session-details { break-inside: avoid; }
  img.shot { max-width: 100%; max-height: 9cm; object-fit: contain; object-position: left top; }
  .shot-actions { display: none; }
  a { color: inherit; text-decoration: none; }
}
`
