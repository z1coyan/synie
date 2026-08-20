// 筛选加法器纯函数自检（由 grid-checks 引入， bun run check 覆盖）
import { adderFields, filterableFields, filterTargetOf, resolveFilterColumn } from './filter-fields'
import type { FilterState, GridColumnMeta } from './types'

const col = (name: string, extra: Partial<GridColumnMeta> = {}): GridColumnMeta => ({
  name,
  type: 'string',
  label: name,
  sortable: true,
  filterable: true,
  enumOptions: null,
  ref: null,
  ...extra,
})

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    console.error(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`)
    process.exit(1)
  }
}

const materialCode = col('materialCode', { label: '物料' })
const materialId = col('materialId', {
  type: 'fk',
  label: '物料ID',
  ref: { resource: 'invMaterials', relation: 'material', labelField: 'code' },
})
const code = col('code', { label: '编号' })
const notes = col('notes', { label: '备注', filterable: false })
const allColumns = [materialCode, materialId, code, notes]
const overrides = { materialCode: { filterField: 'materialId', label: '物料' } }

const materialTarget = filterTargetOf(materialCode, overrides, allColumns)
eq(materialTarget?.name, 'materialId', '物料列代理到 materialId')
eq(materialTarget?.type, 'fk', '物料列筛选控件是 fk')
eq(materialTarget?.label, '物料', '物料列筛选标签用列标签')

eq(
  filterableFields([materialCode, code, notes], overrides, allColumns).map((f) => [f.name, f.label]),
  [
    ['materialId', '物料'],
    ['code', '编号'],
  ],
  '可见列 + 代理去重，不可筛列排除',
)

const fields = filterableFields([materialCode, code], overrides, allColumns)
const filters: FilterState = { materialId: { kind: 'fk', values: ['m1'], labels: ['A-1'] } }
eq(
  adderFields(fields, filters).map((f) => f.name),
  ['code'],
  '已筛字段不进加法器',
)

eq(filterableFields([notes], {}, [notes]), [], '没有可筛列时加法器为空')

eq(resolveFilterColumn('materialId', [materialCode, code], overrides, allColumns)?.label, '物料', '预置 materialId 标签仍是物料')
eq(resolveFilterColumn('code', [materialCode], overrides, allColumns)?.label, '编号', '隐藏列预置筛选用 meta 标签')

console.log('filter-fields-checks ok')
