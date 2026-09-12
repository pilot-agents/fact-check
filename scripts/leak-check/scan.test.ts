import { describe, expect, test } from 'vitest'
import type { LeakPattern } from './patterns.js'
import { findPackagingViolations, looksBinary, scanPathName, scanText } from './scan.js'

const NEEDLE: LeakPattern = { id: 'needle', label: '目印', regex: /(needle)/g }
const EMPTY_MATCH: LeakPattern = { id: 'empty', label: '長さ 0 の一致', regex: /x*/g }

describe('scanText', () => {
  test.each([
    { name: '1 行目の先頭', text: 'needle', line: 1, column: 1 },
    { name: '1 行目の途中', text: 'ab needle', line: 1, column: 4 },
    { name: '2 行目', text: 'ab\nneedle', line: 2, column: 1 },
    { name: '3 行目の途中', text: 'ab\ncd\nef needle', line: 3, column: 4 },
  ])('$name の位置を 1 始まりで返す', ({ text, line, column }) => {
    expect(scanText('f.txt', text, [NEEDLE])).toEqual([
      {
        file: 'f.txt',
        channels: [],
        line,
        column,
        patternId: 'needle',
        patternLabel: '目印',
        masked: 'ne***',
      },
    ])
  })

  test.each([
    { name: '一致なし', text: 'nothing', expected: 0 },
    { name: '同じ行に 2 件', text: 'needle needle', expected: 2 },
    { name: '別の行に 1 件ずつ', text: 'needle\nneedle', expected: 2 },
  ])('$name', ({ text, expected }) => {
    expect(scanText('f.txt', text, [NEEDLE])).toHaveLength(expected)
  })

  test('長さ 0 の一致でも走査が止まらない', () => {
    expect(scanText('f.txt', 'ab', [EMPTY_MATCH]).length).toBeGreaterThan(0)
  })

  test('同じパターンを続けて使っても前回の位置を引きずらない', () => {
    expect(scanText('f.txt', 'needle', [NEEDLE])).toHaveLength(1)
    expect(scanText('f.txt', 'needle', [NEEDLE])).toHaveLength(1)
  })
})

describe('looksBinary', () => {
  test.each([
    { name: '普通のテキスト', bytes: [0x61, 0x62, 0x63], expected: false },
    { name: '空ファイル', bytes: [], expected: false },
    { name: 'NUL を含む', bytes: [0x61, 0x00, 0x62], expected: true },
    { name: '先頭が NUL', bytes: [0x00], expected: true },
  ])('$name', ({ bytes, expected }) => {
    expect(looksBinary(Uint8Array.from(bytes))).toBe(expected)
  })
})

describe('scanPathName', () => {
  test('ファイル名そのものに当たったら行と桁は持たない', () => {
    expect(scanPathName('docs/needle.md', [NEEDLE])).toEqual([
      {
        file: 'docs/needle.md',
        channels: [],
        line: null,
        column: null,
        patternId: 'needle',
        patternLabel: '目印',
        masked: 'ne***',
      },
    ])
  })

  test.each([
    { name: '当たらないファイル名', file: 'docs/readme.md', expected: 0 },
    { name: 'ディレクトリ名に当たる', file: 'needle/readme.md', expected: 1 },
    { name: '拡張子の手前に当たる', file: 'docs/a-needle.md', expected: 1 },
    { name: '同じ名前が 2 回出れば 2 件', file: 'needle/needle.md', expected: 2 },
  ])('$name', ({ file, expected }) => {
    expect(scanPathName(file, [NEEDLE])).toHaveLength(expected)
  })
})

describe('findPackagingViolations', () => {
  test.each([
    { name: 'dist 直下だけなら通る', files: ['dist/index.js', 'README.md', 'package.json'], expected: 0 },
    { name: 'dist のサブディレクトリ（意図した構成）は通る', files: ['dist/tools/register.js'], expected: 0 },
    { name: 'rootDir がずれた dist/src は落とす', files: ['dist/src/index.js'], expected: 1 },
    { name: 'dist/e2e は落とす', files: ['dist/e2e/run-e2e.js'], expected: 1 },
    { name: 'dist/scripts は落とす', files: ['dist/scripts/make-bin-executable.js'], expected: 1 },
    { name: 'ソースマップは落とす', files: ['dist/index.js.map'], expected: 1 },
    { name: '複数あれば全部返す', files: ['dist/src/index.js', 'dist/index.js.map'], expected: 2 },
    { name: '空の一覧', files: [], expected: 0 },
  ])('$name', ({ files, expected }) => {
    expect(findPackagingViolations(files)).toHaveLength(expected)
  })
})
