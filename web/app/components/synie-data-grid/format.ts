import type { GridColumnMeta, Row } from './types'

/** 共享单元格文本格式化:表格默认渲染、CSV 导出、打印视图三条路径保持一致 */
export function cellText(col: GridColumnMeta, value: unknown, row?: Row): string {
  if (col.type === 'fk' && col.ref) {
    const rel = col.ref.relation ? (row?.[col.ref.relation] as Record<string, unknown> | null | undefined) : null
    if (rel && col.ref.labelField && rel[col.ref.labelField] != null) return String(rel[col.ref.labelField])
    // join 缺失(权限裁剪后的旧数据/多态 fk 无 join):退回截断 id,不报错
    return value == null || value === '' ? '' : String(value).slice(0, 8)
  }
  if (col.type === 'enumArray')
    return (Array.isArray(value) ? value : [])
      .map((v) => col.enumOptions?.find((o) => o.value === v)?.label ?? String(v))
      .join('、')
  if (value == null || value === '') return ''
  if (col.type === 'boolean') return value ? '是' : '否'
  if (col.type === 'datetime') return new Date(String(value)).toLocaleString('zh-CN', { hour12: false })
  if (col.type === 'enum') return col.enumOptions?.find((o) => o.value === value)?.label ?? String(value)
  return String(value)
}
