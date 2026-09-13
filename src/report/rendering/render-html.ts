import { escapeHtml } from '../../html/escape-html.js'
import { embedJson } from './embed-json.js'
import { viewerLabels } from './labels.js'
import type { ViewerPayload } from './viewer-payload.js'
import { VIEWER_SCRIPT } from './viewer-script.js'
import { VIEWER_STYLE } from './viewer-style.js'

/**
 * report.html。人が読んで回るためのビューア。
 *
 * 台帳をそのまま並べた文書では、主張が 67 件あるセッションで「どこが問題か」「その根拠は何か」に
 * 辿り着けない。左に元ネタ本文の全文を判定色で塗り、右に選んだ主張の証拠を出す形にして、
 * 元ネタのどこがどう裏取りされたかを行き来できるようにする。
 *
 * 1 ファイルで完結させる（CSS も JS もインライン、外部 URL を一切読まない）。証拠のスクショだけは
 * セッションディレクトリからの相対パスで参照する。ディレクトリごと渡せば file:// で開ける。
 */

/** JS を切っているブラウザで白紙にしないための説明。ここだけは静的に出す。 */
const NOSCRIPT = [
  '<noscript><div class="warn"><strong>このページは JavaScript で描画します。</strong>',
  '無効になっているため表示できません。同じ内容は同じディレクトリの <code>report.md</code> と',
  '<code>report.json</code> にもあります。</div></noscript>',
].join(' ')

/**
 * 画面の器。3 領域（主張一覧 → 元ネタ本文 → 選択中の詳細）を横に並べる。
 *
 * 上部は「今どれを見ているか」を決めるものだけ（表題・件数・網羅率・判定フィルター・警告）に絞る。
 * セッション id・生成時刻・台帳 version・出どころの内訳は `<details>` の中へ入れた。初期画面の
 * 高さを管理情報で埋めると、本文と証拠が折り返しの下に沈む（改善前は本文が 950px 下から始まっていた）。
 *
 * キーボードと読み上げのために置いているもの:
 * - 先頭のスキップリンク。詳細へ行くのに一覧のボタンを全部通らせない（実測で 15 個あった）
 * - 3 領域の見出しを h2 にして `aria-labelledby` で領域に結ぶ。見出し移動で領域を渡り歩ける
 * - `#selection-live` は**選択が変わったことだけ**を読み上げる小さな領域。詳細ペイン自体を
 *   aria-live にすると、主張を 1 つ移るたびに証拠の全文が読み上げられて操作できなくなる
 * - ペイン本体に `tabindex="-1"` を付けるのはスキップリンクの飛び先にするため
 *   （リンクで飛んだ先にフォーカスが乗らないと、次の Tab が先頭に戻る）
 */
const BODY = `
<div class="wrap">
  <a class="skip-link" href="#source-body">元ネタ本文へ移動</a>
  <a class="skip-link" href="#detail-body">選択中の主張の詳細へ移動</a>
  <header class="topbar">
    <div class="topbar-main">
      <div class="title-block">
        <p class="app-title">ファクトチェック結果</p>
        <h1 id="title"></h1>
      </div>
      <div class="stats" id="stats"></div>
    </div>
    <div class="toolbar">
      <div class="chips" id="chips"></div>
      <details class="session-details">
        <summary>セッションの詳細</summary>
        <div class="session-details-body">
          <dl class="kv" id="meta"></dl>
          <div class="provenance" id="provenance"></div>
        </div>
      </details>
      <div id="exclusions"></div>
    </div>
    <div id="global-warn"></div>
  </header>
  ${NOSCRIPT}
  <div class="layout">
    <nav class="pane" id="nav-pane" aria-labelledby="nav-head-label">
      <div class="pane-head">
        <h2 id="nav-head-label">主張</h2>
        <span class="pane-head-note" id="nav-count"></span>
      </div>
      <div class="pane-body" id="nav-body"></div>
    </nav>
    <section class="pane" id="source-pane" aria-labelledby="source-head-label">
      <div class="pane-head">
        <h2 id="source-head-label">元ネタ本文</h2>
        <span class="legend" id="legend"></span>
      </div>
      <div class="pane-body" id="source-body" tabindex="-1"></div>
    </section>
    <section class="pane" id="detail-pane" aria-labelledby="detail-head-label">
      <div class="pane-head">
        <h2 id="detail-head-label">主張の詳細</h2>
        <span class="stepper">
          <button type="button" id="prev-claim" title="前の主張へ (k / ↑)">‹ 前</button>
          <span id="claim-position" class="position"></span>
          <button type="button" id="next-claim" title="次の主張へ (j / ↓)">次 ›</button>
        </span>
      </div>
      <div class="pane-body" id="detail-body" tabindex="-1"></div>
    </section>
  </div>
  <p id="selection-live" class="visually-hidden" role="status" aria-live="polite"></p>
  <div id="printAll" class="print-only"></div>
  <dialog id="lightbox" aria-label="スクリーンショットの原寸表示">
    <div class="lightbox-bar">
      <span class="lightbox-hint" id="lightbox-caption"></span>
      <button type="button" id="lightbox-close">閉じる (Esc)</button>
    </div>
    <img id="lightbox-img" alt="">
  </dialog>
</div>`

export function renderHtml(payload: ViewerPayload): string {
  const title = escapeHtml(payload.ledger.title ?? payload.ledger.session_id)
  return [
    '<!doctype html>',
    '<html lang="ja"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>ファクトチェック結果: ${title}</title>`,
    `<style>${VIEWER_STYLE}</style>`,
    '</head><body>',
    BODY,
    `<script type="application/json" id="fact-check-data">${embedJson(payload)}</script>`,
    `<script type="application/json" id="fact-check-labels">${embedJson(viewerLabels())}</script>`,
    `<script>${VIEWER_SCRIPT}</script>`,
    '</body></html>',
    '',
  ].join('\n')
}
