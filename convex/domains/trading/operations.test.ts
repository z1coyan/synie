import { describe, expect, test } from 'bun:test'
import { collectPurchaseDemandLines } from './operations'

describe('purchase demand candidate pagination', () => {
  test('每页不超过 100，首个空资格页后仍沿 opaque cursor 读取', async () => {
    const calls: Array<{ numItems: number; cursor: string | null }> = []
    const first = Array.from({ length: 100 }, (_, index) => ({
      id: `demand-${index}`,
      demandNo: `D-${index}`,
      companyId: 'company-1',
    }))
    const result = await collectPurchaseDemandLines({
      loadDemands: async (numItems, cursor) => {
        calls.push({ numItems, cursor })
        return cursor === null
          ? {
              results: first,
              pageInfo: { continueCursor: 'demand/next', isDone: false },
            }
          : {
              results: [{ id: 'demand-101', demandNo: 'D-101', companyId: 'company-1' }],
              pageInfo: { continueCursor: null, isDone: true },
            }
      },
      loadItems: async (demandId) => demandId === 'demand-101'
        ? [{
            id: 'item-101', status: 'OPEN', remainingArrangeableQty: '2.500000',
            materialCode: 'M-1', materialName: '原料', materialId: 'material-1',
            unitId: 'unit-1', unitName: '件', baseQty: '10',
          }]
        : [],
    }, { isOutsourced: true, search: '原料' })

    expect(calls).toEqual([
      { numItems: 100, cursor: null },
      { numItems: 100, cursor: 'demand/next' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'item-101',
      demandId: 'demand-101',
      remainingBaseQty: '2.5',
      suggestedQty: '2.5',
      isOutsourced: true,
    })
  })

  test('未结束页缺 cursor 或重复 cursor 时 fail-closed', async () => {
    await expect(collectPurchaseDemandLines({
      loadDemands: async () => ({
        results: [],
        pageInfo: { continueCursor: null, isDone: false },
      }),
      loadItems: async () => [],
    }, { isOutsourced: false })).rejects.toThrow(/缺少 continueCursor/)

    let call = 0
    await expect(collectPurchaseDemandLines({
      loadDemands: async () => ({
        results: [],
        pageInfo: { continueCursor: 'same', isDone: false },
      }),
      loadItems: async () => {
        call += 1
        return []
      },
    }, { isOutsourced: false })).rejects.toThrow(/重复/)
    expect(call).toBe(0)
  })
})
