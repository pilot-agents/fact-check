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

const BODY = `
<div class="wrap">
  <header class="topbar">
    <h1 id="title"></h1>
    <div class="meta" id="meta"></div>
    <div class="chips" id="chips"></div>
    <div class="provenance" id="provenance"></div>
    <div id="global-warn"></div>
  </header>
  ${NOSCRIPT}
  <section class="attention-wrap">
    <h2>要確認一覧</h2>
    <p class="attention-note" id="attention-note"></p>
    <div id="attention-list"></div>
  </section>
  <div class="layout">
    <section class="pane" id="source-pane">
      <div class="pane-head"><span>元ネタ本文</span><span class="legend" id="legend"></span></div>
      <div class="pane-body" id="source-body"></div>
    </section>
    <section class="pane" id="detail-pane">
      <div class="pane-head">
        <span id="detail-head-label">主張の詳細</span>
        <span class="keyhint">j / k または ↑ ↓ で前後の主張へ</span>
      </div>
      <div class="pane-body" id="detail-body"></div>
    </section>
  </div>
  <div id="printAll" class="print-only"></div>
  <div id="lightbox" hidden>
    <span class="lightbox-hint">クリックまたは Esc で閉じる</span>
    <img id="lightbox-img" alt="">
  </div>
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
