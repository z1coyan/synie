import { describe, expect, test } from 'bun:test'
import { assertStockCountItemsReady, stockPosting } from '../commands'

type StoredItem = {
  _id: string
  resource: 'invStockCountItems'
  companyId: string
  parentId: string
  status: null
  data: Record<string, unknown>
  decimalValues: Record<string, unknown>
  insertedAt: number
  updatedAt: number
}

function item(
  id: string,
  decimalValues: Record<string, unknown>,
): StoredItem {
  return {
    _id: id,
    resource: 'invStockCountItems',
    companyId: 'company-1',
    parentId: 'count-1',
    status: null,
    data: {
      countId: 'count-1',
      materialId: `material-${id}`,
      unitId: 'unit-1',
    },
    decimalValues,
    insertedAt: 1,
    updatedAt: 1,
  }
}

function context(items: StoredItem[]) {
  return {
    db: {
      query(table: string) {
        expect(table).toBe('inventoryDocuments')
        return {
          withIndex(name: string, configure: (query: { eq: (field: string, value: unknown) => unknown }) => unknown) {
            expect(name).toBe('by_resource_parent_sort')
            const equals: Array<[string, unknown]> = []
            const query = {
              eq(field: string, value: unknown) {
                equals.push([field, value])
                return query
              },
            }
            configure(query)
            expect(equals).toEqual([
              ['resource', 'invStockCountItems'],
              ['parentId', 'count-1'],
            ])
            return { collect: async () => items }
          },
        }
      },
    },
  }
}

describe('库存盘点审批过账路径', () => {
  test('完整性 helper 同时拒绝 null、undefined 与空串，但接受明确的零', () => {
    expect(() => assertStockCountItemsReady([{
      countedQuantity: '',
      convertedCounted: '0',
    }])).toThrow('审核前每行都必须填写实盘数量')
    expect(() => assertStockCountItemsReady([{
      countedQuantity: '0',
      convertedCounted: '   ',
    }])).toThrow('审核前每行都必须填写实盘数量')
    expect(() => assertStockCountItemsReady([{
      countedQuantity: '0',
      convertedCounted: '0',
    }])).not.toThrow()
  })

  test('空盘点单在任何差额计算前拒绝审批', async () => {
    await expect(stockPosting(
      context([]) as never,
      'invStockCounts',
      'count-1',
      { warehouseId: 'warehouse-1' },
      'approve',
    )).rejects.toThrow('审核前必须至少填写一行盘点明细')
  })

  test('任一行缺录入或折算实盘数均拒绝，不能把 null 当零', async () => {
    for (const row of [
      item('missing-input', { convertedCounted: 0n, bookQuantity: 0n }),
      item('missing-converted', { countedQuantity: 0n, bookQuantity: 0n }),
    ]) {
      await expect(stockPosting(
        context([row]) as never,
        'invStockCounts',
        'count-1',
        { warehouseId: 'warehouse-1' },
        'approve',
      )).rejects.toThrow('审核前每行都必须填写实盘数量')
    }
  })

  test('明确填写零且折算值为零是完整行，零差异无需产生库存分录', async () => {
    await expect(stockPosting(
      context([item('zero', {
        countedQuantity: 0n,
        convertedCounted: 0n,
        bookQuantity: 0n,
      })]) as never,
      'invStockCounts',
      'count-1',
      { warehouseId: 'warehouse-1' },
      'approve',
    )).resolves.toBeNull()
  })
})
