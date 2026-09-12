import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import { describeCause } from '../errors.js'
import { renderSessionList } from './render-list.js'
import { listSessions, SESSION_ID_PATTERN } from './sessions.js'

/**
 * セッション一覧を配る小さなローカルサーバー。
 *
 * 読むだけ。台帳も report.html も書き換えない（書き込みの入口は MCP ツールと report:rebuild に
 * 限る）。待受は 127.0.0.1 だけで、配るのはセッションディレクトリ配下の決まった拡張子だけ。
 * レポートは相対パスでスクショを参照するので、`/s/<session_id>/report.html` という配置にして
 * 同じ相対パスがそのまま解決するようにしている。
 */

const HOST = '127.0.0.1'
const SESSION_PREFIX = '/s/'

/** 配ってよい拡張子。証拠のスナップショットまで含める（読み手が原本に当たれるように）。 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
}

export type ViewerServer = { url: string; port: number; close: () => Promise<void> }

export async function startViewerServer(args: { baseDir: string; port: number }): Promise<ViewerServer> {
  const server = createServer((request, response) => {
    handle(args.baseDir, request, response).catch((cause: unknown) => {
      send(response, 500, 'text/plain; charset=utf-8', `内部エラー: ${describeCause(cause)}\n`)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(args.port, HOST, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await closeServer(server)
    throw new Error('ビューアの待受アドレスが取れなかった')
  }
  return {
    url: `http://${HOST}:${address.port}/`,
    port: address.port,
    close: () => closeServer(server),
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((cause) => (cause === undefined ? resolve() : reject(cause)))
  })
}

async function handle(baseDir: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(response, 405, 'text/plain; charset=utf-8', '読み取り専用のサーバーなので GET だけを受け付ける\n')
    return
  }
  const requestPath = decodePath(new URL(request.url ?? '/', 'http://localhost').pathname)
  if (requestPath === null) {
    send(response, 400, 'text/plain; charset=utf-8', 'URL のパスを読めない\n')
    return
  }
  if (requestPath === '/' || requestPath === '/index.html') {
    const rows = await listSessions(baseDir)
    send(response, 200, 'text/html; charset=utf-8', renderSessionList({ baseDir, rows }))
    return
  }
  if (requestPath.startsWith(SESSION_PREFIX)) {
    await serveSessionFile(baseDir, requestPath.slice(SESSION_PREFIX.length), response)
    return
  }
  send(response, 404, 'text/plain; charset=utf-8', `そのパスは配っていない (${requestPath})\n`)
}

function decodePath(pathname: string): string | null {
  try {
    const decoded = decodeURIComponent(pathname)
    return decoded.includes('\0') ? null : decoded
  } catch {
    return null
  }
}

/**
 * セッションディレクトリ配下のファイルを配る。
 *
 * session_id を形で縛ったうえで、実際に開くパスがそのセッションのディレクトリの内側に
 * 収まっていることも確かめる。前者だけだと `..` を含む残りのパスで外に出られる。
 */
async function serveSessionFile(baseDir: string, rest: string, response: ServerResponse): Promise<void> {
  const slash = rest.indexOf('/')
  const sessionId = slash === -1 ? rest : rest.slice(0, slash)
  const relative = slash === -1 ? '' : rest.slice(slash + 1)
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    send(response, 400, 'text/plain; charset=utf-8', `session_id の形が不正 (${sessionId})\n`)
    return
  }
  if (relative === '') {
    send(response, 404, 'text/plain; charset=utf-8', 'ファイル名が無い（例: report.html）\n')
    return
  }
  const root = path.join(path.resolve(baseDir), sessionId)
  const target = path.resolve(root, relative)
  if (target !== root && !target.startsWith(root + path.sep)) {
    send(response, 403, 'text/plain; charset=utf-8', 'セッションディレクトリの外は配らない\n')
    return
  }
  const contentType = CONTENT_TYPES[path.extname(target).toLowerCase()]
  if (contentType === undefined) {
    send(
      response,
      415,
      'text/plain; charset=utf-8',
      `配るのは ${Object.keys(CONTENT_TYPES).join(' / ')} だけ (${path.basename(target)})\n`,
    )
    return
  }
  let size: number
  try {
    const info = await stat(target)
    if (!info.isFile()) {
      send(response, 404, 'text/plain; charset=utf-8', 'ファイルではない\n')
      return
    }
    size = info.size
  } catch (cause) {
    send(response, 404, 'text/plain; charset=utf-8', `見つからない: ${describeCause(cause)}\n`)
    return
  }
  response.writeHead(200, { 'content-type': contentType, 'content-length': String(size) })
  createReadStream(target)
    .on('error', (cause) => {
      // ヘッダは送り終えているので本文を差し替えられない。切って、理由をサーバー側に残す。
      process.stderr.write(`ファイルの読み出しに失敗した (path=${target}): ${describeCause(cause)}\n`)
      response.destroy()
    })
    .pipe(response)
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': String(Buffer.byteLength(body)),
  })
  response.end(body)
}
