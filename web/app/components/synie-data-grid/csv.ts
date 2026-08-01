import type { ResourceQuery } from '~/lib/resources/types'
import type { ResourceReader } from '~/lib/resources/catalog'
import type { GridColumnMeta, Row } from './types'

export function toCsv<C extends Pick<GridColumnMeta, 'name' | 'label'>>(
  columns: C[],
  rows: Row[],
  // 可选格式化器:传入时单元格值先格式化再转义(与表格/打印视图保持一致);不传保持裸 String 行为
  format?: (col: C, value: unknown, row: Row) => string
): string {
  const escape = (v: unknown): string => {
    const s = v == null ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  const cell = (col: C, value: unknown, row: Row) => escape(format ? format(col, value, row) : value)
  const header = columns.map((c) => escape(c.label)).join(',')
  const lines = rows.map((r) => columns.map((c) => cell(c, r[c.name], r)).join(','))
  return [header, ...lines].join('\r\n')
}

const EXPORT_PAGE = 200
// ponytail: 前端循环拉页导出,万行级数据再改后端流式导出
export async function fetchAllRows(
  reader: Pick<ResourceReader, 'query'>,
  query: Omit<ResourceQuery, 'numItems' | 'cursor'>,
): Promise<Row[]> {
  const rows: Row[] = []
  let cursor: string | null = null
  const seenCursors = new Set<string>()
  for (;;) {
    const page = await reader.query({ ...query, numItems: EXPORT_PAGE, cursor })
    rows.push(...page.results)
    if (page.pageInfo.isDone || page.results.length === 0) return rows
    const next = page.pageInfo.continueCursor
    if (!next) throw new Error('分页未结束但缺少 continueCursor')
    if (seenCursors.has(next)) throw new Error('分页 cursor 重复,已中止导出')
    seenCursors.add(next)
    cursor = next
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
