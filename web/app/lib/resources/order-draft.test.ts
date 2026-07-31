import { describe, expect, test } from 'bun:test'
import type { Row } from '~/components/synie-data-grid/types'
import {
  buildOrderDraft,
  createInMemoryOrderDraftAdapter,
  purchaseOrderDraftAdapter,
  salesOrderDraftAdapter,
  type OrderDraft,
  type OrderSide,
} from './order-draft'

const salesHeader = {
  companyId: 'company-1',
  orderNo: 'SO-1',
  orderDate: '2026-07-31',
  orderType: 'SAMPLE',
  partyType: 'CUSTOMER',
  partyId: 'customer-1',
  currencyId: 'currency-1',
  exchangeRate: '1',
  remarks: null,
}

function item(idx: number) {
  return {
    idx,
    qty: String(idx),
    materialId: `material-${idx}`,
    unitId: `unit-${idx}`,
    price: String(idx * 10),
    taxRate: '0.13',
    remarks: null,
    quotationItemId: null,
    issueLines: [],
    byproductLines: [],
  }
}

async function exerciseSide(side: OrderSide) {
  const adapter = createInMemoryOrderDraftAdapter(side)
  const header = side === 'sales'
    ? salesHeader
    : {
        ...salesHeader,
        orderNo: 'PO-1',
        orderType: 'SPOT',
        partyType: 'SUPPLIER',
        partyId: 'supplier-1',
        isOutsourced: true,
      }
  const created = await adapter.createDraft({
    ...header,
    items: [
      item(1),
      {
        ...item(2),
        issueLines:
          side === 'purchase'
            ? [{
                materialId: 'raw-1',
                unitId: 'unit-1',
                quantity: '5',
                remarks: null,
              }]
            : [],
        byproductLines: [],
      },
    ],
  })
  const kept = created.items[1]!
  const issue = kept.issueLines[0]
  const replaced = await adapter.replaceDraft(created.id, {
    ...header,
    terms: '整单替换',
    items: [
      {
        ...item(2),
        id: kept.id,
        qty: '20',
        issueLines:
          side === 'purchase'
            ? [{
                id: issue!.id,
                materialId: 'raw-1',
                unitId: 'unit-1',
                quantity: '8',
                remarks: '更新',
              }]
            : [],
        byproductLines:
          side === 'purchase'
            ? [{
                materialId: 'scrap-1',
                unitId: 'unit-1',
                quantity: '1',
                remarks: null,
              }]
            : [],
      },
      item(3),
    ],
  })
  expect(replaced.items).toHaveLength(2)
  expect(replaced.items.some((row) => row.id === created.items[0]?.id)).toBe(false)
  expect(replaced.items[0]?.id).toBe(kept.id)
  expect(replaced.items[0]?.qty).toBe('20')
  if (side === 'purchase') {
    expect(replaced.items[0]?.issueLines[0]?.id).toBe(issue?.id)
    expect(replaced.items[0]?.issueLines[0]?.quantity).toBe('8')
    expect(replaced.items[0]?.byproductLines).toHaveLength(1)
  }
}

describe('销售/采购订单 Aggregate Draft module', () => {
  test('production 与测试 Adapter 共享 load/create/replace interface', () => {
    for (const adapter of [
      salesOrderDraftAdapter,
      purchaseOrderDraftAdapter,
      createInMemoryOrderDraftAdapter('sales'),
      createInMemoryOrderDraftAdapter('purchase'),
    ]) {
      expect(typeof adapter.loadDraft).toBe('function')
      expect(typeof adapter.createDraft).toBe('function')
      expect(typeof adapter.replaceDraft).toBe('function')
    }
  })

  test('表单转换保留持久化身份并完整携带采购委外子树', () => {
    const draft = buildOrderDraft(
      'purchase',
      { ...salesHeader, isOutsourced: true },
      '交易条款',
      [{
        id: 'saved-item',
        ...item(1),
        materialName: '仅展示',
        issueLines: [
          {
            id: 'saved-issue',
            materialId: 'raw-1',
            unitId: 'unit-1',
            quantity: 5,
            issuedQty: 2,
          },
          {
            id: 'local:issue',
            materialId: 'raw-2',
            unitId: 'unit-1',
            quantity: 3,
          },
        ],
        byproductLines: [{
          id: 'saved-byproduct',
          materialId: 'scrap-1',
          unitId: 'unit-1',
          quantity: 1,
        }],
      } as Row],
    )
    expect(draft.terms).toBe('交易条款')
    expect(draft.items[0]?.id).toBe('saved-item')
    expect(draft.items[0]).not.toHaveProperty('materialName')
    expect(draft.items[0]?.issueLines[0]?.id).toBe('saved-issue')
    expect(draft.items[0]?.issueLines[0]).not.toHaveProperty('issuedQty')
    expect(draft.items[0]?.issueLines[1]).not.toHaveProperty('id')
    expect(draft.items[0]?.byproductLines[0]?.id).toBe('saved-byproduct')
  })

  test('销售/采购均可整体增改删；采购覆盖发料与副产物', async () => {
    await exerciseSide('sales')
    await exerciseSide('purchase')
  })

  test('采购嵌套身份失败时替换前完整快照保持不变', async () => {
    const adapter = createInMemoryOrderDraftAdapter('purchase')
    const created = await adapter.createDraft({
      ...salesHeader,
      orderType: 'SPOT',
      partyType: 'SUPPLIER',
      partyId: 'supplier-1',
      isOutsourced: true,
      items: [{
        ...item(1),
        issueLines: [{
          materialId: 'raw-1',
          unitId: 'unit-1',
          quantity: '5',
          remarks: null,
        }],
      }],
    } satisfies OrderDraft)
    const before = await adapter.loadDraft(created.id)

    await expect(
      adapter.replaceDraft(created.id, {
        ...salesHeader,
        orderType: 'SPOT',
        partyType: 'SUPPLIER',
        partyId: 'supplier-1',
        isOutsourced: true,
        terms: '不可见',
        items: [{
          ...item(1),
          id: created.items[0]!.id,
          issueLines: [{
            id: 'foreign-line',
            materialId: 'raw-1',
            unitId: 'unit-1',
            quantity: '9',
            remarks: null,
          }],
        }],
      }),
    ).rejects.toThrow(/不属于订单条目/)
    expect(await adapter.loadDraft(created.id)).toEqual(before)
  })

  test('销售与非委外采购拒绝委外子表且不写入状态', async () => {
    const line = {
      materialId: 'raw-1',
      unitId: 'unit-1',
      quantity: '1',
      remarks: null,
    }
    await expect(
      createInMemoryOrderDraftAdapter('sales').createDraft({
        ...salesHeader,
        items: [{ ...item(1), issueLines: [line] }],
      }),
    ).rejects.toThrow(/销售订单不支持委外配置/)
    await expect(
      createInMemoryOrderDraftAdapter('purchase').createDraft({
        ...salesHeader,
        orderType: 'SPOT',
        partyType: 'SUPPLIER',
        partyId: 'supplier-1',
        isOutsourced: false,
        items: [{ ...item(1), byproductLines: [line] }],
      }),
    ).rejects.toThrow(/仅委外订单/)
  })

  test('测试 Adapter 返回隔离快照', async () => {
    const adapter = createInMemoryOrderDraftAdapter('sales')
    const created = await adapter.createDraft({
      ...salesHeader,
      items: [item(1)],
    })
    const loaded = await adapter.loadDraft(created.id)
    loaded.items[0]!.qty = '999'
    expect((await adapter.loadDraft(created.id)).items[0]?.qty).toBe('1')
  })
})
