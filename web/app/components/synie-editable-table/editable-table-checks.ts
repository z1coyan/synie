// bun app/components/synie-editable-table/editable-table-checks.ts 可直接运行的纯函数自检
import { appendItem, displayColumns, isLocalRow, localRowId, mergeItem, removeItem } from './editable'
import type { GridColumnMeta, Row } from '../synie-data-grid/types'

const col = (name: string, type: GridColumnMeta['type'] = 'string'): GridColumnMeta => ({
  name,
  type,
  label: `L:${name}`,
  sortable: true,
  filterable: true,
  enumOptions: null,
  ref: null,
})

const accountCol: GridColumnMeta = {
  name: 'accountId',
  type: 'fk',
  label: '科目',
  sortable: false,
  filterable: true,
  enumOptions: null,
  ref: { resource: 'basAccounts', relation: 'account', labelField: 'name' },
}

const cols: GridColumnMeta[] = [
  col('id'),
  col('summary'),
  col('amount', 'decimal'),
  accountCol,
  col('insertedAt', 'datetime'),
  col('updatedAt', 'datetime'),
]

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    console.error(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`)
    process.exit(1)
  }
}

// —— displayColumns:剔 id/时间戳/exclude;columns 白名单按其顺序,未知名忽略 ——
eq(
  displayColumns(cols).map((c) => c.name),
  ['summary', 'amount', 'accountId'],
  '缺省剔 id 与时间戳'
)
eq(displayColumns(cols, undefined, ['amount']).map((c) => c.name), ['summary', 'accountId'], 'exclude 生效')
eq(
  displayColumns(cols, ['accountId', 'summary', 'nope', 'id']).map((c) => c.name),
  ['accountId', 'summary'],
  'columns 定序,未知名/系统字段忽略'
)

// —— displayColumns:meta 之外的计算列,overrides 同名声明才合成;不声明仍忽略 ——
const computed = displayColumns(cols, ['diff', 'summary'], [], { diff: { label: '差异' } })
eq(
  computed.map((c) => [c.name, c.label, c.sortable, c.filterable]),
  [
    ['diff', '差异', false, false],
    ['summary', 'L:summary', true, true],
  ],
  '计算列按 overrides 合成且定序,不可排序/筛选'
)
eq(displayColumns(cols, ['nope']).map((c) => c.name), [], '未知名无 overrides 仍忽略')

// —— localRowId / isLocalRow ——
const lid = localRowId()
eq(isLocalRow({ id: lid } as Row), true, '本地 id 判真')
eq(isLocalRow({ id: 'a3f0…' } as Row), false, '服务端 id 判假')
eq(lid === localRowId(), false, '本地 id 不重复')

// —— appendItem:values 展开后 id 固定在参数值 ——
const items: Row[] = [{ id: 'r1', summary: '旧', amount: 1, accountId: 'a1', account: { name: '现金' } }]
const appended = appendItem(items, { summary: '新', id: '恶意覆盖' }, 'local:x')
eq(appended.length, 2, 'append 追加一行')
eq(appended[1].id, 'local:x', 'append id 以参数为准')
eq(appended[0].id, 'r1', 'append 不动原行')

// —— mergeItem:覆盖字段;fk 变更清 join,未变保留 ——
const changed = mergeItem(items, items[0], { summary: '改', accountId: 'a2' }, cols)
eq(changed[0].summary, '改', 'merge 覆盖字段')
eq(changed[0].account, null, 'fk 变更清掉旧 join')
const kept = mergeItem(items, items[0], { summary: '改', accountId: 'a1' }, cols)
eq((kept[0].account as { name: string }).name, '现金', 'fk 未变保留 join')
const untouched = mergeItem(items, items[0], { summary: '改' }, cols)
eq((untouched[0].account as { name: string }).name, '现金', 'values 不含 fk 时保留 join')
eq(mergeItem(items, items[0], {}, cols)[0].id, 'r1', 'merge 保留 id')

// —— removeItem ——
eq(removeItem(appended, 'local:x').map((r) => r.id), ['r1'], 'remove 按 id 删')
eq(removeItem(appended, '不存在').length, 2, 'remove 未命中不动')

console.log('editable-table-checks ok')
