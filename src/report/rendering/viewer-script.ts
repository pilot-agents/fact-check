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
  var exclusions = ledger.exclusions || []
  var claimById = {}
  var attachmentsFor = {}
  var evidenceById = {}
  var nonClaimById = {}
  var i

  /**
   * 「今も有効か」の**規則はここには無い**。サーバー側 (ledger-effective.ts) が導いた
   * id の集合を受け取って、その通りに絞るだけ。同じ規則を 2 つの言語で書くと、
   * 片方だけ直したときに画面と集計が静かに食い違う。
   */
  function idSet(ids) {
    var set = {}
    for (var n = 0; n < ids.length; n += 1) set[ids[n]] = true
    return set
  }

  function keepEffective(records, ids) {
    var kept = []
    for (var n = 0; n < records.length; n += 1) {
      if (ids[records[n].id] === true) kept.push(records[n])
    }
    return kept
  }

  var effectiveClaimIds = idSet(data.effective.claims)
  var effectiveNonClaimIds = idSet(data.effective.non_claims)
  var effectiveAttachmentIds = idSet(data.effective.attachments)

  var claims = keepEffective(ledger.claims, effectiveClaimIds)
  var nonClaims = keepEffective(ledger.non_claims, effectiveNonClaimIds)

  for (i = 0; i < claims.length; i += 1) {
    claimById[claims[i].id] = claims[i]
    attachmentsFor[claims[i].id] = []
  }
  // 証拠は取り消されたものも引けるようにしておく（取り消し履歴が中身を出すため）。
  for (i = 0; i < ledger.evidence.length; i += 1) evidenceById[ledger.evidence[i].id] = ledger.evidence[i]
  for (i = 0; i < nonClaims.length; i += 1) nonClaimById[nonClaims[i].id] = nonClaims[i]
  for (i = 0; i < ledger.attachments.length; i += 1) {
    var attachment = ledger.attachments[i]
    if (effectiveAttachmentIds[attachment.id] !== true) continue
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

  /** 本文の順で数えた「何件目の主張か」。画面に出す番号は一覧・見出しでこれに揃える。 */
  function claimNumber(id) {
    for (var n = 0; n < claims.length; n += 1) {
      if (claims[n].id === id) return n + 1
    }
    return 0
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

  /**
   * 上部は「今どれを見るか」を決めるものだけに絞る。表題・件数・網羅率・判定フィルター・警告。
   * id / 時刻 / version / 出どころの内訳・長い元タイトルの全文は details の中へ入れる
   * （初期画面を管理情報で埋めると、本文と証拠が折り返しの下に沈む）。
   */
  function renderHead() {
    document.title = 'ファクトチェック結果: ' + titleText()
    var heading = byId('title')
    heading.textContent = titleText()
    heading.title = titleText()

    renderStats()

    var meta = clear(byId('meta'))
    kv(meta, '表題', el('span', null, titleText()))
    kv(meta, 'セッション', el('code', null, ledger.session_id))
    var origin = el('span', null, ledger.source.kind)
    if (ledger.source.origin) {
      origin.appendChild(document.createTextNode(' — '))
      origin.appendChild(originNode(ledger.source.origin))
    }
    kv(meta, '元ネタ', origin)
    kv(meta, '本文の長さ', el('span', null, ledger.source.length + ' 文字'))
    kv(meta, 'レポート生成', el('span', null, data.generated_at))
    if (ledger.version !== undefined) kv(meta, '台帳 version', el('span', null, String(ledger.version)))

    renderChips()
    renderProvenance()
  }

  function kv(list, label, valueNode) {
    list.appendChild(el('dt', null, label))
    var dd = el('dd')
    dd.appendChild(valueNode)
    list.appendChild(dd)
    return list
  }

  function stat(label, value, cls) {
    var node = el('span', cls ? 'stat ' + cls : 'stat')
    node.appendChild(el('b', null, String(value)))
    node.appendChild(document.createTextNode(label))
    return node
  }

  function renderStats() {
    var host = clear(byId('stats'))
    host.appendChild(stat('主張', data.summary.claims.total))
    if (data.attention.length > 0) {
      host.appendChild(stat('要確認', data.attention.length, 'attention-stat'))
    }
    host.appendChild(stat('証拠', data.summary.evidence.total))
    var coverage = stat('網羅率', data.summary.coverage.percent, data.summary.coverage.complete ? null : 'incomplete')
    coverage.title =
      data.summary.coverage.covered + '/' + data.summary.coverage.total + ' 文字' +
      (data.summary.coverage.complete ? '' : ' — 本文に未処理の範囲が残っている')
    host.appendChild(coverage)
    if (!data.summary.coverage.complete) {
      host.appendChild(stat('未処理の範囲あり', '', 'incomplete'))
    }
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
      afterFilterChange()
    })
    chips.appendChild(all)
  }

  /**
   * 絞り込みが変わった後の再描画。**選択の再解決をここ 1 箇所に置く**。
   * 描き直す側と選択を持つ側が別々に判断すると、絞り込みで消えた主張の詳細が右に残り続ける。
   */
  function afterFilterChange() {
    renderChips()
    renderNav()
    renderSource()
    var ids = visibleClaimIds()
    // 不変条件: 表示できる主張が 1 件でもあれば、必ずそのどれかが選ばれている。
    // これを保たないと、一度絞り込みを空にしたあと戻しても詳細が空のまま戻らない。
    if (ids.length === 0) {
      selected = null
    } else if (selected === null || ids.indexOf(selected) === -1) {
      selectClaim(ids[0], 'filter')
      return
    }
    renderDetail()
    markSelection()
    renderStepper()
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
      afterFilterChange()
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
    // 台帳より古いレポートを「最新の結果」と読ませない。一番上に出す。
    if (ledger.reports_stale_since) {
      var stale = el('div', 'warn warn-stale')
      stale.appendChild(el('strong', null, '⚠️ finalize を通していない暫定表示です。'))
      stale.appendChild(document.createTextNode(' ' + labels.stale_report_warning))
      stale.appendChild(el('div', 'where', '台帳が変わった時刻: ' + ledger.reports_stale_since))
      warn.appendChild(stale)
    }
    var captured = data.summary.evidence.by_provenance.agent_captured
    if (captured > 0) {
      var box = el('div', 'warn')
      box.appendChild(el('strong', null, '⚠️ AI が提出した証拠が ' + captured + ' 件あります。'))
      box.appendChild(document.createTextNode(' ' + labels.agent_captured_warning))
      warn.appendChild(box)
    }
    renderExclusions()
  }

  /* ---- 取り消し履歴 ---- */

  /**
   * 取り消しの履歴。**取り消したものを一覧から外すだけにしない。**
   * 外して終わりだと、誤登録があったこと自体が画面から消えて追えなくなる。
   * 常時出す帯は件数だけにして、全件は details の中に置く（畳んでいても紙には全部出る）。
   */
  function renderExclusions() {
    var host = clear(byId('exclusions'))
    if (exclusions.length === 0) return
    var live = 0
    for (var n = 0; n < exclusions.length; n += 1) if (!exclusions[n].restored) live += 1
    var box = el('details', 'session-details')
    box.appendChild(
      el(
        'summary',
        null,
        '取り消し履歴 — 取り消し中 ' + live + ' 件 / 履歴 ' + exclusions.length + ' 件',
      ),
    )
    var body = el('div', 'session-details-body')
    body.appendChild(
      el('p', 'where', '取り消しても元の記録と取得済みのファイル（本文・HTML・PDF・画像）は消えていない。'),
    )
    for (var k = 0; k < exclusions.length; k += 1) body.appendChild(exclusionNode(exclusions[k]))
    box.appendChild(body)
    host.appendChild(box)
  }

  function exclusionNode(exclusion) {
    var section = el('section', 'exclusion' + (exclusion.restored ? ' exclusion-restored' : ''))
    var head = el('div', 'att-head')
    head.appendChild(el('span', 'badge', exclusion.restored ? '復元済み' : '取り消し中'))
    head.appendChild(
      el(
        'span',
        null,
        (labels.exclusion_target[exclusion.target_type] || exclusion.target_type) + ' ' + exclusion.target_id,
      ),
    )
    section.appendChild(head)
    var list = el('dl', 'kv')
    kv(list, '取り消し id', el('code', null, exclusion.id))
    kv(list, '取り消した時刻', el('span', null, exclusion.excluded_at))
    kv(list, '取り消した理由', el('span', null, exclusion.reason))
    if (exclusion.restored) {
      kv(list, '復元した時刻', el('span', null, exclusion.restored.at))
      kv(list, '復元した理由', el('span', null, exclusion.restored.reason))
    }
    var target = excludedTargetNode(exclusion)
    if (target !== null) kv(list, '取り消した中身', target)
    section.appendChild(list)
    return section
  }

  /** 取り消された対象そのもの。id だけでは何を取り消したのか読み手に分からない。 */
  function excludedTargetNode(exclusion) {
    var n
    if (exclusion.target_type === 'claim') {
      for (n = 0; n < ledger.claims.length; n += 1) {
        if (ledger.claims[n].id === exclusion.target_id) {
          return el('span', null, ledger.claims[n].claim + '（元ネタ [' + ledger.claims[n].start + ', ' + ledger.claims[n].end + ')）')
        }
      }
      return null
    }
    if (exclusion.target_type === 'non_claim') {
      for (n = 0; n < ledger.non_claims.length; n += 1) {
        if (ledger.non_claims[n].id === exclusion.target_id) {
          return el('span', null, ledger.non_claims[n].reason + '（元ネタ [' + ledger.non_claims[n].start + ', ' + ledger.non_claims[n].end + ')）')
        }
      }
      return null
    }
    if (exclusion.target_type === 'evidence') {
      var evidence = evidenceById[exclusion.target_id]
      if (!evidence) return null
      return el('span', null, evidence.source.type === 'url' ? evidence.source.url : evidence.source.path)
    }
    if (exclusion.target_type === 'attachment') {
      for (n = 0; n < ledger.attachments.length; n += 1) {
        var a = ledger.attachments[n]
        if (a.id === exclusion.target_id) {
          return el('span', null, a.claim_id + ' ← ' + a.evidence_id + '（' + (labels.relation[a.relation] || a.relation) + '）「' + a.quote + '」')
        }
      }
      return null
    }
    return el('span', null, 'セッション全体を保管した。台帳を変える操作は受け付けない状態。')
  }

  /* ---- 主張一覧（細いナビ） ---- */

  /**
   * 全主張を本文の順に並べた 1 本のナビ。
   *
   * 以前は上部に「要確認だけの表」を置いていたが、(1) 画面の上半分を占めて本文と証拠が
   * 折り返しの下に沈み、(2) 選択状態を持つ器が本文と合わせて 2 つになり、(3) verified の
   * 主張へ辿り着く道がどこにも無かった。並びを本文と同じにして、要確認には印を付ける。
   */
  function attentionIds() {
    var ids = {}
    for (var n = 0; n < data.attention.length; n += 1) ids[data.attention[n].claim_id] = true
    return ids
  }

  function renderNav() {
    var host = clear(byId('nav-body'))
    var flagged = attentionIds()
    var ids = visibleClaimIds()
    byId('nav-count').textContent =
      ids.length === claims.length
        ? '全 ' + claims.length + ' 件'
        : ids.length + ' / ' + claims.length + ' 件を表示'
    if (ids.length === 0) {
      host.appendChild(el('p', 'empty', '判定の絞り込みで表示できる主張がありません。上の「すべて表示」で戻せます。'))
      return
    }
    for (var n = 0; n < claims.length; n += 1) {
      var claim = claims[n]
      if (!active[verdictOf(claim)]) continue
      host.appendChild(navItem(claim, n + 1, flagged[claim.id] === true))
    }
  }

  function navItem(claim, number, flagged) {
    var value = verdictOf(claim)
    var item = el('button', 'nav-item v-' + value)
    item.type = 'button'
    item.setAttribute('data-claim', claim.id)
    item.setAttribute('aria-current', claim.id === selected ? 'true' : 'false')
    var top = el('div', 'nav-item-top')
    top.appendChild(el('span', 'nav-num', String(number)))
    top.appendChild(el('span', 'mark', labels.mark[value]))
    top.appendChild(el('span', null, labels.verdict[value]))
    if (flagged) top.appendChild(el('span', 'nav-flag', '要確認'))
    item.appendChild(top)
    item.appendChild(el('div', 'nav-item-text', claim.claim))
    item.title = claim.claim
    item.addEventListener('click', function () { selectClaim(claim.id, 'nav') })
    return item
  }

  /**
   * 判定のバッジ。通常表示に出すのは**日本語の呼び名だけ**にする。
   * 括弧付きの内部の値（partially_verified など）は読み手の判断を助けないのに、
   * 一番目立つ場所を占めていた。値そのものは捨てず、hover の title と管理情報の details に残す。
   */
  function badge(value) {
    var node = el('span', 'badge v-' + value)
    node.appendChild(el('span', 'mark', labels.mark[value]))
    node.appendChild(document.createTextNode(' ' + labels.verdict[value]))
    node.title = verdictLabel(value)
    return node
  }

  /* ---- 左ペイン: 元ネタ本文 ---- */

  function renderSource() {
    var host = clear(byId('source-body'))
    // 行長を抑える器は本文の中に置く。外枠に max-width を掛けると、広い画面で
    // 左右が余るだけで証拠のカラムまで狭くなる。
    var inner = el('div', 'source-inner')
    var text = data.source_text
    for (var n = 0; n < data.spans.length; n += 1) {
      inner.appendChild(spanNode(data.spans[n], text.slice(data.spans[n].start, data.spans[n].end)))
    }
    host.appendChild(inner)
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
    // 本文の主張はマウスでしか選べなかった。button 要素にすると本文の折り返しと選択が壊れるので、
    // span のまま role/tabindex/キー操作を付けて、キーボードだけでも本文から選べるようにする。
    var node = el('span', 'seg seg-claim v-' + value)
    node.setAttribute('data-claim', primary.id)
    node.setAttribute('data-verdict', value)
    node.setAttribute('role', 'button')
    node.setAttribute('tabindex', '0')
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
    node.setAttribute('aria-label', claimNumber(primary.id) + ' 件目の主張: ' + primary.claim)
    node.addEventListener('click', function () { selectClaim(primary.id, 'source') })
    // Enter と Space は button と同じ意味にする。Space はページ送りを奪うので既定を止める。
    node.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
      event.preventDefault()
      selectClaim(primary.id, 'source')
    })
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
    renderStepper()
    if (from !== 'source') scrollSourceTo(id)
    if (from !== 'nav') scrollNavTo(id)
    byId('detail-body').scrollTop = 0
    announceSelection(id)
  }

  /**
   * 選択が変わったことの読み上げ。**詳細全部を読み上げさせない。**
   *
   * 詳細ペイン自体を aria-live にすると、主張を 1 つ移るたびに証拠・引用文・但し書きまで
   * 全文が読み上げられて、次の操作に移れなくなる。読み上げるのは「何件目の何を選んだか」
   * と判定だけにして、中身は本人が詳細へ移動して読む。
   */
  function announceSelection(id) {
    var claim = claimById[id]
    if (!claim) return
    var ids = visibleClaimIds()
    var position = ids.indexOf(id)
    byId('selection-live').textContent =
      (position === -1 ? claimNumber(id) + ' 件目' : position + 1 + ' / ' + ids.length + ' 件目') +
      'を選択: ' + labels.verdict[verdictOf(claim)] + '。' + headline(claim.claim, 60)
  }

  /** 本文・ナビの両方に同じ選択を映す。選択の見え方を持つ場所はこの 1 関数だけにする。 */
  function markSelection() {
    var segments = document.querySelectorAll('#source-body .seg-claim')
    for (var n = 0; n < segments.length; n += 1) {
      segments[n].classList.toggle('selected', segments[n].getAttribute('data-claim') === selected)
    }
    var items = document.querySelectorAll('#nav-body .nav-item')
    for (var r = 0; r < items.length; r += 1) {
      items[r].setAttribute('aria-current', items[r].getAttribute('data-claim') === selected ? 'true' : 'false')
    }
  }

  /** 前後ボタンと「何件目か」。可視集合は visibleClaimIds() だけを見る（キーボードと同じ真）。 */
  function renderStepper() {
    var ids = visibleClaimIds()
    var index = selected === null ? -1 : ids.indexOf(selected)
    byId('claim-position').textContent = index === -1 ? '— / ' + ids.length : index + 1 + ' / ' + ids.length
    byId('prev-claim').disabled = ids.length === 0 || index <= 0
    byId('next-claim').disabled = ids.length === 0 || (index !== -1 && index >= ids.length - 1)
  }

  /**
   * 選択した箇所を枠の中へ送る。
   *
   * offsetTop は「一番近い position 付き祖先」からの距離なので、枠に position が付いていないと
   * 画面全体からの距離になり、まったく別の位置へスクロールする（実際に、選択中の主張が
   * 本文の枠に入らないまま先頭が表示されていた）。どこからの距離かに依存しない
   * getBoundingClientRect の差分で測る。
   */
  function scrollIntoPane(bodyId, selector, always) {
    var body = byId(bodyId)
    var target = body.querySelector(selector)
    if (!target) return
    var bodyRect = body.getBoundingClientRect()
    var targetRect = target.getBoundingClientRect()
    var alreadyVisible = targetRect.top >= bodyRect.top && targetRect.bottom <= bodyRect.bottom
    if (!always && alreadyVisible) return
    var delta = targetRect.top - bodyRect.top - body.clientHeight / 3
    body.scrollTop = Math.max(0, Math.min(body.scrollHeight - body.clientHeight, body.scrollTop + delta))
  }

  function scrollSourceTo(id) {
    scrollIntoPane('source-body', '.seg-claim[data-claim="' + id + '"]', true)
  }

  function scrollNavTo(id) {
    scrollIntoPane('nav-body', '.nav-item[data-claim="' + id + '"]', false)
  }

  function renderDetail() {
    var host = clear(byId('detail-body'))
    if (selected === null) {
      byId('detail-head-label').textContent = '主張の詳細'
      host.appendChild(el('p', 'empty', '左の一覧か、本文で印の付いた箇所を選ぶと、その主張の判定と証拠がここに出ます。'))
      return
    }
    // 見出しに出すのは一覧と同じ人向けの番号。内部 id は管理情報の details で読める。
    byId('detail-head-label').textContent = '主張の詳細 — ' + claimNumber(selected) + ' 件目'
    host.appendChild(claimDetail(claimById[selected]))
  }

  /**
   * 詳細は「主張 → 判定の理由 → 証拠」の順に読ませる。元ネタの該当文は本文の左に同じものが
   * 出ているので details に畳む（重複で 2 画面ぶん流すと、証拠が下に押し出される）。
   */
  function claimDetail(claim) {
    var value = verdictOf(claim)
    var article = el('article', 'claim-detail v-' + value)
    article.setAttribute('data-claim', claim.id)

    var head = el('div', 'detail-head')
    head.appendChild(badge(value))
    article.appendChild(head)

    article.appendChild(el('h3', 'claim-text', claim.claim))
    article.appendChild(field('判定の理由', el('p', 'rationale', claim.verdict ? claim.verdict.rationale : 'まだ判定が付いていない')))
    article.appendChild(
      more('元ネタの該当文と管理情報', function (box) {
        box.appendChild(quote(claim.source_text))
        var list = el('dl', 'kv')
        kv(list, '主張 id', el('code', null, claim.id))
        kv(list, '判定の値', el('code', null, value))
        if (claim.kind) kv(list, '種別', el('span', null, claim.kind))
        kv(list, '元ネタの範囲', el('span', null, '[' + claim.start + ', ' + claim.end + ')'))
        if (claim.verdict) kv(list, '判定時刻', el('span', null, claim.verdict.decided_at))
        box.appendChild(list)
      }),
    )

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

  /**
   * 折りたたみ。開く JS を書かずにブラウザの details に任せる。
   * 印刷時は CSS 側で中身を強制表示するので、畳んだ情報が紙から消えることはない。
   */
  function more(summaryText, fill) {
    var box = el('details', 'more')
    box.appendChild(el('summary', null, summaryText))
    var body = el('div')
    fill(body)
    box.appendChild(body)
    return box
  }

  /** 長い記録を「見出しは常時 + 全文は開いて読む」で出す。文字は 1 つも削らない。 */
  function fullText(cls, summaryText, text) {
    var box = el('details', cls)
    box.appendChild(el('summary', null, summaryText))
    box.appendChild(el('pre', null, text))
    return box
  }

  /** 長い一文の頭だけを見出しに使う。全文は必ず pre の側に入る（切った文字は捨てない）。 */
  function headline(text, limit) {
    var oneLine = String(text).replace(/\\s+/g, ' ').trim()
    return oneLine.length <= limit ? oneLine : oneLine.slice(0, limit) + '…'
  }

  function attachmentNode(attachment) {
    var evidence = evidenceById[attachment.evidence_id]
    var section = el('section', 'attachment')
    section.setAttribute('data-attachment', attachment.id)

    var head = el('div', 'att-head')
    head.appendChild(
      el('span', 'badge rel rel-' + attachment.relation, labels.relation[attachment.relation] || attachment.relation),
    )
    if (evidence) {
      head.appendChild(el('span', null, labels.provenance[evidence.provenance] || evidence.provenance))
    }
    section.appendChild(head)

    section.appendChild(el('blockquote', 'quote', attachment.quote))
    var where = '証拠本文の [' + attachment.match.start + ', ' + attachment.match.end + ') に実在'
    if (attachment.pdf_page !== null && attachment.pdf_page !== undefined) where += ' ・ PDF ' + attachment.pdf_page + ' ページ目'
    section.appendChild(el('div', 'where', where))
    section.appendChild(field('根拠の説明', el('p', 'rationale', attachment.rationale)))

    if (!evidence) {
      section.appendChild(el('p', 'missing', '証拠 ' + attachment.evidence_id + ' が台帳に無い'))
    } else {
      var origin = evidence.source.type === 'url' ? evidence.source.url : evidence.source.path
      var originLine = el('p', 'att-origin')
      originLine.appendChild(el('span', 'label', '出典 '))
      originLine.appendChild(originNode(origin))
      section.appendChild(originLine)
      // AI 提出の警告と語の照合結果は畳まない。畳めるのは「読まなくても判断が変わらない」ものだけ。
      if (evidence.provenance === 'agent_captured') {
        var warn = el('div', 'warn warn-compact')
        warn.appendChild(el('strong', null, '⚠️ AI が提出した証拠です。'))
        warn.appendChild(document.createTextNode(' ' + labels.agent_captured_warning))
        section.appendChild(warn)
      }
      var terms = termCheckNode(evidence)
      if (terms !== null) section.appendChild(terms)
      section.appendChild(
        more('証拠 ' + evidence.id + ' の記録（取得時刻・sha256・取得経緯）', function (box) {
          box.appendChild(evidenceMeta(attachment, evidence))
        }),
      )
    }
    section.appendChild(screenshotNode(attachment))
    return section
  }

  /**
   * expected_terms の照合結果。未申告を黙って空欄にすると「検査して問題なし」と読まれるので、
   * 「未検査」と書く。不一致は畳まずその場に出す（AI が別ページや CSS を出した合図）。
   */
  function termCheckNode(evidence) {
    if (evidence.provenance !== 'agent_captured') return null
    var check = evidence.term_check
    if (check === null || check === undefined) {
      return el('p', 'where', '確認したい語の照合: 未検査（expected_terms の申告なし）')
    }
    if (!check.missing || check.missing.length === 0) {
      return el('p', 'where', '確認したい語の照合: 申告された ' + check.terms.length + ' 語すべてが提出本文に実在')
    }
    var warn = el('div', 'warn warn-compact')
    warn.appendChild(
      el('strong', null, '⚠️ 申告された ' + check.terms.length + ' 語のうち ' + check.missing.length + ' 語が提出本文に見つかりません。'),
    )
    warn.appendChild(document.createTextNode(' 見つからなかった語: ' + check.missing.join(' / ')))
    return warn
  }

  function evidenceMeta(attachment, evidence) {
    var list = el('dl', 'kv')
    kv(list, '紐づけ id', el('code', null, attachment.id + ' → ' + attachment.evidence_id))
    kv(list, '関係の値', el('code', null, attachment.relation))
    kv(list, '取得方法', el('span', null, labels.provenance[evidence.provenance] || evidence.provenance))
    kv(list, '出どころ', el('span', evidence.discovered_via ? null : 'unrecorded', discoveryText(evidence)))
    kv(list, '取得時刻', el('span', null, evidence.fetched_at))
    kv(list, '本文 sha256', el('code', null, evidence.text_sha256))
    if (evidence.note) kv(list, 'AI の説明', el('span', null, evidence.note))
    return list
  }

  function discoveryText(evidence) {
    if (!evidence.discovered_via) return labels.unrecorded
    var text = labels.discovered_via[evidence.discovered_via] || evidence.discovered_via
    return evidence.discovery_note ? text + ' — ' + evidence.discovery_note : text
  }

  /**
   * 画像。撮れなかった記録は「見出し + 全文を開く」で出し、切らずに全部残す
   * （実運用で 1 件 800 文字近いスタック付きのエラーが出た。切ると原因調査の手がかりが消える）。
   */
  function screenshotNode(attachment) {
    if (!attachment.screenshot_path) {
      var reason = attachment.screenshot_note
      if (!reason) return el('p', 'missing', 'スクリーンショットなし — 理由の記録なし')
      return fullText('failure', '⚠️ スクリーンショットなし — ' + headline(reason, 70), reason)
    }
    var figure = el('figure', 'shot')
    var image = el('img', 'shot')
    var alt = attachment.id + ' の引用箇所をハイライトした画像'
    image.loading = 'lazy'
    image.alt = alt

    var actions = el('div', 'shot-actions')
    var zoom = el('button', 'shot-zoom', '原寸で開く')
    zoom.type = 'button'
    zoom.addEventListener('click', function () { openLightbox(image.src, alt) })
    actions.appendChild(zoom)

    // 画像が開けなかったことを「画像が無い」と見分けられるようにする。壊れた画像アイコンだけ出して
    // 正常扱いにしない（セッションディレクトリごと移したのに画像を置き忘れた場合がこれ）。
    image.addEventListener('error', function () {
      if (image.parentNode === figure) figure.removeChild(image)
      figure.insertBefore(
        el('p', 'missing', '画像ファイルを読み込めませんでした（パス: ' + attachment.screenshot_path + '）。同じ場所にファイルがあるか確かめてください。'),
        figure.firstChild,
      )
      zoom.disabled = true
    })
    image.src = attachment.screenshot_path
    figure.appendChild(image)
    figure.appendChild(
      el(
        'figcaption',
        null,
        attachment.screenshot_source
          ? labels.screenshot_source[attachment.screenshot_source] || attachment.screenshot_source
          : labels.unrecorded,
      ),
    )
    figure.appendChild(actions)

    if (attachment.screenshot_note) {
      figure.appendChild(fullText('notice', '但し書き — ' + headline(attachment.screenshot_note, 70), attachment.screenshot_note))
    }
    return figure
  }

  /* ---- 原寸表示（ブラウザ標準の dialog。Escape・フォーカストラップ・背景は標準に任せる） ---- */

  var lastFocused = null

  function openLightbox(src, alt) {
    var box = byId('lightbox')
    var image = byId('lightbox-img')
    image.src = src
    image.alt = alt
    byId('lightbox-caption').textContent = alt
    lastFocused = document.activeElement
    if (typeof box.showModal === 'function') box.showModal()
    else box.setAttribute('open', 'open')
    byId('lightbox-close').focus()
  }

  function closeLightbox() {
    var box = byId('lightbox')
    if (typeof box.close === 'function') box.close()
    else box.removeAttribute('open')
    // 開く前にいたボタンへフォーカスを戻す（キーボードだけで読み進められるようにする）。
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus()
    lastFocused = null
  }

  /* ---- 印刷用（要確認一覧のあとに全主張の詳細を並べる） ---- */

  /**
   * 紙に出す全主張。**印刷のときに画面の状態を書き換えない**ことを設計で守る。
   *
   * 閉じた details の中身は、CSS では紙に出せない（display も content-visibility も効かないことを
   * 実測で確認した）。かといって印刷の直前に画面の details を開くと、読み手が畳んでおいた場所が
   * 印刷のあと開いたままになる恐れがある（戻す処理はブラウザが afterprint を出すかに依存する）。
   *
   * そこで、この印刷用の複製だけを**最初から開いた状態**で作る。ここは画面には出ない領域なので、
   * 開いておいても読み手には見えず、戻す処理も要らない。セッションの管理情報も、画面側の
   * details を当てにせずここへ複製する（画面側は紙では隠れる）。
   */
  function renderPrintAll() {
    var host = clear(byId('printAll'))

    if (ledger.reports_stale_since) {
      var stale = el('div', 'warn warn-stale')
      stale.appendChild(el('strong', null, '⚠️ finalize を通していない暫定表示です。'))
      stale.appendChild(document.createTextNode(' ' + labels.stale_report_warning))
      stale.appendChild(el('div', 'where', '台帳が変わった時刻: ' + ledger.reports_stale_since))
      host.appendChild(stale)
    }

    host.appendChild(el('h2', null, 'セッションの詳細'))
    var meta = el('dl', 'kv')
    kv(meta, '表題', el('span', null, titleText()))
    kv(meta, 'セッション', el('code', null, ledger.session_id))
    var origin = el('span', null, ledger.source.kind)
    if (ledger.source.origin) origin.appendChild(document.createTextNode(' — ' + ledger.source.origin))
    kv(meta, '元ネタ', origin)
    kv(meta, '網羅率', el('span', null, data.summary.coverage.percent + ' (' + data.summary.coverage.covered + '/' + data.summary.coverage.total + ' 文字)'))
    kv(meta, 'レポート生成', el('span', null, data.generated_at))
    if (ledger.version !== undefined) kv(meta, '台帳 version', el('span', null, String(ledger.version)))
    host.appendChild(meta)

    host.appendChild(el('h2', null, '主張ごとの判定（全 ' + claims.length + ' 件）'))
    for (var n = 0; n < claims.length; n += 1) {
      var block = el('div', 'print-claim')
      block.appendChild(claimDetail(claims[n]))
      host.appendChild(block)
    }

    // 対象外とした範囲は report.md には全件あるのに、紙には 1 件も出ていなかった。
    // 「なぜここは裏取りの対象外なのか」は網羅率 100% の根拠の半分なので、紙にも全件出す。
    // 並びと項目は render-markdown.ts の「対象外とした範囲」と同じにする（形式ごとに違う紙を作らない）。
    if (nonClaims.length > 0) {
      host.appendChild(el('h2', null, '対象外とした範囲（全 ' + nonClaims.length + ' 件）'))
      for (var m = 0; m < nonClaims.length; m += 1) {
        var nonClaim = nonClaims[m]
        var item = el('section', 'print-nonclaim')
        item.appendChild(
          el('h3', null, nonClaim.id + ' [' + nonClaim.start + ', ' + nonClaim.end + ')'),
        )
        item.appendChild(field('対象外とした理由', el('p', 'rationale', nonClaim.reason)))
        item.appendChild(quote(nonClaim.source_text))
        host.appendChild(item)
      }
    }

    if (exclusions.length > 0) {
      var live = 0
      for (var e = 0; e < exclusions.length; e += 1) if (!exclusions[e].restored) live += 1
      host.appendChild(
        el('h2', null, '取り消し履歴（取り消し中 ' + live + ' 件 / 全 ' + exclusions.length + ' 件）'),
      )
      host.appendChild(
        el('p', 'where', '取り消しても元の記録と取得済みのファイルは消えていない。'),
      )
      for (var x = 0; x < exclusions.length; x += 1) host.appendChild(exclusionNode(exclusions[x]))
    }

    var boxes = host.querySelectorAll('details')
    for (var d = 0; d < boxes.length; d += 1) boxes[d].open = true
  }

  /* ---- キーボード ---- */

  function visibleClaimIds() {
    var ids = []
    for (var n = 0; n < claims.length; n += 1) {
      if (active[verdictOf(claims[n])]) ids.push(claims[n].id)
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

  /** 文字を打っている最中の j / k を横取りしない（入力欄・選択・編集可能領域）。 */
  function isTyping(target) {
    if (!target || !target.tagName) return false
    var tag = target.tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
    return target.isContentEditable === true
  }

  document.addEventListener('keydown', function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    // Escape は dialog 自身が閉じる。閉じた後の後始末は close イベントで受ける。
    if (event.key === 'Escape') return
    if (isTyping(event.target)) return
    var delta = 0
    if (event.key === 'j' || event.key === 'ArrowDown') delta = 1
    if (event.key === 'k' || event.key === 'ArrowUp') delta = -1
    if (delta === 0) return
    event.preventDefault()
    moveSelection(delta)
  })

  byId('prev-claim').addEventListener('click', function () { moveSelection(-1) })
  byId('next-claim').addEventListener('click', function () { moveSelection(1) })
  byId('lightbox-close').addEventListener('click', closeLightbox)
  // Escape で閉じた経路でもフォーカスを戻す。close は showModal / close どちらでも起きる。
  byId('lightbox').addEventListener('close', function () {
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus()
    lastFocused = null
  })

  renderHead()
  renderNav()
  renderSource()
  renderDetail()
  renderStepper()
  renderPrintAll()
  if (data.attention.length > 0) selectClaim(data.attention[0].claim_id, 'init')
  else if (claims.length > 0) selectClaim(claims[0].id, 'init')
})()
`
