import type { GridColumnMeta } from './types'

/** 共享单元格文本格式化:表格默认渲染、CSV 导出、打印视图三条路径保持一致 */
export function cellText(col: GridColumnMeta, value: unknown): string {
  if (value == null || value === '') return ''
  if (col.type === 'boolean') return value ? '是' : '否'
  if (col.type === 'datetime') return new Date(String(value)).toLocaleString('zh-CN', { hour12: false })
  if (col.type === 'enum') return col.enumOptions?.find((o) => o.value === value)?.label ?? String(value)
  return String(value)
}
