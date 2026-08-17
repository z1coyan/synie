/**
 * 内存行集上执行 ResourceQuery（搜索 / 列筛选 / 排序 / 分页）。
 * 供无独立 list API 的局部读模型（报表下钻抽屉等）接入 SynieDataGrid。
 */
import type { ColumnFilter, FilterState } from '@synie/shared'
import type { ResourceList, ResourceQuery, ResourceTransport } from '~/lib/resources/types'
import { dateOnlyText } from './format'
import type { GridColumnMeta, Row } from './types'

export function createLocalRowsTransport(
  id: string,
  rows: readonly Row[],
  columns: readonly GridColumnMeta[],
): ResourceTransport {
  return {
    id,
    query: async (input) => queryLocalRows(rows, columns, input),
    get: async (rowId) => rows.find((row) => row.id === rowId) ?? null,
  }
}

export function queryLocalRows(
  rows: readonly Row[],
  columns: readonly GridColumnMeta[],
  query: ResourceQuery,
): ResourceList {
  const byName = new Map(columns.map((col) => [col.name, col]))
  let next = rows.filter((row) => matchFilters(row, query.filter, byName) && matchSearch(row, query.search, columns))
  if (query.sort) next = sortRows(next, query.sort.column, query.sort.direction, byName.get(query.sort.column))
  const count = next.length
  const start = Math.max(0, query.offset)
  return { count, results: next.slice(start, start + query.limit) }
}

function matchSearch(row: Row, search: string | undefined, columns: readonly GridColumnMeta[]): boolean {
  const needle = search?.trim().toLowerCase()
  if (!needle) return true
  return columns.some((col) => {
    if (col.type !== 'string' && col.type !== 'enum') return false
    const text = cellSearchText(col, row[col.name]).toLowerCase()
    return text.includes(needle)
  })
}

function matchFilters(
  row: Row,
  filter: FilterState | undefined,
  byName: Map<string, GridColumnMeta>,
): boolean {
  if (!filter) return true
  for (const [name, spec] of Object.entries(filter)) {
    const col = byName.get(name)
    if (!col) continue
    if (!matchColumn(row[name], spec, col)) return false
  }
  return true
}

function matchColumn(value: unknown, spec: ColumnFilter, col: GridColumnMeta): boolean {
  switch (spec.kind) {
    case 'text': {
      const text = String(value ?? '')
      const needle = spec.value
      switch (spec.op) {
        case 'contains':
          return text.toLowerCase().includes(needle.toLowerCase())
        case 'notContains':
          return !text.toLowerCase().includes(needle.toLowerCase())
        case 'eq':
          return text === needle
        case 'notEq':
          return text !== needle
        default:
          return true
      }
    }
    case 'enum':
      return spec.values.length === 0 || spec.values.includes(String(value ?? ''))
    case 'bool':
      return Boolean(value) === spec.eq
    case 'number': {
      const n = Number(value)
      if (!Number.isFinite(n)) return false
      if (spec.op === 'between') {
        if (spec.gte != null && spec.gte !== '' && !(n >= Number(spec.gte))) return false
        if (spec.lte != null && spec.lte !== '' && !(n <= Number(spec.lte))) return false
        return true
      }
      const rhs = Number(spec.value)
      if (!Number.isFinite(rhs)) return false
      if (spec.op === 'eq') return n === rhs
      if (spec.op === 'gt') return n > rhs
      if (spec.op === 'lt') return n < rhs
      if (spec.op === 'gte') return n >= rhs
      return n <= rhs
    }
    case 'date': {
      const day = dateOnlyText(value)
      if (!day) return false
      if (spec.op === 'between') {
        if (spec.gte && day < spec.gte) return false
        if (spec.lte && day > spec.lte) return false
        return true
      }
      if (spec.op === 'eq') return day === spec.value
      if (spec.op === 'before') return day < spec.value
      return day > spec.value
    }
    case 'fk':
      if (spec.op === 'isNil') return value == null || value === ''
      return spec.values.includes(String(value ?? ''))
    default:
      return true
  }
}

function sortRows(
  rows: Row[],
  column: string,
  direction: 'ascending' | 'descending',
  col: GridColumnMeta | undefined,
): Row[] {
  const dir = direction === 'ascending' ? 1 : -1
  return [...rows].sort((a, b) => compareValues(a[column], b[column], col) * dir)
}

function compareValues(a: unknown, b: unknown, col: GridColumnMeta | undefined): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  if (col?.type === 'integer' || col?.type === 'decimal') return Number(a) - Number(b)
  if (col?.type === 'date' || col?.type === 'datetime') {
    return dateOnlyText(a).localeCompare(dateOnlyText(b))
  }
  return String(a).localeCompare(String(b), 'zh')
}

function cellSearchText(col: GridColumnMeta, value: unknown): string {
  if (value == null) return ''
  if (col.type === 'enum') {
    return col.enumOptions?.find((o) => o.value === value)?.label ?? String(value)
  }
  return String(value)
}
