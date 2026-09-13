import { describe, expect, test } from 'vitest'
import { describeCause, FactCheckError } from './errors.js'

/**
 * describeCause は catch の中からしか呼ばれない。ここで投げると、記録するはずだった
 * 失敗が別の例外に化けて消える。だから守るのは 2 つだけ:
 *   (1) どんな入力でも投げず string を返す
 *   (2) 入力が持っていた情報が出力に現れる（黙って切らない・落とさない）
 *
 * 期待値は「出力に含まれるはずの文字列」で書く。inspect の整形そのものを固定すると、
 * Node の更新で落ちるだけのテストになり、守りたい 2 つは守れない。
 */

/** 循環する cause を持つ Error。旧実装はここで RangeError を投げていた。 */
function circularCause(): Error {
  const error = new Error('循環する')
  ;(error as Error & { cause?: unknown }).cause = error
  return error
}

/** 2 つの Error が互いを cause にする。旧実装はここでも RangeError を投げていた。 */
function mutualCause(): Error {
  const left = new Error('左の失敗')
  const right = new Error('右の失敗', { cause: left })
  ;(left as Error & { cause?: unknown }).cause = right
  return left
}

/** 実測した fetch 失敗の形。cause が AggregateError で、message が空。 */
function fetchFailure(): Error {
  const first = Object.assign(new Error('connect ECONNREFUSED ::1:9099'), { code: 'ECONNREFUSED' })
  const second = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9099'), {
    code: 'ECONNREFUSED',
  })
  return new TypeError('fetch failed', { cause: new AggregateError([first, second], '') })
}

/**
 * 読み出すと投げるプロパティを持つ Error。`message` を潰した場合と、独立した項目を
 * 足した場合とで inspect の挙動が変わる（前者は Error 全体が読めなくなる）ので、
 * 同じ作り方で 2 種類作れるようにする。
 */
function errorWithThrowingProperty(message: string, property: string, enumerable: boolean): Error {
  const error = new Error(message)
  Object.defineProperty(error, property, {
    get() {
      throw new Error(`${property} の getter が投げた`)
    },
    enumerable,
    configurable: true,
  })
  return error
}

const throwingMessage = (): Error => errorWithThrowingProperty('読めない', 'message', false)
const throwingGetter = (): Error => errorWithThrowingProperty('任意 getter が投げる', 'detail', true)

/** 呼ばれた回数を数える getter / trap を仕込むための道具。 */
function counter(): { counts: Record<string, number>; bump: (key: string) => void } {
  const counts: Record<string, number> = {}
  return {
    counts,
    bump: (key: string) => {
      counts[key] = (counts[key] ?? 0) + 1
    },
  }
}

function throwingInspector(): Error {
  const error = new Error('custom inspector が投げる')
  return Object.assign(error, {
    [Symbol.for('nodejs.util.inspect.custom')]: () => {
      throw new Error('inspector が投げた')
    },
  })
}

function circularObject(): Record<string, unknown> {
  const value: Record<string, unknown> = { label: '循環オブジェクト' }
  value.self = value
  return value
}

function deepCause(depth: number): Error {
  let error = new Error('一番奥の失敗')
  for (let index = 0; index < depth; index += 1) error = new Error(`層${index}`, { cause: error })
  return error
}

describe('describeCause は投げず、入力の情報を落とさない', () => {
  test.each([
    { name: '素の Error', make: () => new Error('素の失敗'), contains: ['Error', '素の失敗'] },
    {
      name: '入れ子の cause',
      make: () => new Error('外側', { cause: new Error('内側') }),
      contains: ['外側', '内側'],
    },
    { name: '循環する cause', make: circularCause, contains: ['循環する', 'Circular'] },
    { name: '相互参照する cause', make: mutualCause, contains: ['左の失敗', '右の失敗', 'Circular'] },
    {
      name: 'AggregateError の子は全件出る',
      make: () => new AggregateError([new Error('1 件目'), new Error('2 件目')], 'まとめて失敗'),
      contains: ['まとめて失敗', '1 件目', '2 件目'],
    },
    {
      name: '実測した fetch 失敗（cause が AggregateError）',
      make: fetchFailure,
      contains: ['fetch failed', '::1:9099', '127.0.0.1:9099', 'ECONNREFUSED'],
    },
    {
      name: '兄弟フィールドを落とさない',
      make: () =>
        Object.assign(new Error('stat に失敗'), {
          code: 'ENOENT',
          errno: -2,
          syscall: 'stat',
          path: '/nope',
        }),
      contains: ['ENOENT', 'errno', 'stat', '/nope'],
    },
    { name: '任意 getter が投げても成立する', make: throwingGetter, contains: ['任意 getter が投げる'] },
    {
      name: 'custom inspector が投げても成立する',
      make: throwingInspector,
      contains: ['custom inspector が投げる'],
    },
    { name: '循環オブジェクト', make: circularObject, contains: ['循環オブジェクト', 'Circular'] },
    { name: 'BigInt', make: () => 10n, contains: ['10n'] },
    { name: 'Symbol', make: () => Symbol('しるし'), contains: ['しるし'] },
    { name: '関数', make: () => () => 1, contains: ['Function'] },
    { name: 'undefined', make: () => undefined, contains: ['undefined'] },
    { name: 'null', make: () => null, contains: ['null'] },
  ])('$name', ({ make, contains }) => {
    const described = describeCause(make())
    expect(typeof described).toBe('string')
    for (const fragment of contains) expect(described).toContain(fragment)
  })

  test('文字列はそのまま返す（引用符で包み直さない）', () => {
    expect(describeCause('そのままの文字列')).toBe('そのままの文字列')
  })

  test('stack を落とさない', () => {
    expect(describeCause(new Error('スタックつき'))).toContain('    at ')
  })

  test('長い message を切り詰めない', () => {
    const long = 'あ'.repeat(50_000)
    expect(describeCause(new Error(long))).toContain(long)
  })

  test('深い cause を切り詰めない（最奥まで出る）', () => {
    const described = describeCause(deepCause(200))
    expect(described).toContain('層199')
    expect(described).toContain('一番奥の失敗')
  })

  test('name / message を読めない Error は、読めなかった事実と記述子を残す', () => {
    const described = describeCause(throwingMessage())
    expect(described).toContain('[object Error]')
    // showHidden により、何が読めなかったのかが記述子として出る。
    expect(described).toContain('[message]')
    expect(described).toContain('name か message を読み出せない')
  })
})

/**
 * 「外部のコードを実行しない」は戻り値からは分からない。**呼ばれた回数を数えて**確かめる。
 *
 * 実測の結果、止められるものと止められないものがある。止められないものを「止まっている」と
 * 書かないために、両方をテストに固定する。
 */
describe('describeCause がどの外部コードを動かすか（呼び出し回数で確認）', () => {
  test.each([
    {
      name: 'ふつうのプロパティの getter は呼ばれない',
      make: (bump: (key: string) => void) => {
        const error = new Error('任意 getter')
        Object.defineProperty(error, 'detail', {
          get() {
            bump('detail')
            return '秘密'
          },
          enumerable: true,
          configurable: true,
        })
        return error
      },
      key: 'detail',
      expected: 0,
    },
    {
      name: 'Proxy の ownKeys trap は呼ばれない',
      make: (bump: (key: string) => void) =>
        new Proxy(
          { a: 1 },
          {
            ownKeys(target) {
              bump('ownKeys')
              return Reflect.ownKeys(target)
            },
          },
        ),
      key: 'ownKeys',
      expected: 0,
    },
    {
      name: 'Proxy の get trap は呼ばれない',
      make: (bump: (key: string) => void) =>
        new Proxy(
          { a: 1 },
          {
            get(target, key, receiver) {
              bump('get')
              return Reflect.get(target, key, receiver)
            },
          },
        ),
      key: 'get',
      expected: 0,
    },
    {
      name: 'custom inspector は呼ばれない',
      make: (bump: (key: string) => void) =>
        Object.assign(new Error('custom inspector'), {
          [Symbol.for('nodejs.util.inspect.custom')]: () => {
            bump('customInspect')
            return '差し替えた表示'
          },
        }),
      key: 'customInspect',
      expected: 0,
    },
    {
      // 止められない。Node の Error 整形が読むため。件数まで固定して、
      // 「実行しない」と書けないことをテストの側にも残す。
      name: 'Error の message は Node の整形が読むので呼ばれる',
      make: (bump: (key: string) => void) => {
        const error = new Error('もとの message')
        Object.defineProperty(error, 'message', {
          get() {
            bump('message')
            return 'もとの message'
          },
          configurable: true,
        })
        return error
      },
      key: 'message',
      expected: 2,
    },
    {
      name: 'Error の name は Node の整形が読むので呼ばれる',
      make: (bump: (key: string) => void) => {
        const error = new Error('name を getter にした')
        Object.defineProperty(error, 'name', {
          get() {
            bump('name')
            return 'MyError'
          },
          configurable: true,
        })
        return error
      },
      key: 'name',
      // 2 回。showHidden を付けているため、表示名の決定と記述子の列挙で読まれる（実測）。
      expected: 2,
    },
    {
      name: 'オブジェクトの Symbol.toStringTag は読まれる',
      make: (bump: (key: string) => void) => {
        const value: Record<string | symbol, unknown> = {}
        Object.defineProperty(value, Symbol.toStringTag, {
          get() {
            bump('toStringTag')
            return 'Tagged'
          },
          configurable: true,
        })
        return value
      },
      key: 'toStringTag',
      expected: 1,
    },
  ])('$name', ({ make, key, expected }) => {
    const { counts, bump } = counter()
    const described = describeCause(make(bump))
    expect(typeof described).toBe('string')
    expect(counts[key] ?? 0).toBe(expected)
  })

  test('非 enumerable な code / details も落とさない', () => {
    const error = new Error('非 enumerable の保持')
    Object.defineProperty(error, 'code', { value: 'E_HIDDEN', enumerable: false })
    Object.defineProperty(error, 'details', { value: { field: 'x' }, enumerable: false })
    const described = describeCause(error)
    expect(described).toContain('E_HIDDEN')
    expect(described).toContain('field')
  })

  test('ownKeys が投げる Proxy を空のオブジェクトに化かさない', () => {
    const described = describeCause(
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('ownKeys が投げた')
          },
        },
      ),
    )
    // `{}` だと本物の空オブジェクトと区別が付かない。Proxy だと分かる形で出ること。
    expect(described).toContain('Proxy')
    expect(described).not.toBe('{}')
  })

  test('読めない Error でも、読めなかった事実と記述子は残る', () => {
    const described = describeCause(throwingMessage())
    expect(described).toContain('[object Error]')
    expect(described).toContain('[message]')
    expect(described).toContain('name か message を読み出せない')
  })
})

/**
 * inspect が本当に失敗する入力での挙動。
 *
 * 直す前は、ここで型名だけの文字列を返していた（説明できなかった値も、失敗の理由も消えた）。
 * 「必ず string を返す」より「原因を捨てない」を優先し、両方を**値のまま**持って投げる。
 */
describe('記述そのものが失敗したとき', () => {
  /**
   * cause に取り消し済みの Proxy を持つ Error。inspect が
   * `Cannot perform 'getPrototypeOf' on a proxy that has been revoked` で投げることを実測済み。
   */
  function inspectBreaker(): { value: Error; revoked: object } {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    return { value: new Error('外側', { cause: proxy }), revoked: proxy }
  }

  test('元の値と記述の失敗を、identity ごと保持して投げる', () => {
    const { value } = inspectBreaker()
    let thrown: unknown
    try {
      describeCause(value)
      throw new Error('投げなかった（この経路が壊れている）')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AggregateError)
    const aggregate = thrown as AggregateError
    // 型名や文字列に潰さず、元の値そのものが入っていること。
    expect(aggregate.errors[0]).toBe(value)
    expect(aggregate.errors[1]).toBeInstanceOf(TypeError)
    expect((aggregate.errors[1] as Error).message).toContain('revoked')
    expect(aggregate.message).toContain('errors[0]')
  })

  test('fromCause も同じ例外をそのまま通す（握りつぶさない）', () => {
    const { value } = inspectBreaker()
    expect(() => FactCheckError.fromCause('文脈', value)).toThrow(AggregateError)
  })

  test('元の値に触れずに包む（Array.isArray すら投げる値がある）', () => {
    const { revoked } = inspectBreaker()
    // fix 前のコメントは「typeof / null / Array.isArray は絶対安全」と書いていたが、誤り。
    expect(() => Array.isArray(revoked)).toThrow(TypeError)
  })
})

describe('FactCheckError.fromCause', () => {
  test('元の cause を保持したまま、説明をメッセージへ畳み込む', () => {
    const cause = new Error('元の失敗')
    const error = FactCheckError.fromCause('文脈の説明', cause)
    expect(error).toBeInstanceOf(FactCheckError)
    expect(error.cause).toBe(cause)
    expect(error.message).toContain('文脈の説明')
    expect(error.message).toContain('元の失敗')
  })

  test('循環する cause でも投げない', () => {
    const error = FactCheckError.fromCause('文脈', circularCause())
    expect(error.message).toContain('Circular')
  })

  test('fromCause した Error をさらに describeCause しても、両方の情報が残る', () => {
    const described = describeCause(FactCheckError.fromCause('外側の文脈', fetchFailure()))
    expect(described).toContain('外側の文脈')
    expect(described).toContain('::1:9099')
    expect(described).toContain('127.0.0.1:9099')
  })
})
