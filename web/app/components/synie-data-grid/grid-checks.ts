// bun app/components/synie-data-grid/grid-checks.ts 可直接运行的纯函数自检
import './filter-fields-checks'
import { dayEnd, dayStart, nextSort, UUID_RE } from './query'
import { toCsv } from './csv'
import { cellText, dateOnlyText } from './format'
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

// 三态排序循环：顺序 → 逆序 → 取消；换列从顺序重新开始。
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

// datetime 筛选日期按本地日界换算为 UTC 瞬时。
const date = '2026-01-05'
eq(dayStart(date), new Date(`${date}T00:00:00`).toISOString(), '日期起点换算')
eq(dayEnd(date), new Date(`${date}T23:59:59.999`).toISOString(), '日期终点换算')
eq(dateOnlyText('2026-07-31T00:00:00.000Z'), '2026-07-31', '业务日 ISO 格式化为 YYYY-MM-DD')
eq(dateOnlyText('2026-07-31'), '2026-07-31', '业务日 wire 保持 YYYY-MM-DD')
eq(dateOnlyText('未知日期'), '未知日期', '非 ISO 业务日原样回落')
eq(dateOnlyText(null), '', '空业务日为空串')

const uuid = '11111111-1111-1111-1111-111111111111'
eq(UUID_RE.test(uuid), true, '合法 UUID')
eq(UUID_RE.test('DROP TABLE'), false, '非法资源 id')

const rows: Row[] = [{ id: '1', code: 'a,b', name: '含"引号"', enabled: true }]
eq(
  toCsv([{ name: 'code', label: '编码' }, { name: 'name', label: '名称' }], rows),
  '编码,名称\r\n"a,b","含""引号"""',
  'CSV 转义'
)

eq(
  toCsv(
    cols.filter((column) => column.name === 'code' || column.name === 'enabled'),
    rows,
    cellText
  ),
  '编码,启用\r\n"a,b",是',
  'CSV 格式化器 boolean→是'
)

const fkCol: GridColumnMeta = {
  name: 'parentId',
  type: 'fk',
  label: '上级公司',
  sortable: false,
  filterable: true,
  enumOptions: null,
  ref: { resource: 'basCompanies', relation: 'parent', labelField: 'name' },
}
const fkRow = { id: 'x', parentId: uuid, parent: { id: uuid, name: '集团总部' } } as unknown as Row
eq(cellText(fkCol, uuid, fkRow), '集团总部', 'fk cellText 读取资源标签')
eq(cellText(fkCol, uuid, { id: 'x', parent: null } as unknown as Row), '11111111', '资源标签缺失退回截断 id')
eq(cellText(fkCol, null, { id: 'x' } as unknown as Row), '', 'fk 空值为空串')

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
eq(cellText(polyCol, uuid, { id: 'x', partyType: 'SUPPLIER' } as unknown as Row), '11111111', '多态 fk 文本退截断 id')

// picker 跨页累积选中。
const row = (id: string): Row => ({ id }) as Row
const page1 = [row('a'), row('b')]
const page2 = [row('c'), row('d')]
eq(mergePick([], page1, new Set(['a']) as Selection, 'multiple').map((item) => item.id), ['a'], '多选：本页勾选')
eq(mergePick([row('a')], page1, new Set(['a', 'b']) as Selection, 'multiple').map((item) => item.id), ['a', 'b'], '多选：本页追加')
eq(mergePick([row('a')], page2, new Set(['a', 'c']) as Selection, 'multiple').map((item) => item.id), ['a', 'c'], '多选：翻页保留非本页选中')
eq(mergePick([row('a'), row('c')], page1, new Set(['c']) as Selection, 'multiple').map((item) => item.id), ['c'], '多选：本页取消勾选被移除')
eq(mergePick([row('a')], page1, 'all', 'multiple').map((item) => item.id), ['a', 'b'], '多选：全选等于本页全选')
eq(mergePick([], page1, new Set(['b']) as Selection, 'single').map((item) => item.id), ['b'], '单选：点行选中')
eq(mergePick([row('b')], page1, new Set() as Selection, 'single').map((item) => item.id), [], '单选：同页取消清空')
eq(mergePick([row('b')], page2, new Set(['b']) as Selection, 'single').map((item) => item.id), ['b'], '单选：翻页保留')
eq(mergePick([row('b')], page2, new Set(['c']) as Selection, 'single').map((item) => item.id), ['c'], '单选：换页改选替换')

console.log('grid-checks ok')
