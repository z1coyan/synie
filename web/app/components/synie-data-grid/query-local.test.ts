import { describe, expect, test } from 'bun:test'
import { queryLocalRows } from './query-local'
import type { GridColumnMeta, Row } from './types'

const columns: GridColumnMeta[] = [
  { name: 'postingDate', type: 'date', label: '日期', sortable: true, filterable: true, enumOptions: null, ref: null },
  {
    name: 'type',
    type: 'enum',
    label: '类型',
    sortable: true,
    filterable: true,
    enumOptions: [
      { value: '销售发货', label: '销售发货' },
      { value: '发票开出', label: '发票开出' },
    ],
    ref: null,
  },
  { name: 'voucherNo', type: 'string', label: '单号', sortable: true, filterable: true, enumOptions: null, ref: null },
  { name: 'amount', type: 'decimal', label: '金额', sortable: true, filterable: true, enumOptions: null, ref: null },
]

const rows: Row[] = [
  { id: '1', postingDate: '2026-07-10', type: '发票开出', voucherNo: 'FP-2', amount: '200' },
  { id: '2', postingDate: '2026-07-01', type: '销售发货', voucherNo: 'FH-1', amount: '100' },
]

describe('queryLocalRows', () => {
  test('搜索命中单号或类型', () => {
    expect(queryLocalRows(rows, columns, { limit: 20, offset: 0, search: 'FH' }).results.map((r) => r.id)).toEqual([
      '2',
    ])
    expect(queryLocalRows(rows, columns, { limit: 20, offset: 0, search: '发票' }).count).toBe(1)
  })

  test('枚举与日期筛选', () => {
    const filtered = queryLocalRows(rows, columns, {
      limit: 20,
      offset: 0,
      filter: {
        type: { kind: 'enum', values: ['销售发货'] },
        postingDate: { kind: 'date', op: 'between', gte: '2026-07-01', lte: '2026-07-01' },
      },
    })
    expect(filtered.results.map((r) => r.id)).toEqual(['2'])
  })

  test('金额排序与分页', () => {
    const page = queryLocalRows(rows, columns, {
      limit: 1,
      offset: 0,
      sort: { column: 'amount', direction: 'descending' },
    })
    expect(page.count).toBe(2)
    expect(page.results[0]!.id).toBe('1')
  })
})
