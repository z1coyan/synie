// bun app/components/synie-data-grid/grid-checks.ts 可直接运行的纯函数自检
import { buildFilterLiteral, buildRowQuery, dayEnd, dayStart, nextSort, toSortLiteral } from './query'
import { toCsv } from './csv'
import { cellText } from './format'
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

// 三态排序循环:顺序 → 逆序 → 取消;换列从顺序重新开始
eq(nextSort(null, 'code', 'ascending'), { column: 'code', direction: 'ascending' }, '首次点击顺序')
eq(
  nextSort({ column: 'code', direction: 'ascending' }, 'code', 'descending'),
  { column: 'code', direction: 'descending' },
  '再点逆序'
)
eq(nextSort({ column: 'code', direction: 'descending' }, 'code', 'ascending'), null, '三点取消排序')
eq(
  nextSort({ column: 'code', direction: 'descending' }, 'name', 'ascending'),
  { column: 'name', direction: 'ascending' },
  '换列重新顺序'
)

eq(
  buildFilterLiteral({ name: { kind: 'text', op: 'contains', value: '采购' } }, '', cols),
  '{name: {contains: "采购"}}',
  '单列 contains'
)
eq(
  buildFilterLiteral({ name: { kind: 'text', op: 'notContains', value: '采购' } }, '', cols),
  '{not: [{name: {contains: "采购"}}]}',
  'notContains 走 not 组合子'
)
eq(
  buildFilterLiteral({ name: { kind: 'text', op: 'notEq', value: 'a' } }, '', cols),
  '{name: {notEq: "a"}}',
  'notEq'
)
eq(
  buildFilterLiteral(
    { enabled: { kind: 'bool', eq: true }, insertedAt: { kind: 'date', op: 'between', gte: '2026-01-01', lte: '2026-01-31' } },
    'x',
    cols
  ),
  `{and: [{enabled: {eq: true}}, {insertedAt: {greaterThanOrEqual: "${dayStart('2026-01-01')}", lessThanOrEqual: "${dayEnd('2026-01-31')}"}}, {or: [{code: {contains: "x"}}, {name: {contains: "x"}}]}]}`,
  '组合筛选+搜索,datetime 区间换算日界'
)
eq(
  buildFilterLiteral({ insertedAt: { kind: 'date', op: 'eq', value: '2026-01-05' } }, '', cols),
  `{insertedAt: {greaterThanOrEqual: "${dayStart('2026-01-05')}", lessThanOrEqual: "${dayEnd('2026-01-05')}"}}`,
  'datetime 等于展开为当天区间'
)
eq(
  buildFilterLiteral({ insertedAt: { kind: 'date', op: 'before', value: '2026-01-05' } }, '', cols),
  `{insertedAt: {lessThan: "${dayStart('2026-01-05')}"}}`,
  'datetime 之前取日始'
)
eq(buildFilterLiteral({}, '', cols), null, '空筛选')

eq(
  buildRowQuery('sysRoles', cols, { limit: 20, offset: 40, sortLiteral: null, filterLiteral: null }),
  'query { sysRoles(limit: 20, offset: 40) { count results { id code name enabled insertedAt } } }',
  '行查询'
)

// enum 白名单 + 数值 range 校验(修复:非法值不得裸拼进查询串)
const extraCols: GridColumnMeta[] = [
  ...cols,
  {
    name: 'status',
    type: 'enum',
    label: '状态',
    sortable: true,
    filterable: true,
    enumOptions: [
      { value: 'active', label: '启用' },
      { value: 'disabled', label: '停用' },
    ],
  },
  { name: 'seq', type: 'integer', label: '序号', sortable: true, filterable: true, enumOptions: null },
]

eq(
  buildFilterLiteral({ status: { kind: 'enum', values: ['active', 'hacked) { x }'] } }, '', extraCols),
  '{status: {in: [ACTIVE]}}',
  'enum 白名单过滤非法值'
)
eq(
  buildFilterLiteral({ seq: { kind: 'number', op: 'between', gte: '10', lte: 'abc' } }, '', extraCols),
  '{seq: {greaterThanOrEqual: 10}}',
  '数值区间非法端跳过'
)
eq(
  buildFilterLiteral({ seq: { kind: 'number', op: 'between', gte: '0x10' } }, '', extraCols),
  '{seq: {greaterThanOrEqual: 16}}',
  '数值 token 归一化(0x10 → 16)'
)
eq(
  buildFilterLiteral({ seq: { kind: 'number', op: 'gt', value: '5' } }, '', extraCols),
  '{seq: {greaterThan: 5}}',
  '数值单操作符'
)
eq(
  buildFilterLiteral({ seq: { kind: 'number', op: 'eq', value: 'abc' } }, '', extraCols),
  null,
  '数值非法值整体跳过'
)

// 纯 date 列(非 datetime)直接比日期字符串,不换算日界
const dateCols: GridColumnMeta[] = [
  { name: 'dueOn', type: 'date', label: '截止日', sortable: true, filterable: true, enumOptions: null },
]
eq(
  buildFilterLiteral({ dueOn: { kind: 'date', op: 'eq', value: '2026-01-05' } }, '', dateCols),
  '{dueOn: {eq: "2026-01-05"}}',
  'date 列等于直接比字符串'
)
eq(
  buildFilterLiteral({ dueOn: { kind: 'date', op: 'after', value: '2026-01-05' } }, '', dateCols),
  '{dueOn: {greaterThan: "2026-01-05"}}',
  'date 列之后'
)

const rows: Row[] = [{ id: '1', code: 'a,b', name: '含"引号"', enabled: true }]
eq(
  toCsv([{ name: 'code', label: '编码' }, { name: 'name', label: '名称' }], rows),
  '编码,名称\r\n"a,b","含""引号"""',
  'CSV 转义'
)

// 带 cellText 格式化器:boolean 列导出为 是/否(与表格/打印视图一致),而非裸 true/false
eq(
  toCsv(
    cols.filter((c) => c.name === 'code' || c.name === 'enabled'),
    rows,
    cellText
  ),
  '编码,启用\r\n"a,b",是',
  'CSV 格式化器 boolean→是'
)

console.log('grid-checks ok')
