import { describe, expect, test } from 'vitest'
import {
  CHILD_DOWN_CODE,
  parseRpcEnvelope,
  RESTART_INTERRUPTED_CODE,
  type ShimAction,
  ShimCore,
  type ShimSnapshot,
} from './shim-core.js'

/**
 * 状態機械は「出来事の並び」でしか意味を持たないので、1 行 = 1 シナリオ（出来事の台本）の表にする。
 * 期待値は、外から観測できる動き（何をどちらへ送ったか・子を起動/停止したか）の並びだけを見る。
 * stderr へのログは診断であって振る舞いではないので、並びからは外して別のテストで確かめる。
 */

/** 台本に書く出来事。I/O は無いので、実プロセスも実時刻も要らない。 */
type Beat =
  | { on: 'start' }
  | { on: 'client'; line: string }
  | { on: 'child'; line: string }
  | { on: 'spawned' }
  | { on: 'exited'; detail: string }
  | { on: 'restart'; reason: string }
  | { on: 'closed' }

const request = (id: number | string, method: string): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params: {} })
const response = (id: number | string): string => JSON.stringify({ jsonrpc: '2.0', id, result: {} })
const notification = (method: string): string => JSON.stringify({ jsonrpc: '2.0', method })

/** 見比べやすい 1 行にする。中身の再構成ではなく、表示のための要約。 */
function summarizeLine(line: string): string {
  let parsed: { id?: unknown; method?: unknown; error?: { code?: unknown } }
  try {
    parsed = JSON.parse(line) as typeof parsed
  } catch {
    // 読めない行は、読めなかったことが分かる形で丸ごと残す（情報は落とさない）。
    return `raw(${line})`
  }
  if (parsed.error !== undefined) return `error(id=${String(parsed.id)},code=${String(parsed.error.code)})`
  if (typeof parsed.method === 'string') {
    return parsed.id === undefined ? `notify(${parsed.method})` : `req(${String(parsed.id)},${parsed.method})`
  }
  return `res(${String(parsed.id)})`
}

function summarizeAction(action: ShimAction): string | null {
  switch (action.kind) {
    case 'log':
      return null
    case 'spawn_child':
      return 'spawn'
    case 'stop_child':
      return 'stop'
    case 'exit':
      return 'exit'
    case 'to_child':
      return `→child ${summarizeLine(action.line)}`
    case 'to_client':
      return `→client ${summarizeLine(action.line)}`
  }
}

function play(beats: readonly Beat[]): { moves: string[]; actions: ShimAction[]; snapshot: ShimSnapshot } {
  const core = new ShimCore()
  const actions: ShimAction[] = []
  for (const beat of beats) {
    switch (beat.on) {
      case 'start':
        actions.push(...core.start())
        break
      case 'client':
        actions.push(...core.handleClientLine(beat.line))
        break
      case 'child':
        actions.push(...core.handleChildLine(beat.line))
        break
      case 'spawned':
        actions.push(...core.handleChildSpawned())
        break
      case 'exited':
        actions.push(...core.handleChildExit(beat.detail))
        break
      case 'restart':
        actions.push(...core.requestRestart(beat.reason))
        break
      case 'closed':
        actions.push(...core.handleClientClosed())
        break
    }
  }
  const moves = actions.map(summarizeAction).filter((move): move is string => move !== null)
  return { moves, actions, snapshot: core.snapshot() }
}

/** 初回接続が終わって稼働中になるまでの共通の出だし。 */
const BOOTED: readonly Beat[] = [
  { on: 'start' },
  { on: 'spawned' },
  { on: 'client', line: request(1, 'initialize') },
  { on: 'child', line: response(1) },
  { on: 'client', line: notification('notifications/initialized') },
]
const BOOTED_MOVES = [
  'spawn',
  '→child req(1,initialize)',
  '→client res(1)',
  '→child notify(notifications/initialized)',
]
/** 新しい子が上がって、送り直した initialize の応答が返ってくるまで。 */
const RESPAWNED: readonly Beat[] = [
  { on: 'exited', detail: 'code=null signal=SIGTERM' },
  { on: 'spawned' },
  { on: 'child', line: response(1) },
]

describe('ShimCore — 出来事の並びに対して何をするか', () => {
  test.each([
    {
      name: '初回: initialize と応答はそのまま素通しし、送り直しはしない',
      beats: BOOTED,
      expected: BOOTED_MOVES,
      state: 'running',
      pending: [],
      buffered: [],
    },
    {
      name: '初回: 子が起動する前に来た行は溜まり、起動後に順番どおり流れる',
      beats: [
        { on: 'start' },
        { on: 'client', line: request(1, 'initialize') },
        { on: 'client', line: notification('notifications/initialized') },
        { on: 'spawned' },
        { on: 'child', line: response(1) },
      ],
      expected: [
        'spawn',
        '→child req(1,initialize)',
        '→child notify(notifications/initialized)',
        '→client res(1)',
      ],
      state: 'running',
      pending: [],
      buffered: [],
    },
    {
      name: '再起動: 覚えた initialize を送り直し、その応答は読み捨てて list_changed を出す',
      beats: [...BOOTED, { on: 'restart', reason: 'index.ts' }, ...RESPAWNED],
      expected: [
        ...BOOTED_MOVES,
        'stop',
        'spawn',
        '→child req(1,initialize)',
        '→child notify(notifications/initialized)',
        '→client notify(notifications/tools/list_changed)',
      ],
      state: 'running',
      pending: [],
      buffered: [],
    },
    {
      name: '再起動: 応答待ちのリクエストには中断のエラー応答を返す',
      beats: [
        ...BOOTED,
        { on: 'client', line: request(2, 'tools/call') },
        { on: 'restart', reason: 'index.ts' },
        ...RESPAWNED,
      ],
      expected: [
        ...BOOTED_MOVES,
        '→child req(2,tools/call)',
        `→client error(id=2,code=${RESTART_INTERRUPTED_CODE})`,
        'stop',
        'spawn',
        '→child req(1,initialize)',
        '→child notify(notifications/initialized)',
        '→client notify(notifications/tools/list_changed)',
      ],
      state: 'running',
      pending: [],
      buffered: [],
    },
    {
      name: '再起動: 応答が返り済みのリクエストにはエラー応答を返さない',
      beats: [
        ...BOOTED,
        { on: 'client', line: request(2, 'tools/call') },
        { on: 'child', line: response(2) },
        { on: 'restart', reason: 'index.ts' },
      ],
      expected: [...BOOTED_MOVES, '→child req(2,tools/call)', '→client res(2)', 'stop'],
      state: 'starting',
      pending: [],
      buffered: [],
    },
    {
      name: '再起動中に来た行は溜まり、初期化し直した後に順番どおり流れる',
      beats: [
        ...BOOTED,
        { on: 'restart', reason: 'index.ts' },
        { on: 'client', line: request(3, 'tools/list') },
        { on: 'client', line: request(4, 'tools/call') },
        ...RESPAWNED,
      ],
      expected: [
        ...BOOTED_MOVES,
        'stop',
        'spawn',
        '→child req(1,initialize)',
        '→child notify(notifications/initialized)',
        '→client notify(notifications/tools/list_changed)',
        '→child req(3,tools/list)',
        '→child req(4,tools/call)',
      ],
      state: 'running',
      pending: ['3=tools/list', '4=tools/call'],
      buffered: [],
    },
    {
      name: '入れ替え中にもう一度変更が来ても、子を二重に止めない',
      beats: [
        ...BOOTED,
        { on: 'restart', reason: 'index.ts' },
        { on: 'restart', reason: 'tools.ts' },
        ...RESPAWNED,
      ],
      expected: [
        ...BOOTED_MOVES,
        'stop',
        'spawn',
        '→child req(1,initialize)',
        '→child notify(notifications/initialized)',
        '→client notify(notifications/tools/list_changed)',
      ],
      state: 'running',
      pending: [],
      buffered: [],
    },
    {
      name: '子が起動に失敗したら、以後のリクエストに子が居ない旨のエラー応答を返す',
      beats: [
        ...BOOTED,
        { on: 'restart', reason: 'index.ts' },
        { on: 'exited', detail: 'code=null signal=SIGTERM' },
        { on: 'spawned' },
        { on: 'exited', detail: 'code=1 signal=null' },
        { on: 'client', line: request(5, 'tools/call') },
      ],
      expected: [
        ...BOOTED_MOVES,
        'stop',
        'spawn',
        '→child req(1,initialize)',
        `→client error(id=5,code=${CHILD_DOWN_CODE})`,
      ],
      state: 'no_child',
      pending: [],
      buffered: [],
    },
    {
      name: '子が起動に失敗したら、溜めていた行にもエラー応答を返す',
      beats: [
        ...BOOTED,
        { on: 'restart', reason: 'index.ts' },
        { on: 'client', line: request(6, 'tools/call') },
        { on: 'exited', detail: 'code=null signal=SIGTERM' },
        { on: 'spawned' },
        { on: 'exited', detail: 'code=1 signal=null' },
      ],
      expected: [
        ...BOOTED_MOVES,
        'stop',
        'spawn',
        '→child req(1,initialize)',
        `→client error(id=6,code=${CHILD_DOWN_CODE})`,
      ],
      state: 'no_child',
      pending: [],
      buffered: [],
    },
    {
      name: '子が落ちたら、応答待ちのリクエストにもエラー応答を返す',
      beats: [
        ...BOOTED,
        { on: 'client', line: request(7, 'tools/call') },
        { on: 'exited', detail: 'code=1 signal=null' },
      ],
      expected: [...BOOTED_MOVES, '→child req(7,tools/call)', `→client error(id=7,code=${CHILD_DOWN_CODE})`],
      state: 'no_child',
      pending: [],
      buffered: [],
    },
    {
      name: '子が居ない間の通知は捨てる（応答を返す相手が居ないため）',
      beats: [
        ...BOOTED,
        { on: 'exited', detail: 'code=1 signal=null' },
        { on: 'client', line: notification('notifications/cancelled') },
      ],
      expected: BOOTED_MOVES,
      state: 'no_child',
      pending: [],
      buffered: [],
    },
    {
      name: '止まっていた子は、次の変更でもう一度起動を試みる',
      beats: [
        ...BOOTED,
        { on: 'exited', detail: 'code=1 signal=null' },
        { on: 'restart', reason: 'index.ts' },
        { on: 'spawned' },
        { on: 'child', line: response(1) },
      ],
      expected: [
        ...BOOTED_MOVES,
        'spawn',
        '→child req(1,initialize)',
        '→child notify(notifications/initialized)',
        '→client notify(notifications/tools/list_changed)',
      ],
      state: 'running',
      pending: [],
      buffered: [],
    },
    {
      name: 'JSON として読めない行も、中身を触らずそのまま中継する',
      beats: [
        ...BOOTED,
        { on: 'client', line: 'これは JSON ではない' },
        { on: 'child', line: 'これも JSON ではない' },
      ],
      expected: [...BOOTED_MOVES, '→child raw(これは JSON ではない)', '→client raw(これも JSON ではない)'],
      state: 'running',
      pending: [],
      buffered: [],
    },
    {
      name: 'クライアントが切断したら、子を止めて自分も終了する',
      beats: [...BOOTED, { on: 'closed' }],
      expected: [...BOOTED_MOVES, 'stop', 'exit'],
      state: 'running',
      pending: [],
      buffered: [],
    },
    {
      name: '切断後に子が終わっても、起動失敗とは扱わない（応答を返す相手がもう居ない）',
      beats: [
        ...BOOTED,
        { on: 'client', line: request(10, 'tools/call') },
        { on: 'closed' },
        { on: 'exited', detail: 'code=null signal=SIGTERM' },
      ],
      expected: [...BOOTED_MOVES, '→child req(10,tools/call)', 'stop', 'exit'],
      state: 'no_child',
      pending: ['10=tools/call'],
      buffered: [],
    },
    {
      name: '子が居ない状態で切断されたら、止める子は無く終了だけする',
      beats: [...BOOTED, { on: 'exited', detail: 'code=1 signal=null' }, { on: 'closed' }],
      expected: [...BOOTED_MOVES, 'exit'],
      state: 'no_child',
      pending: [],
      buffered: [],
    },
  ] satisfies Array<{
    name: string
    beats: readonly Beat[]
    expected: string[]
    state: ShimSnapshot['state']
    pending: string[]
    buffered: string[]
  }>)('$name', ({ beats, expected, state, pending, buffered }) => {
    const played = play(beats)
    expect(played.moves).toEqual(expected)
    expect(played.snapshot.state).toBe(state)
    expect(played.snapshot.pending).toEqual(pending)
    expect(played.snapshot.buffered).toEqual(buffered)
  })
})

describe('ShimCore — 初期化を覚えているか', () => {
  test.each([
    {
      name: 'initialize も initialized も来ていなければ、覚えているものは無い',
      beats: [{ on: 'start' }, { on: 'spawned' }],
      expectedId: null,
      expectedAnswered: false,
      expectedInitialized: false,
    },
    {
      name: 'initialize が来たら id を覚えるが、応答前は送り直さない',
      beats: [{ on: 'start' }, { on: 'spawned' }, { on: 'client', line: request(1, 'initialize') }],
      expectedId: 1,
      expectedAnswered: false,
      expectedInitialized: false,
    },
    {
      name: '応答がクライアントへ返った時点で送り直しの対象になる',
      beats: [
        { on: 'start' },
        { on: 'spawned' },
        { on: 'client', line: request(1, 'initialize') },
        { on: 'child', line: response(1) },
      ],
      expectedId: 1,
      expectedAnswered: true,
      expectedInitialized: false,
    },
    {
      name: 'id が文字列でも覚える',
      beats: [{ on: 'start' }, { on: 'spawned' }, { on: 'client', line: request('init-1', 'initialize') }],
      expectedId: 'init-1',
      expectedAnswered: false,
      expectedInitialized: false,
    },
    {
      name: 'id が 0 でも覚える（0 を「無い」と取り違えない）',
      beats: [{ on: 'start' }, { on: 'spawned' }, { on: 'client', line: request(0, 'initialize') }],
      expectedId: 0,
      expectedAnswered: false,
      expectedInitialized: false,
    },
    {
      name: 'initialized 通知も覚える',
      beats: BOOTED,
      expectedId: 1,
      expectedAnswered: true,
      expectedInitialized: true,
    },
  ] satisfies Array<{
    name: string
    beats: readonly Beat[]
    expectedId: string | number | null
    expectedAnswered: boolean
    expectedInitialized: boolean
  }>)('$name', ({ beats, expectedId, expectedAnswered, expectedInitialized }) => {
    const { snapshot } = play(beats)
    expect(snapshot.rememberedInitializeId).toBe(expectedId)
    expect(snapshot.rememberedInitializeAnswered).toBe(expectedAnswered)
    expect(snapshot.rememberedInitialized).toBe(expectedInitialized)
  })
})

describe('ShimCore — エラー応答の中身', () => {
  test.each([
    {
      name: '再起動で中断したときは、どの method だったかを本文に残す',
      beats: [
        ...BOOTED,
        { on: 'client', line: request(2, 'tools/call') },
        { on: 'restart', reason: 'index.ts' },
      ],
      expectedCode: RESTART_INTERRUPTED_CODE,
      expectedParts: ['サーバーを再起動したため中断した', 'tools/call'],
    },
    {
      name: '子が起動していないときは、どの method を処理できなかったかを本文に残す',
      beats: [
        ...BOOTED,
        { on: 'exited', detail: 'code=1 signal=null' },
        { on: 'client', line: request(8, 'tools/list') },
      ],
      expectedCode: CHILD_DOWN_CODE,
      expectedParts: ['子プロセスが起動していないため', 'tools/list'],
    },
    {
      name: '子が落ちて応答待ちが消えたときは、終了したことを本文に残す',
      beats: [
        ...BOOTED,
        { on: 'client', line: request(9, 'tools/call') },
        { on: 'exited', detail: 'code=1 signal=null' },
      ],
      expectedCode: CHILD_DOWN_CODE,
      expectedParts: ['子プロセスが終了したため中断した', 'tools/call'],
    },
  ] satisfies Array<{
    name: string
    beats: readonly Beat[]
    expectedCode: number
    expectedParts: string[]
  }>)('$name', ({ beats, expectedCode, expectedParts }) => {
    const { actions } = play(beats)
    const errors = actions
      .filter((action) => action.kind === 'to_client')
      .map((action) => JSON.parse(action.line) as { error?: { code: number; message: string } })
      .filter((body): body is { error: { code: number; message: string } } => body.error !== undefined)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.error.code).toBe(expectedCode)
    for (const part of expectedParts) expect(errors[0]?.error.message).toContain(part)
  })
})

describe('ShimCore — 子の終わり方は必ず stderr へ出す', () => {
  test.each([
    {
      name: '落ちたときは、終了の詳細と直せば起動し直すことを出す',
      beats: [...BOOTED, { on: 'exited', detail: 'code=1 signal=null' }],
      expectedParts: ['code=1 signal=null', '直して保存すると起動をやり直す'],
    },
    {
      name: '切断の後片付けで終わったときは、落ちたとは書かない',
      beats: [...BOOTED, { on: 'closed' }, { on: 'exited', detail: 'code=null signal=SIGTERM' }],
      expectedParts: ['子プロセスを終了させた', 'code=null signal=SIGTERM'],
    },
  ] satisfies Array<{ name: string; beats: readonly Beat[]; expectedParts: string[] }>)(
    '$name',
    ({ beats, expectedParts }) => {
      const { actions } = play(beats)
      const logs = actions.filter((action) => action.kind === 'log').map((action) => action.message)
      for (const part of expectedParts) {
        expect(logs.some((message) => message.includes(part))).toBe(true)
      }
    },
  )
})

describe('ShimCore — 起こり得ない順序は黙って進めず落とす', () => {
  test.each([
    {
      name: 'start は 2 回呼べない',
      run: (core: ShimCore) => {
        core.start()
        core.start()
      },
      expectedMessage: 'start は最初の 1 回だけ呼べる',
    },
    {
      name: '起動していないのに子が起動したことにはできない',
      run: (core: ShimCore) => core.handleChildSpawned(),
      expectedMessage: '子の起動は starting のときだけ起きるはず',
    },
  ] satisfies Array<{ name: string; run: (core: ShimCore) => unknown; expectedMessage: string }>)(
    '$name',
    ({ run, expectedMessage }) => {
      expect(() => run(new ShimCore())).toThrowError(expectedMessage)
    },
  )
})

describe('parseRpcEnvelope — id と method の取り出し', () => {
  test.each([
    { name: 'リクエスト', line: request(1, 'tools/call'), expected: { id: 1, method: 'tools/call' } },
    {
      name: 'id が 0 のリクエスト',
      line: request(0, 'tools/call'),
      expected: { id: 0, method: 'tools/call' },
    },
    {
      name: 'id が空文字のリクエスト',
      line: request('', 'tools/call'),
      expected: { id: '', method: 'tools/call' },
    },
    {
      name: 'id が文字列のリクエスト',
      line: request('a', 'tools/call'),
      expected: { id: 'a', method: 'tools/call' },
    },
    {
      name: '通知（id が無い）',
      line: notification('notifications/initialized'),
      expected: { id: null, method: 'notifications/initialized' },
    },
    { name: '応答（method が無い）', line: response(7), expected: { id: 7, method: null } },
    {
      name: 'エラー応答も応答として読む',
      line: JSON.stringify({ jsonrpc: '2.0', id: 7, error: { code: -32000, message: 'x' } }),
      expected: { id: 7, method: null },
    },
    {
      name: 'id が null の通知は id 無しとして読む',
      line: JSON.stringify({ jsonrpc: '2.0', id: null, method: 'notifications/cancelled' }),
      expected: { id: null, method: 'notifications/cancelled' },
    },
    {
      name: 'id が数でも文字列でもなければ id 無しとして読む',
      line: JSON.stringify({ jsonrpc: '2.0', id: { nested: 1 }, method: 'tools/call' }),
      expected: { id: null, method: 'tools/call' },
    },
  ] satisfies Array<{
    name: string
    line: string
    expected: { id: string | number | null; method: string | null }
  }>)('$name', ({ line, expected }) => {
    const outcome = parseRpcEnvelope(line)
    expect(outcome.ok).toBe(true)
    expect(outcome.ok ? outcome.envelope : null).toEqual(expected)
  })

  test.each([
    { name: '空文字', line: '', expectedPart: 'SyntaxError' },
    { name: 'JSON として壊れている', line: '{"id":', expectedPart: 'SyntaxError' },
    {
      name: 'JSON だがオブジェクトでない（配列）',
      line: '[1,2]',
      expectedPart: 'JSON-RPC のオブジェクトではない',
    },
    {
      name: 'JSON だがオブジェクトでない（数）',
      line: '42',
      expectedPart: 'JSON-RPC のオブジェクトではない',
    },
    {
      name: 'JSON だがオブジェクトでない（null）',
      line: 'null',
      expectedPart: 'JSON-RPC のオブジェクトではない',
    },
  ] satisfies Array<{ name: string; line: string; expectedPart: string }>)(
    '$name は理由付きで読めなかったことを返す',
    ({ line, expectedPart }) => {
      const outcome = parseRpcEnvelope(line)
      expect(outcome.ok).toBe(false)
      expect(outcome.ok ? '' : outcome.reason).toContain(expectedPart)
    },
  )
})
