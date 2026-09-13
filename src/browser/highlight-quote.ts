import { describeCause, FactCheckError } from '../errors.js'
import { escapeHtml } from '../html/escape-html.js'
import { locateQuoteIgnoringWhitespace } from '../quote-matching/find-quote.js'
import { writeSessionFile } from '../session/ledger-store.js'
import { getBrowser } from './browser-pool.js'
import { PAGE_TIMEOUT_MS } from './capture-page.js'

/**
 * 引用箇所までスクロールし、ハイライトを重ねたスクショを撮る。
 *
 * **描くのは取得時に保存したスナップショットで、ライブページではない。** 取り直すと、取得時と
 * 違う内容が写る（記事の差し替え・ログイン要求・レート制限）うえ、取得できたページが画像のときだけ
 * 弾かれることが実際に起きた（HTTP 取得は 200 なのにヘッドレスブラウザだけ 403）。ページが
 * 落ちていても 403 でも画像が残るほうが、証拠として一貫している。引き換えに、外部 CSS と画像が
 * 当たらないので**見た目は元ページと違う**。これは「取得時点の保存内容の描画」であって、
 * 元ページの外観の再現ではない。
 *
 * 外部通信は二重に塞ぐ。JS を無効にしたコンテキストで開き（保存 HTML の中のインライン script を
 * 走らせない）、さらに `context.route` でスナップショット本体以外の要求を全部 abort する。
 * 実在しないホストを割り当てるやり方は render-pdf-page.ts と同じ。
 *
 * 照合そのものは Node 側に任せ、ページ側には「DOM のテキストを集める」と
 * 「与えられたオフセットに枠を描く」しかさせない。照合規則をページ内に複製すると、
 * サーバー側の照合と静かにずれて「引用は在ることになっているのに別の場所が光る」事故に
 * なるため。両方の evaluate は同じ JSHandle（同じテキストノード配列）を使うので、
 * 2 回の走査がずれることもない。
 *
 * **ページへ渡す関数の中に入れ子の関数式を書いてはいけない。** tsx（esbuild の keepNames）は
 * 名前の付く関数式を `__name(fn, "...")` で包む。Playwright はコールバックを toString して
 * ページ内で eval するので、`__name` が未定義のページ側で ReferenceError になる。tsc 出力では
 * 起きないため、dist だけを叩く e2e はこれを通してしまう（実際に 29 件の画像が全滅した）。
 * TreeWalker の filter を使わず、除外はループの中で親タグを見て行う。
 *
 * 位置特定に使うのは findQuote ではなく locateQuoteIgnoringWhitespace。DOM のテキストノードは
 * ブロック要素の境界に空白を持たないので、素直に連結すると `2,500 kg` + `to LEO` が
 * `2,500 kgto LEO` になり、ブロック境界を改行にするスナップショット側（cheerio 由来）と食い違う。
 * 逆にテキストノードを常に空白で継ぐと、今度はインライン要素の継ぎ目に無い空白が入って食い違う。
 * どちらにも倒れないよう、ページ側は区切りを入れて連結し、Node 側は空白を無視して位置を引く。
 * 引用文が実在することは attach_evidence が findQuote で既に確かめている（ここは位置合わせだけ）。
 *
 * ハイライトは DOM を書き換えずに絶対配置の矩形を重ねて描く。surroundContents は
 * 要素境界をまたぐ範囲で失敗し、失敗を隠すと「ハイライト無しのスクショ」を
 * 「ハイライト済み」と偽ることになるため使わない。
 */

/** 実在しないホスト。ここへの要求だけをスナップショットで応答し、他は全部 abort する。 */
const VIRTUAL_ORIGIN = 'https://snapshot.invalid'
const SNAPSHOT_URL = `${VIRTUAL_ORIGIN}/snapshot`

/** 取得時に保存した証拠のスナップショット。html があればそれを、無ければ抽出本文を描く。 */
export type QuoteSnapshot = { kind: 'html'; html: string } | { kind: 'text'; text: string }

export type HighlightOutcome =
  | { screenshotPath: string; highlighted: true; note: null }
  | { screenshotPath: string; highlighted: false; note: string }
  | { screenshotPath: null; highlighted: false; note: string }

export async function captureQuoteHighlight(args: {
  sessionId: string
  /** 証拠の取得元。画像の中には出ない（エラー文と但し書きのため） */
  origin: string
  snapshot: QuoteSnapshot
  quote: string
  screenshotRelativePath: string
}): Promise<HighlightOutcome> {
  let browser: Awaited<ReturnType<typeof getBrowser>>
  try {
    browser = await getBrowser()
  } catch (cause) {
    return { screenshotPath: null, highlighted: false, note: describeCause(cause) }
  }
  // 保存 HTML の中のインライン script を走らせないために JS を切る。この設定でも
  // ハイライト用の page.evaluate / page.evaluateHandle は動くことを実測で確認している
  // （なぜ動くかは確かめていない。Playwright の実装に依存するので、更新時は再確認が要る）。
  const context = await browser.newContext({ javaScriptEnabled: false })
  try {
    // 変数名を document にしない。ページ側へ渡す関数が同じ名前のグローバルを見る。
    const snapshotHtml = snapshotDocument(args.snapshot)
    await context.route('**/*', async (route) => {
      if (route.request().url() === SNAPSHOT_URL) {
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body: snapshotHtml })
        return
      }
      // 保存 HTML が参照する外部 CSS・画像・iframe はここで止める。落とさずに通すと
      // 「取得時点の保存内容を描いた」と言えなくなるうえ、外部の停止や 403 に引きずられる。
      await route.abort()
    })

    const page = await context.newPage()
    const response = await page.goto(SNAPSHOT_URL, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS })
    if (response === null || !response.ok()) {
      const status = response === null ? 'no-response' : `${response.status()} ${response.statusText()}`
      return {
        screenshotPath: null,
        highlighted: false,
        note: `保存済みスナップショットを描画用に開けなかった (origin=${args.origin}, status=${status})`,
      }
    }

    const nodesHandle = await page.evaluateHandle(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      const nodes: Text[] = []
      const spans: Array<{ start: number; end: number }> = []
      let text = ''
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        // TreeWalker の filter を使わないのは、filter オブジェクトに入れ子の関数式が要るため
        // （tsx が __name で包んでページ内 eval が壊れる）。除外はここで親タグを見て行う。
        const tag = node.parentElement?.tagName ?? ''
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue
        const value = (node as Text).nodeValue ?? ''
        const start = text.length
        text += value
        spans.push({ start, end: text.length })
        nodes.push(node as Text)
        // テキストノードの継ぎ目には必ず区切りを入れる。入れないとブロック境界で語がくっつく。
        // Node 側の照合は空白を無視するので、入れ過ぎて困ることはない。
        text += '\n'
      }
      return { nodes, spans, text }
    })

    const domText = await nodesHandle.evaluate((held) => held.text)
    const match = locateQuoteIgnoringWhitespace(domText, args.quote)
    if (match === null) {
      const screenshot = await page.screenshot({ fullPage: true })
      await writeSessionFile(args.sessionId, args.screenshotRelativePath, screenshot)
      return {
        screenshotPath: args.screenshotRelativePath,
        highlighted: false,
        note: `引用文は抽出本文には実在したが、保存済みスナップショットを描いた DOM 側では同じ文字列を見つけられなかったため、ハイライト無しのフルページスクショを保存した (origin=${args.origin})`,
      }
    }

    const painted = await nodesHandle.evaluate((held, span) => {
      let startNode: Text | null = null
      let startOffset = 0
      let endNode: Text | null = null
      let endOffset = 0
      for (let index = 0; index < held.spans.length; index += 1) {
        const nodeSpan = held.spans[index]
        const node = held.nodes[index]
        if (nodeSpan === undefined || node === undefined) continue
        if (startNode === null && nodeSpan.start <= span.start && span.start < nodeSpan.end) {
          startNode = node
          startOffset = span.start - nodeSpan.start
        }
        if (endNode === null && nodeSpan.start < span.end && span.end <= nodeSpan.end) {
          endNode = node
          endOffset = span.end - nodeSpan.start
        }
      }
      if (startNode === null || endNode === null) return false
      const range = document.createRange()
      range.setStart(startNode, startOffset)
      range.setEnd(endNode, endOffset)
      const rects = Array.from(range.getClientRects())
      if (rects.length === 0) return false
      const layer = document.createElement('div')
      layer.style.cssText =
        'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none'
      document.body.appendChild(layer)
      for (const rect of rects) {
        const box = document.createElement('div')
        box.style.cssText = [
          'position:absolute',
          `left:${rect.left + window.scrollX}px`,
          `top:${rect.top + window.scrollY}px`,
          `width:${rect.width}px`,
          `height:${rect.height}px`,
          'background:rgba(255,214,0,0.42)',
          'outline:2px solid #e08b00',
          'border-radius:2px',
        ].join(';')
        layer.appendChild(box)
      }
      const first = rects[0]
      if (first !== undefined) {
        window.scrollTo({
          top: Math.max(0, first.top + window.scrollY - window.innerHeight / 3),
          behavior: 'instant',
        })
      }
      return true
    }, match)

    // 抽出本文を描いた画像は**必ず全ページで撮る**。ビューポートだけを撮ると、
    // 引用箇所までスクロールした結果、画面上端の行が但し書きの帯に隠れて切れる（実測）。
    // 全ページなら帯は先頭に 1 度だけ描かれ、その分は pre の上余白が確保しているので、
    // 本文が 1 行も欠けない。保存 HTML のほうは元の見た目を保つためこれまでどおり。
    const fullPage = !painted || args.snapshot.kind === 'text'
    const screenshot = await page.screenshot({ fullPage })
    await writeSessionFile(args.sessionId, args.screenshotRelativePath, screenshot)
    if (!painted) {
      return {
        screenshotPath: args.screenshotRelativePath,
        highlighted: false,
        note: `引用箇所は DOM 上で特定できたが、描画矩形が取れず（非表示要素の可能性）ハイライトを重ねられなかった (origin=${args.origin})`,
      }
    }
    return { screenshotPath: args.screenshotRelativePath, highlighted: true, note: null }
  } catch (cause) {
    // ここで潰すのは「スクショが撮れなかった」だけ。attach_evidence 自体は引用照合に
    // 通っている以上成立させ、撮れなかった事実は返り値と台帳とレポートに残す（指示どおり）。
    return {
      screenshotPath: null,
      highlighted: false,
      note: describeCause(
        FactCheckError.fromCause(
          `保存済みスナップショットからのハイライト付きスクショの取得に失敗した (origin=${args.origin})`,
          cause,
        ),
      ),
    }
  } finally {
    await context.close()
  }
}

/**
 * 画像の中に焼き込む但し書き。
 *
 * 抽出本文を描いた画像は、元ページのレイアウトを一切持たない素のテキストになる。それでも
 * **レポートの外に画像だけ持ち出されたとき**に、元ページを実際に撮ったキャプチャだと
 * 読み違えられる余地は残る。台帳とレポートの screenshot_source だけでなく、画像そのものにも
 * 出どころを書く。
 *
 * **通常の流れに置く（position:fixed にしない）。** 固定にすると、全ページ撮影のときに
 * 帯がスクロール位置のまま画像の途中に写り込み、その行の本文が隠れて切れる（実測）。
 * 抽出本文の画像は必ず全ページで撮るので、先頭に普通に置けば必ず写り、何も隠さない。
 */
const TEXT_SNAPSHOT_BANNER =
  '取得時に保存した抽出本文を描画したものです。元ページの実キャプチャではありません。'

/**
 * 描画するページを組み立てる。
 *
 * HTML のスナップショットはそのまま渡す（取得時の DOM をできるだけ変えない）。HTML を持たない
 * 証拠（text/plain の URL）と、HTML では引用箇所を描けなかった証拠は抽出本文しか無いので、
 * escape して等幅で流し込む。どちらも「取得時点の保存内容」であることに変わりはない。
 *
 * 但し書きの帯は DOM のテキストにも入るが、位置合わせには影響しない。位置は引用文そのものを
 * DOM 全体のテキストから探して決めており、帯の文言が引用文と一致することはない。
 */
function snapshotDocument(snapshot: QuoteSnapshot): string {
  if (snapshot.kind === 'html') return snapshot.html
  return [
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">',
    '<style>body{margin:0;background:#fff;color:#111}',
    '.snapshot-banner{background:#4a3000;color:#fff;padding:8px 14px;',
    'font:600 13px/1.5 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}',
    'pre{margin:0;padding:16px 24px 24px;white-space:pre-wrap;word-break:break-word;',
    'font:14px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}</style>',
    '</head><body><div class="snapshot-banner">',
    escapeHtml(TEXT_SNAPSHOT_BANNER),
    '</div><pre>',
    escapeHtml(snapshot.text),
    '</pre></body></html>',
  ].join('')
}
