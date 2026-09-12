import { describe, expect, test } from 'vitest'
import { builtinPatterns, denylistPatterns, MIN_ENV_VALUE_LENGTH, maskSecret } from './patterns.js'
import { scanText } from './scan.js'

/**
 * 検査したい文字列をここに直書きすると、このテストファイル自身が check:leaks に引っかかる
 * （テストは git のコミット対象に入る）。断片を join で組み立てて、ファイル上には形が残らないようにする。
 * 期待値のマスク済み文字列も同じ理由で組み立てる。
 */
const underUsers = (...parts: readonly string[]): string => ['', 'Users', ...parts].join('/')
const underHome = (...parts: readonly string[]): string => ['', 'home', ...parts].join('/')
const underWindowsUsers = (...parts: readonly string[]): string => ['C:', 'Users', ...parts].join('\\')

const PLAIN_EMAIL = ['contact', 'mail.internal'].join('@')
const RESERVED_EMAIL = ['dev', 'example.com'].join('@')

/** 実マシンの値に依存させないための、作り物の環境。 */
const ENV = { user: 'tanuki', home: ['', 'tmp', 'sandbox'].join('/') }
const { patterns } = builtinPatterns(ENV)

function hits(text: string): string[] {
  return scanText('sample.txt', text, patterns).map((finding) => `${finding.patternId}:${finding.masked}`)
}

describe('builtinPatterns — ホームディレクトリの絶対パスを検出する', () => {
  test.each([
    {
      name: 'Unix のホーム配下（区切りで終わる）',
      text: underUsers('someone', 'notes.md'),
      expected: [`unix-home-path:${underUsers('so***', '')}`],
    },
    {
      name: 'Linux のホーム配下（区切りで終わる）',
      text: underHome('someone', 'notes.md'),
      expected: [`unix-home-path:${underHome('so***', '')}`],
    },
    {
      name: 'ユーザー名で終わる裸の形',
      text: underUsers('someone'),
      expected: [`unix-home-path:${underUsers('so***')}`],
    },
    {
      name: '引用符の直前で終わる形',
      text: `"${underUsers('someone')}"`,
      expected: [`unix-home-path:${underUsers('so***')}`],
    },
    {
      name: '行末で終わる形（後ろに文字がない）',
      text: `cache dir: ${underUsers('someone')}`,
      expected: [`unix-home-path:${underUsers('so***')}`],
    },
    {
      name: '環境変数の代入の右辺',
      text: `HOME=${underUsers('someone')}`,
      expected: [`unix-home-path:${underUsers('so***')}`],
    },
    {
      name: '空白を含むユーザー名',
      text: underUsers('John Doe', 'notes.md'),
      expected: [`unix-home-path:${underUsers('Jo***', '')}`],
    },
    {
      name: '非 ASCII のユーザー名',
      text: underUsers('山田太郎', 'notes.md'),
      expected: [`unix-home-path:${underUsers('山田***', '')}`],
    },
    {
      name: 'Windows のホーム配下（区切りで終わる）',
      text: underWindowsUsers('someone', 'notes.md'),
      expected: [`windows-home-path:${underWindowsUsers('so***', '')}`],
    },
    {
      name: 'Windows のユーザー名で終わる裸の形',
      text: underWindowsUsers('someone'),
      expected: [`windows-home-path:${underWindowsUsers('so***')}`],
    },
    {
      name: 'Windows の空白を含むユーザー名',
      text: underWindowsUsers('John Doe', 'notes.md'),
      expected: [`windows-home-path:${underWindowsUsers('Jo***', '')}`],
    },
    {
      name: '同じ行に 2 つ並んでも両方拾う',
      text: `${underUsers('someone')} ${underHome('another')}`,
      expected: [`unix-home-path:${underUsers('so***')}`, `unix-home-path:${underHome('an***')}`],
    },
  ])('$name', ({ text, expected }) => {
    expect(hits(text)).toEqual(expected)
  })
})

describe('builtinPatterns — その他を検出する', () => {
  test.each([
    { name: 'メールアドレス', text: PLAIN_EMAIL, expected: ['email:co***'] },
    { name: '実行しているマシンの $USER の値', text: 'author is tanuki', expected: ['env-user:ta***'] },
    {
      name: '実行しているマシンの $USER の値は大文字小文字を問わない',
      text: 'author is TANUKI',
      expected: ['env-user:TA***'],
    },
    {
      name: '実行しているマシンの $HOME の値',
      text: `cache at ${ENV.home}`,
      expected: ['env-home:/t***'],
    },
    {
      name: '1 行に複数あれば全部拾う',
      text: `${underUsers('someone', '')} と ${PLAIN_EMAIL}`,
      expected: [`unix-home-path:${underUsers('so***', '')}`, 'email:co***'],
    },
  ])('$name', ({ text, expected }) => {
    expect(hits(text)).toEqual(expected)
  })
})

describe('builtinPatterns — 検出しない', () => {
  test.each([
    { name: 'URL の途中のホーム配下らしき並びは当たらない', text: 'https://example.com/home/team/' },
    { name: '相対パスは当たらない', text: ['src', 'home', 'index.ts'].join('/') },
    { name: 'ホーム直下でもユーザー名が無ければ当たらない', text: underUsers('') },
    { name: '区切りの直後が空白なら当たらない（散文中の言及）', text: `${underHome('')} 配下に置く` },
    { name: '文書用に予約されたドメインのアドレスは見逃す', text: RESERVED_EMAIL },
    { name: '@ があってもドメインの形でなければ当たらない', text: 'npm i @scope/pkg' },
    { name: '$USER の値を含まない普通の文', text: 'this line is clean' },
    { name: '空文字列', text: '' },
  ])('$name', ({ text }) => {
    expect(hits(text)).toEqual([])
  })
})

describe('builtinPatterns — 利用者名は単語として照合する', () => {
  /** `env-user` の単語境界。値は環境から来るので、普通の単語と重なる値でも誤検知させない。 */
  const wordBounded = builtinPatterns({ user: 'tanuki', home: undefined }).patterns

  test.each([
    { name: '単独なら当たる', text: 'tanuki', expected: 1 },
    { name: '前後が空白でも当たる', text: 'by tanuki today', expected: 1 },
    { name: '後ろが記号なら当たる', text: 'tanuki.md', expected: 1 },
    { name: '後ろに英数字が続くと当たらない', text: 'tanukisan', expected: 0 },
    { name: '前に英数字があると当たらない', text: 'notanuki', expected: 0 },
    { name: 'アンダースコアで囲まれていると当たらない', text: '_tanuki_', expected: 0 },
    { name: 'ハイフンで繋がっていても当たる（ファイル名に混ざる形）', text: 'my-tanuki-dir', expected: 1 },
  ])('$name', ({ text, expected }) => {
    expect(scanText('sample.txt', text, wordBounded).filter((f) => f.patternId === 'env-user')).toHaveLength(
      expected,
    )
  })
})

describe('builtinPatterns — 使わなかったパターンは理由を返す', () => {
  function skippedReason(env: { user?: string | undefined; home?: string | undefined }, id: string) {
    const { patterns: used, skipped } = builtinPatterns(env)
    return {
      used: used.some((pattern) => pattern.id === id),
      reason: skipped.find((entry) => entry.id === id)?.reason,
    }
  }

  test.each([
    { name: `${MIN_ENV_VALUE_LENGTH - 1} 文字の $USER は短すぎるので使わない`, user: 'ab', used: false },
    { name: `${MIN_ENV_VALUE_LENGTH} 文字の $USER は使う`, user: 'abc', used: true },
    { name: `${MIN_ENV_VALUE_LENGTH + 1} 文字の $USER は使う`, user: 'abcd', used: true },
    { name: '未設定の $USER は使わない', user: undefined, used: false },
    { name: '空白だけの $USER は使わない', user: '   ', used: false },
    { name: '汎用のアカウント名は使わない', user: 'root', used: false },
    { name: '汎用のアカウント名は大文字でも使わない', user: 'ROOT', used: false },
    { name: 'コンテナの既定ユーザー名も使わない', user: 'node', used: false },
  ])('$name', ({ user, used }) => {
    const result = skippedReason({ user, home: undefined }, 'env-user')
    expect(result.used).toBe(used)
    // 使わなかったときは必ず理由が付く（黙って消えると「検査したつもり」になる）。
    expect(result.reason === undefined).toBe(used)
  })

  test.each([
    { name: '未設定の $HOME は使わない', home: undefined, used: false },
    { name: '値のある $HOME は使う', home: ['', 'tmp', 'sandbox'].join('/'), used: true },
  ])('$name', ({ home, used }) => {
    const result = skippedReason({ user: undefined, home }, 'env-home')
    expect(result.used).toBe(used)
    expect(result.reason === undefined).toBe(used)
  })
})

describe('denylistPatterns', () => {
  const list = ['# コメント', '', 'alpha', '  beta  '].join('\n')

  test.each([{ name: 'コメントと空行は語にならない', expected: 2 }])('$name', ({ expected }) => {
    expect(denylistPatterns(list, 'list.txt')).toHaveLength(expected)
  })

  test.each([
    { name: '禁止語に当たる', text: 'we use alpha here', expected: ['denylist-3:al***'] },
    { name: '大文字小文字を問わない', text: 'we use ALPHA here', expected: ['denylist-3:AL***'] },
    { name: '前後の空白は落として照合する', text: 'and beta too', expected: ['denylist-4:be***'] },
    { name: '語を含まない行は当たらない', text: 'nothing here', expected: [] },
  ])('$name', ({ text, expected }) => {
    const found = scanText('sample.txt', text, denylistPatterns(list, 'list.txt'))
    expect(found.map((finding) => `${finding.patternId}:${finding.masked}`)).toEqual(expected)
  })

  test('禁止語そのものは説明文に出さない', () => {
    const [pattern] = denylistPatterns(list, 'list.txt')
    expect(pattern?.label.includes('alpha')).toBe(false)
  })
})

describe('maskSecret', () => {
  test.each([
    { name: '空文字列', value: '', expected: '***' },
    { name: '1 文字', value: 'a', expected: '***' },
    { name: '2 文字はそのままでは出さない', value: 'ab', expected: '***' },
    { name: '3 文字は先頭 2 文字だけ残す', value: 'abc', expected: 'ab***' },
    { name: '長い値も先頭 2 文字だけ残す', value: 'abcdefgh', expected: 'ab***' },
  ])('$name', ({ value, expected }) => {
    expect(maskSecret(value)).toBe(expected)
  })
})
