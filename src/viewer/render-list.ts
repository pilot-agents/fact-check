import { escapeHtml } from '../html/escape-html.js'
import { VERDICT_LABEL, VERDICT_MARK } from '../report/rendering/labels.js'
import type { VerdictValue } from '../session/ledger-types.js'
import type { SessionRow } from './sessions.js'

/** セッション一覧のページ。ローカルのサーバーが返す唯一の HTML。 */

const ORDER: readonly VerdictValue[] = ['contradicted', 'partially_verified', 'unverifiable', 'verified']

const STYLE = `
* { box-sizing: border-box; }
body {
  margin: 0; padding: 1.4rem 1.2rem 3rem; color: #1b1b1b; background: #fff;
  font-family: system-ui, -apple-system, 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', Meiryo, sans-serif;
  font-size: 15px; line-height: 1.7;
}
h1 { font-size: 1.3rem; margin: 0 0 .3rem; }
.note { color: #55595e; font-size: .87rem; margin: 0 0 1rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88em; word-break: break-all; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
th, td { border: 1px solid #d8dce0; padding: .45rem .6rem; text-align: left; vertical-align: top; }
th { background: #f7f8f9; white-space: nowrap; }
td.title { min-width: 14rem; }
td.origin { max-width: 26rem; word-break: break-all; color: #55595e; font-size: .85rem; }
td.when { white-space: nowrap; font-size: .85rem; color: #55595e; }
.counts { display: flex; flex-wrap: wrap; gap: .25rem; }
.count { border: 1px solid currentColor; border-radius: 4px; padding: 0 .35rem; font-size: .8rem; white-space: nowrap; }
.count.contradicted { color: #9f1f17; background: #fbe3e1; }
.count.partially_verified { color: #8a5b00; background: #fdf2d5; }
.count.unverifiable { color: #4b5157; background: #e9ecee; }
.count.verified { color: #16643c; background: #e3f2e8; }
.count.without_verdict { color: #5a5a5a; background: #f1f1f1; }
.pending { color: #8a5b00; font-size: .85rem; }
.broken { color: #9f1f17; font-size: .85rem; white-space: pre-wrap; }
.empty { color: #55595e; }
a.report { font-weight: 600; }
`

export function renderSessionList(args: { baseDir: string; rows: readonly SessionRow[] }): string {
  const parts: string[] = [
    '<!doctype html>',
    '<html lang="ja"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>ファクトチェックのセッション一覧</title>',
    `<style>${STYLE}</style></head><body>`,
    '<h1>ファクトチェックのセッション一覧</h1>',
    `<p class="note">保存先: <code>${escapeHtml(args.baseDir)}</code> — ${args.rows.length} セッション。` +
      'このページと配下のファイルは読み取り専用で配っています。</p>',
  ]
  if (args.rows.length === 0) {
    parts.push(
      '<p class="empty">セッションがまだありません。MCP の <code>start_session</code> で作られます。</p>',
    )
  } else {
    parts.push('<table><thead><tr>')
    for (const column of ['表題', '開始日時', '元ネタ', '網羅率', '判定ごとの件数', 'レポート']) {
      parts.push(`<th>${column}</th>`)
    }
    parts.push('</tr></thead><tbody>')
    for (const row of args.rows) parts.push(rowHtml(row))
    parts.push('</tbody></table>')
  }
  parts.push('</body></html>', '')
  return parts.join('\n')
}

function rowHtml(row: SessionRow): string {
  const cells: string[] = []
  cells.push(
    `<td class="title">${escapeHtml(row.title ?? '（表題なし）')}<br><code>${escapeHtml(row.id)}</code></td>`,
  )
  cells.push(`<td class="when">${escapeHtml(row.created_at ?? '—')}</td>`)
  if (row.error !== null) {
    cells.push(
      `<td class="origin" colspan="3"><span class="broken">台帳が読めない: ${escapeHtml(row.error)}</span></td>`,
    )
    cells.push(`<td>${reportCell(row)}</td>`)
    return `<tr>${cells.join('')}</tr>`
  }
  const source = row.source
  cells.push(
    `<td class="origin">${escapeHtml(source === null ? '—' : source.kind)}${
      source === null || source.origin === null ? '' : `<br>${escapeHtml(source.origin)}`
    }</td>`,
  )
  const summary = row.summary
  cells.push(
    `<td class="when">${summary === null ? '—' : escapeHtml(summary.coverage.percent)}${
      summary === null || summary.coverage.complete ? '' : ' <span class="pending">未完了</span>'
    }</td>`,
  )
  cells.push(`<td>${countsHtml(row)}</td>`)
  cells.push(`<td>${reportCell(row)}</td>`)
  return `<tr>${cells.join('')}</tr>`
}

function countsHtml(row: SessionRow): string {
  const summary = row.summary
  if (summary === null) return '—'
  const chips = ORDER.filter((value) => summary.claims[value] > 0).map(
    (value) =>
      `<span class="count ${value}">${VERDICT_MARK[value]} ${VERDICT_LABEL[value]} ${summary.claims[value]}</span>`,
  )
  if (summary.claims.without_verdict > 0) {
    chips.push(
      `<span class="count without_verdict">${VERDICT_MARK.none} ${VERDICT_LABEL.none} ${summary.claims.without_verdict}</span>`,
    )
  }
  if (chips.length === 0) return `<span class="pending">主張 ${summary.claims.total} 件</span>`
  return `<div class="counts">${chips.join('')}</div>`
}

/**
 * レポートへの導線。finalize 済みでなくても report.html があれば開けるようにする
 * （report:rebuild で作り直した過去のセッションがここに出る）。
 */
function reportCell(row: SessionRow): string {
  const link = row.finalized
    ? `<a class="report" href="/s/${encodeURIComponent(row.id)}/report.html">report.html</a>`
    : '<span class="pending">report.html はまだ無い</span>'
  const summary = row.summary
  // 台帳が読めていないときは進み具合そのものが分からないので、未完了とは書かない。
  if (summary === null) return link
  if (summary.coverage.complete && summary.claims.without_verdict === 0) return link
  return (
    `${link}<div class="pending">未完了（網羅率 ${escapeHtml(summary.coverage.percent)}` +
    `・未判定 ${summary.claims.without_verdict} 件）</div>`
  )
}
