import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chromium, type Page } from 'playwright'
import { readEmbeddedJson } from '../src/report/rendering/embed-json.js'
import type { ViewerPayload } from '../src/report/rendering/viewer-payload.js'
import { startFixtureServer } from './fixtures/serve-fixtures.js'
import { extractInlineScript, jsSyntaxDiagnostics } from './js-syntax.js'
import { callTool } from './mcp/call-tool.js'

/**
 * end-to-end 検証。MCP サーバーを子プロセスとして stdio で起動し、実際のツール呼び出しだけで
 * 一連のワークフローを通す。外部サイトには一切アクセスせず、証拠はローカルの HTTP サーバーが配る
 * 固定ページだけを使う。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const WORK_DIR = path.join(HERE, 'tmp')

const SOURCE_TEXT = [
  '四半期業績メモ',
  '',
  '当期の売上は前年比120%に達した。営業利益は前年比150%に伸びた。海外向けの出荷は412台だった。',
  '国内の新規契約は37件だった。',
].join('\n')

/**
 * AI が自分のブラウザ操作ツールで取ってきたことにする本文。文面は架空で、実在の組織とは関係しない。
 * これを提出することで agent_captured の警告と partially_verified の判定がレポートに出る。
 */
const AGENT_CAPTURED_TEXT = [
  '架空社の開示ページ（この文面は e2e の作り物）。',
  '国内の新規契約は37件と発表した。',
  'なお対象期間の記載は無い。',
].join('\n')

/** 証拠にする PDF。文面は架空で、実在の組織とは関係しない。 */
const PDF_PAGES = [
  ['Fictional Quarterly Filing', 'This page is a fixture served from localhost only.'],
  ['Overseas shipment summary', 'The overseas shipment totalled 412 units in the quarter.'],
]

let failures = 0

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

function check(label: string, condition: boolean, detail: string): void {
  if (condition) {
    log(`  [OK] ${label} — ${detail}`)
    return
  }
  failures += 1
  log(`  [NG] ${label} — ${detail}`)
}

const VERDICTS = ['contradicted', 'partially_verified', 'unverifiable', 'verified', 'none'] as const

/**
 * 判定フィルターの全 32 通り（5 種の ON/OFF）を回し、**画面が出している集合**と
 * **フィルターから決まるはずの集合**が一致することを突き合わせる。
 *
 * 人が思いつく 2〜3 パターンだけを見ていると、「絞り込みで選択中の主張が消えたのに
 * 詳細だけ前のまま残る」「空一覧で何も言わない」が通り抜ける。判定は 5 種しかないので全数で回せる。
 */
async function checkFilterMatrix(page: Page, claimCount: number): Promise<void> {
  log('\n[11b] 判定フィルターの全 32 通り')
  const failures: string[] = []
  for (let bits = 0; bits < 1 << VERDICTS.length; bits += 1) {
    await page.click('#chip-all')
    const off: string[] = []
    for (let n = 0; n < VERDICTS.length; n += 1) {
      if ((bits & (1 << n)) !== 0) continue
      off.push(VERDICTS[n] ?? '')
      await page.click(`.chip[data-verdict="${VERDICTS[n]}"]`)
    }
    // 画面とは別の道筋で期待値を出す: 埋め込みデータの判定を数えるだけ。
    const observed = await page.evaluate((offValues: string[]) => {
      const raw = document.getElementById('fact-check-data')
      const parsed = JSON.parse(raw?.textContent ?? '{}') as {
        ledger: { claims: Array<{ id: string; verdict: { value: string } | null }> }
      }
      const expectedIds = parsed.ledger.claims
        .filter((claim) => !offValues.includes(claim.verdict === null ? 'none' : claim.verdict.value))
        .map((claim) => claim.id)
      const navIds = Array.from(document.querySelectorAll('#nav-body .nav-item')).map((node) =>
        node.getAttribute('data-claim'),
      )
      const detail = document.querySelector('#detail-body .claim-detail')
      return {
        expectedIds,
        navIds,
        selected: detail === null ? null : detail.getAttribute('data-claim'),
        emptyShown: document.querySelector('#nav-body .empty') !== null,
        position: document.getElementById('claim-position')?.textContent ?? '',
        dimmed: document.querySelectorAll('#source-body .seg-claim.dim').length,
      }
    }, off)

    const label = off.length === 0 ? '全 ON' : `OFF: ${off.join(',')}`
    if (observed.navIds.join(',') !== observed.expectedIds.join(',')) {
      failures.push(
        `${label} — 一覧が期待と違う (${observed.navIds.length} 件 / 期待 ${observed.expectedIds.length} 件)`,
      )
      continue
    }
    if (observed.expectedIds.length === 0) {
      if (!observed.emptyShown) failures.push(`${label} — 空一覧なのに空状態を出していない`)
      if (observed.selected !== null)
        failures.push(`${label} — 表示 0 件なのに詳細が残っている (${observed.selected})`)
      if (observed.position !== `— / 0`) failures.push(`${label} — 位置表示が ${observed.position}`)
      continue
    }
    if (observed.selected === null || !observed.expectedIds.includes(observed.selected)) {
      failures.push(`${label} — 選択 ${String(observed.selected)} が表示中の主張に含まれない`)
    }
    const index = observed.expectedIds.indexOf(observed.selected ?? '')
    if (observed.position !== `${index + 1} / ${observed.expectedIds.length}`) {
      failures.push(`${label} — 位置表示 ${observed.position} が選択 (${index + 1}) と合わない`)
    }
    if (observed.dimmed !== claimCount - observed.expectedIds.length) {
      failures.push(`${label} — 本文で薄くした数 ${observed.dimmed} が非表示件数と合わない`)
    }
  }
  await page.click('#chip-all')
  check(
    'フィルター 32 通りで一覧・選択・位置・本文の塗りが食い違わない',
    failures.length === 0,
    failures.length === 0 ? '32 通りすべて一致' : failures.join(' / '),
  )
}

/**
 * 絞り込み中の前後移動と印刷。
 *
 * 全件表示のままで前後移動を試すと「可視集合を見ずに全件を辿る」実装でも通ってしまう。
 * 逆に印刷は**絞り込みを引き継いではいけない**（紙は全部が要る）。両方を同じ状態で見る。
 */
async function checkFilteredNavigationAndPrint(page: Page, claimCount: number): Promise<void> {
  await page.click('#chip-all')
  await page.click('.chip[data-verdict="verified"]')
  const visible = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#nav-body .nav-item')).map((node) =>
      node.getAttribute('data-claim'),
    ),
  )
  // 先頭から下へ、次に末尾から上へ歩く。端から始めて片方向だけ試すと、移動が端で止まるだけで
  // 「非表示を跨ぐ」実装でも通ってしまう（実際にこの取り違えで変異を取り逃がした）。
  const visited: string[] = []
  await page.click('#nav-body .nav-item')
  visited.push((await page.getAttribute('#detail-body .claim-detail', 'data-claim')) ?? '')
  for (const key of ['j', 'k']) {
    for (let n = 0; n < claimCount + 2; n += 1) {
      await page.keyboard.press(key)
      const current = await page.getAttribute('#detail-body .claim-detail', 'data-claim')
      if (current !== null) visited.push(current)
    }
  }
  const strayed = visited.filter((id) => !visible.includes(id))
  check(
    '絞り込み中の前後移動は非表示の主張を選ばない',
    visible.length > 0 && visible.length < claimCount && strayed.length === 0,
    `表示 ${visible.length}/${claimCount} 件 / 訪れた先で非表示だったもの ${strayed.length} 件${strayed.length === 0 ? '' : `: ${strayed.join(',')}`}`,
  )
  check(
    '印刷用の一覧は絞り込みを引き継がず全主張を出す',
    (await page.locator('#printAll .print-claim').count()) === claimCount,
    `印刷 ${await page.locator('#printAll .print-claim').count()} 件 / 画面 ${visible.length} 件`,
  )
  await page.click('#chip-all')
}

/**
 * 印刷で「畳んである情報」が本当に紙に出るか。
 *
 * DOM に在る件数を数えるだけでは合格にならない（閉じた details の中身を出さないブラウザがある）。
 * print メディアを当てたうえで、**閉じていた要素の中身が実際に描画されているか**を高さで見る。
 * 併せて、印刷したせいで画面の開閉状態が変わらないことも確かめる。
 */
async function checkPrintRendering(
  page: Page,
  claimCount: number,
  expected: { nonClaimCount: number; exclusionCount: number },
): Promise<void> {
  const before = await page.evaluate(() =>
    Array.from(document.querySelectorAll('details')).map((node) => node.open),
  )
  await page.emulateMedia({ media: 'print' })
  // ページへ渡す関数の中に「名前の付く関数式」を書かないこと。tsx が __name で包み、
  // ページ側で ReferenceError になる（この e2e も tsx で動くので同じ罠にかかる）。
  //
  // 見えているかの判定に getBoundingClientRect の高さを使わない。**閉じた details の中でも
  // 高さは 0 にならない**ことを実測で確認した（閉/開ともに 20px）。高さで見ると、何も出ていない
  // 紙でもテストが通ってしまう。checkVisibility() だけが閉じた details の中身を false と答える。
  const printed = await page.evaluate(() => ({
    claims: document.querySelectorAll('#printAll .print-claim').length,
    failureTotal: document.querySelectorAll('#printAll details.failure pre').length,
    failureTextShown: Array.from(document.querySelectorAll('#printAll details.failure pre')).filter((node) =>
      node.checkVisibility(),
    ).length,
    moreTotal: document.querySelectorAll('#printAll details.more dl.kv').length,
    moreShown: Array.from(document.querySelectorAll('#printAll details.more dl.kv')).filter((node) =>
      node.checkVisibility(),
    ).length,
    quoteTotal: document.querySelectorAll('#printAll details.more blockquote').length,
    quoteShown: Array.from(document.querySelectorAll('#printAll details.more blockquote')).filter((node) =>
      node.checkVisibility(),
    ).length,
    // report.md には全件ある「対象外とした範囲」が、紙には 1 件も出ていなかった。
    // 数えるだけでなく checkVisibility() で「本当に見えているか」を見る。
    nonClaimTotal: document.querySelectorAll('#printAll .print-nonclaim').length,
    nonClaimShown: Array.from(document.querySelectorAll('#printAll .print-nonclaim blockquote')).filter(
      (node) => node.checkVisibility(),
    ).length,
    exclusionTotal: document.querySelectorAll('#printAll .exclusion').length,
    exclusionShown: Array.from(document.querySelectorAll('#printAll .exclusion dl.kv')).filter((node) =>
      node.checkVisibility(),
    ).length,
    // 主張ごとの記録にも dl.kv があるので、セッションの管理情報は #printAll の直下だけを見る
    // （どれか 1 つでも見えていればよい、にすると主張側の kv で通ってしまう）。
    sessionMetaShown: Array.from(document.querySelectorAll('#printAll > dl.kv')).some((node) =>
      node.checkVisibility(),
    ),
    layoutHidden: document.querySelector('.layout')?.checkVisibility() !== true,
  }))
  await page.emulateMedia({ media: 'screen' })
  const after = await page.evaluate(() =>
    Array.from(document.querySelectorAll('details')).map((node) => node.open),
  )

  check(
    '印刷に全主張が出る',
    printed.claims === claimCount && printed.layoutHidden,
    `${printed.claims} / ${claimCount} 件（画面用の 3 領域は紙では隠れる: ${printed.layoutHidden}）`,
  )
  check(
    '印刷で管理情報（元ネタの該当文・証拠の記録）が実際に見える',
    printed.moreTotal > 0 &&
      printed.moreShown === printed.moreTotal &&
      printed.quoteTotal > 0 &&
      printed.quoteShown === printed.quoteTotal,
    `記録 ${printed.moreShown} / ${printed.moreTotal} 件・該当文 ${printed.quoteShown} / ${printed.quoteTotal} 件`,
  )
  check(
    '印刷に失敗の全文が出る',
    printed.failureTotal > 0 && printed.failureTextShown === printed.failureTotal,
    `${printed.failureTextShown} / ${printed.failureTotal} 件`,
  )
  check('印刷にセッションの詳細が出る', printed.sessionMetaShown, '表題の全文・id・生成時刻が紙にも残る')
  check(
    '印刷に対象外とした範囲が全件、本文つきで出る',
    printed.nonClaimTotal === expected.nonClaimCount && printed.nonClaimShown === expected.nonClaimCount,
    `${printed.nonClaimShown} / ${expected.nonClaimCount} 件（report.md の「対象外とした範囲」と同じ件数）`,
  )
  check(
    '印刷に取り消し履歴が全件出る',
    printed.exclusionTotal === expected.exclusionCount && printed.exclusionShown === expected.exclusionCount,
    `${printed.exclusionShown} / ${expected.exclusionCount} 件`,
  )
  check(
    '印刷しても画面の開閉状態は変わらない',
    before.join(',') === after.join(','),
    `開いていた details ${before.filter(Boolean).length} 個 → ${after.filter(Boolean).length} 個`,
  )
}

/**
 * 選んだ主張が**本文の枠の中に実際に見えている**こと。
 * data-claim が一致しているだけでは、枠の外にあっても通ってしまう。
 */
async function checkSelectionIsVisible(page: Page, claimIds: readonly string[]): Promise<void> {
  const failures: string[] = []
  for (const id of claimIds) {
    await page.click(`#nav-body .nav-item[data-claim="${id}"]`)
    const visible = await page.evaluate((claimId: string) => {
      const body = document.getElementById('source-body')
      const target = body?.querySelector(`.seg-claim[data-claim="${claimId}"]`)
      if (!body || !target) return { found: false, inside: false, top: 0, bodyTop: 0, bodyBottom: 0 }
      const b = body.getBoundingClientRect()
      const t = target.getBoundingClientRect()
      return {
        found: true,
        inside: t.bottom > b.top && t.top < b.bottom,
        top: Math.round(t.top),
        bodyTop: Math.round(b.top),
        bodyBottom: Math.round(b.bottom),
      }
    }, id)
    if (!visible.found || !visible.inside) {
      failures.push(
        `${id}: 本文 [${visible.bodyTop}, ${visible.bodyBottom}] に対し該当箇所 top=${visible.top}`,
      )
    }
  }
  check(
    '一覧で選んだ主張が本文の枠の中に見えている',
    failures.length === 0,
    failures.length === 0 ? `${claimIds.length} 件すべて枠内` : failures.join(' / '),
  )
}

/** 枠の下端が画面の中に収まっていること（上部の高さを引き算しないレイアウトの回帰確認）。 */
async function checkPanesFitViewport(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height })
  const box = await page.evaluate(() => {
    const rects = Array.from(document.querySelectorAll('.layout .pane')).map((node) => {
      const r = node.getBoundingClientRect()
      return { top: Math.round(r.top), bottom: Math.round(r.bottom) }
    })
    return {
      rects,
      innerHeight: window.innerHeight,
      pageScrollHeight: document.documentElement.scrollHeight,
      horizontal: document.documentElement.scrollWidth > window.innerWidth,
    }
  })
  const overflowing = box.rects.filter((r) => r.bottom > box.innerHeight)
  check(
    `${width}x${height} で 3 領域の下端が画面に収まる`,
    overflowing.length === 0 && box.pageScrollHeight <= box.innerHeight + 1 && !box.horizontal,
    `枠の下端 ${box.rects.map((r) => r.bottom).join(',')} / 画面 ${box.innerHeight} / ページ高 ${box.pageScrollHeight} / 横溢れ ${box.horizontal}`,
  )
}

/** 前後移動の境界。先頭で「前」、最後で「次」が押せないこと。 */
async function checkStepperBoundaries(page: Page, claimCount: number): Promise<void> {
  const cases = [
    { name: '先頭', key: 'k', repeat: claimCount + 2, disabled: '#prev-claim', enabled: '#next-claim' },
    { name: '最後', key: 'j', repeat: claimCount + 2, disabled: '#next-claim', enabled: '#prev-claim' },
  ]
  for (const item of cases) {
    await page.click('#chip-all')
    for (let n = 0; n < item.repeat; n += 1) await page.keyboard.press(item.key)
    check(
      `${item.name}の主張では片側のボタンだけが無効になる`,
      (await page.isDisabled(item.disabled)) && !(await page.isDisabled(item.enabled)),
      `${item.disabled}=disabled / 位置 ${await page.innerText('#claim-position')}`,
    )
  }
}

/** 入力欄にいる間は j / k を横取りしない（選択が飛ぶと文字が打てない）。 */
async function checkTypingDoesNotStealKeys(page: Page): Promise<void> {
  // 先頭の主張を選んでから j だけを押す。j と k を往復させると、横取りされていても
  // 行って戻るだけで同じ主張に落ち着き、素通しと見分けが付かない。
  await page.click('#chip-all')
  await page.click('#nav-body .nav-item')
  const before = await page.getAttribute('#detail-body .claim-detail', 'data-claim')
  const typed = await page.evaluate(() => {
    const field = document.createElement('input')
    field.id = 'e2e-typing-probe'
    document.body.appendChild(field)
    field.focus()
    return document.activeElement === field
  })
  await page.keyboard.press('j')
  const after = await page.getAttribute('#detail-body .claim-detail', 'data-claim')
  await page.evaluate(() => document.getElementById('e2e-typing-probe')?.remove())
  // 素通しできていることの裏取り: 同じ位置でフォーカスを外して j を押せば必ず動く。
  await page.click('#nav-body .nav-item')
  await page.keyboard.press('j')
  const movedWhenNotTyping = (await page.getAttribute('#detail-body .claim-detail', 'data-claim')) !== before
  check(
    '入力欄にフォーカスがある間は j で選択が動かない（外すと動く）',
    typed && before === after && movedWhenNotTyping,
    `入力中 ${String(before)} → ${String(after)} / 入力外で移動=${movedWhenNotTyping}`,
  )
}

/** 画像の原寸表示: ボタンで開き、閉じるボタンと Escape で閉じ、フォーカスが戻る。 */
/**
 * キーボードと読み上げのための構造を、実際に Tab を押して確かめる。
 *
 * 「focusable な要素が n 個ある」を数えるだけでは足りない。実測では本文の主張が
 * focusable 0 / 15 件で、一覧のボタンを 15 個通らないと詳細へ行けなかった。
 * ここでは Tab を実際に送り、飛べること・押せること・読み上げが出ることを見る。
 */
async function checkKeyboardAndAria(page: Page, claimIds: readonly string[]): Promise<void> {
  // Tab の順序を先頭から見るには、フォーカスの起点を本当に先頭へ戻す必要がある。
  // blur() では Chromium の「次にどこから Tab するか」の起点が戻らない（実測: 直前に
  // 触れたチップの次から始まった）。読み込み直すのが一番確実で、状態も持ち越さない。
  await page.reload({ waitUntil: 'load' })
  await page.keyboard.press('Tab')
  const firstStop = await page.evaluate(() => ({
    className: document.activeElement?.className ?? '',
    text: document.activeElement?.textContent ?? '',
  }))
  check(
    'Tab の 1 つ目がスキップリンクになる',
    firstStop.className.includes('skip-link'),
    `class=${firstStop.className} / ${firstStop.text}`,
  )
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  const jumped = await page.evaluate(() => document.activeElement?.id ?? '')
  check(
    'スキップリンクで詳細ペインへ直接飛べる（一覧のボタンを全部通らない）',
    jumped === 'detail-body',
    `飛び先の id=${jumped}`,
  )

  const structure = await page.evaluate(() => ({
    headings: Array.from(document.querySelectorAll('h2[id]')).map((node) => node.id),
    liveRegions: document.querySelectorAll('[aria-live]').length,
    sourceClaimsTotal: document.querySelectorAll('#source-body .seg-claim').length,
    sourceClaimsFocusable: document.querySelectorAll('#source-body .seg-claim[tabindex="0"]').length,
    labelled: document.querySelectorAll('.pane[aria-labelledby]').length,
  }))
  check(
    '3 領域に h2 の見出しがあり、領域と結ばれている',
    structure.headings.length === 3 && structure.labelled === 3,
    `見出し=${structure.headings.join(', ')} / aria-labelledby=${structure.labelled}`,
  )
  check(
    '本文の主張がキーボードで到達できる',
    structure.sourceClaimsTotal > 0 && structure.sourceClaimsFocusable === structure.sourceClaimsTotal,
    `${structure.sourceClaimsFocusable} / ${structure.sourceClaimsTotal} 件`,
  )
  check(
    '選択を知らせる読み上げ領域がちょうど 1 つある（詳細全体を読み上げさせない）',
    structure.liveRegions === 1,
    `aria-live の数=${structure.liveRegions}`,
  )

  // 本文の主張を Enter と Space で選べること。押すたびに読み上げ通知が更新されること。
  for (const [index, key] of ['Enter', ' '].entries()) {
    const target = claimIds[index]
    if (target === undefined) continue
    await page.focus(`#source-body .seg-claim[data-claim="${target}"]`)
    await page.evaluate(() => {
      const live = document.getElementById('selection-live')
      if (live !== null) live.textContent = ''
    })
    await page.keyboard.press(key === ' ' ? 'Space' : key)
    const selected = await page.getAttribute('#detail-body .claim-detail', 'data-claim')
    const announced = await page.innerText('#selection-live')
    check(
      `本文の主張を ${key === ' ' ? 'Space' : key} で選べる`,
      selected === target,
      `選択=${String(selected)} / 期待=${target}`,
    )
    check(
      `${key === ' ' ? 'Space' : key} での選択が短く読み上げられる`,
      announced.includes('件目を選択') && announced.length < 120,
      `読み上げ文（${announced.length} 文字）= ${announced}`,
    )
  }
  // 詳細ペイン全体が aria-live になっていないこと（なっていると証拠の全文が読み上げられる）。
  check(
    '詳細ペイン自体は読み上げの生きた領域にしない',
    (await page.locator('#detail-body[aria-live]').count()) === 0,
    '#detail-body に aria-live は付いていない',
  )
}

async function checkLightbox(page: Page): Promise<void> {
  await page.click('#chip-all')
  await page.click('#nav-body .nav-item')
  const zoom = page.locator('#detail-body .shot-zoom').first()
  if ((await zoom.count()) === 0) {
    check(
      '画像の原寸表示を開くボタンがある',
      false,
      '詳細に画像が無い（この e2e は画像を持つ claim を先に選ぶ想定）',
    )
    return
  }
  await zoom.focus()
  await zoom.press('Enter')
  check(
    'キーボードから原寸表示を開ける',
    (await page.locator('#lightbox[open]').count()) === 1,
    `dialog open=${await page.locator('#lightbox[open]').count()}`,
  )
  await page.click('#lightbox-close')
  check(
    '閉じるボタンで閉じ、開いたボタンへフォーカスが戻る',
    (await page.locator('#lightbox[open]').count()) === 0 &&
      (await page.evaluate(() => document.activeElement?.className ?? '')).includes('shot-zoom'),
    `open=${await page.locator('#lightbox[open]').count()} / focus=${await page.evaluate(() => document.activeElement?.className ?? '')}`,
  )
  await zoom.press('Enter')
  await page.keyboard.press('Escape')
  check(
    'Escape で閉じ、フォーカスが戻る',
    (await page.locator('#lightbox[open]').count()) === 0 &&
      (await page.evaluate(() => document.activeElement?.className ?? '')).includes('shot-zoom'),
    `open=${await page.locator('#lightbox[open]').count()}`,
  )
}

/**
 * report.html を file:// から開いて、人が使う操作をそのまま踏む。
 *
 * 生成した HTML の文字列を見るだけでは、描画の壊れ方（埋め込みデータが読めない、
 * クリックで何も起きない、絞り込みが塗りに効かない）が通り抜ける。
 */
async function checkViewerPage(
  htmlPath: string,
  expected: {
    partiallyVerifiedClaim: string
    verifiedClaim: string
    screenshotPath: string
    claimCount: number
    nonClaimCount: number
    exclusionCount: number
  },
): Promise<void> {
  // ブラウザを起こす前に、**生成後の** report.html から描画コードを取り出して構文検査する。
  // ブラウザの pageerror は、インライン script の構文エラーだと `Unexpected token ')'` の
  // 1 行だけで stack が空になる（実測）。どの行かはパーサでないと出ない。
  // 単体テストはテンプレートの中身を見ているが、こちらは埋め込み・エスケープを通した後の
  // 実物を見るので、生成の段で壊れた場合もここで捕まる。
  const generatedHtml = await readFile(htmlPath, 'utf8')
  const generatedScript = extractInlineScript(generatedHtml)
  if (generatedScript === null) {
    check('report.html に描画コードが埋め込まれている', false, '<script> が見つからない')
  } else {
    const diagnostics = jsSyntaxDiagnostics(generatedScript, 'report.html の描画コード')
    check(
      '生成後の描画コードが JavaScript として構文が通る',
      diagnostics.length === 0,
      diagnostics.join('\n') || `${generatedScript.length} 文字・構文エラーなし`,
    )
  }

  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    const page = await context.newPage()
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    // **stack まで残す。** message だけだと `Unexpected token ')'` の 1 行しか出ず、
    // どこで死んだのかが分からない。全文を持っておいて、失敗したときにそのまま出す。
    page.on('pageerror', (error) => {
      consoleErrors.push(`pageerror: ${error.message}\n${error.stack ?? '(stack なし)'}`)
    })
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
    // 描画コードが例外で死んでいると、以下の検査は全部「0 件」になり、そのあと
    // 要素待ちで 30 秒タイムアウトして落ちる。**原因より先にタイムアウトが出る**ので、
    // ここで例外そのものを出し、続きの検査には進まない。
    // （ビューアの JS は TS のテンプレート文字列なので、構文エラーは tsc では捕まらない。
    //  同じものを src/report/rendering/viewer-script.test.ts が TypeScript のパーサで
    //  先に検査しているが、そこを抜けた実行時例外はここが最後の砦になる。）
    const rendered = consoleErrors.length === 0
    check('ビューアの描画コードが例外なく走る', rendered, consoleErrors.join('\n---\n') || 'エラーなし')
    if (!rendered) {
      log('  描画が死んでいるので、以降のビューア検査は行わない（原因は上の全文）')
      await context.close()
      return
    }

    check(
      '主張一覧に全主張が出る（verified も含めて辿り着ける）',
      (await page.locator('#nav-body .nav-item').count()) === expected.claimCount &&
        (await page.locator(`#nav-body .nav-item[data-claim="${expected.verifiedClaim}"]`).count()) === 1,
      `${await page.locator('#nav-body .nav-item').count()} 件 / ${expected.claimCount} 件`,
    )
    check(
      '要確認の主張には印が付き、verified には付かない',
      (await page
        .locator(`#nav-body .nav-item[data-claim="${expected.partiallyVerifiedClaim}"] .nav-flag`)
        .count()) === 1 &&
        (await page
          .locator(`#nav-body .nav-item[data-claim="${expected.verifiedClaim}"] .nav-flag`)
          .count()) === 0,
      `要確認の印 ${await page.locator('#nav-body .nav-flag').count()} 件`,
    )
    check(
      '上部から巨大な要確認表が消えている',
      (await page.locator('.attention-row').count()) === 0 &&
        (await page.locator('#attention-list').count()) === 0,
      '主張一覧に一本化されている',
    )

    await page.click(`#source-body .seg-claim[data-claim="${expected.verifiedClaim}"]`)
    const detailClaim = await page.getAttribute('#detail-body .claim-detail', 'data-claim')
    const shotSrc = await page.getAttribute('#detail-body img.shot', 'src')
    // 読み込みは非同期なので、クリック直後に見ると間に合わない。待って、待てなかった理由は残す。
    let shotLoadProblem: string | null = null
    try {
      await page.waitForFunction(
        () => {
          const image = document.querySelector('#detail-body img.shot')
          return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
        },
        undefined,
        { timeout: 15_000 },
      )
    } catch (cause) {
      shotLoadProblem = cause instanceof Error ? cause.message : String(cause)
    }
    check(
      '本文の claim をクリックすると右ペインにその claim の詳細が出る',
      detailClaim === expected.verifiedClaim,
      `data-claim=${String(detailClaim)}`,
    )
    check(
      '詳細に相対パスのスクショが出て、実際に読み込める',
      shotSrc === expected.screenshotPath && shotLoadProblem === null,
      `src=${String(shotSrc)} / 読み込み=${shotLoadProblem ?? '成功'}`,
    )
    // 管理情報は初期表示では畳んである（innerText に出ない）。開くと読める、が守りたい振る舞い。
    const metaHiddenAtFirst = !(await page.innerText('#detail-body')).includes('本文 sha256')
    const summaries = page.locator('#detail-body details.more > summary')
    const summaryCount = await summaries.count()
    for (let n = 0; n < summaryCount; n += 1) await summaries.nth(n).click()
    check(
      '管理情報は初期は畳まれ、開くと sha256 まで読める',
      metaHiddenAtFirst && summaryCount > 0 && (await page.innerText('#detail-body')).includes('本文 sha256'),
      `初期は非表示=${metaHiddenAtFirst} / details ${summaryCount} 個`,
    )

    await page.click(`#nav-body .nav-item[data-claim="${expected.partiallyVerifiedClaim}"]`)
    check(
      '主張一覧をクリックすると詳細と本文の選択が揃う',
      (await page.getAttribute('#detail-body .claim-detail', 'data-claim')) ===
        expected.partiallyVerifiedClaim &&
        (await page
          .locator(`#source-body .seg-claim.selected[data-claim="${expected.partiallyVerifiedClaim}"]`)
          .count()) > 0 &&
        (await page
          .locator(
            `#nav-body .nav-item[aria-current="true"][data-claim="${expected.partiallyVerifiedClaim}"]`,
          )
          .count()) === 1,
      expected.partiallyVerifiedClaim,
    )

    await checkFilterMatrix(page, expected.claimCount)

    await page.click('#chip-all')
    await page.click(`#source-body .seg-claim[data-claim="${expected.verifiedClaim}"]`)
    const positionBefore = await page.innerText('#claim-position')
    await page.keyboard.press('j')
    const afterKey = await page.getAttribute('#detail-body .claim-detail', 'data-claim')
    check(
      'j キーで次の claim に移動し、位置表示も進む',
      afterKey !== null &&
        afterKey !== expected.verifiedClaim &&
        (await page.innerText('#claim-position')) !== positionBefore,
      `${expected.verifiedClaim} → ${String(afterKey)} / 位置 ${positionBefore} → ${await page.innerText('#claim-position')}`,
    )
    await page.click('#prev-claim')
    check(
      '「前」ボタンで戻る',
      (await page.getAttribute('#detail-body .claim-detail', 'data-claim')) === expected.verifiedClaim &&
        (await page.innerText('#claim-position')) === positionBefore,
      `位置 ${await page.innerText('#claim-position')}`,
    )

    await checkStepperBoundaries(page, expected.claimCount)
    await checkFilteredNavigationAndPrint(page, expected.claimCount)
    await checkSelectionIsVisible(page, [expected.verifiedClaim, expected.partiallyVerifiedClaim])
    await checkPrintRendering(page, expected.claimCount, {
      nonClaimCount: expected.nonClaimCount,
      exclusionCount: expected.exclusionCount,
    })
    for (const size of [
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
    ]) {
      await checkPanesFitViewport(page, size.width, size.height)
    }
    await page.setViewportSize({ width: 1400, height: 900 })
    await checkTypingDoesNotStealKeys(page)
    await checkKeyboardAndAria(page, [expected.verifiedClaim, expected.partiallyVerifiedClaim])
    await checkLightbox(page)

    check(
      'AI 提出の証拠に警告が出る',
      (await page.innerText('#global-warn')).includes('AI が提出した証拠が 2 件あります'),
      await page.innerText('#global-warn'),
    )
    check(
      '印刷用に全 claim の詳細が並ぶ',
      (await page.locator('#printAll .print-claim').count()) === expected.claimCount,
      `${await page.locator('#printAll .print-claim').count()} 件`,
    )
    check('ブラウザのコンソールにエラーが出ない', consoleErrors.length === 0, consoleErrors.join(' / '))
    await context.close()
  } finally {
    await browser.close()
  }
}

/**
 * 持ち出し用の HTML を、**セッションディレクトリの外**から file:// で開く。
 *
 * report.html と違って画像は相対パスでは辿れない場所にあるので、画像が実際に表示されれば
 * 埋め込みが効いている。文字列に data: が含まれるかを見るだけでは、ビューアが src を組む
 * 段で相対パスに戻していても気づけない。
 */
async function checkExportedHtml(
  htmlPath: string,
  expected: { verifiedClaim: string; screenshotPath: string; claimCount: number },
): Promise<void> {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    const page = await context.newPage()
    const problems: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text())
    })
    page.on('pageerror', (error) => {
      problems.push(`pageerror: ${error.message}\n${error.stack ?? '(stack なし)'}`)
    })
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
    check(
      '持ち出した HTML の描画コードが例外なく走る',
      problems.length === 0,
      problems.join('\n---\n') || 'エラーなし',
    )
    check(
      '持ち出した HTML にも全主張が出る',
      (await page.locator('#nav-body .nav-item').count()) === expected.claimCount,
      `${await page.locator('#nav-body .nav-item').count()} / ${expected.claimCount} 件`,
    )
    await page.click(`#source-body .seg-claim[data-claim="${expected.verifiedClaim}"]`)
    const shotSrc = (await page.getAttribute('#detail-body img.shot', 'src')) ?? ''
    let loadProblem: string | null = null
    try {
      await page.waitForFunction(
        () => {
          const image = document.querySelector('#detail-body img.shot')
          return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
        },
        undefined,
        { timeout: 15_000 },
      )
    } catch (cause) {
      loadProblem = cause instanceof Error ? cause.message : String(cause)
    }
    check(
      'セッションディレクトリの外でも画像が data URI から実際に表示される',
      shotSrc.startsWith('data:image/png;base64,') && loadProblem === null,
      `src=${shotSrc.slice(0, 40)}… / 読み込み=${loadProblem ?? '成功'}`,
    )
    // 表示上のパスは台帳の相対パスのまま（data URI に書き換えていない）。
    const embedded = readEmbeddedJson(await readFile(htmlPath, 'utf8'), 'fact-check-data') as ViewerPayload
    check(
      '台帳の screenshot_path は相対パスのまま、埋め込みは assets に別で持つ',
      embedded.ledger.attachments.some((a) => a.screenshot_path === expected.screenshotPath) &&
        Object.keys(embedded.assets).includes(expected.screenshotPath),
      `assets ${Object.keys(embedded.assets).length} 件`,
    )
    await context.close()
  } finally {
    await browser.close()
  }
}

/** `pnpm viewer` を実際に起動して、一覧とレポートが配られることを確かめる。 */
async function checkViewerServer(sessionId: string): Promise<void> {
  const viewer = spawn('pnpm', ['viewer', '--port', '0'], {
    cwd: ROOT,
    env: { ...process.env, FACT_CHECK_DIR: WORK_DIR } as Record<string, string>,
    // プロセスグループごと終わらせるため（pnpm が起こす子まで残さない）。
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  viewer.stdout.setEncoding('utf8')
  viewer.stderr.setEncoding('utf8')
  viewer.stdout.on('data', (chunk: string) => {
    output += chunk
  })
  viewer.stderr.on('data', (chunk: string) => {
    output += chunk
  })
  try {
    const url = await waitForUrl(() => output)
    if (url === null) {
      check('pnpm viewer が URL を表示して起動する', false, output.trim())
      return
    }
    check('pnpm viewer が URL を表示して起動する', true, url)

    const list = await fetch(url)
    const listHtml = await list.text()
    check(
      'セッション一覧に e2e のセッションが出る',
      list.status === 200 && listHtml.includes(sessionId) && listHtml.includes('e2e テスト'),
      `status=${list.status}`,
    )
    const reportLink = `${url}s/${sessionId}/report.html`
    check(
      '一覧が指す report.html のリンクが載っている',
      listHtml.includes(`/s/${sessionId}/report.html`),
      reportLink,
    )
    const reportResponse = await fetch(reportLink)
    const reportBody = await reportResponse.text()
    check(
      'report.html へのリンクが 200 を返す',
      reportResponse.status === 200 && reportBody.includes('fact-check-data'),
      `status=${reportResponse.status} / ${reportBody.length} バイト`,
    )
    const outside = await fetch(`${url}s/${sessionId}/%2e%2e%2f%2e%2e%2fpackage.json`)
    check('セッションディレクトリの外は配らない', outside.status === 403, `status=${outside.status}`)
  } finally {
    if (viewer.pid !== undefined) {
      try {
        process.kill(-viewer.pid, 'SIGTERM')
      } catch (cause) {
        log(`  [注意] pnpm viewer を終了できなかった: ${String(cause)}`)
      }
    }
  }
}

/** 起動の完了は「URL が出たこと」で判断する。出るまで待ち、出なければ null を返す。 */
async function waitForUrl(read: () => string): Promise<string | null> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const found = /http:\/\/127\.0\.0\.1:\d+\//.exec(read())
    if (found !== null) return found[0]
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return null
}

async function main(): Promise<void> {
  await rm(WORK_DIR, { recursive: true, force: true })
  await mkdir(WORK_DIR, { recursive: true })

  const fixture = await startFixtureServer(PDF_PAGES)
  const articleUrl = fixture.articleUrl
  const pdfUrl = fixture.pdfUrl
  log(`固定ページ配信サーバー: ${articleUrl} / ${pdfUrl}`)

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'dist', 'index.js')],
    env: { ...process.env, FACT_CHECK_DIR: WORK_DIR } as Record<string, string>,
    stderr: 'inherit',
  })
  const client = new Client({ name: 'fact-check-e2e', version: '0.1.0' })
  await client.connect(transport)
  log('MCP サーバーに stdio で接続した')

  try {
    const tools = await client.listTools()
    const names = tools.tools.map((tool) => tool.name).sort()
    check(
      'ツール一覧',
      names.join(',') ===
        [
          'attach_evidence',
          'export_report',
          'fetch_evidence',
          'finalize',
          'get_status',
          'mark_non_claim',
          'read_source_segments',
          'register_claim',
          'register_segments',
          'revise_record',
          'set_verdict',
          'start_session',
          'submit_agent_capture',
        ].join(','),
      names.join(', '),
    )
    check(
      '入力スキーマが公開されている',
      tools.tools.every((tool) => typeof tool.inputSchema === 'object'),
      `${tools.tools.length} 件すべてに inputSchema がある`,
    )

    log('\n[1] start_session')
    const started = await callTool(client, 'start_session', {
      source: { type: 'text', text: SOURCE_TEXT },
      title: 'e2e テスト',
    })
    check('start_session が通る', started.ok, started.ok ? '' : started.text)
    const sessionId = started.data.session_id as string
    const segments = started.data.segments as Array<{ start: number; end: number }>
    check('session_id が返る', typeof sessionId === 'string' && sessionId.length > 0, sessionId)
    check(
      '候補範囲が本文を隙間なく敷き詰める',
      segments[0]?.start === 0 && segments.at(-1)?.end === SOURCE_TEXT.length,
      `${segments.length} 個`,
    )

    log('\n[2] register_segments でまとめて登録する')
    const salesEnd = SOURCE_TEXT.indexOf('営業利益')
    const profitEnd = SOURCE_TEXT.indexOf('海外向け')
    const contractStart = SOURCE_TEXT.indexOf('国内の新規契約')
    const bulkRejected = await callTool(client, 'register_segments', {
      session_id: sessionId,
      items: [
        {
          kind: 'claim',
          start: SOURCE_TEXT.indexOf('当期の売上'),
          end: salesEnd,
          claim: '当期の売上は前年比 120% に達した',
          claim_kind: '数値',
        },
        { kind: 'claim', start: salesEnd, end: 99_999, claim: '本文の外にはみ出した範囲' },
      ],
    })
    check('1 件でも不正なら拒否される', !bulkRejected.ok, bulkRejected.text.split('\n')[0] ?? '')
    check(
      '拒否時にどの item が不正かが分かる',
      bulkRejected.text.includes('items[1]'),
      '不正な item の位置が示されている',
    )
    const afterReject = await callTool(client, 'get_status', { session_id: sessionId })
    check(
      '拒否されたときは 1 件も登録されていない',
      (afterReject.data.summary as { claims: { total: number } }).claims.total === 0,
      'claim 0 件',
    )

    const bulk = await callTool(client, 'register_segments', {
      session_id: sessionId,
      items: [
        {
          kind: 'claim',
          start: SOURCE_TEXT.indexOf('当期の売上'),
          end: salesEnd,
          claim: '当期の売上は前年比 120% に達した',
          claim_kind: '数値',
        },
        {
          kind: 'claim',
          start: salesEnd,
          end: profitEnd,
          claim: '営業利益は前年比 150% に伸びた',
          claim_kind: '数値',
        },
        {
          kind: 'claim',
          start: profitEnd,
          end: contractStart,
          claim: '海外向けの出荷は 412 台だった',
          claim_kind: '数値',
        },
        {
          kind: 'claim',
          start: contractStart,
          end: SOURCE_TEXT.length,
          claim: '国内の新規契約は 37 件だった',
          claim_kind: '数値',
        },
      ],
    })
    check('まとめ登録が通る', bulk.ok, bulk.ok ? '' : bulk.text)
    const registered = (bulk.data.registered ?? []) as Array<{ id: string; kind: string }>
    check('4 件とも登録される', registered.length === 4, `${registered.length} 件`)
    const claimA = { data: { claim_id: registered[0]?.id } }
    const claimB = { data: { claim_id: registered[1]?.id } }
    const claimC = { data: { claim_id: registered[2]?.id } }
    const claimD = { data: { claim_id: registered[3]?.id } }

    log('\n[3] 網羅率不足の状態で finalize を呼ぶ')
    const earlyFinalize = await callTool(client, 'finalize', { session_id: sessionId })
    check('finalize が拒否される', !earlyFinalize.ok, earlyFinalize.text.split('\n')[0] ?? '')
    check('拒否理由に網羅率が出る', earlyFinalize.text.includes('網羅率が'), '網羅率の不足が明示されている')

    log('\n[4] mark_non_claim（1 件ずつの登録）で見出しと空行を埋める')
    const nonClaim = await callTool(client, 'mark_non_claim', {
      session_id: sessionId,
      start: 0,
      end: SOURCE_TEXT.indexOf('当期の売上'),
      reason: '見出しと空行',
    })
    check(
      'non_claim が登録できる',
      nonClaim.ok,
      nonClaim.ok ? String(nonClaim.data.non_claim_id) : nonClaim.text,
    )
    const covered = await callTool(client, 'get_status', { session_id: sessionId })
    const summary = covered.data.summary as { coverage: { percent: string; complete: boolean } }
    check('網羅率が 100% になる', summary.coverage.complete, summary.coverage.percent)

    log('\n[5] fetch_evidence（ローカル HTTP）')
    const evidence = await callTool(client, 'fetch_evidence', {
      session_id: sessionId,
      source: { type: 'url', url: articleUrl },
      discovered_via: 'cited_in_source',
      discovery_note: '元ネタの概要欄に出典として書かれていた',
    })
    check('fetch_evidence が通る', evidence.ok, evidence.ok ? '' : evidence.text)
    check('provenance が http', evidence.data.provenance === 'http', String(evidence.data.provenance))
    check(
      'discovered_via が記録される',
      evidence.data.discovered_via === 'cited_in_source',
      String(evidence.data.discovered_via),
    )
    check(
      'ナビゲーションとフッターは本文から除かれる',
      !String(evidence.data.text).includes('トップ / 業績 / お問い合わせ') &&
        !String(evidence.data.text).includes('実在の組織の業績を示すものではありません'),
      '記事領域だけが抽出されている',
    )
    check(
      '本文からスクリプトの中身が除かれている',
      !String(evidence.data.text).includes('本文テキストに含まれてはいけない'),
      'script 要素の中身は抽出本文に入っていない',
    )
    const evidenceId = evidence.data.evidence_id as string

    log('\n[6] attach_evidence（実在する引用 / 実在しない引用）')
    const goodAttach = await callTool(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claimA.data.claim_id,
      evidence_id: evidenceId,
      quote: '当期の売上は前年比    120%    となり、期初計画をわずかに上回りました。',
      relation: 'supports',
      rationale: '同じ数値が証拠ページに書かれている（空白差は正規化して照合される）',
    })
    check('実在する引用は通る', goodAttach.ok, goodAttach.ok ? '' : goodAttach.text)
    check('引用の実在がツール側で確認される', goodAttach.data.quote_verified === true, 'quote_verified=true')
    const highlightShot = goodAttach.data.screenshot_path as string | null
    check(
      'ハイライト付きスクショが保存される',
      typeof highlightShot === 'string' && highlightShot.endsWith('.png'),
      `${String(highlightShot)} / 但し書き=${String(goodAttach.data.screenshot_note)}`,
    )

    const badAttach = await callTool(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claimB.data.claim_id,
      evidence_id: evidenceId,
      quote: '営業利益は前年比 150% に伸びました。',
      relation: 'supports',
      rationale: '捏造した引用文',
    })
    check('実在しない引用は拒否される', !badAttach.ok, badAttach.text.split('\n')[0] ?? '')
    check(
      '拒否時に近い箇所が示される',
      badAttach.text.includes('最も長く一致した前方部分'),
      '近い箇所の抜粋が添えられている',
    )

    const contradictAttach = await callTool(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claimB.data.claim_id,
      evidence_id: evidenceId,
      quote: '営業利益は前年比 95% にとどまり、前年を下回りました。',
      relation: 'contradicts',
      rationale: '証拠は 95% であり、元ネタの 150% と矛盾する',
    })
    check('矛盾する証拠は通る', contradictAttach.ok, contradictAttach.ok ? '' : contradictAttach.text)
    check(
      '単一ブロック内の引用はハイライト付きで撮れる',
      goodAttach.data.screenshot_note === null,
      `但し書き=${String(goodAttach.data.screenshot_note)}`,
    )

    log('\n[6b] ブロック要素をまたぐ引用でもハイライトが付く')
    const crossBlockAttach = await callTool(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claimA.data.claim_id,
      evidence_id: evidenceId,
      quote: '最大積載量は 2,500 kg to LEO までを想定しています。',
      relation: 'partial',
      rationale: '引用文が 2 つの段落にまたがっている（DOM 側では改行が無い）',
    })
    check(
      'ブロックをまたぐ引用が照合に通る',
      crossBlockAttach.ok,
      crossBlockAttach.ok ? '' : crossBlockAttach.text,
    )
    check(
      'ブロックまたぎでもハイライト付きになる',
      crossBlockAttach.data.screenshot_note === null &&
        typeof crossBlockAttach.data.screenshot_path === 'string',
      `但し書き=${String(crossBlockAttach.data.screenshot_note)} / ${String(crossBlockAttach.data.screenshot_path)}`,
    )

    log('\n[6c] PDF を証拠として取得し、引用箇所のページを描画する')
    const pdfEvidence = await callTool(client, 'fetch_evidence', {
      session_id: sessionId,
      source: { type: 'url', url: pdfUrl },
      discovered_via: 'agent_search',
      discovery_note: '元ネタには無い出典。「overseas shipment 412」で検索して見つけた',
    })
    check('PDF の fetch_evidence が通る', pdfEvidence.ok, pdfEvidence.ok ? '' : pdfEvidence.text)
    check(
      'PDF は HTTP 取得として記録される',
      pdfEvidence.data.provenance === 'http',
      String(pdfEvidence.data.provenance),
    )
    check('PDF のページ数が返る', pdfEvidence.data.pdf_pages === 2, String(pdfEvidence.data.pdf_pages))
    const pdfSaved = pdfEvidence.data.saved as { pdf_path: string | null; text_path: string }
    check(
      '元の PDF バイト列が保存される',
      typeof pdfSaved.pdf_path === 'string' && pdfSaved.pdf_path.endsWith('.pdf'),
      String(pdfSaved.pdf_path),
    )
    check(
      'PDF の本文が抽出される',
      String(pdfEvidence.data.text).includes('The overseas shipment totalled 412 units'),
      '2 ページ目の文が抽出本文に入っている',
    )

    const pdfAttach = await callTool(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claimC.data.claim_id,
      evidence_id: pdfEvidence.data.evidence_id,
      quote: 'The overseas shipment totalled 412 units in the quarter.',
      relation: 'supports',
      rationale: 'PDF の 2 ページ目に同じ数値がある',
    })
    check('PDF の引用が照合に通る', pdfAttach.ok, pdfAttach.ok ? '' : pdfAttach.text)
    check('引用箇所のページ番号が記録される', pdfAttach.data.pdf_page === 2, String(pdfAttach.data.pdf_page))
    check(
      'PDF のページを描画したハイライト付きスクショが保存される',
      pdfAttach.data.screenshot_note === null && typeof pdfAttach.data.screenshot_path === 'string',
      `但し書き=${String(pdfAttach.data.screenshot_note)} / ${String(pdfAttach.data.screenshot_path)}`,
    )
    const pdfShot = pdfAttach.data.screenshot_path as string | null

    log('\n[6d] AI が自分で取得した証拠を submit_agent_capture で提出する')
    const captured = await callTool(client, 'submit_agent_capture', {
      session_id: sessionId,
      url: `${fixture.origin}/agent-only`,
      text: AGENT_CAPTURED_TEXT,
      discovered_via: 'agent_knowledge',
      discovery_note: '元ネタには出典が無く、自分の知識から当たりを付けた（架空）',
      note: 'fetch_evidence では取得できなかったので、自分のブラウザ操作ツールで開いて本文をコピーした（架空）',
    })
    check('submit_agent_capture が通る', captured.ok, captured.ok ? '' : captured.text)
    check(
      'provenance が agent_captured になる',
      captured.data.provenance === 'agent_captured',
      String(captured.data.provenance),
    )
    const capturedAttach = await callTool(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claimD.data.claim_id,
      evidence_id: captured.data.evidence_id,
      quote: '国内の新規契約は37件と発表した。',
      relation: 'partial',
      rationale: '件数は一致するが、対象期間が書かれていない',
    })
    check(
      'AI 提出の証拠にも引用の照合が効く',
      capturedAttach.ok,
      capturedAttach.ok ? '' : capturedAttach.text,
    )
    check(
      'AI 提出の画像は出どころが agent_captured のままになる',
      capturedAttach.data.screenshot_source === null,
      `screenshot_source=${String(capturedAttach.data.screenshot_source)}（画像の提出が無い証拠なので null）`,
    )

    log('\n[6e] expected_terms の照合')
    const missingTerms = await callTool(client, 'submit_agent_capture', {
      session_id: sessionId,
      url: `${fixture.origin}/agent-only-2`,
      text: AGENT_CAPTURED_TEXT,
      discovered_via: 'agent_search',
      expected_terms: ['国内の新規契約', '海外向けの出荷'],
      note: '本文の抽出に失敗していないかを expected_terms で確かめる（架空）',
    })
    check('expected_terms を付けても登録できる', missingTerms.ok, missingTerms.ok ? '' : missingTerms.text)
    const termCheck = missingTerms.data.expected_terms as { checked: boolean; missing: string[] }
    check(
      '本文に無い語が missing として返る',
      termCheck.checked === true && termCheck.missing.join(',') === '海外向けの出荷',
      `checked=${String(termCheck.checked)} / missing=[${termCheck.missing.join(', ')}]`,
    )

    log('\n[6f] 取得元を止めてから画像を作る（保存済みスナップショットから描く）')
    await fixture.close()
    log(`固定ページ配信サーバーを停止した: ${articleUrl}`)
    const offlineFetch = await fetch(articleUrl).then(
      () => 'まだ応答している',
      () => '接続できない',
    )
    check('取得元がもう応答しない', offlineFetch === '接続できない', offlineFetch)
    const offlineAttach = await callTool(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claimA.data.claim_id,
      evidence_id: evidenceId,
      quote: 'The overseas shipment totalled 412 units in the quarter.',
      relation: 'supports',
      rationale: '取得元が落ちていても、保存済みスナップショットから画像を作れることの確認',
    })
    check(
      '取得元が落ちていても画像が作れる',
      offlineAttach.ok &&
        typeof offlineAttach.data.screenshot_path === 'string' &&
        offlineAttach.data.screenshot_note === null,
      `${String(offlineAttach.data.screenshot_path)} / 但し書き=${String(offlineAttach.data.screenshot_note)}`,
    )
    check(
      '画像の出どころが保存済み HTML と記録される',
      offlineAttach.data.screenshot_source === 'saved_html',
      String(offlineAttach.data.screenshot_source),
    )
    check(
      '成功した画像には失敗用の但し書きが付かない',
      goodAttach.data.screenshot_source === 'saved_html' && goodAttach.data.screenshot_note === null,
      `screenshot_source=${String(goodAttach.data.screenshot_source)} / 但し書き=${String(goodAttach.data.screenshot_note)}`,
    )
    check(
      'PDF の画像は出どころが pdf_page になる',
      pdfAttach.data.screenshot_source === 'pdf_page',
      String(pdfAttach.data.screenshot_source),
    )

    log('\n[6g] 保存 HTML で描けない引用は、保存した抽出本文を描いて撮り直す')
    // 固定ページが自分で隠している一節。抽出本文には出るが、保存 HTML を描いた DOM では
    // 描画矩形が取れない。実データの 35 件中 3 件がこの形だった。
    // **ツール側で display:none を解除することはしない。** 代わりに、取得時に保存した
    // 抽出本文のほうを描いて引用箇所を示す（外部にも当たらない）。
    const fallbackAttach = await callTool(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claimA.data.claim_id,
      evidence_id: evidenceId,
      quote: 'The deferred note records 87 exceptions handled during the quarter.',
      relation: 'partial',
      rationale: 'ページ自身が隠している一節（保存 HTML では描画矩形が取れない）',
    })
    check(
      '折りたたみの中の引用でも添付は通る',
      fallbackAttach.ok,
      fallbackAttach.ok ? '' : fallbackAttach.text,
    )
    const fallbackAttempts = fallbackAttach.data.screenshot_attempts as Array<{
      source: string
      path: string | null
      highlighted: boolean
      note: string | null
      adopted: boolean
    }>
    check(
      '保存 HTML では撮れず、保存した抽出本文で撮り直している',
      fallbackAttach.data.screenshot_source === 'saved_text' &&
        fallbackAttempts.length === 2 &&
        fallbackAttempts[0]?.source === 'saved_html' &&
        fallbackAttempts[0]?.highlighted === false &&
        fallbackAttempts[1]?.source === 'saved_text' &&
        fallbackAttempts[1]?.highlighted === true,
      fallbackAttempts.map((a) => `${a.source}:${a.highlighted ? '光った' : '光らず'}`).join(' → '),
    )
    check(
      '2 つの試行の画像が別のパスに残る（上書きしない）',
      fallbackAttempts[0]?.path !== null &&
        fallbackAttempts[1]?.path !== null &&
        fallbackAttempts[0]?.path !== fallbackAttempts[1]?.path,
      `${String(fallbackAttempts[0]?.path)} / ${String(fallbackAttempts[1]?.path)}`,
    )
    for (const attempt of fallbackAttempts) {
      if (attempt.path === null) continue
      const bytes = await stat(path.join(WORK_DIR, sessionId, attempt.path))
      check(
        `試行 ${attempt.source} の画像が実体として保存されている`,
        bytes.size > 1000,
        `${attempt.path} = ${bytes.size} バイト`,
      )
    }
    check(
      '保存 HTML で撮れなかった理由が全文残る',
      typeof fallbackAttach.data.screenshot_note === 'string' &&
        String(fallbackAttach.data.screenshot_note).includes('saved_html') &&
        String(fallbackAttach.data.screenshot_note).includes('描画矩形が取れず'),
      String(fallbackAttach.data.screenshot_note).replace(/\n/g, ' / '),
    )

    log('\n[7] set_verdict')
    const badVerdict = await callTool(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimB.data.claim_id,
      verdict: 'verified',
      rationale: 'supports が無いのに verified にしようとする',
    })
    check('supports が無ければ verified は拒否される', !badVerdict.ok, badVerdict.text.split('\n')[0] ?? '')

    const verdictA = await callTool(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimA.data.claim_id,
      verdict: 'verified',
      rationale: '証拠ページの記述と一致する',
    })
    check('claim 1 を verified にできる', verdictA.ok, verdictA.ok ? '' : verdictA.text)

    log('\n[8] verdict 未設定のまま finalize を呼ぶ')
    const pendingFinalize = await callTool(client, 'finalize', { session_id: sessionId })
    check('finalize が拒否される', !pendingFinalize.ok, pendingFinalize.text.split('\n')[0] ?? '')
    check(
      '未判定の claim_id が示される',
      pendingFinalize.text.includes(String(claimB.data.claim_id)),
      String(claimB.data.claim_id),
    )

    const verdictB = await callTool(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimB.data.claim_id,
      verdict: 'contradicted',
      rationale: '証拠は 95% で、元ネタの 150% とは矛盾する',
    })
    check('claim 2 を contradicted にできる', verdictB.ok, verdictB.ok ? '' : verdictB.text)

    const verdictC = await callTool(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimC.data.claim_id,
      verdict: 'verified',
      rationale: 'PDF の 2 ページ目の記述と一致する',
    })
    check('claim 3 を verified にできる', verdictC.ok, verdictC.ok ? '' : verdictC.text)

    const verdictD = await callTool(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimD.data.claim_id,
      verdict: 'partially_verified',
      rationale: '件数は AI が提出した証拠と一致するが、対象期間が確認できない',
    })
    check('claim 4 を partially_verified にできる', verdictD.ok, verdictD.ok ? '' : verdictD.text)

    log('\n[9] finalize')
    const finalized = await callTool(client, 'finalize', { session_id: sessionId })
    check('finalize が通る', finalized.ok, finalized.ok ? '' : finalized.text)
    const report = finalized.data.report as { markdown: string; json: string; html: string; dir: string }

    log('\n[10] 生成物の確認')
    const reportHtml = await readFile(report.html, 'utf8')
    const reportJson = JSON.parse(await readFile(report.json, 'utf8')) as { ledger: unknown }
    const ledgerOnDisk = JSON.parse(await readFile(path.join(report.dir, 'ledger.json'), 'utf8')) as unknown
    check(
      'report.json の内容が台帳と一致する',
      JSON.stringify(reportJson.ledger) === JSON.stringify(ledgerOnDisk),
      'report.json の ledger と ledger.json が同一',
    )
    const payload = readEmbeddedJson(reportHtml, 'fact-check-data') as ViewerPayload
    const embeddedShots = payload.ledger.attachments.map((a) => a.screenshot_path)
    check(
      'report.html がスクショを相対パスで参照する',
      typeof highlightShot === 'string' &&
        embeddedShots.includes(highlightShot) &&
        embeddedShots.every((shot) => shot === null || (!shot.startsWith('/') && !shot.includes('://'))),
      `${String(highlightShot)} / 参照 ${embeddedShots.filter((shot) => shot !== null).length} 件`,
    )
    check(
      'report.html に元ネタ本文と塗り分けの区間が埋め込まれる',
      payload.source_text === SOURCE_TEXT &&
        payload.spans[0]?.start === 0 &&
        payload.spans.at(-1)?.end === SOURCE_TEXT.length,
      `${payload.spans.length} 区間 / 本文 ${payload.source_text.length} 文字`,
    )
    if (typeof highlightShot === 'string') {
      const shotPath = path.join(report.dir, highlightShot)
      const info = await stat(shotPath)
      const head = await readFile(shotPath)
      check(
        'スクショが PNG として実在する',
        info.size > 0 && head.subarray(1, 4).toString('ascii') === 'PNG',
        `${info.size} バイト`,
      )
    }
    if (typeof pdfShot === 'string') {
      const shotPath = path.join(report.dir, pdfShot)
      const head = await readFile(shotPath)
      check(
        'PDF ページのスクショが PNG として実在する',
        head.length > 0 && head.subarray(1, 4).toString('ascii') === 'PNG',
        `${head.length} バイト`,
      )
    }
    const savedPdf = await readFile(path.join(report.dir, pdfSaved.pdf_path ?? ''))
    check(
      '保存された PDF が PDF として実在する',
      savedPdf.subarray(0, 5).toString('latin1') === '%PDF-',
      `${savedPdf.length} バイト`,
    )

    const reportMarkdown = await readFile(report.markdown, 'utf8')
    check('report.md に判定が出る', reportMarkdown.includes('裏取り済み (verified)'), 'verified が本文にある')
    const attentionSection = reportMarkdown.slice(
      reportMarkdown.indexOf('## 要確認一覧'),
      reportMarkdown.indexOf('## 主張ごとの判定'),
    )
    check(
      'report.md の先頭に要確認一覧が出る',
      reportMarkdown.indexOf('## 要確認一覧') > 0 &&
        reportMarkdown.indexOf('## 要確認一覧') < reportMarkdown.indexOf('## 主張ごとの判定'),
      '集計の直後に一覧がある',
    )
    check(
      '要確認一覧に verified 以外の claim だけが載る',
      attentionSection.includes(String(claimB.data.claim_id)) &&
        attentionSection.includes(String(claimD.data.claim_id)) &&
        !attentionSection.includes(String(claimA.data.claim_id)),
      `${String(claimB.data.claim_id)} と ${String(claimD.data.claim_id)} が載り、${String(claimA.data.claim_id)} は載らない`,
    )
    check(
      'レポートに証拠の出どころが出る',
      reportMarkdown.includes('出どころ: 元ネタが出典として示していた') &&
        reportMarkdown.includes('出どころ: AI が検索などで見つけた'),
      'cited_in_source と agent_search の両方が区別できる',
    )
    check(
      'レポートに引用箇所のページ番号が出る',
      reportMarkdown.includes('PDF 2 ページ目'),
      'PDF のページ番号が本文にある',
    )
    check(
      'report.html の要確認一覧に verified 以外だけが重い順で入る',
      payload.attention.map((item) => item.claim_id).join(',') ===
        [claimB.data.claim_id, claimD.data.claim_id].join(','),
      payload.attention.map((item) => `${item.claim_id}(${item.verdict})`).join(', '),
    )
    check(
      'report.md に矛盾判定が出る',
      reportMarkdown.includes('矛盾 (contradicted)'),
      'contradicted が本文にある',
    )

    let exclusionCount = 0
    let nonClaimCount = 0

    log('\n[10b] 誤登録の取り消しと復元（登録 → 誤添付 → 取消 → 再添付 → 判定 → finalize）')
    // 誤って付けた添付。関係も理由も間違っている、という想定。
    const wrongAttach = await callTool(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claimA.data.claim_id,
      evidence_id: evidenceId,
      quote: '営業利益は前年比 95% にとどまり、前年を下回りました。',
      relation: 'supports',
      rationale: '（誤登録）別の主張の根拠を取り違えて付けた',
    })
    check('誤った添付も登録自体は通る（引用は実在するため）', wrongAttach.ok, wrongAttach.text.slice(0, 120))
    const wrongAttachmentId = String(wrongAttach.data.attachment_id)

    const excludeWrong = await callTool(client, 'revise_record', {
      session_id: sessionId,
      action: 'exclude',
      target_type: 'attachment',
      target_id: wrongAttachmentId,
      reason: '別の主張の根拠を取り違えて付けた',
    })
    check('誤った添付を取り消せる', excludeWrong.ok, excludeWrong.ok ? '' : excludeWrong.text)
    check(
      '取り消しても元の添付レコードは台帳に残る',
      (
        JSON.parse(await readFile(path.join(report.dir, 'ledger.json'), 'utf8')) as {
          attachments: Array<{ id: string }>
        }
      ).attachments.some((a) => a.id === wrongAttachmentId),
      `${wrongAttachmentId} は台帳に残っている`,
    )

    // 根拠消失: claimA の supports は複数あるので、その共通の親である証拠ごと取り消す。
    // 親（証拠）を取り消すと、ぶら下がる添付が一斉に根拠でなくなることの確認も兼ねる。
    const excludeBasis = await callTool(client, 'revise_record', {
      session_id: sessionId,
      action: 'exclude',
      target_type: 'evidence',
      target_id: evidenceId,
      reason: '根拠が無くなる状況を作る（検証用）',
    })
    check('根拠になっていた証拠を取り消せる', excludeBasis.ok, excludeBasis.ok ? '' : excludeBasis.text)
    check(
      '根拠が無くなった判定がその場で報告される',
      (excludeBasis.data.verdicts_without_basis as Array<{ claim_id: string }>).some(
        (item) => item.claim_id === claimA.data.claim_id,
      ),
      JSON.stringify(excludeBasis.data.verdicts_without_basis),
    )
    const blockedFinalize = await callTool(client, 'finalize', { session_id: sessionId })
    check(
      '根拠が無くなった判定のままでは finalize が拒否される',
      !blockedFinalize.ok && blockedFinalize.text.includes('根拠が無くなっている'),
      blockedFinalize.text.split('\n').slice(0, 3).join(' / '),
    )

    // 除外取消（復元）で根拠が戻る。
    const restoreBasis = await callTool(client, 'revise_record', {
      session_id: sessionId,
      action: 'restore',
      target_type: 'evidence',
      target_id: evidenceId,
      reason: 'これは正しい根拠だった',
    })
    check('取り消しを戻せる', restoreBasis.ok, restoreBasis.ok ? '' : restoreBasis.text)
    check(
      '戻した直後に根拠が揃う',
      (restoreBasis.data.verdicts_without_basis as unknown[]).length === 0,
      JSON.stringify(restoreBasis.data.verdicts_without_basis),
    )

    // 親子の復元: 親（主張）を取り消して戻しても、個別に取り消した子（添付）は戻らない。
    const excludeParent = await callTool(client, 'revise_record', {
      session_id: sessionId,
      action: 'exclude',
      target_type: 'claim',
      target_id: String(claimA.data.claim_id),
      reason: '主張の切り方を見直す（検証用）',
    })
    check('親の主張を取り消せる', excludeParent.ok, excludeParent.ok ? '' : excludeParent.text)
    const whileParentExcluded = await callTool(client, 'get_status', { session_id: sessionId })
    check(
      '親を取り消すと網羅率が下がり、その主張の添付も根拠から外れる',
      !(whileParentExcluded.data.summary as { coverage: { complete: boolean } }).coverage.complete,
      `網羅率 complete=${String((whileParentExcluded.data.summary as { coverage: { complete: boolean } }).coverage.complete)}`,
    )
    const restoreParent = await callTool(client, 'revise_record', {
      session_id: sessionId,
      action: 'restore',
      target_type: 'claim',
      target_id: String(claimA.data.claim_id),
      reason: 'やはりこの切り方でよい',
    })
    check('親の主張を戻せる', restoreParent.ok, restoreParent.ok ? '' : restoreParent.text)
    const afterParentRestore = JSON.parse(await readFile(path.join(report.dir, 'ledger.json'), 'utf8')) as {
      exclusions: Array<{ target_id: string; restored: unknown }>
    }
    check(
      '親を戻しても、自分で取り消した子は取り消されたまま',
      afterParentRestore.exclusions.some((e) => e.target_id === wrongAttachmentId && e.restored === null),
      afterParentRestore.exclusions
        .map((e) => `${e.target_id}:${e.restored === null ? '取り消し中' : '復元済み'}`)
        .join(', '),
    )

    // 二重取消・二重復元は黙って成功させず、今の状態を示して拒否する。
    const doubleExclude = await callTool(client, 'revise_record', {
      session_id: sessionId,
      action: 'exclude',
      target_type: 'attachment',
      target_id: wrongAttachmentId,
      reason: '二重取消',
    })
    check(
      '二重取消は「すでに取り消されている」と言って拒否する',
      !doubleExclude.ok && doubleExclude.text.includes('すでに取り消されている'),
      doubleExclude.text.split('\n')[0] ?? '',
    )
    const doubleRestore = await callTool(client, 'revise_record', {
      session_id: sessionId,
      action: 'restore',
      target_type: 'claim',
      target_id: String(claimA.data.claim_id),
      reason: '二重復元',
    })
    check(
      '二重復元は「戻すものが無い」と言って拒否する',
      !doubleRestore.ok && doubleRestore.text.includes('戻すものが無い'),
      doubleRestore.text.split('\n')[0] ?? '',
    )

    // 再添付して判定を付け直し、finalize まで通す。
    const reattach = await callTool(client, 'attach_evidence', {
      session_id: sessionId,
      claim_id: claimA.data.claim_id,
      evidence_id: evidenceId,
      quote: '内訳としては、既存顧客向けの継続利用が全体の 7 割を占めています。',
      relation: 'supports',
      rationale: '取り消したあとに付け直した根拠',
    })
    check('取り消しのあとに付け直せる', reattach.ok, reattach.ok ? '' : reattach.text)
    const reverdict = await callTool(client, 'set_verdict', {
      session_id: sessionId,
      claim_id: claimA.data.claim_id,
      verdict: 'verified',
      rationale: '付け直した根拠で改めて確認した',
    })
    check('判定を付け直せる', reverdict.ok, reverdict.ok ? '' : reverdict.text)

    // 古いレポートが「最新」に見えないこと。
    const staleMarkdown = await readFile(report.markdown, 'utf8')
    check(
      '台帳が変わったあとのレポートに、暫定表示であることが書かれている',
      staleMarkdown.includes('finalize を通していない暫定表示'),
      staleMarkdown.split('\n').slice(0, 4).join(' / '),
    )

    const refinalized = await callTool(client, 'finalize', { session_id: sessionId })
    check('取り消しを整理したあとに finalize が通る', refinalized.ok, refinalized.ok ? '' : refinalized.text)
    const finalMarkdown = await readFile(report.markdown, 'utf8')
    check(
      'finalize すると暫定表示の断りが消える',
      !finalMarkdown.includes('finalize を通していない暫定表示'),
      finalMarkdown.split('\n')[2] ?? '',
    )
    check(
      'report.md に取り消し履歴が全件出る（理由つき）',
      finalMarkdown.includes('## 取り消し履歴') &&
        finalMarkdown.includes('別の主張の根拠を取り違えて付けた') &&
        finalMarkdown.includes('やはりこの切り方でよい'),
      '取り消しと復元の理由が両方載っている',
    )
    const verdictSection = finalMarkdown.slice(0, finalMarkdown.indexOf('## 取り消し履歴'))
    const historySection = finalMarkdown.slice(finalMarkdown.indexOf('## 取り消し履歴'))
    check(
      '取り消した添付は判定の節から外れ、履歴の節にだけ残る',
      !verdictSection.includes('（誤登録）別の主張の根拠を取り違えて付けた') &&
        historySection.includes('（誤登録）別の主張の根拠を取り違えて付けた'),
      `判定の節に出る=${verdictSection.includes('（誤登録）')} / 履歴の節に出る=${historySection.includes('（誤登録）')}`,
    )

    // get_status / finalize / report.json / report.html の集計が一致すること。
    const finalStatus = await callTool(client, 'get_status', { session_id: sessionId })
    const finalJson = JSON.parse(await readFile(report.json, 'utf8')) as {
      summary: { claims: { total: number }; attachments: { total: number }; exclusions: { active: number } }
      ledger: { exclusions: unknown[] }
    }
    const finalHtmlPayload = readEmbeddedJson(
      await readFile(report.html, 'utf8'),
      'fact-check-data',
    ) as ViewerPayload
    const statusSummary = finalStatus.data.summary as {
      claims: { total: number }
      attachments: { total: number }
      exclusions: { active: number; total: number }
    }
    check(
      'get_status / finalize / report.json / report.html の集計が一致する',
      statusSummary.claims.total === finalJson.summary.claims.total &&
        statusSummary.claims.total === finalHtmlPayload.summary.claims.total &&
        statusSummary.attachments.total === finalJson.summary.attachments.total &&
        statusSummary.attachments.total === finalHtmlPayload.summary.attachments.total &&
        statusSummary.exclusions.active === finalJson.summary.exclusions.active &&
        statusSummary.exclusions.active === finalHtmlPayload.summary.exclusions.active,
      `主張 ${statusSummary.claims.total} / 添付 ${statusSummary.attachments.total} / 取り消し中 ${statusSummary.exclusions.active}`,
    )
    exclusionCount = (finalStatus.data.exclusions as unknown[]).length
    nonClaimCount = (finalStatus.data.summary as { non_claims: number }).non_claims

    log('\n[10c] セッションの保管と復元')
    const archived = await callTool(client, 'revise_record', {
      session_id: sessionId,
      action: 'exclude',
      target_type: 'session',
      target_id: sessionId,
      reason: '検証用に一度保管する',
    })
    check('セッションを保管できる', archived.ok, archived.ok ? '' : archived.text)
    const blockedRegister = await callTool(client, 'register_claim', {
      session_id: sessionId,
      start: 0,
      end: 5,
      claim: '保管中の追加',
    })
    check(
      '保管中は台帳を変える操作を受け付けない',
      !blockedRegister.ok && blockedRegister.text.includes('保管されている'),
      blockedRegister.text.split('\n')[0] ?? '',
    )
    const readWhileArchived = await callTool(client, 'get_status', { session_id: sessionId })
    check(
      '保管中でも読み返しはできる',
      readWhileArchived.ok && readWhileArchived.data.archived === true,
      `archived=${String(readWhileArchived.data.archived)}`,
    )
    const unarchived = await callTool(client, 'revise_record', {
      session_id: sessionId,
      action: 'restore',
      target_type: 'session',
      target_id: sessionId,
      reason: '続きをやる',
    })
    check('保管を解除できる', unarchived.ok, unarchived.ok ? '' : unarchived.text)
    const refinalized2 = await callTool(client, 'finalize', { session_id: sessionId })
    check('解除後に finalize し直せる', refinalized2.ok, refinalized2.ok ? '' : refinalized2.text)
    exclusionCount = (
      (await callTool(client, 'get_status', { session_id: sessionId })).data.exclusions as unknown[]
    ).length

    log('\n[10d] 取り消し履歴を持たない旧台帳を読む')
    const legacyDir = path.join(WORK_DIR, 'legacy_session')
    await mkdir(legacyDir, { recursive: true })
    const currentLedger = JSON.parse(await readFile(path.join(report.dir, 'ledger.json'), 'utf8')) as Record<
      string,
      unknown
    > & { session_id: string; attachments: Array<Record<string, unknown>> }
    // 取り消し機能より前の version 2 の台帳を再現する: 新しく足した項目を落とす。
    currentLedger.session_id = 'legacy_session'
    delete currentLedger.exclusions
    delete currentLedger.reports_stale_since
    for (const attachment of currentLedger.attachments) delete attachment.screenshot_attempts
    await writeFile(path.join(legacyDir, 'ledger.json'), `${JSON.stringify(currentLedger, null, 2)}\n`)
    await writeFile(
      path.join(legacyDir, 'source.txt'),
      await readFile(path.join(report.dir, 'source.txt'), 'utf8'),
    )
    const legacyStatus = await callTool(client, 'get_status', { session_id: 'legacy_session' })
    check(
      '取り消し履歴を持たない旧台帳も読める',
      legacyStatus.ok && (legacyStatus.data.exclusions as unknown[]).length === 0,
      legacyStatus.ok ? '取り消し 0 件として読めた' : (legacyStatus.text.split('\n')[0] ?? ''),
    )
    const legacyEdit = await callTool(client, 'revise_record', {
      session_id: 'legacy_session',
      action: 'exclude',
      target_type: 'claim',
      target_id: String(claimA.data.claim_id),
      reason: '旧台帳でも取り消せること',
    })
    check(
      '旧台帳でも取り消しを追記できる',
      legacyEdit.ok,
      legacyEdit.ok ? '' : (legacyEdit.text.split('\n')[0] ?? ''),
    )

    log('\n[11] report.html をブラウザで開いて操作する')
    await checkViewerPage(report.html, {
      partiallyVerifiedClaim: String(claimD.data.claim_id),
      verifiedClaim: String(claimA.data.claim_id),
      screenshotPath: String(highlightShot),
      claimCount: 4,
      nonClaimCount,
      exclusionCount,
    })

    log('\n[11c] export_report でレポートを 1 ファイルの HTML / PDF として持ち出す')
    const exportDir = path.join(WORK_DIR, 'exported')
    const pdfPath = path.join(exportDir, 'fact-check.pdf')
    const exportedPdf = await callTool(client, 'export_report', {
      session_id: sessionId,
      format: 'pdf',
      output_path: pdfPath,
    })
    check('PDF を書き出せる', exportedPdf.ok, exportedPdf.ok ? '' : exportedPdf.text)
    if (exportedPdf.ok) {
      const pdfBytes = await readFile(pdfPath)
      check(
        '書き出したファイルが PDF として実在し、画像を埋め込んでいる',
        pdfBytes.subarray(0, 5).toString('latin1') === '%PDF-' &&
          pdfBytes.length === exportedPdf.data.bytes &&
          Number(exportedPdf.data.inlined_images) >= 1,
        `${pdfBytes.length} バイト / 画像 ${String(exportedPdf.data.inlined_images)} 件`,
      )
      check(
        'finalize 済みなので暫定の警告は付かない',
        exportedPdf.data.reports_stale_since === null && exportedPdf.data.warning === null,
        String(exportedPdf.data.warning),
      )
    }
    const refusedOverwrite = await callTool(client, 'export_report', {
      session_id: sessionId,
      format: 'pdf',
      output_path: pdfPath,
    })
    check(
      '同じ出力先へは overwrite 無しでは書かない',
      !refusedOverwrite.ok && refusedOverwrite.text.includes('出力先に既にファイルがある'),
      refusedOverwrite.text.split('\n')[0] ?? '',
    )
    const exportedHtmlPath = path.join(exportDir, 'standalone', 'fact-check.html')
    const exportedHtml = await callTool(client, 'export_report', {
      session_id: sessionId,
      format: 'html',
      output_path: exportedHtmlPath,
    })
    check('HTML を書き出せる', exportedHtml.ok, exportedHtml.ok ? '' : exportedHtml.text)
    if (exportedHtml.ok) {
      await checkExportedHtml(exportedHtmlPath, {
        verifiedClaim: String(claimA.data.claim_id),
        screenshotPath: String(highlightShot),
        claimCount: 4,
      })
    }

    log('\n[12] pnpm viewer でセッション一覧を配る')
    await checkViewerServer(sessionId)

    log('\n[13] プロセスを再起動してもセッションを再開できる')
    await client.close()
    const transport2 = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'dist', 'index.js')],
      env: { ...process.env, FACT_CHECK_DIR: WORK_DIR } as Record<string, string>,
      stderr: 'inherit',
    })
    const client2 = new Client({ name: 'fact-check-e2e-resume', version: '0.1.0' })
    await client2.connect(transport2)
    const resumed = await callTool(client2, 'get_status', { session_id: sessionId })
    check('別プロセスから同じ session_id で状態が読める', resumed.ok, resumed.ok ? '' : resumed.text)
    check(
      '再開後も網羅率と判定が保たれている',
      (resumed.data.summary as { coverage: { complete: boolean } }).coverage.complete &&
        (resumed.data.claims_without_verdict as unknown[]).length === 0,
      '網羅率 100% / 未判定 0 件',
    )
    await client2.close()
  } finally {
    await fixture.close()
  }

  log(`\n成果物: ${WORK_DIR}`)
  if (failures > 0) {
    log(`\n失敗 ${failures} 件`)
    process.exitCode = 1
    return
  }
  log('\nすべての確認項目が通った')
}

main().catch((error: unknown) => {
  process.stdout.write(`e2e が例外で停止した:\n${String(error instanceof Error ? error.stack : error)}\n`)
  process.exitCode = 1
})
