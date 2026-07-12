// bun app/components/synie-data-grid/grid-checks.ts 可直接运行的纯函数自检
import { buildFilterLiteral, buildRowQuery, dayEnd, dayStart, nextSort, toSortLiteral } from './query'
import { toCsv } from './csv'
import { cellText } from './format'
import { mergePick } from './pick'
import type { GridColumnMeta, Row } from './types'
import type { Selection } from 'react-aria-components'

const cols: GridColumnMeta[] = [
  { name: 'code', type: 'string', label: '编码', sortable: true, filterable: true, enumOptions: null, ref: null },
  { name: 'name', type: 'string', label: '名称', sortable: true, filterable: true, enumOptions: null, ref: null },
  { name: 'enabled', type: 'boolean', label: '启用', sortable: true, filterable: true, enumOptions: null, ref: null },
  { name: 'insertedAt', type: 'datetime', label: '创建时间', sortable: true, filterable: true, enumOptions: null, ref: null },
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
    ref: null,
  },
  { name: 'seq', type: 'integer', label: '序号', sortable: true, filterable: true, enumOptions: null, ref: null },
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
  { name: 'dueOn', type: 'date', label: '截止日', sortable: true, filterable: true, enumOptions: null, ref: null },
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

// —— fk 筛选(uuid 白名单)与行查询 join ——
const uuid1 = '11111111-1111-1111-1111-111111111111'
const fkCol: GridColumnMeta = {
  name: 'parentId',
  type: 'fk',
  label: '上级公司',
  sortable: false,
  filterable: true,
  enumOptions: null,
  ref: { resource: 'basCompanies', relation: 'parent', labelField: 'name' },
}
eq(
  buildFilterLiteral({ parentId: { kind: 'fk', values: [uuid1, 'DROP TABLE'], labels: ['集团'] } }, '', [fkCol]),
  `{parentId: {in: ["${uuid1}"]}}`,
  'fk 筛选:合法 uuid 进 in,非法串剔除'
)
eq(buildFilterLiteral({ parentId: { kind: 'fk', values: ['nope'], labels: [] } }, '', [fkCol]), null, 'fk 全非法为 null')
eq(
  buildRowQuery('basCompanies', [fkCol], { limit: 10, offset: 0, sortLiteral: null, filterLiteral: null }),
  'query { basCompanies(limit: 10, offset: 0) { count results { id parentId parent { id name } } } }',
  'fk 行查询带 join'
)
const fkRow = { id: 'x', parentId: uuid1, parent: { id: uuid1, name: '集团总部' } } as unknown as Row
eq(cellText(fkCol, uuid1, fkRow), '集团总部', 'fk cellText 读 join label')
eq(cellText(fkCol, uuid1, { id: 'x', parent: null } as unknown as Row), '11111111', 'join 缺失退回截断 id')
eq(cellText(fkCol, null, { id: 'x' } as unknown as Row), '', 'fk 空值为空串')

// —— 多态 fk:无 relation 不 join;判别列自动取回;CSV/打印退截断 id ——
const polyCol: GridColumnMeta = {
  name: 'partyId',
  type: 'fk',
  label: '对手',
  sortable: false,
  filterable: true,
  enumOptions: null,
  ref: {
    resource: null,
    relation: null,
    labelField: null,
    discriminator: 'partyType',
    discriminatorType: 'enum',
    variants: [
      { value: 'CUSTOMER', resource: 'salCustomers', labelField: 'name', label: '客户' },
      { value: 'SUPPLIER', resource: 'purSuppliers', labelField: 'name', label: '供应商' },
    ],
  },
}
eq(
  buildRowQuery('accGlEntries', [polyCol], { limit: 10, offset: 0, sortLiteral: null, filterLiteral: null }),
  'query { accGlEntries(limit: 10, offset: 0) { count results { id partyId partyType } } }',
  '多态 fk 行查询不带 join,判别列不可见也自动取回'
)
eq(cellText(polyCol, uuid1, { id: 'x', partyType: 'SUPPLIER' } as unknown as Row), '11111111', '多态 fk 文本退截断 id')

// —— 多态 fk 筛选:判别 eq + id in 组合;变体 token 按 variants 白名单,uuid 白名单同普通 fk ——
eq(
  buildFilterLiteral(
    { partyId: { kind: 'polyFk', op: 'in', variant: 'SUPPLIER', values: [uuid1, 'DROP TABLE'], labels: ['甲供'] } },
    '',
    [polyCol]
  ),
  `{and: [{partyType: {eq: SUPPLIER}}, {partyId: {in: ["${uuid1}"]}}]}`,
  '多态 fk 筛选:判别 eq 与 id in 组合,非法 uuid 剔除'
)
eq(
  buildFilterLiteral(
    { partyId: { kind: 'polyFk', op: 'in', variant: 'EVIL) OR (TRUE', values: [uuid1], labels: [] } },
    '',
    [polyCol]
  ),
  null,
  '多态 fk 筛选:变体不在白名单为 null(防注入)'
)
eq(
  buildFilterLiteral({ partyId: { kind: 'polyFk', op: 'in', variant: 'SUPPLIER', values: ['nope'], labels: [] } }, '', [
    polyCol,
  ]),
  null,
  '多态 fk 筛选:uuid 全非法为 null'
)
eq(
  buildFilterLiteral({ partyId: { kind: 'polyFk', op: 'isNil' } }, '', [polyCol]),
  '{partyId: {isNil: true}}',
  '多态 fk 筛选:仅看空值走 isNil'
)

// —— 字符串判别的多态 fk(分录来源单据):筛选 eq 值带引号,行查询同样自动取回判别列 ——
const voucherCol: GridColumnMeta = {
  name: 'voucherId',
  type: 'fk',
  label: '来源单据',
  sortable: false,
  filterable: true,
  enumOptions: null,
  ref: {
    resource: null,
    relation: null,
    labelField: null,
    discriminator: 'voucherType',
    discriminatorType: 'string',
    variants: [{ value: 'acc.gl_journal', resource: 'accGlJournals', labelField: 'voucherNo', label: '凭证' }],
  },
}
eq(
  buildFilterLiteral(
    { voucherId: { kind: 'polyFk', op: 'in', variant: 'acc.gl_journal', values: [uuid1], labels: ['记-0001'] } },
    '',
    [voucherCol]
  ),
  `{and: [{voucherType: {eq: "acc.gl_journal"}}, {voucherId: {in: ["${uuid1}"]}}]}`,
  '多态 fk 筛选:字符串判别值带引号'
)
eq(
  buildRowQuery('accGlEntries', [voucherCol], { limit: 10, offset: 0, sortLiteral: null, filterLiteral: null }),
  'query { accGlEntries(limit: 10, offset: 0) { count results { id voucherId voucherType } } }',
  '字符串判别多态 fk 行查询自动取回判别列'
)

// —— picker 跨页累积选中 ——
const r = (id: string): Row => ({ id }) as Row
const page1 = [r('a'), r('b')]
const page2 = [r('c'), r('d')]
eq(mergePick([], page1, new Set(['a']) as Selection, 'multiple').map((x) => x.id), ['a'], '多选:本页勾选')
eq(mergePick([r('a')], page1, new Set(['a', 'b']) as Selection, 'multiple').map((x) => x.id), ['a', 'b'], '多选:本页追加')
eq(mergePick([r('a')], page2, new Set(['a', 'c']) as Selection, 'multiple').map((x) => x.id), ['a', 'c'], '多选:翻页保留非本页选中')
eq(mergePick([r('a'), r('c')], page1, new Set(['c']) as Selection, 'multiple').map((x) => x.id), ['c'], '多选:本页取消勾选被移除')
eq(mergePick([r('a')], page1, 'all', 'multiple').map((x) => x.id), ['a', 'b'], '多选:全选=本页全选')
eq(mergePick([], page1, new Set(['b']) as Selection, 'single').map((x) => x.id), ['b'], '单选:点行选中')
eq(mergePick([r('b')], page1, new Set() as Selection, 'single').map((x) => x.id), [], '单选:同页取消清空')
eq(mergePick([r('b')], page2, new Set(['b']) as Selection, 'single').map((x) => x.id), ['b'], '单选:翻页保留')
eq(mergePick([r('b')], page2, new Set(['c']) as Selection, 'single').map((x) => x.id), ['c'], '单选:换页改选替换')

console.log('grid-checks ok')
