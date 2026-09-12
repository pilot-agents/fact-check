import { describeCause } from '../../src/errors.js'

/**
 * ホットリロード用シムの中身。プロセス起動・fs.watch・stdio を一切知らない純粋な部分。
 *
 * 出来事（クライアントから 1 行来た／子が終わった／変更を検知した）を受け取り、
 * 外の世界にやってほしいこと（ShimAction の列）を返すだけにしてある。こうしておくと
 * 「再起動中に来た呼び出しを溜めたか」「応答待ちにエラーを返したか」「initialize の応答を
 * 読み捨てたか」を、プロセスを 1 つも起動せずにそのまま試験できる。
 *
 * JSON-RPC の行は id と method を読むだけで、中身は書き換えない。中継するのは常に元の行そのまま。
 */

/** 再起動でリクエストを中断したときの code。JSON-RPC が実装側に開けている -32000..-32099 の先頭。 */
export const RESTART_INTERRUPTED_CODE = -32000
/** 子プロセスが動いていないために処理できなかったときの code。再起動中断と区別できるように分ける。 */
export const CHILD_DOWN_CODE = -32001

/** MCP の初期化完了通知。再起動のたびに新しい子へ送り直す。 */
export const INITIALIZED_NOTIFICATION = 'notifications/initialized'
/** ツール定義が変わったかもしれないことをクライアントに知らせる通知。 */
export const TOOL_LIST_CHANGED_NOTIFICATION = 'notifications/tools/list_changed'

export type RpcId = string | number

/**
 * 子プロセスの今の様子。
 * - `no_child`: 子が居ない。放っておいても戻らない（起動失敗・異常終了の後）
 * - `starting`: 子を立ち上げている最中（古い子の停止待ちを含む）。まだ使えない
 * - `initializing`: 新しい子に initialize を送り直し、その応答を待っている
 * - `running`: そのまま中継してよい
 */
export type ShimState = 'no_child' | 'starting' | 'initializing' | 'running'

export type ShimAction =
  | { kind: 'to_child'; line: string }
  | { kind: 'to_client'; line: string }
  | { kind: 'log'; message: string }
  | { kind: 'spawn_child' }
  | { kind: 'stop_child'; reason: string }
  | { kind: 'exit' }

/** 振り分けに要る最小限だけ。id が null なら通知、method が null なら応答。 */
export type RpcEnvelope = { id: RpcId | null; method: string | null }

export type ParseOutcome = { ok: true; envelope: RpcEnvelope } | { ok: false; reason: string }

/**
 * 1 行を JSON-RPC として読む。読めなかったことは呼び出し元に理由付きで返す（黙って捨てない）。
 * 読めなくても中継はするので、ここでの失敗は「振り分けの手がかりが無い」以上の意味を持たない。
 */
export function parseRpcEnvelope(line: string): ParseOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    return { ok: false, reason: describeCause(error) }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `JSON-RPC のオブジェクトではない: ${typeof parsed}` }
  }
  const record = parsed as Record<string, unknown>
  const rawId = record.id
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null
  const method = typeof record.method === 'string' ? record.method : null
  return { ok: true, envelope: { id, method } }
}

export function errorResponseLine(id: RpcId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}

export function notificationLine(method: string): string {
  return JSON.stringify({ jsonrpc: '2.0', method })
}

function describeEnvelope(envelope: RpcEnvelope | null): string {
  if (envelope === null) return '読めなかった行'
  if (envelope.method === null) return `応答 id=${String(envelope.id)}`
  if (envelope.id === null) return `通知 ${envelope.method}`
  return `リクエスト ${envelope.method} id=${String(envelope.id)}`
}

type RememberedInitialize = { line: string; id: RpcId }

export type ShimSnapshot = {
  state: ShimState
  childAlive: boolean
  /** 応答待ちのリクエスト。`id=method` の形で、送った順。 */
  pending: string[]
  /** 子の入れ替え中に溜めたクライアントからの行。 */
  buffered: string[]
  rememberedInitializeId: RpcId | null
  rememberedInitializeAnswered: boolean
  rememberedInitialized: boolean
}

export class ShimCore {
  private state: ShimState = 'no_child'
  private childAlive = false
  /** stop_child を出して子の終了を待っている最中か。終わったら新しい子を起動する。 */
  private awaitingExitForRestart = false
  /** クライアントが切れて、後片付けとして子を終わらせている最中か。起動失敗と取り違えないため。 */
  private shuttingDown = false
  private initializeRequest: RememberedInitialize | null = null
  /** 覚えた initialize に、子が既に応答を返してクライアントへ届いたか。送り直しはこれが立ってからだけ。 */
  private initializeAnswered = false
  private initializedNotification: string | null = null
  /** クライアント → 子 に投げたまま応答が返っていないリクエスト。id → method。 */
  private readonly pending = new Map<RpcId, string>()
  /** 子を入れ替えている間にクライアントから来た行。順番のまま溜める。 */
  private readonly buffered: string[] = []

  snapshot(): ShimSnapshot {
    return {
      state: this.state,
      childAlive: this.childAlive,
      pending: [...this.pending].map(([id, method]) => `${String(id)}=${method}`),
      buffered: [...this.buffered],
      rememberedInitializeId: this.initializeRequest?.id ?? null,
      rememberedInitializeAnswered: this.initializeAnswered,
      rememberedInitialized: this.initializedNotification !== null,
    }
  }

  /** 最初の 1 回だけ。ここから子の起動が始まる。 */
  start(): ShimAction[] {
    if (this.state !== 'no_child' || this.childAlive) {
      throw new Error(`start は最初の 1 回だけ呼べる（現在: ${this.state}）`)
    }
    this.state = 'starting'
    return [{ kind: 'log', message: '子プロセスを起動する' }, { kind: 'spawn_child' }]
  }

  handleClientLine(line: string): ShimAction[] {
    const outcome = parseRpcEnvelope(line)
    if (!outcome.ok) {
      return [
        { kind: 'log', message: `クライアントからの行を JSON-RPC として読めなかった: ${outcome.reason}` },
        ...this.forwardToChild(line, null),
      ]
    }
    const actions: ShimAction[] = []
    const { id, method } = outcome.envelope
    // 覚えるのは中継とは別に必ずやる。子が落ちていて中継できない間に来ても取りこぼさないため。
    if (method === 'initialize' && id !== null) {
      this.initializeRequest = { line, id }
      actions.push({ kind: 'log', message: `initialize を覚えた（id=${String(id)}）` })
    }
    if (method === INITIALIZED_NOTIFICATION) {
      this.initializedNotification = line
      actions.push({ kind: 'log', message: `${INITIALIZED_NOTIFICATION} を覚えた` })
    }
    actions.push(...this.forwardToChild(line, outcome.envelope))
    return actions
  }

  handleChildLine(line: string): ShimAction[] {
    const outcome = parseRpcEnvelope(line)
    if (!outcome.ok) {
      return [
        { kind: 'log', message: `子からの行を JSON-RPC として読めなかった: ${outcome.reason}` },
        { kind: 'to_client', line },
      ]
    }
    const { id, method } = outcome.envelope
    const replayedId = this.initializeRequest?.id
    if (this.state === 'initializing' && method === null && id !== null && id === replayedId) {
      return this.finishHandshake()
    }
    if (id !== null && method === null) {
      this.pending.delete(id)
      // 初回の initialize の応答はクライアントへそのまま返す。送り直しが要るのはこれ以降。
      if (id === replayedId) this.initializeAnswered = true
    }
    return [{ kind: 'to_client', line }]
  }

  handleChildSpawned(): ShimAction[] {
    if (this.state !== 'starting') {
      throw new Error(`子の起動は starting のときだけ起きるはず（現在: ${this.state}）`)
    }
    this.childAlive = true
    const remembered = this.initializeRequest
    if (remembered === null || !this.initializeAnswered) {
      // 初回。クライアントの initialize はまだ応答を受け取っていないので、素通しして子に答えさせる。
      this.state = 'running'
      return [{ kind: 'log', message: '子プロセスが起動した' }, ...this.flushBuffered()]
    }
    this.state = 'initializing'
    return [
      { kind: 'log', message: '子プロセスが起動した。覚えておいた initialize を送り直す' },
      { kind: 'to_child', line: remembered.line },
    ]
  }

  handleChildExit(detail: string): ShimAction[] {
    this.childAlive = false
    if (this.shuttingDown) {
      this.state = 'no_child'
      return [{ kind: 'log', message: `子プロセスを終了させた（${detail}）` }]
    }
    if (this.awaitingExitForRestart) {
      this.awaitingExitForRestart = false
      this.state = 'starting'
      return [
        { kind: 'log', message: `古い子プロセスが終了した（${detail}）。新しい子を起動する` },
        { kind: 'spawn_child' },
      ]
    }
    this.state = 'no_child'
    return [
      {
        kind: 'log',
        message: `子プロセスが落ちた（${detail}）。上の stderr に理由が出ている。直して保存すると起動をやり直す`,
      },
      ...this.failPending(CHILD_DOWN_CODE, '子プロセスが終了したため中断した'),
      ...this.drainBufferedWhileDown(),
    ]
  }

  /** 監視しているディレクトリの変更をまとめたものが 1 回ここに来る。 */
  requestRestart(reason: string): ShimAction[] {
    const actions: ShimAction[] = [{ kind: 'log', message: `変更を検知した: ${reason}` }]
    if (this.awaitingExitForRestart) {
      actions.push({ kind: 'log', message: 'すでに子を入れ替えている最中なので、この変更もその子に載る' })
      return actions
    }
    if (this.childAlive) {
      actions.push(...this.failPending(RESTART_INTERRUPTED_CODE, 'サーバーを再起動したため中断した'))
      this.awaitingExitForRestart = true
      this.state = 'starting'
      actions.push({ kind: 'stop_child', reason })
      return actions
    }
    if (this.state === 'no_child') {
      this.state = 'starting'
      actions.push({ kind: 'log', message: '止まっていた子プロセスを起動し直す' })
      actions.push({ kind: 'spawn_child' })
      return actions
    }
    actions.push({ kind: 'log', message: 'すでに子プロセスを起動中なので、この変更はその子に載る' })
    return actions
  }

  handleClientClosed(): ShimAction[] {
    this.shuttingDown = true
    const actions: ShimAction[] = [
      { kind: 'log', message: 'クライアントが stdin を閉じた。子プロセスを終わらせて自分も終了する' },
    ]
    if (this.childAlive) actions.push({ kind: 'stop_child', reason: 'クライアントが切断した' })
    actions.push({ kind: 'exit' })
    return actions
  }

  /**
   * 再送した initialize の応答を読み捨ててから、初期化完了通知・list_changed・溜めた行の順に流す。
   * 応答を読み捨てるのは、クライアントから見れば初期化は最初の 1 回で終わっているため。
   */
  private finishHandshake(): ShimAction[] {
    const actions: ShimAction[] = [
      { kind: 'log', message: '再送した initialize の応答はクライアントに流さず読み捨てた' },
    ]
    if (this.initializedNotification !== null) {
      actions.push({ kind: 'to_child', line: this.initializedNotification })
    }
    this.state = 'running'
    actions.push({ kind: 'to_client', line: notificationLine(TOOL_LIST_CHANGED_NOTIFICATION) })
    actions.push(...this.flushBuffered())
    actions.push({ kind: 'log', message: '新しい子プロセスに入れ替わった' })
    return actions
  }

  private forwardToChild(line: string, envelope: RpcEnvelope | null): ShimAction[] {
    if (this.state === 'running') {
      if (envelope !== null && envelope.id !== null && envelope.method !== null) {
        this.pending.set(envelope.id, envelope.method)
      }
      return [{ kind: 'to_child', line }]
    }
    if (this.state === 'no_child') return this.rejectWhileDown(line, envelope)
    this.buffered.push(line)
    return [
      {
        kind: 'log',
        message: `子の入れ替え中なので溜める（${describeEnvelope(envelope)}、${this.buffered.length} 件目）`,
      },
    ]
  }

  private rejectWhileDown(line: string, envelope: RpcEnvelope | null): ShimAction[] {
    if (envelope === null || envelope.id === null || envelope.method === null) {
      return [{ kind: 'log', message: `子プロセスが動いていないので中継できずに捨てた: ${line}` }]
    }
    const message =
      `子プロセスが起動していないため ${envelope.method} を処理できない。` +
      'stderr に出ている起動失敗の理由を直して保存すると、もう一度起動を試みる'
    return [{ kind: 'to_client', line: errorResponseLine(envelope.id, CHILD_DOWN_CODE, message) }]
  }

  private flushBuffered(): ShimAction[] {
    const lines = this.buffered.splice(0, this.buffered.length)
    if (lines.length === 0) return []
    const actions: ShimAction[] = [
      { kind: 'log', message: `溜めていた ${lines.length} 件を順番に新しい子へ流す` },
    ]
    for (const line of lines) {
      const outcome = parseRpcEnvelope(line)
      actions.push(...this.forwardToChild(line, outcome.ok ? outcome.envelope : null))
    }
    return actions
  }

  private drainBufferedWhileDown(): ShimAction[] {
    const lines = this.buffered.splice(0, this.buffered.length)
    if (lines.length === 0) return []
    const actions: ShimAction[] = [
      { kind: 'log', message: `溜めていた ${lines.length} 件は子が居ないので流せない` },
    ]
    for (const line of lines) {
      const outcome = parseRpcEnvelope(line)
      actions.push(...this.rejectWhileDown(line, outcome.ok ? outcome.envelope : null))
    }
    return actions
  }

  private failPending(code: number, reason: string): ShimAction[] {
    const actions: ShimAction[] = []
    for (const [id, method] of this.pending) {
      const message = `${reason}（method: ${method}）。同じ呼び出しをもう一度投げ直すこと`
      actions.push({ kind: 'to_client', line: errorResponseLine(id, code, message) })
    }
    this.pending.clear()
    return actions
  }
}
