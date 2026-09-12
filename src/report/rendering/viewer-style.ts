/**
 * report.html のスタイル。外部 CSS も Web フォントも読み込まない（file:// で開いても同じに見せるため）。
 *
 * 判定は色だけで示さない。塗りと一緒に 1 文字の記号（済・部・不・矛・未）と下線の種類を変える。
 * 色の差が見えない読み手にも、どの範囲がどの判定かが分かる必要がある。
 */
export const VIEWER_STYLE = `
:root {
  --ink: #1b1b1b;
  --sub: #55595e;
  --line: #d8dce0;
  --bg: #ffffff;
  --panel: #f7f8f9;
  --link: #14538a;
  --verified-ink: #16643c; --verified-bg: #e3f2e8; --verified-line: #4c9d6d;
  --partially_verified-ink: #8a5b00; --partially_verified-bg: #fdf2d5; --partially_verified-line: #d0a02a;
  --unverifiable-ink: #4b5157; --unverifiable-bg: #e9ecee; --unverifiable-line: #9aa2a8;
  --contradicted-ink: #9f1f17; --contradicted-bg: #fbe3e1; --contradicted-line: #d2564b;
  --none-ink: #5a5a5a; --none-bg: #f1f1f1; --none-line: #b4b4b4;
  --warn-bg: #fff3e0; --warn-line: #e08a2e;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  color: var(--ink);
  background: var(--bg);
  font-family: system-ui, -apple-system, 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', Meiryo, sans-serif;
  font-size: 15px;
  line-height: 1.7;
}
a { color: var(--link); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88em; word-break: break-all; }
h1 { font-size: 1.35rem; margin: 0 0 .4rem; }
h2 { font-size: 1.05rem; margin: 0 0 .5rem; }
h3 { font-size: 1rem; margin: .2rem 0 .6rem; }
h4 { font-size: .92rem; margin: 1.2rem 0 .4rem; color: var(--sub); }

.wrap { max-width: 1600px; margin: 0 auto; padding: 1rem 1.2rem 3rem; }
.topbar { border-bottom: 1px solid var(--line); padding-bottom: .8rem; margin-bottom: 1rem; }
.meta { display: flex; flex-wrap: wrap; gap: .3rem 1.4rem; color: var(--sub); font-size: .87rem; margin: 0 0 .6rem; }
.meta span.strong { color: var(--ink); font-weight: 600; }
.meta .incomplete { color: var(--contradicted-ink); font-weight: 600; }

.chips { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin: .5rem 0 .2rem; }
.chips .chips-label { color: var(--sub); font-size: .85rem; margin-right: .2rem; }
.chip {
  font: inherit; font-size: .85rem; cursor: pointer;
  border: 1px solid var(--line); border-radius: 999px; padding: .18rem .7rem;
  background: var(--panel); color: var(--sub); display: inline-flex; align-items: center; gap: .35rem;
}
.chip .mark { font-size: .78rem; }
.chip[aria-pressed='true'] { color: var(--ink); border-color: currentColor; }
.chip[aria-pressed='true'][data-verdict='verified'] { background: var(--verified-bg); color: var(--verified-ink); }
.chip[aria-pressed='true'][data-verdict='partially_verified'] { background: var(--partially_verified-bg); color: var(--partially_verified-ink); }
.chip[aria-pressed='true'][data-verdict='unverifiable'] { background: var(--unverifiable-bg); color: var(--unverifiable-ink); }
.chip[aria-pressed='true'][data-verdict='contradicted'] { background: var(--contradicted-bg); color: var(--contradicted-ink); }
.chip[aria-pressed='true'][data-verdict='none'] { background: var(--none-bg); color: var(--none-ink); }
.chip[aria-pressed='false'] { opacity: .55; text-decoration: line-through; }
.chip-all { border-radius: 6px; }

.provenance { color: var(--sub); font-size: .85rem; margin-top: .5rem; display: flex; flex-wrap: wrap; gap: .2rem 1.2rem; }

.warn {
  background: var(--warn-bg); border: 1px solid var(--warn-line); border-left-width: 5px;
  border-radius: 6px; padding: .6rem .8rem; margin: .7rem 0; font-size: .9rem;
}
.warn strong { color: #8a4b00; }

.attention-wrap { margin-bottom: 1.1rem; }
#attention-list { max-height: 45vh; overflow: auto; border-radius: 6px; }
.attention-note { color: var(--sub); font-size: .87rem; margin: 0 0 .5rem; }
table.attention { border-collapse: collapse; width: 100%; font-size: .9rem; }
table.attention th, table.attention td { border: 1px solid var(--line); padding: .4rem .6rem; text-align: left; vertical-align: top; }
table.attention th { background: var(--panel); font-weight: 600; white-space: nowrap; }
table.attention tr.attention-row { cursor: pointer; }
table.attention tr.attention-row:hover td { background: #f2f6fb; }
table.attention tr.attention-row.selected td { background: #e8f0fa; }
table.attention td.col-id { white-space: nowrap; font-size: .85rem; }
table.attention td .badge { white-space: nowrap; }
table.attention td.col-src { width: 38%; }

.layout { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 1rem; align-items: start; }
@media (max-width: 980px) { .layout { grid-template-columns: minmax(0, 1fr); } }
.pane { border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
.pane > .pane-head {
  position: sticky; top: 0; z-index: 2; background: var(--panel);
  border-bottom: 1px solid var(--line); border-radius: 8px 8px 0 0;
  padding: .45rem .8rem; font-size: .85rem; color: var(--sub);
  display: flex; justify-content: space-between; gap: .8rem; flex-wrap: wrap;
}
.pane > .pane-body { position: relative; padding: .9rem 1rem 1.2rem; max-height: calc(100vh - 4rem); overflow: auto; }
@media (max-width: 980px) { .pane > .pane-body { max-height: none; } }

#source-pane .pane-body { white-space: pre-wrap; word-break: break-word; line-height: 2.05; font-size: 15px; }
.seg { border-radius: 3px; padding: .06em 0; }
.seg-claim { cursor: pointer; border-bottom: 2px solid transparent; }
.seg-claim.v-verified { background: var(--verified-bg); border-bottom-color: var(--verified-line); }
.seg-claim.v-partially_verified { background: var(--partially_verified-bg); border-bottom-color: var(--partially_verified-line); border-bottom-style: dashed; }
.seg-claim.v-unverifiable { background: var(--unverifiable-bg); border-bottom-color: var(--unverifiable-line); border-bottom-style: dotted; }
.seg-claim.v-contradicted { background: var(--contradicted-bg); border-bottom-color: var(--contradicted-line); border-bottom-style: double; }
.seg-claim.v-none { background: var(--none-bg); border-bottom-color: var(--none-line); border-bottom-style: dotted; }
.seg-claim.selected { outline: 2px solid #1f6feb; outline-offset: 1px; }
.seg-claim.dim { background: transparent; border-bottom-color: transparent; opacity: .55; }
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
.overlap-mark { font-size: .62em; vertical-align: .45em; color: #1f6feb; font-weight: 700; }

.legend { display: flex; flex-wrap: wrap; gap: .2rem .8rem; font-size: .8rem; color: var(--sub); }
.legend b { font-weight: 700; }

.badge {
  display: inline-block; border-radius: 4px; padding: .05rem .45rem; font-size: .82rem;
  font-weight: 600; border: 1px solid currentColor;
}
.badge.v-verified { background: var(--verified-bg); color: var(--verified-ink); }
.badge.v-partially_verified { background: var(--partially_verified-bg); color: var(--partially_verified-ink); }
.badge.v-unverifiable { background: var(--unverifiable-bg); color: var(--unverifiable-ink); }
.badge.v-contradicted { background: var(--contradicted-bg); color: var(--contradicted-ink); }
.badge.v-none { background: var(--none-bg); color: var(--none-ink); }
.badge.rel { background: var(--panel); color: var(--sub); font-weight: 500; }

.claim-detail { border-top: 3px solid transparent; }
.claim-detail.v-verified { border-top-color: var(--verified-line); }
.claim-detail.v-partially_verified { border-top-color: var(--partially_verified-line); }
.claim-detail.v-unverifiable { border-top-color: var(--unverifiable-line); }
.claim-detail.v-contradicted { border-top-color: var(--contradicted-line); }
.claim-detail.v-none { border-top-color: var(--none-line); }
.detail-head { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: .6rem 0 .5rem; font-size: .85rem; color: var(--sub); }
.claim-text { font-size: 1.02rem; line-height: 1.6; margin: .2rem 0 .8rem; }
.field { margin: .6rem 0; }
.field > .label { display: block; color: var(--sub); font-size: .8rem; margin-bottom: .15rem; }
blockquote {
  margin: .2rem 0; padding: .45rem .75rem; background: var(--panel);
  border-left: 4px solid #9db4cd; white-space: pre-wrap; word-break: break-word;
}
blockquote.quote { border-left-color: #6f96c0; }
.attachment { border: 1px solid var(--line); border-radius: 8px; padding: .7rem .85rem; margin: .7rem 0; }
.att-head { display: flex; flex-wrap: wrap; gap: .45rem; align-items: center; font-size: .85rem; color: var(--sub); margin-bottom: .4rem; }
.where { color: var(--sub); font-size: .8rem; margin: .2rem 0 .5rem; }
dl.kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .15rem .8rem; margin: .5rem 0 0; font-size: .85rem; }
dl.kv dt { color: var(--sub); }
dl.kv dd { margin: 0; word-break: break-word; }
.missing { color: var(--contradicted-ink); font-size: .88rem; }
.unrecorded { color: var(--sub); font-style: normal; }
figure.shot { margin: .6rem 0 0; }
img.shot { max-width: 100%; border: 1px solid var(--line); border-radius: 6px; display: block; cursor: zoom-in; }
figure.shot figcaption { color: var(--sub); font-size: .78rem; margin-top: .2rem; }
.empty { color: var(--sub); }

#lightbox {
  position: fixed; inset: 0; background: rgba(0,0,0,.8); z-index: 50;
  display: flex; align-items: center; justify-content: center; padding: 1rem; overflow: auto; cursor: zoom-out;
}
#lightbox[hidden] { display: none; }
#lightbox img { background: #fff; max-width: none; }
#lightbox .lightbox-hint { position: fixed; top: .6rem; left: .8rem; color: #fff; font-size: .85rem; }

.print-only { display: none; }

@media print {
  body { font-size: 10.5pt; }
  .wrap { max-width: none; padding: 0; }
  .chips, .layout, #lightbox, .legend, .keyhint { display: none !important; }
  .print-only { display: block; }
  .print-claim { break-inside: avoid; border-top: 1px solid var(--line); padding-top: .5rem; margin-top: .8rem; }
  table.attention { font-size: 9.5pt; }
  #attention-list { max-height: none; overflow: visible; }
  .attachment { break-inside: avoid; }
  img.shot { max-width: 100%; max-height: 9cm; object-fit: contain; object-position: left top; }
  a { color: inherit; text-decoration: none; }
}
.keyhint { color: var(--sub); font-size: .8rem; }
`
