import { describe, expect, test } from 'bun:test'
import {
  assertIssueWarehousePair,
  assertOutsourcedDraftCanActivate,
  assertOutsourcedReceiptCurrencies,
  assertWarehouseRule,
  controlledReceiptQuantities,
  proportionalReceiptLines,
  shouldCarryReceiptChildren,
} from './fulfillmentDrafts'

function stored(
  id: string,
  resource: string,
  data: Record<string, unknown>,
  options: { companyId?: string | null; parentId?: string | null; status?: string | null } = {},
) {
  return {
    _id: id,
    _creationTime: 1,
    resource,
    companyId: options.companyId ?? null,
    parentId: options.parentId ?? null,
    status: options.status ?? null,
    sortKey: '',
    searchText: '',
    decimalValues: {},
    data,
    insertedAt: 1,
    updatedAt: 1,
  }
}

type FakeDocument = ReturnType<typeof stored> | Record<string, unknown>

function context(documents: Record<string, FakeDocument>) {
  return {
    db: {
      normalizeId(_table: string, id: string) { return documents[id] ? id : null },
      async get(id: string) { return documents[id] ?? null },
      query(_table: string) {
        return {
          withIndex(_name: string, configure: (q: { eq: (field: string, value: unknown) => unknown }) => unknown) {
            const equals: Array<[string, unknown]> = []
            const q = { eq(field: string, value: unknown) { equals.push([field, value]); return q } }
            configure(q)
            return {
              async collect() {
                return Object.values(documents).filter((row) => equals.every(([field, value]) =>
                  row[field] === value,
                ))
              },
            }
          },
        }
      },
    },
  } as never
}

describe('委外履约 Aggregate Draft 派生', () => {
  test('已对账数量只从既有受控值继承，剩余量使用默认单位数量扣减', () => {
    expect(controlledReceiptQuantities('12.5', undefined)).toEqual({
      reconciledQty: '0.000000',
      remainingReconcilableQty: '12.500000',
    })
    expect(controlledReceiptQuantities('12.5', '2.25')).toEqual({
      reconciledQty: '2.250000',
      remainingReconcilableQty: '10.250000',
    })
    expect(() => controlledReceiptQuantities('12.5', '-1')).toThrow(
      '已对账数量不合法',
    )
  })

  test('新成品行按默认单位比例一次性构造材料/副产物子行，跳过非正数量', () => {
    const sources = [
      { id: 'line-1', quantity: '10' },
      { id: 'line-zero', quantity: '0' },
      { id: 'line-2', quantity: '3' },
    ]
    expect(
      proportionalReceiptLines(
        'material',
        sources,
        '2.5',
        '5',
        'outsourced-warehouse',
      ),
    ).toEqual([
      {
        idx: 0,
        qty: '5.000000',
        remarks: null,
        orderItemMaterialId: 'line-1',
        outsourcedWarehouseId: 'outsourced-warehouse',
      },
      {
        idx: 1,
        qty: '1.500000',
        remarks: null,
        orderItemMaterialId: 'line-2',
        outsourcedWarehouseId: 'outsourced-warehouse',
      },
    ])
    expect(
      proportionalReceiptLines('byproduct', sources.slice(0, 1), '1', '4', null),
    ).toEqual([
      {
        idx: 0,
        qty: '2.500000',
        remarks: null,
        orderItemByproductId: 'line-1',
        warehouseId: null,
      },
    ])
  })

  test('自动带出只发生在新行的显式空 collection，replace 与已提交子行均不重复带入', () => {
    expect(shouldCarryReceiptChildren(null, [])).toBe(true)
    expect(shouldCarryReceiptChildren({ id: 'saved-item' }, [])).toBe(false)
    expect(
      shouldCarryReceiptChildren(null, [
        { orderItemMaterialId: 'manual-line', qty: '1' },
      ]),
    ).toBe(false)
    expect(shouldCarryReceiptChildren(null, undefined)).toBe(false)
  })

  test('订单默认单位数量无效时不代入，避免除零或非有限数量', () => {
    const source = [{ id: 'line-1', quantity: '10' }]
    expect(proportionalReceiptLines('material', source, '1', '0', null)).toEqual(
      [],
    )
    expect(
      proportionalReceiptLines('material', source, '1', 'not-a-number', null),
    ).toEqual([])
  })

  test('普通仓必须是本公司启用叶子仓', () => {
    const warehouse = {
      companyId: 'company-1', active: true, isLeaf: true, isOutsourced: false,
      partyType: null, partyId: null,
    }
    expect(() => assertWarehouseRule('ordinary', warehouse, {
      companyId: 'company-1', partyType: 'SUPPLIER', partyId: 'supplier-1',
    })).not.toThrow()
    expect(() => assertWarehouseRule('ordinary', { ...warehouse, isOutsourced: true }, {
      companyId: 'company-1', partyType: 'SUPPLIER', partyId: 'supplier-1',
    })).not.toThrow()
    expect(() => assertWarehouseRule('ordinary', { ...warehouse, companyId: 'company-2' }, {
      companyId: 'company-1', partyType: 'SUPPLIER', partyId: 'supplier-1',
    })).toThrow('仓库不属于本公司')
    expect(() => assertWarehouseRule('ordinary', { ...warehouse, active: false }, {
      companyId: 'company-1', partyType: 'SUPPLIER', partyId: 'supplier-1',
    })).toThrow('仓库已停用')
    expect(() => assertWarehouseRule('ordinary', { ...warehouse, isLeaf: false }, {
      companyId: 'company-1', partyType: 'SUPPLIER', partyId: 'supplier-1',
    })).toThrow('仅可使用叶子仓')
  })

  test('外协仓还必须标记为外协仓并绑定当前对手', () => {
    const warehouse = {
      companyId: 'company-1', active: true, isLeaf: true, isOutsourced: true,
      partyType: 'SUPPLIER', partyId: 'supplier-1',
    }
    const expected = { companyId: 'company-1', partyType: 'SUPPLIER', partyId: 'supplier-1' }
    expect(() => assertWarehouseRule('outsourced', warehouse, expected)).not.toThrow()
    expect(() => assertWarehouseRule('outsourced', { ...warehouse, isOutsourced: false }, expected))
      .toThrow('仓库不是外协仓')
    expect(() => assertWarehouseRule('outsourced', { ...warehouse, partyId: 'supplier-2' }, expected))
      .toThrow('外协仓未绑定当前对手')
  })

  test('委外发料行的起止仓必填且不能相同', () => {
    expect(() => assertIssueWarehousePair('warehouse-1', 'warehouse-2')).not.toThrow()
    expect(() => assertIssueWarehousePair(null, 'warehouse-2')).toThrow('调出仓与外协仓均为必填')
    expect(() => assertIssueWarehousePair('warehouse-1', 'warehouse-1')).toThrow('调出仓与外协仓不能相同')
  })

  test('委外入库的来源订单原币必须一致', () => {
    expect(() => assertOutsourcedReceiptCurrencies(['CNY', 'CNY'])).not.toThrow()
    expect(() => assertOutsourcedReceiptCurrencies(['CNY', 'USD']))
      .toThrow('同一委外入库单的来源订单币种必须一致')
  })

  test('委外入库审核在过账前重读仓库，并要求材料/副产物行仓库已落行', async () => {
    const documents: Record<string, FakeDocument> = {
      item: stored('item', 'purOutsourcedReceiptItems', {
        receiptId: 'receipt', orderItemId: 'order-item', warehouseId: 'ordinary-warehouse',
      }, { companyId: 'company-1', parentId: 'receipt' }),
      material: stored('material', 'purOutsourcedReceiptItemMaterials', {
        receiptItemId: 'item', orderItemMaterialId: 'material-source',
        outsourcedWarehouseId: 'outsourced-warehouse',
      }, { companyId: 'company-1', parentId: 'item' }),
      byproduct: stored('byproduct', 'purOutsourcedReceiptItemByproducts', {
        receiptItemId: 'item', orderItemByproductId: 'byproduct-source',
        warehouseId: 'ordinary-warehouse',
      }, { companyId: 'company-1', parentId: 'item' }),
      'order-item': stored('order-item', 'purOrderItems', {
        orderId: 'order', currencyCode: 'CNY',
      }, { companyId: 'company-1' }),
      order: stored('order', 'purOrders', {
        isOutsourced: true, partyType: 'SUPPLIER', partyId: 'supplier-1',
      }, { companyId: 'company-1', status: 'AUDITED' }),
      'material-source': stored('material-source', 'purOrderItemMaterials', {
        orderItemId: 'order-item',
      }, { companyId: 'company-1', parentId: 'order-item' }),
      'byproduct-source': stored('byproduct-source', 'purOrderItemByproducts', {
        orderItemId: 'order-item',
      }, { companyId: 'company-1', parentId: 'order-item' }),
      'ordinary-warehouse': {
        _id: 'ordinary-warehouse', companyId: 'company-1', active: true, isLeaf: true,
        isOutsourced: false, partyType: null, partyId: null,
      },
      'outsourced-warehouse': {
        _id: 'outsourced-warehouse', companyId: 'company-1', active: true, isLeaf: true,
        isOutsourced: true, partyType: 'SUPPLIER', partyId: 'supplier-1',
      },
    }
    const activation = () => assertOutsourcedDraftCanActivate(
      context(documents),
      'purOutsourcedReceipts',
      {
        id: 'receipt', companyId: 'company-1',
        partyType: 'SUPPLIER', partyId: 'supplier-1',
      },
    )
    await expect(activation()).resolves.toBeUndefined()

    documents.material = stored('material', 'purOutsourcedReceiptItemMaterials', {
      receiptItemId: 'item', orderItemMaterialId: 'material-source',
      outsourcedWarehouseId: null,
    }, { companyId: 'company-1', parentId: 'item' })
    await expect(activation()).rejects.toThrow('材料扣减行必须填写外协仓')
  })
})
