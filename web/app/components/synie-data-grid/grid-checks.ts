// bun app/components/synie-data-grid/grid-checks.ts 可直接运行的纯函数自检
import { buildFilterLiteral, buildRowQuery, toSortLiteral } from './query'
import { toCsv } from './csv'
import type { GridColumnMeta, Row } from './types'

const cols: GridColumnMeta[] = [
  { name: 'code', type: 'string', label: '编码', sortable: true, filterable: true, enumOptions: null },
  { name: 'name', type: 'string', label: '名称', sortable: true, filterable: true, enumOptions: null },
  { name: 'enabled', type: 'boolean', label: '启用', sortable: true, filterable: true, enumOptions: null },
  { name: 'insertedAt', type: 'datetime', label: '创建时间', sortable: true, filterable: true, enumOptions: null },
]

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    console.error(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`)
    process.exit(1)
  }
}

eq(toSortLiteral({ column: 'insertedAt', direction: 'descending' }), '[{field: INSERTED_AT, order: DESC}]', 'sort 字面量')
eq(toSortLiteral(null), null, '空排序')

eq(
  buildFilterLiteral({ name: { kind: 'text', contains: '采购' } }, '', cols),
  '{name: {contains: "采购"}}',
  '单列 contains'
)
eq(
  buildFilterLiteral(
    { enabled: { kind: 'bool', eq: true }, insertedAt: { kind: 'range', gte: '2026-01-01T00:00:00Z' } },
    'x',
    cols
  ),
  '{and: [{enabled: {eq: true}}, {insertedAt: {greaterThanOrEqual: "2026-01-01T00:00:00Z"}}, {or: [{code: {contains: "x"}}, {name: {contains: "x"}}]}]}',
  '组合筛选+搜索'
)
eq(buildFilterLiteral({}, '', cols), null, '空筛选')

eq(
  buildRowQuery('sysRoles', cols, { limit: 20, offset: 40, sortLiteral: null, filterLiteral: null }),
  'query { sysRoles(limit: 20, offset: 40) { count results { id code name enabled insertedAt } } }',
  '行查询'
)

const rows: Row[] = [{ id: '1', code: 'a,b', name: '含"引号"', enabled: true }]
eq(
  toCsv([{ name: 'code', label: '编码' }, { name: 'name', label: '名称' }], rows),
  '编码,名称\r\n"a,b","含""引号"""',
  'CSV 转义'
)

console.log('grid-checks ok')
