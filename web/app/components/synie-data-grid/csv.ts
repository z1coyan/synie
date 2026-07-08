import { gqlFetch } from '~/lib/graphql'
import { buildRowQuery } from './query'
import type { GridColumnMeta, Row } from './types'

export function toCsv<C extends Pick<GridColumnMeta, 'name' | 'label'>>(
  columns: C[],
  rows: Row[],
  // 可选格式化器:传入时单元格值先格式化再转义(与表格/打印视图保持一致);不传保持裸 String 行为
  format?: (col: C, value: unknown) => string
): string {
  const escape = (v: unknown): string => {
    const s = v == null ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  const cell = (col: C, value: unknown) => escape(format ? format(col, value) : value)
  const header = columns.map((c) => escape(c.label)).join(',')
  const lines = rows.map((r) => columns.map((c) => cell(c, r[c.name])).join(','))
  return [header, ...lines].join('\r\n')
}

const EXPORT_PAGE = 200
// ponytail: 前端循环拉页导出,万行级数据再改后端流式导出
export async function fetchAllRows(
  resource: string,
  columns: GridColumnMeta[],
  filterLiteral: string | null,
  sortLiteral: string | null
): Promise<Row[]> {
  const rows: Row[] = []
  let offset = 0
  for (;;) {
    const query = buildRowQuery(resource, columns, { limit: EXPORT_PAGE, offset, sortLiteral, filterLiteral })
    const data = await gqlFetch<Record<string, { count: number; results: Row[] }>>(query)
    const page = data[resource]
    rows.push(...page.results)
    // 按实际返回行数推进:Ash 会把超出 max_page_size 的 limit 静默钳制,固定步进 EXPORT_PAGE 会跳行丢数据
    offset += page.results.length
    if (rows.length >= page.count || page.results.length === 0) return rows
  }
}

export function downloadCsv(filename: string, csv: string): void {
  // UTF-8 BOM,Excel 打开中文不乱码
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
