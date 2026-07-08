import type { GridColumnMeta, Row } from './types'

function cellText(col: GridColumnMeta, value: unknown): string {
  if (value == null || value === '') return ''
  if (col.type === 'boolean') return value ? '是' : '否'
  if (col.type === 'datetime') return new Date(String(value)).toLocaleString('zh-CN', { hour12: false })
  if (col.type === 'enum') return col.enumOptions?.find((o) => o.value === value)?.label ?? String(value)
  return String(value)
}

const esc = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** 默认打印视图:列定义渲染成打印友好表格。正式单据模板走 onPrint 覆盖。 */
export function printRows(columns: GridColumnMeta[], rows: Row[], title: string): void {
  const win = window.open('', '_blank', 'width=900,height=650')
  if (!win) return
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
}
