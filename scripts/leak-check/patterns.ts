/**
 * 公開物に混ざってはいけない文字列のパターン。
 *
 * ここには固有の語を 1 つも書かない。書いた時点で、禁止語そのものがリポジトリに入って公開される
 * （検査が漏洩経路になる）。組み込みは「形」でしか判定しない汎用パターンだけにし、固有の語は
 * リポジトリの外に置いた禁止語リスト（環境変数 FACT_CHECK_LEAK_DENYLIST）から読む。
 *
 * 報告に出す一致文字列は必ずマスクする。検査の出力はログやターミナル履歴に残るので、
 * 生のまま出すと検査自体が二次的な漏洩になる。
 */

export type LeakPattern = {
  id: string
  /** 何に当たったかの説明。固有の語を含めてはいけない */
  label: string
  /** group 1 があればそこを機微な部分としてマスクする。無ければ一致全体をマスクする */
  regex: RegExp
  /** 一致しても見逃す値（文書用に予約された名前など）。一致文字列全体に対して判定する */
  exempt?: RegExp
}

/** 使わなかったパターンと、その理由。「検査したつもり」を防ぐため必ず出力する */
export type SkippedPattern = { id: string; reason: string }

export type BuiltinPatternSet = { patterns: LeakPattern[]; skipped: SkippedPattern[] }

/**
 * 文書用に予約されていて実在し得ないドメイン（RFC 2606 / RFC 6761）。
 * 除外しないと、テストやサンプルに書いた作り物のアドレスで毎回止まる。
 */
const RESERVED_DOMAIN = /@(?:[A-Za-z0-9-]+\.)*(?:example\.(?:com|org|net)|example|test|invalid|localhost)$/i

/**
 * ホームディレクトリ配下の絶対パス。URL の途中や相対パスを拾わないよう直前の文字を見る。
 *
 * ユーザー名は「区切り以外の 1 文字以上」で取る。末尾の区切りは任意にして、区切りで終わらない
 * 裸の形（行末・引用符の直前・`HOME=` の右辺）も落とさない。空白を挟む名前と非 ASCII の名前も
 * 拾うが、区切りの直後に空白が来る形（散文中でホーム配下の並びに触れただけの行）は拾わない。
 */
const UNIX_HOME_PATH = /(?<![A-Za-z0-9._-])\/(?:Users|home)\/([^/\s"'`]+(?: [^/\s"'`]+)*)\/?/g

/** Windows のホームディレクトリ配下の絶対パス。取り方の考え方は Unix と同じ。 */
const WINDOWS_HOME_PATH = /(?<![A-Za-z0-9])[A-Za-z]:\\Users\\([^\\\s"'`]+(?: [^\\\s"'`]+)*)\\?/g

const EMAIL = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g

/** 短すぎる環境変数の値は普通の単語と区別が付かず、誤検知しか生まない。 */
export const MIN_ENV_VALUE_LENGTH = 3

/**
 * どのマシンにもある汎用のアカウント名。コンテナや CI では利用者名がこれになる。
 *
 * これを照合に使ってはいけない。理由は 2 つある。(a) 誰のものでもない名前なので、混ざっていても
 * 漏洩ではない。(b) 普通のコードに単語として現れる（`node:fs` の `node`、CSS の疑似クラス、
 * PDF のキーワード、HTML パーサの API 名）。使うと公開してよいコードで大量に当たり、検査が
 * 「いつも赤いので誰も見ないもの」に変わる。除外したことは必ず出力に出す。
 */
const GENERIC_ACCOUNT_NAMES = new Set([
  'root',
  'admin',
  'administrator',
  'user',
  'users',
  'guest',
  'nobody',
  'runner',
  'ubuntu',
  'debian',
  'docker',
  'vagrant',
  'jenkins',
  'node',
  'build',
  'builder',
  'default',
])

export type EnvValues = { user?: string | undefined; home?: string | undefined }

/**
 * 組み込みパターン。実行しているマシンの値（$USER / $HOME）は環境から読む。値そのものを
 * コードに書かないのが要点で、これによりパターン定義自体は誰のマシンでも同じになる。
 *
 * 環境変数から作れなかったパターンは捨てずに `skipped` で返す。黙って消えると
 * 「検査したつもりで何も見ていない」状態になる。
 */
export function builtinPatterns(env: EnvValues): BuiltinPatternSet {
  const patterns: LeakPattern[] = [
    { id: 'unix-home-path', label: 'ホームディレクトリの絶対パス (Unix)', regex: UNIX_HOME_PATH },
    { id: 'windows-home-path', label: 'ホームディレクトリの絶対パス (Windows)', regex: WINDOWS_HOME_PATH },
    { id: 'email', label: 'メールアドレス', regex: EMAIL, exempt: RESERVED_DOMAIN },
  ]
  const skipped: SkippedPattern[] = []
  // 利用者名は普通の単語と重なりやすいので単語境界を付ける。$HOME は絶対パスなので付けない
  // （`/tmp/sandbox/notes.md` のように区切りが続く形に当てたい）。
  addEnvPattern(patterns, skipped, {
    id: 'env-user',
    label: '実行しているマシンの利用者名 ($USER / $USERNAME / $LOGNAME)',
    value: env.user,
    toRegex: wordBoundedLiteral,
    rejectValue: genericAccountNameReason,
  })
  addEnvPattern(patterns, skipped, {
    id: 'env-home',
    label: '実行しているマシンの $HOME の値',
    value: env.home,
    toRegex: literalRegex,
  })
  return { patterns, skipped }
}

type EnvPatternSpec = {
  id: string
  label: string
  value: string | undefined
  toRegex: (literal: string) => RegExp
  /** 形は整っていても照合に使ってはいけない値。使えないときは理由を返す */
  rejectValue?: (value: string) => string | null
}

function addEnvPattern(patterns: LeakPattern[], skipped: SkippedPattern[], spec: EnvPatternSpec): void {
  const unusable = unusableReason(spec.value)
  if (unusable !== null) {
    skipped.push({ id: spec.id, reason: unusable })
    return
  }
  // unusableReason が null を返した時点で値は存在する。
  const value = (spec.value ?? '').trim()
  const rejected = spec.rejectValue?.(value) ?? null
  if (rejected !== null) {
    skipped.push({ id: spec.id, reason: rejected })
    return
  }
  patterns.push({ id: spec.id, label: spec.label, regex: spec.toRegex(value) })
}

/** 汎用のアカウント名なら、そのまま出力できる理由を返す（値自体は含めない）。 */
function genericAccountNameReason(value: string): string | null {
  if (!GENERIC_ACCOUNT_NAMES.has(value.toLowerCase())) return null
  return (
    'コンテナや CI で使われる汎用のアカウント名で、利用者を指さないうえ、' +
    '普通のコードに単語として現れるため照合に使わない'
  )
}

/** パターンに使えない値か。使えないときは、そのまま出力できる理由を返す（値自体は含めない）。 */
function unusableReason(value: string | undefined): string | null {
  if (value === undefined) return '環境変数が未設定'
  const trimmed = value.trim()
  if (trimmed === '') return '環境変数が空白だけ'
  if (trimmed.length < MIN_ENV_VALUE_LENGTH) {
    return `値が ${MIN_ENV_VALUE_LENGTH} 文字未満で、普通の単語と区別が付かない`
  }
  return null
}

/**
 * リポジトリ外の禁止語リストをパターンに変える。語そのものは label に入れない
 * （検査の出力に禁止語が現れては本末転倒なので、行番号だけで示す）。
 *
 * `originLabel` は出力にそのまま出る。リストの絶対パスを渡してはいけない（置き場所自体が
 * ローカルのホームパスなので、出力に出すと組み込みパターンが拾う類の情報を自分で漏らす）。
 */
export function denylistPatterns(content: string, originLabel: string): LeakPattern[] {
  const patterns: LeakPattern[] = []
  content.split(/\r?\n/).forEach((rawLine, index) => {
    const word = rawLine.trim()
    if (word === '' || word.startsWith('#')) return
    patterns.push({
      id: `denylist-${index + 1}`,
      label: `外部の禁止語リストの ${index + 1} 行目 (${originLabel})`,
      regex: literalRegex(word),
    })
  })
  return patterns
}

function literalRegex(literal: string): RegExp {
  return new RegExp(`(${escapeRegExp(literal)})`, 'gi')
}

/**
 * 前後が識別子の文字でないときだけ当てる。値が `fooBar` や `_foo_` の一部に当たるのを防ぐ。
 * ハイフンは境界に含める（`my-<name>-notes.md` のようにファイル名へ利用者名が混ざる形を拾うため）。
 */
function wordBoundedLiteral(literal: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])(${escapeRegExp(literal)})(?![A-Za-z0-9_])`, 'gi')
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 機微な値の見せ方。先頭 2 文字だけ残す。 */
export function maskSecret(value: string): string {
  return value.length <= 2 ? '***' : `${value.slice(0, 2)}***`
}

/**
 * 一致箇所の報告用表記。group 1 があればその部分だけを伏せ、周りの形は残す
 * 伏せるのは機微な部分だけで、周りの形（どのパターンに当たったか）は読めるようにする。
 */
export function maskMatch(match: RegExpExecArray): string {
  const whole = match[0]
  const secret = match[1]
  if (secret === undefined || secret === '') return maskSecret(whole)
  const at = whole.indexOf(secret)
  if (at === -1) return maskSecret(whole)
  return `${whole.slice(0, at)}${maskSecret(secret)}${whole.slice(at + secret.length)}`
}

/** 予約済みの名前などで見逃してよい一致か。 */
export function isExempt(pattern: LeakPattern, match: RegExpExecArray): boolean {
  return pattern.exempt?.test(match[1] ?? match[0]) ?? false
}
