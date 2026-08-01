import { describe, expect, test } from 'bun:test'
import {
  assertReconciliationDraftCanActivate,
  assertReconciliationRules,
  assertReconciliationSourceSelection,
} from './reconciliationDrafts'

function stored(
  id: string,
  resource: string,
  data: Record<string, unknown>,
  options: {
    companyId?: string | null
    status?: string | null
    decimals?: Record<string, bigint>
  } = {},
) {
  return {
    _id: id,
    _creationTime: 1,
    resource,
    companyId: options.companyId ?? null,
    parentId: null,
    status: options.status ?? null,
    sortKey: '',
    searchText: '',
    decimalValues: options.decimals ?? {},
    data,
    insertedAt: 1,
    updatedAt: 1,
  }
}

function context(documents: Record<string, ReturnType<typeof stored>>) {
  return {
    db: {
      normalizeId(_table: string, id: string) { return documents[id] ? id : null },
      async get(id: string) { return documents[id] ?? null },
    },
  } as never
}

const head = {
  side: 'sales' as const,
  reconciliationType: 'REGULAR',
  companyId: 'company-1',
  partyType: 'CUSTOMER',
  partyId: 'customer-1',
}

function line(overrides: Record<string, unknown> = {}) {
  return {
    requestedQty: '2',
    sourceQty: '10',
    sourceBaseQty: '20',
    reconciledQty: '4',
    fulfillmentStatus: 'AUDITED',
    companyId: 'company-1',
    partyType: 'CUSTOMER',
    partyId: 'customer-1',
    currencyCode: 'CNY',
    orderPrice: '10',
    orderType: 'REGULAR',
    ...overrides,
  }
}

describe('对账聚合草稿旧后端规则', () => {
  test('采购对账标准/委外入库来源必须恰选一个', () => {
    expect(() => assertReconciliationSourceSelection('purchase', {
      receiptItemId: 'receipt-item', outsourcedReceiptItemId: 'outsourced-item',
    })).toThrow('标准入库条目与委外入库条目必须恰选一个')
    expect(() => assertReconciliationSourceSelection('purchase', {}))
      .toThrow('标准入库条目与委外入库条目必须恰选一个')
  })

  test('合法采购来源显式清空未选槽位，避免 replace 保留存量伪 FK', () => {
    expect(assertReconciliationSourceSelection('purchase', {
      receiptItemId: 'receipt-item',
    })).toEqual({
      sourceResource: 'purReceiptItems',
      sourceId: 'receipt-item',
      trustedDerived: { receiptItemId: 'receipt-item', outsourcedReceiptItemId: null },
    })
    expect(assertReconciliationSourceSelection('purchase', {
      outsourcedReceiptItemId: 'outsourced-item',
    })).toEqual({
      sourceResource: 'purOutsourcedReceiptItems',
      sourceId: 'outsourced-item',
      trustedDerived: { receiptItemId: null, outsourcedReceiptItemId: 'outsourced-item' },
    })
  })

  test('销售对账只允许且必须选择发货来源', () => {
    expect(assertReconciliationSourceSelection('sales', {
      deliveryItemId: 'delivery-item',
    })).toEqual({
      sourceResource: 'salDeliveryItems',
      sourceId: 'delivery-item',
      trustedDerived: { deliveryItemId: 'delivery-item' },
    })
    expect(() => assertReconciliationSourceSelection('sales', {}))
      .toThrow('销售对账必须选择一个发货条目来源')
    expect(() => assertReconciliationSourceSelection('sales', {
      deliveryItemId: 'delivery-item', receiptItemId: 'receipt-item',
    })).toThrow('销售对账只允许发货条目来源')
  })

  test('对账类型必填且只接受两个旧后端枚举', () => {
    expect(() => assertReconciliationRules(
      { ...head, reconciliationType: null },
      [],
    )).toThrow('对账类型必须为常规或赠送/样品')
  })

  test('按来源行单位比例折算默认单位，并拒绝超过剩余可对账数量', () => {
    expect(() => assertReconciliationRules(head, [line()])).not.toThrow()
    expect(() => assertReconciliationRules(head, [line({ requestedQty: '9' })]))
      .toThrow('超过来源条目剩余可对账数量')
  })

  test('同一张对账单的来源订单原币必须一致', () => {
    expect(() => assertReconciliationRules(head, [line(), line({ currencyCode: 'USD' })]))
      .toThrow('同一对账单的来源订单币种必须一致')
  })

  test('常规对账拒绝零金额来源，销售侧另拒绝样品订单来源', () => {
    expect(() => assertReconciliationRules(head, [line({ orderPrice: '0' })]))
      .toThrow('常规对账单不能选择零金额条目')
    expect(() => assertReconciliationRules(head, [line({ orderType: 'SAMPLE' })]))
      .toThrow('常规销售对账单不能选择样品订单来源')
  })

  test('赠送/样品对账允许零金额与样品来源，但仍复检来源状态及单头归属', () => {
    expect(() => assertReconciliationRules(
      { ...head, reconciliationType: 'GIFT_SAMPLE' },
      [line({ orderPrice: '0', orderType: 'SAMPLE' })],
    )).not.toThrow()
    expect(() => assertReconciliationRules(head, [line({ fulfillmentStatus: 'VOIDED' })]))
      .toThrow('仅已审核履约条目可对账')
    expect(() => assertReconciliationRules(head, [line({ partyId: 'other-customer' })]))
      .toThrow('对账单公司或对手与履约单不一致')
  })

  test('生效前重读来源已对账投影，草稿保存后余量变化也会 fail-fast', async () => {
    const documents = {
      'delivery-item': stored('delivery-item', 'salDeliveryItems', {
        deliveryId: 'delivery', orderItemId: 'order-item', orderCurrencyCode: 'CNY',
      }, {
        companyId: 'company-1',
        decimals: {
          qty: 10_000_000n,
          baseQty: 20_000_000n,
          reconciledQty: 17_000_000n,
          orderPrice: 100_000n,
        },
      }),
      delivery: stored('delivery', 'salDeliveries', {
        partyType: 'CUSTOMER', partyId: 'customer-1',
      }, { companyId: 'company-1', status: 'AUDITED' }),
      'order-item': stored('order-item', 'salOrderItems', {
        orderId: 'order', currencyCode: 'CNY',
      }, { companyId: 'company-1' }),
      order: stored('order', 'salOrders', { orderType: 'REGULAR' }, {
        companyId: 'company-1', status: 'AUDITED',
      }),
    }
    const activation = () => assertReconciliationDraftCanActivate(
      context(documents),
      'salReconciliations',
      { ...head, id: 'reconciliation' },
      [{ deliveryItemId: 'delivery-item', qty: '2' }],
    )
    await expect(activation()).rejects.toThrow('超过来源条目剩余可对账数量')

    documents['delivery-item'] = stored('delivery-item', 'salDeliveryItems', {
      deliveryId: 'delivery', orderItemId: 'order-item', orderCurrencyCode: 'CNY',
    }, {
      companyId: 'company-1',
      decimals: {
        qty: 10_000_000n,
        baseQty: 20_000_000n,
        reconciledQty: 16_000_000n,
        orderPrice: 100_000n,
      },
    })
    await expect(activation()).resolves.toBeUndefined()
  })

  test('存量双来源坏记录在生效时于任何来源读取前 fail-closed', async () => {
    await expect(assertReconciliationDraftCanActivate(
      context({}),
      'purReconciliations',
      {
        id: 'reconciliation', reconciliationType: 'REGULAR', companyId: 'company-1',
        partyType: 'SUPPLIER', partyId: 'supplier-1',
      },
      [{
        receiptItemId: 'receipt-item', outsourcedReceiptItemId: 'outsourced-item', qty: '1',
      }],
    )).rejects.toThrow('标准入库条目与委外入库条目必须恰选一个')
  })
})
