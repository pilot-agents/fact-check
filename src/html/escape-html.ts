/**
 * HTML の本文・属性値に文字列を入れるための escape。
 *
 * 表題も元ネタの取得元もファイルパスも、山括弧や引用符を普通に含む。escape を忘れた 1 箇所が
 * ページを黙って壊すので、HTML を組み立てる側（report.html とセッション一覧）は必ずここを通す。
 * 属性値にも使えるように引用符まで落とす。
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
