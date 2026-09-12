import { describe, expect, test } from 'vitest'
import type { FetchAttempt } from '../session/ledger-types.js'
import { buildFetchFailureMessage } from './fetch-source.js'
import { findPdfLinks, MAX_PDF_LINKS } from './pdf-links.js'

/** 文面と候補の抽出をまとめて確かめる。文面だけ通っても、候補が出なければ AI は次に進めない。 */

const BASE = 'https://example.test/notices/2026/index.html'

const ATTEMPTS: FetchAttempt[] = [
  {
    stage: 'http',
    ok: false,
    detail: '本文を記事領域 main から 120 文字（うちリンクでない地の文 18 文字）しか抽出できず',
    at: '2026-01-01T00:00:00.000Z',
  },
  {
    stage: 'browser',
    ok: false,
    detail: '描画後の DOM からも 120 文字しか抽出できず',
    at: '2026-01-01T00:00:01.000Z',
  },
]

function page(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`
}

describe('findPdfLinks', () => {
  test.each([
    {
      name: '相対パス（同じディレクトリ）',
      html: page('<a href="shiryou.pdf">資料</a>'),
      expected: ['https://example.test/notices/2026/shiryou.pdf'],
    },
    {
      name: '相対パス（ルート基準）',
      html: page('<a href="/files/a.pdf">資料</a>'),
      expected: ['https://example.test/files/a.pdf'],
    },
    {
      name: '相対パス（親へ遡る）',
      html: page('<a href="../2025/b.PDF">昨年の資料</a>'),
      expected: ['https://example.test/notices/2025/b.PDF'],
    },
    {
      name: '絶対 URL（別ホスト）',
      html: page('<a href="https://cdn.example.test/x/c.pdf">別サイトの資料</a>'),
      expected: ['https://cdn.example.test/x/c.pdf'],
    },
    {
      name: 'クエリやフラグメントが付いた PDF',
      html: page('<a href="/d.pdf?download=1#page=3">資料</a>'),
      expected: ['https://example.test/d.pdf?download=1#page=3'],
    },
    {
      name: 'type 属性で PDF を示すもの（拡張子は .pdf でない）',
      html: page('<a href="/download?id=42" type="application/pdf">資料</a>'),
      expected: ['https://example.test/download?id=42'],
    },
    {
      name: '同じ URL は 1 回だけ',
      html: page('<a href="/e.pdf">資料</a><a href="/e.pdf">同じ資料（別の場所にも置いてある）</a>'),
      expected: ['https://example.test/e.pdf'],
    },
    {
      name: 'ナビゲーションやフッタの中にあっても拾う',
      html: page('<nav><a href="/nav.pdf">要綱</a></nav><footer><a href="/foot.pdf">附則</a></footer>'),
      expected: ['https://example.test/nav.pdf', 'https://example.test/foot.pdf'],
    },
    {
      name: 'PDF リンクが無い',
      html: page('<a href="/about.html">会社概要</a><a href="/a.pdfx">似た拡張子</a>'),
      expected: [],
    },
    {
      name: 'http(s) でない href は候補にしない',
      html: page('<a href="javascript:void(0)">開く</a><a href="mailto:a@example.test">連絡</a>'),
      expected: [],
    },
    { name: 'リンクが 1 つも無い', html: page('<p>本文はありません</p>'), expected: [] },
  ])('$name', ({ html, expected }) => {
    expect(findPdfLinks(html, BASE)).toEqual(expected)
  })

  test(`候補は ${MAX_PDF_LINKS} 件までに切る`, () => {
    const links = Array.from({ length: 9 }, (_v, index) => `<a href="/f${index}.pdf">資料${index}</a>`)
    expect(findPdfLinks(page(links.join('')), BASE)).toEqual([
      'https://example.test/f0.pdf',
      'https://example.test/f1.pdf',
      'https://example.test/f2.pdf',
      'https://example.test/f3.pdf',
      'https://example.test/f4.pdf',
    ])
  })
})

describe('buildFetchFailureMessage', () => {
  test('PDF リンクがあるとき、その URL を並べて次の呼び出しを指示する', () => {
    const html = page('<a href="shiryou.pdf">資料</a><a href="/files/besshi.pdf">別紙</a>')
    const links = findPdfLinks(html, BASE)
    const message = buildFetchFailureMessage(BASE, ATTEMPTS, links)

    expect(message).toContain(
      'この URL からは証拠を取得できなかった (url=https://example.test/notices/2026/index.html)',
    )
    expect(message).toContain('このページには PDF へのリンクが 2 件ある')
    expect(message).toContain('その URL で fetch_evidence を呼ぶこと')
    expect(message).toContain('  - https://example.test/notices/2026/shiryou.pdf')
    expect(message).toContain('  - https://example.test/files/besshi.pdf')
    // 候補が出せたときは、一般論のほうは出さない（どれを渡すべきかが埋もれる）
    expect(message).not.toContain(
      'そのページがリンクしている PDF の URL を fetch_evidence にそのまま渡すこと',
    )
    // 試行の記録と最後の手段の指示は、候補があっても落とさない
    expect(message).toContain('  - http: 本文を記事領域 main から 120 文字')
    expect(message).toContain('submit_agent_capture')
  })

  test('PDF リンクが無いときは今までの文面のまま', () => {
    const links = findPdfLinks(page('<a href="/about.html">会社概要</a>'), BASE)
    const message = buildFetchFailureMessage(BASE, ATTEMPTS, links)

    expect(links).toEqual([])
    expect(message).toContain('ページに記事本文が無い場合')
    expect(message).toContain('そのページがリンクしている PDF の URL を fetch_evidence にそのまま渡すこと')
    expect(message).not.toContain('このページには PDF へのリンクが')
    expect(message).toContain('submit_agent_capture')
  })
})
