import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSamplePdf } from './build-sample-pdf.js'

/**
 * e2e が使う固定ページの配信。外部サイトには一切アクセスせず、localhost だけで完結させる。
 *
 * 置き場所を e2e/fixtures/ にしてあるのは、これを使う e2e が 2 本あるため
 * （dist を叩く run-e2e.ts と、tsx 経由で本物のサーバーに繋ぐ run-dev-mcp-e2e.ts）。
 * 片方にだけ置くともう片方が同じサーバーを書き写すことになる。
 *
 * close() は「取得後にページが消えても画像が作れる」ことを確かめるのにも使う。証拠の画像は
 * 取得時に保存したスナップショットから作るので、ここを止めた後でも attach_evidence は成功する。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))

export type FixtureServer = {
  origin: string
  articleUrl: string
  pdfUrl: string
  close: () => Promise<void>
}

export async function startFixtureServer(pdfPages: readonly string[][]): Promise<FixtureServer> {
  const html = await readFile(path.join(HERE, 'sample-article.html'), 'utf8')
  const pdf = buildSamplePdf(pdfPages)
  const server = createServer((request, response) => {
    if (request.url === '/article') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
      return
    }
    if (request.url === '/filing.pdf') {
      response.writeHead(200, { 'content-type': 'application/pdf' })
      response.end(pdf)
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('固定ページ配信サーバーの待受アドレスが取れない')
  }
  const origin = `http://127.0.0.1:${address.port}`
  // 「取得元を止めても画像が作れる」ことを試す e2e は本文の途中で止め、finally でももう一度呼ぶ。
  // 2 度目を ERR_SERVER_NOT_RUNNING で失敗させると、後片付けが検証の本題を隠してしまう。
  let closed = false
  return {
    origin,
    articleUrl: `${origin}/article`,
    pdfUrl: `${origin}/filing.pdf`,
    close: async () => {
      if (closed) return
      closed = true
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}
