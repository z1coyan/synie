import { describe, expect, test } from 'bun:test'
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

describe('filterTargetOf / filterableFields', () => {
  test('物料列经 filterField 代理到 materialId，标签用列标签', () => {
    const target = filterTargetOf(materialCode, overrides, allColumns)
    expect(target?.name).toBe('materialId')
    expect(target?.type).toBe('fk')
    expect(target?.label).toBe('物料')
  })

  test('可见列 + 代理去重，不可筛列不进加法器', () => {
    const fields = filterableFields([materialCode, code, notes], overrides, allColumns)
    expect(fields.map((f) => [f.name, f.label])).toEqual([
      ['materialId', '物料'],
      ['code', '编号'],
    ])
  })

  test('已筛字段不出现在加法器', () => {
    const fields = filterableFields([materialCode, code], overrides, allColumns)
    const filters: FilterState = { materialId: { kind: 'fk', values: ['m1'], labels: ['A-1'] } }
    expect(adderFields(fields, filters).map((f) => f.name)).toEqual(['code'])
  })

  test('没有可筛列时加法器候选为空', () => {
    expect(filterableFields([notes], {}, [notes])).toEqual([])
  })
})

describe('resolveFilterColumn', () => {
  test('预置 / URL 的 materialId 标签仍是物料', () => {
    const resolved = resolveFilterColumn('materialId', [materialCode, code], overrides, allColumns)
    expect(resolved?.name).toBe('materialId')
    expect(resolved?.label).toBe('物料')
  })

  test('隐藏列上的预置筛选用 meta 标签', () => {
    const resolved = resolveFilterColumn('code', [materialCode], overrides, allColumns)
    expect(resolved?.label).toBe('编号')
  })
})
