import { describe, expect, test } from 'vitest'
import { isIgnored, parseGitignore } from './gitignore.js'

const GITIGNORE = [
  '# コメント行',
  '',
  'node_modules/',
  'dist/',
  '.fact-check/',
  'e2e/tmp/',
  '.mcp.json',
  '.claude/settings.local.json',
  '*.log',
  '!keep.log',
  'build/**',
  'docs/**/draft.md',
  'temp?.txt',
  '[Tt]humbs.db',
].join('\n')

const rules = parseGitignore(GITIGNORE)

describe('isIgnored', () => {
  test.each([
    { name: 'ディレクトリ限定の規則はそのディレクトリ自身に当たる', path: 'dist', dir: true, expected: true },
    {
      name: 'ディレクトリ限定の規則は配下のファイルにも当たる',
      path: 'dist/index.js',
      dir: false,
      expected: true,
    },
    {
      name: 'ディレクトリ限定の規則は同名のファイルには当たらない',
      path: 'dist',
      dir: false,
      expected: false,
    },
    {
      name: '位置固定のない規則はどの階層でも当たる',
      path: 'src/node_modules/x.ts',
      dir: false,
      expected: true,
    },
    {
      name: '途中に / がある規則はルートからの位置で固定される',
      path: 'e2e/tmp/a.json',
      dir: false,
      expected: true,
    },
    {
      name: '位置固定の規則は別の階層には当たらない',
      path: 'src/e2e/tmp/a.json',
      dir: false,
      expected: false,
    },
    { name: 'ファイル名そのものの規則', path: '.mcp.json', dir: false, expected: true },
    { name: 'パス付きのファイル名の規則', path: '.claude/settings.local.json', dir: false, expected: true },
    {
      name: '同じディレクトリの別ファイルは残る',
      path: '.claude/settings.json',
      dir: false,
      expected: false,
    },
    { name: '* は拡張子の一致に使える', path: 'logs/run.log', dir: false, expected: true },
    { name: '! は後から打ち消す', path: 'keep.log', dir: false, expected: false },
    { name: '! は階層が違えば当たらない', path: 'logs/keep.log', dir: false, expected: false },
    { name: '/** は配下すべてに当たる', path: 'build/a/b/c.js', dir: false, expected: true },
    { name: '途中の ** は 0 階層でも当たる', path: 'docs/draft.md', dir: false, expected: true },
    { name: '途中の ** は複数階層でも当たる', path: 'docs/a/b/draft.md', dir: false, expected: true },
    { name: '? は 1 文字だけに当たる', path: 'temp1.txt', dir: false, expected: true },
    { name: '? は 2 文字には当たらない', path: 'temp12.txt', dir: false, expected: false },
    { name: '文字クラスに当たる', path: 'Thumbs.db', dir: false, expected: true },
    { name: '文字クラスの別の候補にも当たる', path: 'thumbs.db', dir: false, expected: true },
    { name: '文字クラスの範囲外は当たらない', path: 'Xhumbs.db', dir: false, expected: false },
    { name: 'どの規則にも当たらないソース', path: 'src/index.ts', dir: false, expected: false },
    { name: 'コメント行は規則にならない', path: 'コメント行', dir: false, expected: false },
  ])('$name', ({ path: relativePath, dir, expected }) => {
    expect(isIgnored(rules, relativePath, dir)).toBe(expected)
  })
})

describe('parseGitignore', () => {
  test.each([
    { name: '空行とコメントは規則にならない', content: '\n# c\n   \n', expected: 0 },
    { name: '打ち消しも 1 規則として数える', content: '*.log\n!keep.log\n', expected: 2 },
    { name: '行末の空白は無視される', content: 'dist/   \n', expected: 1 },
  ])('$name', ({ content, expected }) => {
    expect(parseGitignore(content)).toHaveLength(expected)
  })

  test('行末の空白を落としても規則の意味は変わらない', () => {
    expect(isIgnored(parseGitignore('dist/   \n'), 'dist/a.js', false)).toBe(true)
  })

  test('打ち消し規則は negated を立てる', () => {
    expect(parseGitignore('!keep.log')[0]?.negated).toBe(true)
  })
})
