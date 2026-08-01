import { describe, expect, test } from 'bun:test'
import type { Actor } from '../../lib/actor'
import { arrangeManualInMutation, removeArrangementInMutation } from './drafts'

type Row = Record<string, unknown> & { _id: string }

function actor(companyIds: string[], permissions = ['mfg.demand:update']): Actor {
  return {
    userId: 'user-1' as Actor['userId'],
    username: 'planner',
    name: 'Planner',
    superAdmin: false,
    allCompanies: false,
    permissions: new Set(permissions),
    companyIds,
  }
}

function fixture(companyId = 'company-a') {
  const tables = new Map<string, Map<string, Row>>()
  let sequence = 0
  const table = (name: string) => {
    let rows = tables.get(name)
    if (!rows) {
      rows = new Map()
      tables.set(name, rows)
    }
    return rows
  }
  const put = (name: string, row: Row) => table(name).set(row._id, row)
  const demandId = 'demand-a'
  const demandItemId = 'demand-item-a'

  put('manufacturingDocuments', {
    _id: demandId,
    resource: 'mfgDemands',
    companyId,
    parentId: null,
    status: 'CONFIRMED',
    sortKey: 'd-1',
    searchText: 'd-1',
    decimalValues: {},
    data: {
      demandNo: 'D-1',
      demandDate: '2026-08-01',
      remarks: null,
      createdById: 'user-owner',
    },
    insertedAt: 1,
    updatedAt: 1,
  })
  put('manufacturingDocuments', {
    _id: demandItemId,
    resource: 'mfgDemandItems',
    companyId,
    parentId: demandId,
    status: 'PENDING',
    sortKey: 'm-1',
    searchText: 'm-1',
    decimalValues: {
      qty: 10_000_000n,
      baseQty: 10_000_000n,
      orderedQty: 0n,
      receivedQty: 0n,
      arrangedQty: 0n,
      completedQty: 0n,
      remainingOrderableQty: 10_000_000n,
      remainingArrangeableQty: 10_000_000n,
    },
    data: {
      idx: 1,
      demandId,
      materialId: 'material-1',
      unitId: 'unit-1',
      needDate: '2026-08-10',
      fulfillmentMethod: null,
      materialCode: 'M-1',
      materialName: '物料一',
      materialSpec: null,
      unitName: '件',
      remarks: null,
      salesOrderItemId: null,
      ordered: false,
    },
    insertedAt: 1,
    updatedAt: 1,
  })

  const db = {
    normalizeId(name: string, id: string) {
      return table(name).has(id) ? id : null
    },
    async get(id: string) {
      for (const rows of tables.values()) {
        const row = rows.get(id)
        if (row) return row
      }
      return null
    },
    query(name: string) {
      return {
        withIndex(_index: string, configure: (query: { eq: (field: string, value: unknown) => unknown }) => unknown) {
          const equalities: Array<[string, unknown]> = []
          const query = {
            eq(field: string, value: unknown) {
              equalities.push([field, value])
              return query
            },
          }
          configure(query)
          const selected = () => [...table(name).values()].filter((row) =>
            equalities.every(([field, value]) => row[field] === value),
          )
          return {
            collect: async () => selected(),
            first: async () => selected()[0] ?? null,
            unique: async () => {
              const rows = selected()
              if (rows.length > 1) throw new Error('expected unique row')
              return rows[0] ?? null
            },
          }
        },
      }
    },
    async insert(name: string, values: Record<string, unknown>) {
      const id = `${name}-${++sequence}`
      put(name, { _id: id, ...values })
      return id
    },
    async patch(id: string, values: Record<string, unknown>) {
      const row = await this.get(id)
      if (!row) throw new Error(`missing row ${id}`)
      Object.assign(row, values)
    },
    async delete(id: string) {
      for (const rows of tables.values()) {
        if (rows.delete(id)) return
      }
    },
  }

  const seedArrangement = () => {
    const id = 'arrangement-a'
    put('mfgDemandArrangements', {
      _id: id,
      demandItemId,
      companyId,
      arrangementType: 'STOCK',
      qtyScaled: 4_000_000n,
      baseQtyScaled: 4_000_000n,
      workOrderId: null,
      purchaseOrderItemId: null,
      remarks: null,
      insertedAt: 1,
      updatedAt: 1,
    })
    return id
  }

  return { ctx: { db } as never, demandItemId, seedArrangement }
}

describe('履约需求手工安排公司范围', () => {
  test('有 update 权限但未获公司授权时不能手工安排', async () => {
    const { ctx, demandItemId } = fixture('company-a')

    try {
      await arrangeManualInMutation(ctx, actor(['company-b']), {
        demandItemId,
        arrangementType: 'STOCK',
        qty: '4',
      })
      throw new Error('预期跨公司手工安排被拒绝')
    } catch (error) {
      expect((error as { data?: { code?: string } }).data?.code).toBe('not_found')
    }
  })

  test('有 update 权限但未获公司授权时不能删除手工安排', async () => {
    const { ctx, seedArrangement } = fixture('company-a')
    const arrangementId = seedArrangement()

    try {
      await removeArrangementInMutation(ctx, actor(['company-b']), arrangementId)
      throw new Error('预期跨公司删除手工安排被拒绝')
    } catch (error) {
      expect((error as { data?: { code?: string } }).data?.code).toBe('not_found')
    }
  })

  test('同公司且有 update 权限时可以新增并删除手工安排', async () => {
    const { ctx, demandItemId } = fixture('company-a')
    const owner = actor(['company-a'])

    const created = await arrangeManualInMutation(ctx, owner, {
      demandItemId,
      arrangementType: 'STOCK',
      qty: '4',
    })
    expect(created).toMatchObject({ baseQty: '4.000000' })
    await expect(removeArrangementInMutation(ctx, owner, String(created.id))).resolves.toBeNull()
  })

  test('同公司但缺少 update 权限时仍拒绝手工安排', async () => {
    const { ctx, demandItemId } = fixture('company-a')

    try {
      await arrangeManualInMutation(ctx, actor(['company-a'], []), {
        demandItemId,
        arrangementType: 'STOCK',
        qty: '4',
      })
      throw new Error('预期无 update 权限的手工安排被拒绝')
    } catch (error) {
      expect((error as { data?: { code?: string } }).data?.code).toBe('forbidden')
    }
  })
})
