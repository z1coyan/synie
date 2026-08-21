import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { AuthService } from '~/platform/auth/service.ts'
import type { Actor } from '~/platform/authz/core/index.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { onError } from '~/platform/http/errors.ts'
import { purchaseFulfillmentHeadRoutes, salesFulfillmentHeadRoutes } from './fulfillment/routes.ts'
import type { FulfillmentService } from './fulfillment/service.ts'
import { orderHeadRoutes } from './order/routes.ts'
import type { OrderService } from './order/service.ts'
import {
  outsourcedIssueRoutes,
  outsourcedReceiptRoutes,
} from './outsourced/routes.ts'
import type { OutsourcedService } from './outsourced/service.ts'
import { quotationHeadRoutes } from './quotation/routes.ts'
import type { QuotationService } from './quotation/service.ts'
import { reconciliationHeadRoutes } from './reconciliation/routes.ts'
import type { ReconciliationService } from './reconciliation/service.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'

/** guard 需要 sealed registry：superAdmin 夹具恒 permit，本文件只验 wire schema */
const authz = createAuthzEnforcer(createSealedResourceRegistry())

const actor: Actor = testActor({
  userId: '',
  username: 'aggregate-route-test',
  name: '聚合路由测试',
  superAdmin: true,
  allCompanies: true,
  permissions: new Set(),
  companyIds: [],
})

const auth = {
  authenticate: async () => actor,
  authenticateRequest: async () => actor,
} as unknown as AuthService

const calls = {
  orderCreate: [] as unknown[],
  quotationCreate: [] as unknown[],
  purchaseReceiptCreate: [] as unknown[],
  reconciliationCreate: [] as unknown[],
  outsourcedIssueCreate: [] as unknown[],
  outsourcedReceiptCreate: [] as unknown[],
}

const orders = {
  createDraft: async (_permit: unknown, _side: string, input: unknown) => {
    calls.orderCreate.push(input)
    return {}
  },
  replaceDraft: async () => ({}),
} as unknown as OrderService

const quotations = {
  createDraft: async (_permit: unknown, _side: string, input: unknown) => {
    calls.quotationCreate.push(input)
    return {}
  },
  replaceDraft: async () => ({}),
} as unknown as QuotationService

const fulfillment = {
  createSalesDraft: async () => ({}),
  replaceSalesDraft: async () => ({}),
  createPurchaseReceiptDraft: async (_permit: unknown, input: unknown) => {
    calls.purchaseReceiptCreate.push(input)
    return {}
  },
  replacePurchaseReceiptDraft: async () => ({}),
} as unknown as FulfillmentService

const reconciliations = {
  createDraft: async (_permit: unknown, _side: string, input: unknown) => {
    calls.reconciliationCreate.push(input)
    return {}
  },
  replaceDraft: async () => ({}),
} as unknown as ReconciliationService

const outsourced = {
  createIssueDraft: async (_permit: unknown, input: unknown) => {
    calls.outsourcedIssueCreate.push(input)
    return {}
  },
  replaceIssueDraft: async () => ({}),
  createReceiptDraft: async (_permit: unknown, input: unknown) => {
    calls.outsourcedReceiptCreate.push(input)
    return {}
  },
  replaceReceiptDraft: async () => ({}),
} as unknown as OutsourcedService

const app = new Hono<AppEnv>()
  .route('/orders', orderHeadRoutes({ auth, authz, orders, side: 'purchase' }))
  .route('/quotations', quotationHeadRoutes({ auth, authz, quotations, side: 'purchase' }))
  .route('/deliveries', salesFulfillmentHeadRoutes({ auth, authz, fulfillment }))
  .route('/receipts', purchaseFulfillmentHeadRoutes({ auth, authz, fulfillment }))
  .route(
    '/reconciliations',
    reconciliationHeadRoutes({ auth, authz, reconciliations, side: 'purchase' }),
  )
  .route('/outsourced-issues', outsourcedIssueRoutes({ auth, authz, outsourced }))
  .route('/outsourced-receipts', outsourcedReceiptRoutes({ auth, authz, outsourced }))
app.onError(onError)

const companyId = crypto.randomUUID()
const partyId = crypto.randomUUID()
const currencyId = crypto.randomUUID()
const materialId = crypto.randomUUID()
const unitId = crypto.randomUUID()
const orderItemId = crypto.randomUUID()
const warehouseId = crypto.randomUUID()
const debitAccountId = crypto.randomUUID()
const creditAccountId = crypto.randomUUID()
const recordId = crypto.randomUUID()

const headers = {
  authorization: 'Bearer test',
  'content-type': 'application/json',
}

const orderHead = {
  companyId,
  orderNo: 'PO-STRICT',
  orderDate: '2026-07-31',
  orderType: 'SPOT',
  isOutsourced: true,
  partyType: 'SUPPLIER',
  partyId,
  currencyId,
  exchangeRate: '1',
}
const orderItem = {
  idx: 1,
  qty: '1',
  materialId,
  unitId,
  price: '2',
  taxRate: '0.13',
  issueLines: [],
  byproductLines: [],
}
const quotationHead = {
  companyId,
  quotationNo: 'PQ-STRICT',
  quotationDate: '2026-07-31',
  validUntil: '2026-08-31',
  partyType: 'SUPPLIER',
  partyId,
  currencyId,
}
const quotationItem = {
  idx: 1,
  materialId,
  unitId,
  pricingMode: 'QTY_TIERED',
  price: null,
  taxRate: '0.13',
  tiers: [{ minQty: '1', price: '2' }],
}
const salesDeliveryHead = {
  companyId,
  deliveryNo: 'SD-STRICT',
  deliveryDate: '2026-07-31',
  partyType: 'CUSTOMER',
  partyId,
  warehouseId,
  debitAccountId,
  creditAccountId,
}
const fulfillmentItem = {
  idx: 1,
  qty: '1',
  orderItemId,
  warehouseId,
}
const purchaseReceiptHead = {
  companyId,
  receiptNo: 'PR-STRICT',
  receiptDate: '2026-07-31',
  partyType: 'SUPPLIER',
  partyId,
  warehouseId,
  debitAccountId,
  creditAccountId,
}
const reconciliationHead = {
  companyId,
  reconciliationType: 'REGULAR',
  partyType: 'SUPPLIER',
  partyId,
  debitAccountId,
  creditAccountId,
}
const reconciliationItem = {
  idx: 1,
  qty: '1',
  receiptItemId: crypto.randomUUID(),
}
const outsourcedIssueHead = {
  companyId,
  issueDate: '2026-07-31',
  partyType: 'SUPPLIER',
  partyId,
  fromWarehouseId: warehouseId,
}
const outsourcedIssueItem = {
  idx: 1,
  qty: '1',
  orderItemMaterialId: crypto.randomUUID(),
  fromWarehouseId: warehouseId,
}
const outsourcedReceiptHead = {
  companyId,
  receiptDate: '2026-07-31',
  partyType: 'SUPPLIER',
  partyId,
  warehouseId,
  debitAccountId,
  creditAccountId,
}
const outsourcedReceiptItem = {
  idx: 1,
  qty: '1',
  orderItemId,
  warehouseId,
}

async function invalidPut(path: string, body: unknown) {
  const response = await app.request(path, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(400)
  return await response.json() as {
    error: { code: string; fields?: Record<string, string[]> }
  }
}

describe('Aggregate Draft HTTP schema', () => {
  test('PUT 必须显式提交全部集合与嵌套子树', async () => {
    const cases: Array<[string, unknown, string]> = [
      [`/orders/${recordId}`, orderHead, 'items'],
      [
        `/orders/${recordId}`,
        { ...orderHead, items: [{ ...orderItem, issueLines: undefined }] },
        'items[0].issueLines',
      ],
      [
        `/orders/${recordId}`,
        { ...orderHead, items: [{ ...orderItem, byproductLines: undefined }] },
        'items[0].byproductLines',
      ],
      [`/quotations/${recordId}`, quotationHead, 'items'],
      [
        `/quotations/${recordId}`,
        { ...quotationHead, items: [{ ...quotationItem, tiers: undefined }] },
        'items[0].tiers',
      ],
      [`/deliveries/${recordId}`, { ...salesDeliveryHead, packBoxes: [] }, 'items'],
      [`/receipts/${recordId}`, purchaseReceiptHead, 'items'],
      [`/reconciliations/${recordId}`, reconciliationHead, 'items'],
      [`/outsourced-issues/${recordId}`, outsourcedIssueHead, 'items'],
      [`/outsourced-receipts/${recordId}`, outsourcedReceiptHead, 'items'],
    ]

    for (const [path, body, field] of cases) {
      const result = await invalidPut(path, body)
      expect(result.error.code).toBe('validation')
      expect(result.error.fields?.[field]).toBeDefined()
    }
  })

  test('聚合 decimal wire 在路由层拒绝非十进制字符串并保留精确路径', async () => {
    const cases: Array<[string, unknown, string]> = [
      [
        `/orders/${recordId}`,
        { ...orderHead, items: [{ ...orderItem, qty: 'abc' }] },
        'items[0].qty',
      ],
      [
        `/orders/${recordId}`,
        {
          ...orderHead,
          items: [{
            ...orderItem,
            issueLines: [{ materialId, unitId, quantity: 'abc' }],
          }],
        },
        'items[0].issueLines[0].quantity',
      ],
      [
        `/quotations/${recordId}`,
        {
          ...quotationHead,
          items: [{
            ...quotationItem,
            tiers: [{ minQty: 'abc', price: '2' }],
          }],
        },
        'items[0].tiers[0].minQty',
      ],
      [
        `/deliveries/${recordId}`,
        {
          ...salesDeliveryHead,
          items: [{ ...fulfillmentItem, qty: 'abc' }],
          packBoxes: [],
        },
        'items[0].qty',
      ],
      [
        `/receipts/${recordId}`,
        {
          ...purchaseReceiptHead,
          items: [{ ...fulfillmentItem, qty: 'abc' }],
        },
        'items[0].qty',
      ],
      [
        `/reconciliations/${recordId}`,
        {
          ...reconciliationHead,
          items: [{ ...reconciliationItem, qty: 'abc' }],
        },
        'items[0].qty',
      ],
    ]

    for (const [path, body, field] of cases) {
      const result = await invalidPut(path, body)
      expect(result.error.fields?.[field]).toEqual(['必须是十进制字符串'])
    }
  })

  test('聚合 date-only wire 拒绝错误格式与不存在的日历日期', async () => {
    const cases: Array<[string, unknown, string]> = [
      [
        `/orders/${recordId}`,
        { ...orderHead, orderDate: '2026-02-30', items: [orderItem] },
        'header.orderDate',
      ],
      [
        `/orders/${recordId}`,
        {
          ...orderHead,
          items: [{ ...orderItem, demandDate: '2026/07/31' }],
        },
        'items[0].demandDate',
      ],
      [
        `/quotations/${recordId}`,
        { ...quotationHead, quotationDate: 'abc', items: [quotationItem] },
        'header.quotationDate',
      ],
      [
        `/quotations/${recordId}`,
        { ...quotationHead, validUntil: '2025-02-29', items: [quotationItem] },
        'header.validUntil',
      ],
      [
        `/deliveries/${recordId}`,
        {
          ...salesDeliveryHead,
          deliveryDate: '2026-13-01',
          items: [fulfillmentItem],
          packBoxes: [],
        },
        'header.deliveryDate',
      ],
      [
        `/deliveries/${recordId}`,
        {
          ...salesDeliveryHead,
          postingDate: '2026-7-31',
          items: [fulfillmentItem],
          packBoxes: [],
        },
        'header.postingDate',
      ],
      [
        `/receipts/${recordId}`,
        {
          ...purchaseReceiptHead,
          receiptDate: '0000-01-01',
          items: [fulfillmentItem],
        },
        'header.receiptDate',
      ],
      [
        `/receipts/${recordId}`,
        {
          ...purchaseReceiptHead,
          postingDate: '2026-04-31',
          items: [fulfillmentItem],
        },
        'header.postingDate',
      ],
    ]

    for (const [path, body, field] of cases) {
      const result = await invalidPut(path, body)
      expect(result.error.fields?.[field]).toEqual(['必须是有效的 YYYY-MM-DD 日期'])
    }

    const validLeapDay = await app.request('/orders', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...orderHead, orderDate: '2024-02-29', items: [] }),
    })
    expect(validLeapDay.status).toBe(201)
  })

  test('POST 保留空表头与缺省嵌套数组的兼容语义', async () => {
    calls.orderCreate.length = 0
    calls.quotationCreate.length = 0
    calls.purchaseReceiptCreate.length = 0
    calls.reconciliationCreate.length = 0
    calls.outsourcedIssueCreate.length = 0
    calls.outsourcedReceiptCreate.length = 0

    const orderResponse = await app.request('/orders', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...orderHead, items: [{
        idx: 1,
        qty: '1',
        materialId,
        unitId,
      }] }),
    })
    expect(orderResponse.status).toBe(201)
    expect(calls.orderCreate[0]).toMatchObject({
      items: [{ issueLines: [], byproductLines: [] }],
    })

    const quotationResponse = await app.request('/quotations', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...quotationHead, items: [{
        idx: 1,
        materialId,
        unitId,
      }] }),
    })
    expect(quotationResponse.status).toBe(201)
    expect(calls.quotationCreate[0]).toMatchObject({ items: [{ tiers: [] }] })

    const receiptResponse = await app.request('/receipts', {
      method: 'POST',
      headers,
      body: JSON.stringify(purchaseReceiptHead),
    })
    expect(receiptResponse.status).toBe(201)
    expect(calls.purchaseReceiptCreate[0]).toMatchObject({ items: [] })

    const reconciliationResponse = await app.request('/reconciliations', {
      method: 'POST',
      headers,
      body: JSON.stringify(reconciliationHead),
    })
    expect(reconciliationResponse.status).toBe(201)
    expect(calls.reconciliationCreate[0]).toMatchObject({ items: [] })

    const issueResponse = await app.request('/outsourced-issues', {
      method: 'POST',
      headers,
      body: JSON.stringify(outsourcedIssueHead),
    })
    expect(issueResponse.status).toBe(201)
    expect(calls.outsourcedIssueCreate[0]).toMatchObject({ items: [] })

    const outsourcedReceiptResponse = await app.request('/outsourced-receipts', {
      method: 'POST',
      headers,
      body: JSON.stringify(outsourcedReceiptHead),
    })
    expect(outsourcedReceiptResponse.status).toBe(201)
    expect(calls.outsourcedReceiptCreate[0]).toMatchObject({ items: [] })
  })
})
