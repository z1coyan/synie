import { describe, expect, test } from 'bun:test'
import type { Actor } from '../../lib/actor'
import { domainRecordCanDelete, domainRecordCanUpdate } from '../shared/records'
import {
  assertSelectableBom,
  defaultUtcBusinessDate,
  deriveBomByproduct,
  deriveBomComponent,
  deriveBomHead,
  requireBomSnapshotPermission,
} from './drafts'

function bomLineContext(input: { conversionExists?: boolean } = {}) {
  const calls: Array<{ table: string; index: string; equals: Array<[string, unknown]> }> = []
  const documents = new Map<string, Record<string, unknown>>([
    ['component-material', { _id: 'component-material', defaultUnitId: 'default-unit' }],
    ['default-unit', { _id: 'default-unit' }],
    ['conversion-unit', { _id: 'conversion-unit' }],
    ['foreign-unit', { _id: 'foreign-unit' }],
  ])
  return {
    calls,
    ctx: {
      db: {
        normalizeId(table: string, id: string) {
          if (table === 'materials' && id === 'component-material') return id
          if (table === 'units' && documents.has(id)) return id
          return null
        },
        async get(id: string) {
          return documents.get(id) ?? null
        },
        query(table: string) {
          return {
            withIndex(index: string, configure: (query: { eq: (field: string, value: unknown) => unknown }) => unknown) {
              const call = { table, index, equals: [] as Array<[string, unknown]> }
              const query = {
                eq(field: string, value: unknown) {
                  call.equals.push([field, value])
                  return query
                },
              }
              configure(query)
              calls.push(call)
              return {
                unique: async () => input.conversionExists ? { _id: 'conversion-1' } : null,
              }
            },
          }
        },
      },
    },
  }
}

describe('制造 BOM 配料行不变量', () => {
  const head = { materialId: 'finished-material' }

  test('单位净用量必须大于零，损耗率必须为非负十进制数', async () => {
    const { ctx } = bomLineContext()

    for (const quantity of ['0', '-0.000001', 'not-a-number']) {
      await expect(deriveBomComponent(ctx as never, {
        head,
        input: { materialId: 'component-material', unitId: 'default-unit', quantity, lossRate: null },
      } as never)).rejects.toThrow('必须大于零')
    }

    for (const lossRate of ['-0.000001', 'not-a-number']) {
      await expect(deriveBomComponent(ctx as never, {
        head,
        input: { materialId: 'component-material', unitId: 'default-unit', quantity: '1', lossRate },
      } as never)).rejects.toThrow(lossRate.startsWith('-') ? '不能为负' : '必须是十进制字符串')
    }

    await expect(deriveBomComponent(ctx as never, {
      head,
      input: { materialId: 'component-material', unitId: 'default-unit', quantity: '1', lossRate: '0' },
    } as never)).resolves.toEqual({})
  })

  test('单位只能是配料物料的默认单位或转换单位', async () => {
    const withoutConversion = bomLineContext()
    await expect(deriveBomComponent(withoutConversion.ctx as never, {
      head,
      input: { materialId: 'component-material', unitId: 'foreign-unit', quantity: '1', lossRate: null },
    } as never)).rejects.toThrow('单位必须是该物料默认单位或转换单位')

    const withConversion = bomLineContext({ conversionExists: true })
    await expect(deriveBomComponent(withConversion.ctx as never, {
      head,
      input: { materialId: 'component-material', unitId: 'conversion-unit', quantity: '1', lossRate: null },
    } as never)).resolves.toEqual({})
    expect(withConversion.calls).toEqual([{
      table: 'materialUnits',
      index: 'by_material_unit',
      equals: [['materialId', 'component-material'], ['unitId', 'conversion-unit']],
    }])
  })
})

describe('制造单据业务日期默认值', () => {
  test('缺省或空白日期使用 UTC 当天，显式日期保持不变', () => {
    const now = new Date('2026-08-01T23:59:59.000Z')
    expect(defaultUtcBusinessDate(undefined, now)).toBe('2026-08-01')
    expect(defaultUtcBusinessDate(null, now)).toBe('2026-08-01')
    expect(defaultUtcBusinessDate('  ', now)).toBe('2026-08-01')
    expect(defaultUtcBusinessDate(' 2026-07-31 ', now)).toBe('2026-07-31')
    expect(() => defaultUtcBusinessDate(20260801, now)).toThrow('业务日期必须是日期字符串')
    expect(() => defaultUtcBusinessDate({}, now)).toThrow('业务日期必须是日期字符串')
  })
})

describe('制造 BOM 副产品行不变量', () => {
  const head = { materialId: 'finished-material' }

  test('单位产出量必须大于零，单位必须属于副产品物料', async () => {
    const { ctx } = bomLineContext()
    await expect(deriveBomByproduct(ctx as never, {
      head,
      input: { materialId: 'component-material', unitId: 'default-unit', quantity: '0' },
    } as never)).rejects.toThrow('必须大于零')
    await expect(deriveBomByproduct(ctx as never, {
      head,
      input: { materialId: 'component-material', unitId: 'foreign-unit', quantity: '1' },
    } as never)).rejects.toThrow('单位必须是该物料默认单位或转换单位')
  })
})

describe('制造 BOM 状态边界', () => {
  test('草稿、启用、停用 BOM 都可整体编辑，但只有草稿可物理删除', async () => {
    for (const status of ['DRAFT', 'ACTIVE', 'INACTIVE']) {
      await expect(deriveBomHead(null as never, null as never, {}, {
        status,
        materialId: 'finished-material',
      })).resolves.toEqual({ status, materialId: 'finished-material' })
      expect(domainRecordCanUpdate('mfgBoms', status)).toBe(true)
    }

    expect(domainRecordCanUpdate('mfgBoms', 'VOIDED')).toBe(false)
    expect(domainRecordCanDelete('mfgBoms', 'DRAFT')).toBe(true)
    expect(domainRecordCanDelete('mfgBoms', 'ACTIVE')).toBe(false)
    expect(domainRecordCanDelete('mfgBoms', 'INACTIVE')).toBe(false)
  })
})

describe('生产工单选用 BOM', () => {
  test('复制 BOM 快照必须具备 BOM 读取权限', () => {
    const base = {
      userId: 'user-1' as Actor['userId'], username: 'tester',
      superAdmin: false, allCompanies: false, companyIds: [],
    }
    expect(() => requireBomSnapshotPermission({
      ...base,
      permissions: new Set(['mfg.work_order:update']),
    })).toThrow('无权限执行该操作')
    expect(() => requireBomSnapshotPermission({
      ...base,
      permissions: new Set(['mfg.bom:read']),
    })).not.toThrow()
  })

  test('applyBom 只接受启用中且母物料与工单一致的 BOM', () => {
    expect(() => assertSelectableBom({
      status: 'ACTIVE', materialId: 'finished-material',
    }, 'finished-material')).not.toThrow()

    for (const status of ['DRAFT', 'INACTIVE']) {
      expect(() => assertSelectableBom({
        status, materialId: 'finished-material',
      }, 'finished-material')).toThrow('仅启用中的 BOM 可选入工单')
    }

    expect(() => assertSelectableBom({
      status: 'ACTIVE', materialId: 'other-material',
    }, 'finished-material')).toThrow('BOM 物料须与工单物料一致')
  })

  test('进行中或已作废工单可走删除闸，已完工工单不可删除', () => {
    expect(domainRecordCanDelete('mfgWorkOrders', 'IN_PROGRESS')).toBe(true)
    expect(domainRecordCanDelete('mfgWorkOrders', 'VOIDED')).toBe(true)
    expect(domainRecordCanDelete('mfgWorkOrders', 'COMPLETED')).toBe(false)
  })
})
