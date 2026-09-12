import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { statSync, watch } from 'node:fs'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { describeCause } from '../../src/errors.js'
import { type ShimAction, ShimCore } from './shim-core.js'

/**
 * `pnpm dev:mcp` の本体。ローカルのソースのまま MCP クライアントに繋ぎ、ソースを保存したら
 * つなぎ直さずに反映させるための薄い前段（シム）。
 *
 * stdio の MCP サーバーはクライアントがプロセスを起動して繋ぎっぱなしにするので、ファイル変更で
 * 素朴にプロセスを再起動すると接続が切れる（新しいプロセスは initialize を受け取っておらず、
 * クライアントも送り直さない）。そこでクライアントとの接続はこのプロセスが保ったまま、内側の
 * 子プロセスだけを入れ替える。何をいつやるかの判断は shim-core.ts が持ち、ここは I/O だけを担う。
 *
 * stdout は JSON-RPC 専用。このプロセス自身の出力は 1 バイトも混ぜず、必ず stderr に出す。
 */

const DEFAULT_SERVER_COMMAND = 'tsx src/index.ts'
const DEFAULT_WATCH_DIR = 'src'
/** 変更をまとめる時間。保存 1 回で複数イベントが飛ぶので、これで 1 回の再起動にする。 */
const DEBOUNCE_MS = 300
/** SIGTERM で終わるのを待つ時間。過ぎたら SIGKILL。 */
const TERM_GRACE_MS = 2000
/** 終了時に子の後片付けを待つ上限。 */
const EXIT_GRACE_MS = TERM_GRACE_MS + 500

const SERVER_FLAG = '--server'
const WATCH_FLAG = '--watch'

type Options = { command: string; args: string[]; watchDir: string }

/** 子の stdio は ['pipe', 'pipe', 'inherit']。stderr は自分の stderr に直結するので null になる。 */
type ShimChild = ChildProcessByStdio<Writable, Readable, null>

/** 知らない引数は黙って捨てず落とす（綴り間違いで既定値のまま動くのを防ぐ）。 */
function parseArgs(argv: readonly string[]): Options {
  let serverCommand = DEFAULT_SERVER_COMMAND
  let watchDir = DEFAULT_WATCH_DIR
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag !== SERVER_FLAG && flag !== WATCH_FLAG) {
      throw new Error(`知らない引数: ${String(flag)}（使えるのは ${SERVER_FLAG} と ${WATCH_FLAG} だけ）`)
    }
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`${flag} に値がない`)
    if (flag === SERVER_FLAG) serverCommand = value
    else watchDir = value
    i += 1
  }
  const parts = serverCommand
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '')
  const [command, ...args] = parts
  if (command === undefined) throw new Error(`${SERVER_FLAG} が空`)
  return { command, args, watchDir }
}

function log(message: string): void {
  process.stderr.write(`[dev-mcp] ${message}\n`)
}

/** 失敗はスタックごと出す。行数を削って原因を消さない。 */
function reportFailure(context: string, error: unknown): void {
  const detail = error instanceof Error && error.stack !== undefined ? error.stack : describeCause(error)
  process.stderr.write(`[dev-mcp] ${context}: ${detail}\n`)
}

class ShimRunner {
  private readonly core = new ShimCore()
  private child: ShimChild | null = null
  private killTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private readonly changedPaths = new Set<string>()
  private exiting = false

  constructor(private readonly options: Options) {}

  run(): void {
    const stat = statSync(this.options.watchDir)
    if (!stat.isDirectory()) throw new Error(`${WATCH_FLAG} がディレクトリではない: ${this.options.watchDir}`)

    // クライアントの読み取りを先に始める。子の起動より先に来た行は状態機械が溜める。
    const clientReader = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
    clientReader.on('line', (line) => {
      if (line.trim() === '') return
      this.apply(this.core.handleClientLine(line))
    })
    clientReader.on('close', () => this.apply(this.core.handleClientClosed()))
    process.stdout.on('error', (error) => reportFailure('クライアントへの stdout が壊れた', error))

    const watcher = watch(this.options.watchDir, { recursive: true }, (_event, filename) => {
      this.changedPaths.add(filename === null ? '(名前の取れない変更)' : filename)
      this.scheduleRestart()
    })
    watcher.on('error', (error) => reportFailure(`${this.options.watchDir} の監視が失敗した`, error))

    log(
      `起動: サーバー "${[this.options.command, ...this.options.args].join(' ')}" / 監視 "${this.options.watchDir}"`,
    )
    this.apply(this.core.start())
  }

  private scheduleRestart(): void {
    if (this.restartTimer !== null) clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      const reason = [...this.changedPaths].join(', ')
      this.changedPaths.clear()
      this.apply(this.core.requestRestart(reason))
    }, DEBOUNCE_MS)
  }

  private apply(actions: readonly ShimAction[]): void {
    for (const action of actions) {
      switch (action.kind) {
        case 'log':
          log(action.message)
          break
        case 'to_client':
          this.writeLine(process.stdout, action.line, 'クライアント')
          break
        case 'to_child': {
          const target = this.child
          if (target === null) throw new Error('子プロセスが無いのに送ろうとした（状態機械の不整合）')
          this.writeLine(target.stdin, action.line, '子プロセス')
          break
        }
        case 'spawn_child':
          this.spawnChild()
          break
        case 'stop_child':
          this.stopChild(action.reason)
          break
        case 'exit':
          this.finish()
          break
      }
    }
  }

  /**
   * 書き込みの失敗は握りつぶさず stderr に全文で出す。ここで投げると、相手が先に閉じただけで
   * 開発ループ全体が落ちてしまい、原因の stderr も読めなくなる。
   */
  private writeLine(stream: NodeJS.WritableStream, line: string, label: string): void {
    stream.write(`${line}\n`, (error) => {
      if (error !== null && error !== undefined) reportFailure(`${label} への書き込みに失敗した`, error)
    })
  }

  private spawnChild(): void {
    // 環境変数（FACT_CHECK_DIR など）はそのまま渡す。子の stderr は自分の stderr に直結する。
    const spawned = spawn(this.options.command, this.options.args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: process.env,
      cwd: process.cwd(),
    })
    this.child = spawned

    spawned.on('spawn', () => this.apply(this.core.handleChildSpawned()))
    spawned.on('error', (error) => {
      reportFailure('子プロセスを起動できなかった', error)
      this.forgetChild(spawned, describeCause(error))
    })
    spawned.on('exit', (code, signal) => {
      this.forgetChild(spawned, `code=${String(code)} signal=${String(signal)}`)
    })
    spawned.stdin.on('error', (error) => reportFailure('子プロセスの stdin が壊れた', error))
    spawned.stdout.on('error', (error) => reportFailure('子プロセスの stdout が壊れた', error))

    const childReader = createInterface({ input: spawned.stdout, crlfDelay: Number.POSITIVE_INFINITY })
    childReader.on('line', (line) => {
      if (line.trim() === '') return
      if (this.child !== spawned) {
        log(`入れ替え済みの子プロセスからの行を捨てた: ${line}`)
        return
      }
      this.apply(this.core.handleChildLine(line))
    })
  }

  /** 起動失敗（error）と終了（exit）の両方が来ることがあるので、先に来たほうだけを 1 回扱う。 */
  private forgetChild(spawned: ShimChild, detail: string): void {
    if (this.child !== spawned) return
    this.child = null
    this.clearKillTimer()
    this.apply(this.core.handleChildExit(detail))
  }

  private stopChild(reason: string): void {
    const target = this.child
    if (target === null) {
      log(`止める子プロセスがもう居ない（${reason}）`)
      return
    }
    log(`子プロセスに SIGTERM を送る（${reason}）`)
    target.kill('SIGTERM')
    this.clearKillTimer()
    this.killTimer = setTimeout(() => {
      if (this.child !== target) return
      log(`${TERM_GRACE_MS}ms たっても終わらないので SIGKILL する`)
      target.kill('SIGKILL')
    }, TERM_GRACE_MS)
    this.killTimer.unref()
  }

  private clearKillTimer(): void {
    if (this.killTimer === null) return
    clearTimeout(this.killTimer)
    this.killTimer = null
  }

  private finish(): void {
    if (this.exiting) return
    this.exiting = true
    const remaining = this.child
    if (remaining === null) {
      process.exit(0)
    }
    remaining.on('exit', () => process.exit(0))
    setTimeout(() => {
      log('子プロセスの終了を待ちきれなかったので、そのまま終了する')
      process.exit(0)
    }, EXIT_GRACE_MS).unref()
  }
}

new ShimRunner(parseArgs(process.argv.slice(2))).run()
