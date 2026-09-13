import { describe, expect, test } from 'vitest'
import { jsSyntaxDiagnostics } from '../../../e2e/js-syntax.js'
import { VIEWER_SCRIPT } from './viewer-script.js'

/**
 * ビューアの JavaScript は TypeScript のテンプレート文字列として持っている。**中身は
 * 型検査も構文検査も通らない。** 実際に、閉じ括弧を 1 つ落としたまま tsc も lint も通り、
 * ブラウザで開いて初めて `Unexpected token ')'` で画面が真っ白になった。
 *
 * 検査そのものは e2e と共有している（`e2e/js-syntax.ts`）。同じ規則を 2 箇所に書くと、
 * 片方だけ直したときに「単体では通るのに e2e で落ちる」が起きる。
 * ここは**テンプレートの中身**を、e2e は**生成後の report.html から取り出した script** を
 * 同じ関数に掛ける。生成の段で壊れる場合もあるので、両方に要る。
 */

/** 検査は e2e と同じ 1 つの実装を通す（規則を 2 箇所に書かない）。 */
const syntaxDiagnostics = (code: string): string[] => jsSyntaxDiagnostics(code, 'viewer-script.js')

describe('VIEWER_SCRIPT', () => {
  test('JavaScript として構文が通る（実行はしない）', () => {
    // 失敗したときに「どの行の何が悪いか」がそのまま出るよう、診断を値として比較する。
    expect(syntaxDiagnostics(VIEWER_SCRIPT)).toEqual([])
  })

  test('構文検査が、実際に起きた壊れ方（閉じ括弧の落ち）を位置つきで検出する', () => {
    // 括弧を数えるだけの検査だと、正規表現・テンプレート文字列・文字列の中の括弧を
    // 数え間違える。下のコードは括弧の数だけ見れば釣り合っていないが、構文としては正しい。
    // パーサに任せているので、これは通る。
    const healthy = [
      'var re = /[)}(]/g',
      'var t = `釣り合っていない: ( {`',
      'var s = "こちらも: ) }"',
      'function f() { return re.test(t) || s.length > 0 }',
      'f()',
      '',
    ].join('\n')
    expect(syntaxDiagnostics(healthy)).toEqual([])

    // 同じコードから閉じ括弧を 1 つだけ落とす（viewer-script.ts で実際に起きた壊れ方）。
    const broken = healthy.replace('|| s.length > 0 }', '|| s.length > 0')
    expect(broken).not.toBe(healthy)
    const diagnostics = syntaxDiagnostics(broken)
    expect(diagnostics.length).toBeGreaterThan(0)
    // 「どのファイルの何行何桁で何が起きたか」がそのまま読める形であること。
    expect(diagnostics[0]).toMatch(/^TS\d+ viewer-script\.js:\d+:\d+ .+/)
  })

  test('外部リソースを読みに行く記述が無い（1 ファイルで完結する）', () => {
    expect(VIEWER_SCRIPT).not.toMatch(/https?:\/\/(?!.*例)/)
    expect(VIEWER_SCRIPT).not.toContain('fetch(')
    expect(VIEWER_SCRIPT).not.toContain('XMLHttpRequest')
  })

  /**
   * 「今も有効か」の規則はサーバー側（ledger-effective.ts）にしか無い。
   * ブラウザに同じ規則を書き写すと、片方だけ直したときに画面と集計が静かに食い違う。
   * 実際に一度書き写してしまい、コメントには「唯一の場所」と書いてあった。
   */
  test('有効かどうかの規則をブラウザ側に書き写していない', () => {
    // 取り消し履歴を自分で走査して判定する形（サーバー側の規則の複製）が無いこと。
    expect(VIEWER_SCRIPT).not.toMatch(/record\.target_type\s*===/)
    expect(VIEWER_SCRIPT).not.toMatch(/\.restored\)\s*continue/)
    // 代わりに、サーバーが導いた id の集合を受け取っていること。
    expect(VIEWER_SCRIPT).toContain('data.effective.claims')
    expect(VIEWER_SCRIPT).toContain('data.effective.attachments')
  })

  test('innerHTML で組み立てない（元ネタも引用も HTML 断片を含みうる）', () => {
    expect(VIEWER_SCRIPT).not.toContain('innerHTML')
    expect(VIEWER_SCRIPT).not.toContain('outerHTML')
    expect(VIEWER_SCRIPT).not.toContain('insertAdjacentHTML')
  })
})
