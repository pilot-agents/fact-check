import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { AttachmentLike } from '../../session/ledger-like.js'
import { inlineScreenshots, screenshotPathsOf, toDataUri } from './inline-assets.js'

/** 画像のパス以外は見ないので、添付の残りの項目は固定の空値で埋める。 */
function attachment(screenshotPath: string | null): AttachmentLike {
  return {
    id: 'attachment_x',
    claim_id: 'claim_1',
    evidence_id: 'evidence_1',
    quote: 'q',
    relation: 'supports',
    rationale: 'r',
    created_at: '2026-01-02T03:04:05.000Z',
    match: { start: 0, end: 1 },
    screenshot_path: screenshotPath,
    screenshot_note: null,
  }
}

describe('screenshotPathsOf', () => {
  test.each([
    { name: '添付なし', paths: [], expected: [] },
    { name: '画像なしの添付だけ', paths: [null], expected: [] },
    { name: '1 件', paths: ['attachments/a.png'], expected: ['attachments/a.png'] },
    {
      name: '同じパスは 1 回（試行ごとに別ファイルでも、採用した画像が同じなら重ねない）',
      paths: ['attachments/a.png', 'attachments/a.png'],
      expected: ['attachments/a.png'],
    },
    {
      name: '台帳に出た順を保ち、null は飛ばす',
      paths: ['attachments/b.png', null, 'attachments/a.png', 'attachments/b.png'],
      expected: ['attachments/b.png', 'attachments/a.png'],
    },
  ])('$name', ({ paths, expected }) => {
    expect(screenshotPathsOf(paths.map(attachment))).toEqual(expected)
  })
})

describe('toDataUri', () => {
  test.each([
    { name: 'png', relativePath: 'attachments/a.png', expected: 'data:image/png;base64,AAEC' },
    {
      name: '拡張子は大文字でも同じ',
      relativePath: 'attachments/A.PNG',
      expected: 'data:image/png;base64,AAEC',
    },
  ])('$name', ({ relativePath, expected }) => {
    expect(toDataUri(relativePath, Uint8Array.from([0, 1, 2]))).toBe(expected)
  })

  test.each([
    { name: '拡張子なし', relativePath: 'attachments/a' },
    { name: 'jpg（保存する画像は PNG だけ）', relativePath: 'attachments/a.jpg' },
    { name: 'svg', relativePath: 'attachments/a.svg' },
  ])('推測で MIME を付けない: $name', ({ relativePath }) => {
    expect(() => toDataUri(relativePath, Uint8Array.from([0]))).toThrow(
      '画像の種類が分からないので埋め込めない',
    )
  })
})

describe('inlineScreenshots', () => {
  let baseDir = ''
  let previousDir: string | undefined
  const sessionId = 'fc_inline_test'

  beforeEach(async () => {
    previousDir = process.env.FACT_CHECK_DIR
    baseDir = await mkdtemp(path.join(tmpdir(), 'fact-check-inline-'))
    process.env.FACT_CHECK_DIR = baseDir
    await mkdir(path.join(baseDir, sessionId, 'attachments'), { recursive: true })
  })

  afterEach(async () => {
    if (previousDir === undefined) delete process.env.FACT_CHECK_DIR
    else process.env.FACT_CHECK_DIR = previousDir
    await rm(baseDir, { recursive: true, force: true })
  })

  test('存在する画像を data URI にして、相対パスをそのまま鍵にする', async () => {
    await writeFile(path.join(baseDir, sessionId, 'attachments', 'a.png'), Uint8Array.from([137, 80, 78, 71]))
    const assets = await inlineScreenshots(sessionId, [attachment('attachments/a.png'), attachment(null)])
    expect(assets).toEqual({ 'attachments/a.png': 'data:image/png;base64,iVBORw==' })
  })

  test('欠けている画像は全件集めてから拒否する（1 件ずつ呼び直させない）', async () => {
    await writeFile(path.join(baseDir, sessionId, 'attachments', 'ok.png'), Uint8Array.from([1]))
    const promise = inlineScreenshots(sessionId, [
      attachment('attachments/missing_1.png'),
      attachment('attachments/ok.png'),
      attachment('attachments/missing_2.png'),
    ])
    await expect(promise).rejects.toThrow('台帳が参照する画像が 2 件見つからない')
    await expect(promise).rejects.toThrow('attachments/missing_1.png, attachments/missing_2.png')
  })
})
