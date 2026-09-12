import { describeCause, FactCheckError } from '../errors.js'
import { locateQuoteIgnoringWhitespace } from '../quote-matching/find-quote.js'
import { writeSessionFile } from '../session/ledger-store.js'
import { getBrowser } from './browser-pool.js'
import { PAGE_TIMEOUT_MS } from './capture-page.js'

/**
 * 引用箇所までスクロールし、ハイライトを重ねたスクショを撮る。
 *
 * 照合そのものは Node 側に任せ、ページ側には「DOM のテキストを集める」と
 * 「与えられたオフセットに枠を描く」しかさせない。照合規則をページ内に複製すると、
 * サーバー側の照合と静かにずれて「引用は在ることになっているのに別の場所が光る」事故に
 * なるため。両方の evaluate は同じ JSHandle（同じテキストノード配列）を使うので、
 * 2 回の走査がずれることもない。
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

export type HighlightOutcome =
  | { screenshotPath: string; highlighted: true; note: null }
  | { screenshotPath: string; highlighted: false; note: string }
  | { screenshotPath: null; highlighted: false; note: string }

export async function captureQuoteHighlight(args: {
  sessionId: string
  url: string
  quote: string
  screenshotRelativePath: string
}): Promise<HighlightOutcome> {
  let browser: Awaited<ReturnType<typeof getBrowser>>
  try {
    browser = await getBrowser()
  } catch (cause) {
    return { screenshotPath: null, highlighted: false, note: describeCause(cause) }
  }
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    const response = await page.goto(args.url, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS })
    if (response === null || !response.ok()) {
      const status = response === null ? 'no-response' : `${response.status()} ${response.statusText()}`
      return {
        screenshotPath: null,
        highlighted: false,
        note: `ハイライト用にページを開けなかった (url=${args.url}, status=${status})`,
      }
    }

    const nodesHandle = await page.evaluateHandle(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const tag = node.parentElement?.tagName ?? ''
          const skipped = tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE'
          return skipped ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
        },
      })
      const nodes: Text[] = []
      const spans: Array<{ start: number; end: number }> = []
      let text = ''
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
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
        note: `引用文はスナップショット本文には実在したが、ブラウザで開いた DOM 側では同じ文字列を見つけられなかったため、ハイライト無しのフルページスクショを保存した (url=${args.url})`,
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

    const screenshot = await page.screenshot({ fullPage: !painted })
    await writeSessionFile(args.sessionId, args.screenshotRelativePath, screenshot)
    if (!painted) {
      return {
        screenshotPath: args.screenshotRelativePath,
        highlighted: false,
        note: `引用箇所は DOM 上で特定できたが、描画矩形が取れず（非表示要素の可能性）ハイライトを重ねられなかった (url=${args.url})`,
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
        FactCheckError.fromCause(`ハイライト付きスクショの取得に失敗した (url=${args.url})`, cause),
      ),
    }
  } finally {
    await context.close()
  }
}
