/**
 * report.html の中で動く描画コード。ブラウザにそのまま渡す JavaScript を文字列で持つ。
 *
 * 外部ファイルにしないのは、report.html が 1 ファイルで完結する（file:// で開いても、
 * セッションディレクトリを別の場所へ移しても同じに動く）という要件のため。
 *
 * 文字列の組み立てに innerHTML を使わない。元ネタも証拠も引用文も、HTML の断片を普通に含む
 * （ファクトチェックの対象がまさにそういう文章である）ので、textContent だけで組み立てて、
 * 描画側に escape 漏れが起きる余地を残さない。
 */
export const VIEWER_SCRIPT = `
(function () {
  'use strict'

  var VERDICTS = ['contradicted', 'partially_verified', 'unverifiable', 'verified', 'none']

  function readJson(id) {
    var node = document.getElementById(id)
    if (node === null) throw new Error('ビューアの埋め込みデータが見つからない (id=' + id + ')')
    return JSON.parse(node.textContent)
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild)
    return node
  }

  function byId(id) {
    var node = document.getElementById(id)
    if (node === null) throw new Error('ビューアの器が見つからない (id=' + id + ')')
    return node
  }

  var data = readJson('fact-check-data')
  var labels = readJson('fact-check-labels')
  var ledger = data.ledger
  var claimById = {}
  var attachmentsFor = {}
  var evidenceById = {}
  var nonClaimById = {}
  var i

  for (i = 0; i < ledger.claims.length; i += 1) {
    claimById[ledger.claims[i].id] = ledger.claims[i]
    attachmentsFor[ledger.claims[i].id] = []
  }
  for (i = 0; i < ledger.evidence.length; i += 1) evidenceById[ledger.evidence[i].id] = ledger.evidence[i]
  for (i = 0; i < ledger.non_claims.length; i += 1) nonClaimById[ledger.non_claims[i].id] = ledger.non_claims[i]
  for (i = 0; i < ledger.attachments.length; i += 1) {
    var attachment = ledger.attachments[i]
    if (!attachmentsFor[attachment.claim_id]) attachmentsFor[attachment.claim_id] = []
    attachmentsFor[attachment.claim_id].push(attachment)
  }

  var active = {}
  for (i = 0; i < VERDICTS.length; i += 1) active[VERDICTS[i]] = true
  var selected = null

  function verdictOf(claim) {
    return claim && claim.verdict ? claim.verdict.value : 'none'
  }

  function verdictLabel(value) {
    return (labels.verdict[value] || value) + ' (' + value + ')'
  }

  function titleText() {
    return ledger.title || ledger.session_id
  }

  function heaviest(claimIds) {
    var best = null
    for (var n = 0; n < claimIds.length; n += 1) {
      var claim = claimById[claimIds[n]]
      if (!claim) continue
      if (best === null) { best = claim; continue }
      if (VERDICTS.indexOf(verdictOf(claim)) < VERDICTS.indexOf(verdictOf(best))) best = claim
    }
    return best
  }

  /* ---- 上部（表題・集計・絞り込み） ---- */

  function renderHead() {
    document.title = 'ファクトチェック結果: ' + titleText()
    byId('title').textContent = 'ファクトチェック結果: ' + titleText()

    var meta = clear(byId('meta'))
    meta.appendChild(el('span', null, 'セッション ' + ledger.session_id))
    var origin = el('span', null, '元ネタ: ' + ledger.source.kind)
    if (ledger.source.origin) {
      origin.appendChild(document.createTextNode(' — '))
      origin.appendChild(originNode(ledger.source.origin))
    }
    meta.appendChild(origin)
    var coverage = el('span', data.summary.coverage.complete ? null : 'incomplete')
    coverage.textContent =
      '網羅率 ' + data.summary.coverage.percent +
      ' (' + data.summary.coverage.covered + '/' + data.summary.coverage.total + ' 文字)' +
      (data.summary.coverage.complete ? '' : ' — 本文に未処理の範囲が残っている')
    meta.appendChild(coverage)
    meta.appendChild(el('span', null, '主張 ' + data.summary.claims.total + ' 件 / 対象外 ' + data.summary.non_claims + ' 件 / 証拠 ' + data.summary.evidence.total + ' 件'))
    meta.appendChild(el('span', null, 'レポート生成 ' + data.generated_at))
    if (ledger.version !== undefined) meta.appendChild(el('span', null, '台帳 version ' + ledger.version))

    renderChips()
    renderProvenance()
  }

  function originNode(origin) {
    if (/^https?:/.test(origin)) {
      var link = el('a', null, origin)
      link.href = origin
      link.target = '_blank'
      link.rel = 'noreferrer noopener'
      return link
    }
    return el('span', null, origin)
  }

  function countOf(value) {
    return value === 'none' ? data.summary.claims.without_verdict : data.summary.claims[value]
  }

  function renderChips() {
    var chips = clear(byId('chips'))
    chips.appendChild(el('span', 'chips-label', '判定で絞り込む:'))
    for (var n = 0; n < VERDICTS.length; n += 1) {
      chips.appendChild(chipFor(VERDICTS[n]))
    }
    var all = el('button', 'chip chip-all', 'すべて表示')
    all.type = 'button'
    all.id = 'chip-all'
    all.addEventListener('click', function () {
      for (var k = 0; k < VERDICTS.length; k += 1) active[VERDICTS[k]] = true
      renderChips()
      renderAttention()
      renderSource()
    })
    chips.appendChild(all)
  }

  function chipFor(value) {
    var chip = el('button', 'chip')
    chip.type = 'button'
    chip.setAttribute('data-verdict', value)
    chip.setAttribute('aria-pressed', active[value] ? 'true' : 'false')
    chip.appendChild(el('span', 'mark', labels.mark[value]))
    chip.appendChild(document.createTextNode(labels.verdict[value] + ' ' + countOf(value)))
    chip.addEventListener('click', function () {
      active[value] = !active[value]
      renderChips()
      renderAttention()
      renderSource()
    })
    return chip
  }

  function renderProvenance() {
    var counts = { cited_in_source: 0, agent_search: 0, agent_knowledge: 0, unrecorded: 0 }
    for (var n = 0; n < ledger.evidence.length; n += 1) {
      var via = ledger.evidence[n].discovered_via
      if (via === null || via === undefined) counts.unrecorded += 1
      else counts[via] = (counts[via] || 0) + 1
    }
    var line = clear(byId('provenance'))
    line.appendChild(el('span', null, '証拠の出どころ:'))
    line.appendChild(el('span', null, labels.discovered_via.cited_in_source + ' ' + counts.cited_in_source + ' 件'))
    line.appendChild(el('span', null, labels.discovered_via.agent_search + ' ' + counts.agent_search + ' 件'))
    line.appendChild(el('span', null, labels.discovered_via.agent_knowledge + ' ' + counts.agent_knowledge + ' 件'))
    if (counts.unrecorded > 0) line.appendChild(el('span', 'unrecorded', labels.unrecorded + ' ' + counts.unrecorded + ' 件'))

    var warn = clear(byId('global-warn'))
    var captured = data.summary.evidence.by_provenance.agent_captured
    if (captured > 0) {
      var box = el('div', 'warn')
      box.appendChild(el('strong', null, '⚠️ AI が提出した証拠が ' + captured + ' 件あります。'))
      box.appendChild(document.createTextNode(' ' + labels.agent_captured_warning))
      warn.appendChild(box)
    }
  }

  /* ---- 要確認一覧 ---- */

  function renderAttention() {
    var note = byId('attention-note')
    var host = clear(byId('attention-list'))
    if (data.attention.length === 0) {
      note.textContent = '矛盾・一部のみ裏取り・裏取り不能と判定された主張はありません。'
      return
    }
    var shown = data.attention.filter(function (item) { return active[item.verdict] })
    note.textContent =
      'verified 以外の ' + data.attention.length + ' 件。重い順（矛盾 → 一部のみ → 裏取り不能）。' +
      (shown.length === data.attention.length ? '' : ' 絞り込み中: ' + shown.length + ' 件を表示。')
    if (shown.length === 0) {
      host.appendChild(el('p', 'empty', '絞り込みで表示できる行がありません。'))
      return
    }
    var table = el('table', 'attention')
    var head = el('tr')
    var columns = ['判定', '主張', '元ネタの該当文', '判定の理由']
    for (var c = 0; c < columns.length; c += 1) head.appendChild(el('th', null, columns[c]))
    table.appendChild(el('thead')).appendChild(head)
    var body = el('tbody')
    for (var n = 0; n < shown.length; n += 1) body.appendChild(attentionRow(shown[n]))
    table.appendChild(body)
    host.appendChild(table)
  }

  function attentionRow(item) {
    var row = el('tr', 'attention-row')
    row.setAttribute('data-claim', item.claim_id)
    var verdictCell = el('td')
    verdictCell.appendChild(badge(item.verdict, true))
    row.appendChild(verdictCell)
    row.appendChild(el('td', 'col-id', item.claim_id))
    row.appendChild(el('td', 'col-src', item.source_text))
    row.appendChild(el('td', null, item.rationale))
    row.addEventListener('click', function () { selectClaim(item.claim_id, 'attention') })
    return row
  }

  function badge(value, short) {
    var node = el('span', 'badge v-' + value)
    node.appendChild(el('span', 'mark', labels.mark[value]))
    node.appendChild(document.createTextNode(' ' + (short ? labels.verdict[value] : verdictLabel(value))))
    node.title = verdictLabel(value)
    return node
  }

  /* ---- 左ペイン: 元ネタ本文 ---- */

  function renderSource() {
    var host = clear(byId('source-body'))
    var text = data.source_text
    for (var n = 0; n < data.spans.length; n += 1) {
      host.appendChild(spanNode(data.spans[n], text.slice(data.spans[n].start, data.spans[n].end)))
    }
    renderLegend()
    markSelection()
  }

  function spanNode(span, text) {
    if (span.claim_ids.length > 0) return claimSpan(span, text)
    if (span.non_claim_ids.length > 0) {
      var reasons = []
      for (var n = 0; n < span.non_claim_ids.length; n += 1) {
        var nonClaim = nonClaimById[span.non_claim_ids[n]]
        reasons.push(span.non_claim_ids[n] + ': ' + (nonClaim ? nonClaim.reason : '理由の記録なし'))
      }
      var skipped = el('span', 'seg seg-nonclaim', text)
      skipped.title = '対象外 — ' + reasons.join(' / ')
      return skipped
    }
    var gap = el('span', 'seg seg-gap', text)
    gap.title = 'どの主張にも対象外にも入っていない範囲（網羅率に数えられていない）'
    return gap
  }

  function claimSpan(span, text) {
    var primary = heaviest(span.claim_ids)
    if (primary === null) {
      var orphan = el('span', 'seg seg-gap', text)
      orphan.title = '台帳に無い主張 id が範囲に付いている: ' + span.claim_ids.join(', ')
      return orphan
    }
    var value = verdictOf(primary)
    var node = el('span', 'seg seg-claim v-' + value)
    node.setAttribute('data-claim', primary.id)
    node.setAttribute('data-verdict', value)
    node.appendChild(document.createTextNode(text))
    if (!active[value]) node.className += ' dim'
    var titleLines = []
    for (var n = 0; n < span.claim_ids.length; n += 1) {
      var claim = claimById[span.claim_ids[n]]
      if (!claim) continue
      titleLines.push(claim.id + ' [' + verdictLabel(verdictOf(claim)) + '] ' + claim.claim)
    }
    if (span.non_claim_ids.length > 0) titleLines.push('対象外の範囲と重なっている: ' + span.non_claim_ids.join(', '))
    node.title = titleLines.join('\\n')
    if (span.start === primary.start) node.insertBefore(el('span', 'mark', labels.mark[value]), node.firstChild)
    if (span.claim_ids.length > 1) node.appendChild(el('span', 'overlap-mark', '+' + (span.claim_ids.length - 1)))
    node.addEventListener('click', function () { selectClaim(primary.id, 'source') })
    return node
  }

  function renderLegend() {
    var legend = clear(byId('legend'))
    for (var n = 0; n < VERDICTS.length; n += 1) {
      var item = el('span', 'v-' + VERDICTS[n])
      item.appendChild(el('b', 'mark', labels.mark[VERDICTS[n]]))
      item.appendChild(document.createTextNode(' ' + labels.verdict[VERDICTS[n]]))
      legend.appendChild(item)
    }
    legend.appendChild(el('span', 'seg-nonclaim', '灰色の文字 = 対象外'))
  }

  /* ---- 右ペイン: 主張の詳細 ---- */

  function selectClaim(id, from) {
    if (!claimById[id]) return
    selected = id
    renderDetail()
    markSelection()
    if (from !== 'source') scrollSourceTo(id)
    byId('detail-body').scrollTop = 0
  }

  function markSelection() {
    var segments = document.querySelectorAll('#source-body .seg-claim')
    for (var n = 0; n < segments.length; n += 1) {
      var isSelected = segments[n].getAttribute('data-claim') === selected
      segments[n].classList.toggle('selected', isSelected)
    }
    var rows = document.querySelectorAll('.attention-row')
    for (var r = 0; r < rows.length; r += 1) {
      rows[r].classList.toggle('selected', rows[r].getAttribute('data-claim') === selected)
    }
  }

  function scrollSourceTo(id) {
    var body = byId('source-body')
    var target = body.querySelector('.seg-claim[data-claim="' + id + '"]')
    if (!target) return
    body.scrollTop = Math.max(0, target.offsetTop - body.clientHeight / 3)
  }

  function renderDetail() {
    var host = clear(byId('detail-body'))
    if (selected === null) {
      host.appendChild(el('p', 'empty', '左の本文で色が付いた部分か、上の要確認一覧の行をクリックすると、その主張の詳細がここに出ます。'))
      return
    }
    byId('detail-head-label').textContent = '主張の詳細 — ' + selected
    host.appendChild(claimDetail(claimById[selected]))
  }

  function claimDetail(claim) {
    var value = verdictOf(claim)
    var article = el('article', 'claim-detail v-' + value)
    article.setAttribute('data-claim', claim.id)

    var head = el('div', 'detail-head')
    head.appendChild(badge(value))
    head.appendChild(el('span', null, claim.id))
    head.appendChild(el('span', null, '元ネタの [' + claim.start + ', ' + claim.end + ')'))
    if (claim.kind) head.appendChild(el('span', null, '種別: ' + claim.kind))
    article.appendChild(head)

    article.appendChild(el('h3', 'claim-text', claim.claim))
    article.appendChild(field('元ネタの該当文', quote(claim.source_text)))
    article.appendChild(field('判定の理由', el('p', null, claim.verdict ? claim.verdict.rationale : 'まだ判定が付いていない')))

    var attachments = attachmentsFor[claim.id] || []
    article.appendChild(el('h4', null, '証拠 ' + attachments.length + ' 件'))
    if (attachments.length === 0) {
      article.appendChild(el('p', 'missing', '紐づいた証拠なし'))
      return article
    }
    for (var n = 0; n < attachments.length; n += 1) article.appendChild(attachmentNode(attachments[n]))
    return article
  }

  function field(label, contentNode) {
    var wrap = el('div', 'field')
    wrap.appendChild(el('span', 'label', label))
    wrap.appendChild(contentNode)
    return wrap
  }

  function quote(text) {
    return el('blockquote', null, text)
  }

  function attachmentNode(attachment) {
    var evidence = evidenceById[attachment.evidence_id]
    var section = el('section', 'attachment')
    section.setAttribute('data-attachment', attachment.id)

    var head = el('div', 'att-head')
    head.appendChild(el('span', 'badge rel', (labels.relation[attachment.relation] || attachment.relation) + ' (' + attachment.relation + ')'))
    head.appendChild(el('span', null, attachment.id + ' → ' + attachment.evidence_id))
    section.appendChild(head)

    var quoteNode = el('blockquote', 'quote', attachment.quote)
    section.appendChild(quoteNode)
    var where = '証拠本文の [' + attachment.match.start + ', ' + attachment.match.end + ') に実在'
    if (attachment.pdf_page !== null && attachment.pdf_page !== undefined) where += ' ・ PDF ' + attachment.pdf_page + ' ページ目'
    section.appendChild(el('div', 'where', where))
    section.appendChild(field('根拠の説明', el('p', null, attachment.rationale)))

    if (!evidence) {
      section.appendChild(el('p', 'missing', '証拠 ' + attachment.evidence_id + ' が台帳に無い'))
    } else {
      section.appendChild(evidenceMeta(evidence))
      if (evidence.provenance === 'agent_captured') {
        var warn = el('div', 'warn')
        warn.appendChild(el('strong', null, '⚠️ AI が提出した証拠です。'))
        warn.appendChild(document.createTextNode(' ' + labels.agent_captured_warning))
        section.appendChild(warn)
      }
    }
    section.appendChild(screenshotNode(attachment))
    return section
  }

  function evidenceMeta(evidence) {
    var list = el('dl', 'kv')
    var origin = evidence.source.type === 'url' ? evidence.source.url : evidence.source.path
    list.appendChild(el('dt', null, '取得元'))
    list.appendChild(el('dd')).appendChild(originNode(origin))
    list.appendChild(el('dt', null, '取得方法'))
    list.appendChild(el('dd', null, labels.provenance[evidence.provenance] || evidence.provenance))
    list.appendChild(el('dt', null, '出どころ'))
    list.appendChild(el('dd', evidence.discovered_via ? null : 'unrecorded', discoveryText(evidence)))
    list.appendChild(el('dt', null, '取得時刻'))
    list.appendChild(el('dd', null, evidence.fetched_at))
    list.appendChild(el('dt', null, '本文 sha256'))
    list.appendChild(el('dd')).appendChild(el('code', null, evidence.text_sha256))
    if (evidence.note) {
      list.appendChild(el('dt', null, 'AI の説明'))
      list.appendChild(el('dd', null, evidence.note))
    }
    return list
  }

  function discoveryText(evidence) {
    if (!evidence.discovered_via) return labels.unrecorded
    var text = labels.discovered_via[evidence.discovered_via] || evidence.discovered_via
    return evidence.discovery_note ? text + ' — ' + evidence.discovery_note : text
  }

  function screenshotNode(attachment) {
    if (!attachment.screenshot_path) {
      return el('p', 'missing', 'スクリーンショットなし — ' + (attachment.screenshot_note || '理由の記録なし'))
    }
    var figure = el('figure', 'shot')
    var image = el('img', 'shot')
    image.src = attachment.screenshot_path
    image.loading = 'lazy'
    image.alt = attachment.id + ' の引用箇所をハイライトしたスクリーンショット'
    image.addEventListener('click', function () { openLightbox(image.src, image.alt) })
    figure.appendChild(image)
    figure.appendChild(el('figcaption', null, 'クリックで原寸表示' + (attachment.screenshot_note ? ' — ' + attachment.screenshot_note : '')))
    return figure
  }

  /* ---- 原寸表示 ---- */

  function openLightbox(src, alt) {
    var box = byId('lightbox')
    var image = byId('lightbox-img')
    image.src = src
    image.alt = alt
    box.hidden = false
  }

  function closeLightbox() {
    byId('lightbox').hidden = true
  }

  /* ---- 印刷用（要確認一覧のあとに全主張の詳細を並べる） ---- */

  function renderPrintAll() {
    var host = clear(byId('printAll'))
    host.appendChild(el('h2', null, '主張ごとの判定（全 ' + ledger.claims.length + ' 件）'))
    for (var n = 0; n < ledger.claims.length; n += 1) {
      var block = el('div', 'print-claim')
      block.appendChild(claimDetail(ledger.claims[n]))
      host.appendChild(block)
    }
  }

  /* ---- キーボード ---- */

  function visibleClaimIds() {
    var ids = []
    for (var n = 0; n < ledger.claims.length; n += 1) {
      if (active[verdictOf(ledger.claims[n])]) ids.push(ledger.claims[n].id)
    }
    return ids
  }

  function moveSelection(delta) {
    var ids = visibleClaimIds()
    if (ids.length === 0) return
    var index = selected === null ? -1 : ids.indexOf(selected)
    if (index === -1) {
      selectClaim(delta > 0 ? ids[0] : ids[ids.length - 1], 'keyboard')
      return
    }
    var next = Math.min(ids.length - 1, Math.max(0, index + delta))
    selectClaim(ids[next], 'keyboard')
  }

  document.addEventListener('keydown', function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'Escape') { closeLightbox(); return }
    var delta = 0
    if (event.key === 'j' || event.key === 'ArrowDown') delta = 1
    if (event.key === 'k' || event.key === 'ArrowUp') delta = -1
    if (delta === 0) return
    event.preventDefault()
    moveSelection(delta)
  })

  byId('lightbox').addEventListener('click', closeLightbox)

  renderHead()
  renderAttention()
  renderSource()
  renderDetail()
  renderPrintAll()
  if (data.attention.length > 0) selectClaim(data.attention[0].claim_id, 'init')
  else if (ledger.claims.length > 0) selectClaim(ledger.claims[0].id, 'init')
})()
`
