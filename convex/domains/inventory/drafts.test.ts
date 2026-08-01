import { describe, expect, test } from 'bun:test'
import {
  deriveStockCountHead,
  prepareStockCountDraftInput,
  stockCountWarehouseItems,
} from './drafts'
import {
  assertStockCountWarehouseSnapshotCurrent,
  freezeStockCountWarehouseSnapshot,
  type StockCountWarehouseSnapshot,
} from './revisions'

describe('库存盘点 AggregateDraft loadAll', () => {
  test('create 的 loadAll 在同 mutation 展开显式 items，并移除一次性指令', async () => {
    const calls: Array<[string, string]> = []
    const prepared = await prepareStockCountDraftInput({
      companyId: 'company-1',
      warehouseId: 'warehouse-1',
      loadAll: true,
    }, 'create', async (companyId, warehouseId) => {
      calls.push([companyId, warehouseId])
      return [{
        materialId: 'material-1',
        unitId: 'unit-1',
        countedQuantity: null,
        remark: null,
      }]
    })

    expect(calls).toEqual([['company-1', 'warehouse-1']])
    expect(prepared).toEqual({
      companyId: 'company-1',
      warehouseId: 'warehouse-1',
      items: [{
        materialId: 'material-1',
        unitId: 'unit-1',
        countedQuantity: null,
        remark: null,
      }],
    })
  })

  test('loadAll 与非空显式明细互斥，普通空建单转成显式空集合', async () => {
    let loadCalled = false
    await expect(prepareStockCountDraftInput({
      companyId: 'company-1',
      warehouseId: 'warehouse-1',
      loadAll: true,
      items: [{ materialId: 'material-1' }],
    }, 'create', async () => {
      loadCalled = true
      return []
    })).rejects.toThrow('items 不能与 loadAll 同时提供')
    expect(loadCalled).toBe(false)

    await expect(prepareStockCountDraftInput({
      companyId: 'company-1',
      warehouseId: 'warehouse-1',
    }, 'create', async () => [])).resolves.toEqual({
      companyId: 'company-1',
      warehouseId: 'warehouse-1',
      items: [],
    })
  })

  test('replace 即使收到 loadAll 也绝不重新整仓生成', async () => {
    const input = { loadAll: true, items: [{ id: 'item-1', countedQuantity: '7' }] }
    let loadCalled = false
    const prepared = await prepareStockCountDraftInput(input, 'replace', async () => {
      loadCalled = true
      return []
    })
    expect(prepared).toBe(input)
    expect(loadCalled).toBe(false)
  })

  test('整仓口径只取当前代、当前公司与仓库的非零余额，使用物料默认单位并按物料编号排序', async () => {
    const indexCalls: Array<{ table: string; name: string; equals: Array<[string, unknown]> }> = []
    const balances = [
      { materialId: 'material-b', baseQty: 2_000_000n },
      { materialId: 'material-zero', baseQty: 0n },
      { materialId: 'material-a', baseQty: -1_000_000n },
    ]
    const materials = new Map([
      ['material-a', { code: 'A-001', defaultUnitId: 'unit-a' }],
      ['material-b', { code: 'B-001', defaultUnitId: 'unit-b' }],
      ['material-zero', { code: 'Z-000', defaultUnitId: 'unit-z' }],
    ])
    const db = {
      normalizeId(table: string, id: string) {
        expect(table).toBe('warehouses')
        return id === 'warehouse-1' ? id : null
      },
      query(table: string) {
        return {
          withIndex(name: string, configure: (query: { eq: (field: string, value: unknown) => unknown }) => unknown) {
            const call = { table, name, equals: [] as Array<[string, unknown]> }
            const query = {
              eq(field: string, value: unknown) {
                call.equals.push([field, value])
                return query
              },
            }
            configure(query)
            indexCalls.push(call)
            if (table === 'projectionGenerations') {
              return { unique: async () => ({ activeGeneration: 7 }) }
            }
            expect(table).toBe('inventoryCurrentBalances')
            return { collect: async () => balances }
          },
        }
      },
      async get(id: string) {
        if (id === 'warehouse-1') {
          return { companyId: 'company-1', isLeaf: true, active: true }
        }
        return materials.get(id) ?? null
      },
    }

    await expect(stockCountWarehouseItems({ db } as never, 'company-1', 'warehouse-1')).resolves.toEqual([
      { materialId: 'material-a', unitId: 'unit-a', countedQuantity: null, remark: null },
      { materialId: 'material-b', unitId: 'unit-b', countedQuantity: null, remark: null },
    ])
    expect(indexCalls).toEqual([
      {
        table: 'projectionGenerations',
        name: 'by_projection',
        equals: [['projection', 'inventory']],
      },
      {
        table: 'inventoryCurrentBalances',
        name: 'by_key',
        equals: [
          ['generation', 7],
          ['companyId', 'company-1'],
          ['warehouseId', 'warehouse-1'],
        ],
      },
    ])
  })

  test('create 冻结 snapshotTakenAt，replace 不重置快照', () => {
    expect(deriveStockCountHead(null, () => 123_456)).toEqual({ snapshotTakenAt: 123_456 })
    expect(deriveStockCountHead({ id: 'count-1' }, () => 999_999)).toEqual({})
  })

  test('create 冻结仓库与 revision，后续 replace 换仓保留原快照并标记待刷新', async () => {
    const writes: StockCountWarehouseSnapshot[] = []
    const readWarehouseIds: string[] = []
    let reads = 0
    await expect(freezeStockCountWarehouseSnapshot({}, 'warehouse-1', async (warehouseId) => {
      reads += 1
      readWarehouseIds.push(warehouseId)
      return 17n
    }, async (snapshot) => {
      writes.push(snapshot)
    })).resolves.toEqual({
      snapshotWarehouseId: 'warehouse-1', warehouseRevision: 17n, needsRefresh: false,
    })
    await expect(freezeStockCountWarehouseSnapshot(writes[0]!, 'warehouse-2', async (warehouseId) => {
      reads += 1
      readWarehouseIds.push(warehouseId)
      return 99n
    }, async (snapshot) => {
      writes.push(snapshot)
    })).resolves.toEqual({
      snapshotWarehouseId: 'warehouse-1', warehouseRevision: 17n, needsRefresh: true,
    })
    expect(reads).toBe(1)
    expect(readWarehouseIds).toEqual(['warehouse-1'])
    expect(writes).toEqual([
      { snapshotWarehouseId: 'warehouse-1', warehouseRevision: 17n, needsRefresh: false },
      { snapshotWarehouseId: 'warehouse-1', warehouseRevision: 17n, needsRefresh: true },
    ])
  })

  test('显式刷新必须用当前仓库与 revision 原子覆盖旧快照', async () => {
    const writes: StockCountWarehouseSnapshot[] = []
    const reads: string[] = []
    const refreshed = await freezeStockCountWarehouseSnapshot({
      snapshotWarehouseId: 'warehouse-1',
      warehouseRevision: 17n,
    }, 'warehouse-2', async (warehouseId) => {
      reads.push(warehouseId)
      return 18n
    }, async (snapshot) => {
      writes.push(snapshot)
    }, true)
    expect(refreshed).toEqual({
      snapshotWarehouseId: 'warehouse-2', warehouseRevision: 18n, needsRefresh: false,
    })
    expect(reads).toEqual(['warehouse-2'])
    expect(writes).toEqual([{
      snapshotWarehouseId: 'warehouse-2', warehouseRevision: 18n, needsRefresh: false,
    }])
  })

  test('仓库 A→B→A 始终保持待刷新，只有显式刷新才能清除', async () => {
    let internal: Record<string, unknown> = {
      snapshotWarehouseId: 'warehouse-a',
      warehouseRevision: 17n,
      needsRefresh: false,
    }
    const writes: Array<Record<string, unknown>> = []
    const save = async (snapshot: Record<string, unknown>) => {
      writes.push(snapshot)
      internal = snapshot
    }

    internal = await freezeStockCountWarehouseSnapshot(
      internal,
      'warehouse-b',
      async () => 99n,
      save,
    )
    expect(internal.needsRefresh).toBe(true)
    expect(writes).toHaveLength(1)

    internal = await freezeStockCountWarehouseSnapshot(
      internal,
      'warehouse-a',
      async () => 17n,
      save,
    )
    expect(internal.needsRefresh).toBe(true)

    internal = await freezeStockCountWarehouseSnapshot(
      internal,
      'warehouse-a',
      async () => 17n,
      save,
      true,
    )
    expect(internal).toEqual({
      snapshotWarehouseId: 'warehouse-a',
      warehouseRevision: 17n,
      needsRefresh: false,
    })
  })

  test('旧记录补 revision 时按已冻结仓库读取，不与编辑后的新仓库错配', async () => {
    const reads: string[] = []
    const snapshot = await freezeStockCountWarehouseSnapshot({
      snapshotWarehouseId: 'warehouse-old',
    }, 'warehouse-new', async (warehouseId) => {
      reads.push(warehouseId)
      return 23n
    }, async () => {})
    expect(reads).toEqual(['warehouse-old'])
    expect(snapshot).toEqual({
      snapshotWarehouseId: 'warehouse-old', warehouseRevision: 23n, needsRefresh: true,
    })
  })

  test('审批同时校验快照仓库和 revision，并提示刷新账面数', () => {
    expect(() => assertStockCountWarehouseSnapshotCurrent({
      snapshotWarehouseId: 'warehouse-1',
      warehouseRevision: 17n,
    }, 'warehouse-1', 17n)).not.toThrow()
    expect(() => assertStockCountWarehouseSnapshotCurrent({
      snapshotWarehouseId: 'warehouse-1',
      warehouseRevision: 17n,
    }, 'warehouse-2', 17n)).toThrow('请刷新账面数后重新审核')
    expect(() => assertStockCountWarehouseSnapshotCurrent({
      snapshotWarehouseId: 'warehouse-1',
      warehouseRevision: 17n,
    }, 'warehouse-1', 18n)).toThrow('请刷新账面数后重新审核')
    expect(() => assertStockCountWarehouseSnapshotCurrent({
      snapshotWarehouseId: 'warehouse-1',
      warehouseRevision: 17n,
      needsRefresh: true,
    }, 'warehouse-1', 17n)).toThrow('请刷新账面数后重新审核')
  })
})
