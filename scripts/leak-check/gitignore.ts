/**
 * `.gitignore` の照合。
 *
 * 公開物の混入検査は「git のコミット対象になるファイル」を見なければ意味がない。このリポジトリは
 * まだ `git init` していないので `git ls-files` も `git check-ignore` も使えず、除外規則を自前で
 * 解釈する。依存は増やさない（検査そのものが依存の混入経路になるのを避ける）。
 *
 * 対応するのは git の除外規則のうち、このリポジトリで使う範囲: コメント・空行・`!` の打ち消し・
 * 末尾 `/` のディレクトリ限定・先頭や途中の `/` による位置固定・`*` `?` `**` `[...]`。
 * 対応しないもの: ネストした `.gitignore`（ルートの 1 枚だけを読む）・`.git/info/exclude`・
 * core.excludesFile。いずれも「読まないと検査対象が増える」方向にしか効かないので、
 * 見落とし（検査漏れ）にはならない。
 */

export type IgnoreRule = {
  /** 元の行。どの規則で外れたかを説明できるように残す */
  source: string
  /** パス自身への一致 */
  self: RegExp
  /** パスがこの規則に一致したディレクトリの下にあるか */
  descendant: RegExp
  negated: boolean
  dirOnly: boolean
}

export function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const rule = parseLine(rawLine)
    if (rule !== null) rules.push(rule)
  }
  return rules
}

function parseLine(rawLine: string): IgnoreRule | null {
  // 末尾の空白は、`\` でエスケープされていない限り無視される。
  const line = rawLine.replace(/(?<!\\)\s+$/, '')
  if (line === '' || line.startsWith('#')) return null

  const negated = line.startsWith('!')
  const afterBang = negated ? line.slice(1) : line
  // 行頭の `#` `!` は `\` でエスケープできる。
  const unescaped = afterBang.replace(/^\\([#!])/, '$1')
  const dirOnly = unescaped.endsWith('/')
  const body = dirOnly ? unescaped.slice(0, -1) : unescaped
  if (body === '') return null

  // 先頭・途中に `/` があれば、ルートからの位置で固定される。無ければどの階層でも当たる。
  const anchored = body.slice(0, -1).includes('/')
  const pattern = anchored && body.startsWith('/') ? body.slice(1) : body
  const prefix = anchored ? '^' : '^(?:.*/)?'
  const translated = translateGlob(pattern)
  return {
    source: rawLine,
    self: new RegExp(`${prefix}${translated}$`),
    descendant: new RegExp(`${prefix}${translated}/`),
    negated,
    dirOnly,
  }
}

/** glob を正規表現の断片に置き換える。`/` はセパレータとして `*` `?` から守る。 */
function translateGlob(pattern: string): string {
  let out = ''
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index]
    if (char === '\\') {
      const next = pattern[index + 1]
      out += next === undefined ? '\\\\' : escapeLiteral(next)
      index += next === undefined ? 1 : 2
      continue
    }
    if (char === '*') {
      if (pattern.startsWith('**/', index)) {
        out += '(?:.*/)?'
        index += 3
        continue
      }
      if (pattern.startsWith('/**', index - 1) && index + 2 === pattern.length) {
        out += '.*'
        index += 2
        continue
      }
      if (pattern.startsWith('**', index)) {
        out += '.*'
        index += 2
        continue
      }
      out += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      out += '[^/]'
      index += 1
      continue
    }
    if (char === '[') {
      const close = findClassEnd(pattern, index)
      if (close !== -1) {
        out += translateClass(pattern.slice(index, close + 1))
        index = close + 1
        continue
      }
    }
    out += escapeLiteral(char ?? '')
    index += 1
  }
  return out
}

function findClassEnd(pattern: string, open: number): number {
  // `[]abc]` や `[^]abc]` のように、直後の `]` は閉じ括弧にならない。
  let index = open + 1
  if (pattern[index] === '!' || pattern[index] === '^') index += 1
  if (pattern[index] === ']') index += 1
  for (; index < pattern.length; index += 1) {
    if (pattern[index] === ']') return index
  }
  return -1
}

function translateClass(raw: string): string {
  const inner = raw.slice(1, -1)
  const negatedClass = inner.startsWith('!') || inner.startsWith('^')
  return `[${negatedClass ? '^' : ''}${negatedClass ? inner.slice(1) : inner}]`
}

function escapeLiteral(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

/**
 * 除外されるか。後に書かれた規則が前の規則を上書きする（git と同じ）ので、最後に一致した
 * 規則の打ち消し有無で決める。
 */
export function isIgnored(rules: readonly IgnoreRule[], relativePath: string, isDirectory: boolean): boolean {
  let ignored = false
  for (const rule of rules) {
    if (!matches(rule, relativePath, isDirectory)) continue
    ignored = !rule.negated
  }
  return ignored
}

function matches(rule: IgnoreRule, relativePath: string, isDirectory: boolean): boolean {
  if (rule.descendant.test(relativePath)) return true
  if (rule.dirOnly && !isDirectory) return false
  return rule.self.test(relativePath)
}
