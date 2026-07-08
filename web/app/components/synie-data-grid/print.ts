import { cellText } from './format'
import type { GridColumnMeta, Row } from './types'

const esc = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/**
 * 默认打印视图:列定义渲染成打印友好表格。正式单据模板走 onPrint 覆盖。
 * @returns 打印窗口是否成功打开(被浏览器弹窗拦截时返回 false,调用方负责用户反馈)
 */
export function printRows(columns: GridColumnMeta[], rows: Row[], title: string): boolean {
  const win = window.open('', '_blank', 'width=900,height=650')
  if (!win) return false
  const head = columns.map((c) => `<th>${esc(c.label)}</th>`).join('')
  const body = rows
    .map((r) => `<tr>${columns.map((c) => `<td>${esc(cellText(c, r[c.name]))}</td>`).join('')}</tr>`)
    .join('')
  win.document.write(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; }
  h1 { font-size: 16px; margin: 0 0 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border: 1px solid #999; padding: 4px 8px; text-align: left; }
  thead { background: #f0f0f0; }
</style></head>
<body><h1>${esc(title)}</h1><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
<script>window.onload = () => { window.print(); }</script></body></html>`)
  win.document.close()
  return true
}
