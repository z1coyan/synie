import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { createRowCommandAdapter } from './catalog/commands'
import type { AggregateDraftAdapter } from './catalog/types'
import { decimalWireInput, resourceListBody } from './resource-wire'
import type { ResourceTransport } from './types'

type FulfillmentAuditRequest = Record<string, unknown>
export interface CompanyAccountDefaults {
  id: string
  deliveryDebitAccountId: string | null
  deliveryCreditAccountId: string | null
  receiptDebitAccountId: string | null
  receiptCreditAccountId: string | null
  [key: string]: unknown
}
type ResourceOperations = Pick<ResourceTransport, 'query' | 'get'> &
  Partial<Pick<ResourceTransport, 'create' | 'update' | 'delete'>>

function resourceClient<const TOperations extends ResourceOperations>(
  resource: string,
  operations: TOperations,
): { id: string } & TOperations {
  return {
    id: `rest:${resource}`,
    ...operations,
  }
}

export async function fetchSalesCompanyAccountDefaults(
  companyId: string,
): Promise<CompanyAccountDefaults | null> {
  try {
    return await apiData(
      api.sales['company-account-defaults']['by-company'][':companyId'].$get({
        param: { companyId },
      }),
    )
  } catch {
    return null
  }
}

export async function auditSalesDelivery(
  id: string,
  _input?: FulfillmentAuditRequest,
) {
  return apiData(api.sales.deliveries[':id'].audit.$post({ param: { id } }))
}

export async function voidSalesDelivery(id: string) {
  return apiData(api.sales.deliveries[':id'].void.$post({ param: { id } }))
}

export async function auditPurchaseReceipt(
  id: string,
  _input?: FulfillmentAuditRequest,
) {
  return apiData(api.purchase.receipts[':id'].audit.$post({ param: { id } }))
}

export async function voidPurchaseReceipt(id: string) {
  return apiData(api.purchase.receipts[':id'].void.$post({ param: { id } }))
}

export async function auditPurchaseOutsourcedIssue(id: string) {
  return apiData(
    api.purchase['outsourced-issues'][':id'].audit.$post({ param: { id } }),
  )
}

export async function voidPurchaseOutsourcedIssue(id: string) {
  return apiData(
    api.purchase['outsourced-issues'][':id'].void.$post({ param: { id } }),
  )
}

export async function auditPurchaseOutsourcedReceipt(
  id: string,
  _input?: FulfillmentAuditRequest,
) {
  return apiData(
    api.purchase['outsourced-receipts'][':id'].audit.$post({ param: { id } }),
  )
}

export async function voidPurchaseOutsourcedReceipt(id: string) {
  return apiData(
    api.purchase['outsourced-receipts'][':id'].void.$post({ param: { id } }),
  )
}

export const salesDeliveryCommandAdapter = createRowCommandAdapter({
  audit: {
    handler: auditSalesDelivery,
    affectedResources: [
      'salDeliveryItems',
      'salOrderItems',
      'invStockEntries',
      'accGlEntries',
      'scmOrderFlowItems',
    ],
  },
  void: {
    handler: voidSalesDelivery,
    affectedResources: [
      'salDeliveryItems',
      'salOrderItems',
      'invStockEntries',
      'accGlEntries',
      'scmOrderFlowItems',
    ],
  },
})

export const purchaseReceiptCommandAdapter = createRowCommandAdapter({
  audit: {
    handler: auditPurchaseReceipt,
    affectedResources: [
      'purReceiptItems',
      'purOrderItems',
      'mfgDemandItems',
      'invStockEntries',
      'accGlEntries',
      'scmOrderFlowItems',
    ],
  },
  void: {
    handler: voidPurchaseReceipt,
    affectedResources: [
      'purReceiptItems',
      'purOrderItems',
      'mfgDemandItems',
      'invStockEntries',
      'accGlEntries',
      'scmOrderFlowItems',
    ],
  },
})

export const purchaseOutsourcedIssueCommandAdapter = createRowCommandAdapter({
  audit: {
    handler: auditPurchaseOutsourcedIssue,
    affectedResources: [
      'purOutsourcedIssueItems',
      'purOrderItemMaterials',
      'invStockEntries',
      'scmOrderFlowItems',
    ],
  },
  void: {
    handler: voidPurchaseOutsourcedIssue,
    affectedResources: [
      'purOutsourcedIssueItems',
      'purOrderItemMaterials',
      'invStockEntries',
      'scmOrderFlowItems',
    ],
  },
})

export const purchaseOutsourcedReceiptCommandAdapter = createRowCommandAdapter({
  audit: {
    handler: auditPurchaseOutsourcedReceipt,
    affectedResources: [
      'purOutsourcedReceiptItems',
      'purOrderItems',
      'mfgDemandItems',
      'invStockEntries',
      'accGlEntries',
      'scmOrderFlowItems',
    ],
  },
  void: {
    handler: voidPurchaseOutsourcedReceipt,
    affectedResources: [
      'purOutsourcedReceiptItems',
      'purOrderItems',
      'mfgDemandItems',
      'invStockEntries',
      'accGlEntries',
      'scmOrderFlowItems',
    ],
  },
})

/**
 * 销售发货聚合草稿 Adapter：完整 load + 原子 create/replace。
 * 表单走 draft，不暴露 RecordWriter 的 create/update。
 */
export interface SalesDeliveryDraftItemInput {
  id?: string
  idx: number
  qty: string
  orderItemId: string
  unitId?: string | null
  warehouseId: string
  remarks?: string | null
}

export interface SalesDeliveryDraftPackLineInput {
  id?: string
  idx: number
  qty: string
  materialId: string
  unitId?: string | null
  remarks?: string | null
}

export interface SalesDeliveryDraftPackBoxInput {
  id?: string
  /** 完整快照字段；即使清空也必须显式传 []。 */
  lines: SalesDeliveryDraftPackLineInput[]
}

export interface SalesDeliveryDraftInput {
  companyId: string
  deliveryNo?: string | null
  deliveryDate?: string | null
  postingDate?: string | null
  partyType: string
  partyId: string
  remarks?: string | null
  warehouseId?: string | null
  debitAccountId: string
  creditAccountId: string
  /** 完整快照字段；省略与显式清空语义不同，因此不可选。 */
  items: SalesDeliveryDraftItemInput[]
  /** 完整快照字段；省略与显式清空语义不同，因此不可选。 */
  packBoxes: SalesDeliveryDraftPackBoxInput[]
}

/** 权威 SavedDraft：表头 + 全部 items + 嵌套 packBoxes.lines */
export type SalesDeliverySavedDraft = Row & {
  items: Row[]
  packBoxes: Array<Row & { lines: Row[] }>
}

function draftRecord(value: unknown, path: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`销售发货草稿 ${path} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function draftArray(
  record: Readonly<Record<string, unknown>>,
  field: string,
  path: string,
): unknown[] {
  const value = record[field]
  if (!Array.isArray(value)) {
    throw new TypeError(`销售发货草稿 ${path} 必须显式提交数组`)
  }
  return value
}

/**
 * Aggregate Draft → wire 的唯一转换入口。
 * 集合字段 fail-closed：缺失、null 或非数组不能被解释为“清空全部子项”。
 */
export function salesDeliveryDraftInput(
  input: SalesDeliveryDraftInput,
): SalesDeliveryDraftInput {
  const record = draftRecord(input, '根对象')
  const items = draftArray(record, 'items', 'items').map((item, itemIndex) =>
    decimalWireInput(
      draftRecord(item, `items[${itemIndex}]`),
      ['qty'],
    ) as unknown as SalesDeliveryDraftItemInput,
  )
  const packBoxes = draftArray(record, 'packBoxes', 'packBoxes').map(
    (box, boxIndex) => {
      const boxRecord = draftRecord(box, `packBoxes[${boxIndex}]`)
      const lines = draftArray(
        boxRecord,
        'lines',
        `packBoxes[${boxIndex}].lines`,
      ).map((line, lineIndex) =>
        decimalWireInput(
          draftRecord(
            line,
            `packBoxes[${boxIndex}].lines[${lineIndex}]`,
          ),
          ['qty'],
        ) as unknown as SalesDeliveryDraftPackLineInput,
      )
      return { ...boxRecord, lines } as unknown as SalesDeliveryDraftPackBoxInput
    },
  )
  return { ...input, items, packBoxes }
}

export interface SalesDeliveryDraftGateway {
  loadDraft(id: string): Promise<SalesDeliverySavedDraft>
  createDraft(input: SalesDeliveryDraftInput): Promise<SalesDeliverySavedDraft>
  replaceDraft(
    id: string,
    input: SalesDeliveryDraftInput,
  ): Promise<SalesDeliverySavedDraft>
}

const productionSalesDeliveryDraftGateway: SalesDeliveryDraftGateway = {
  async loadDraft(id) {
    return apiData(
      api.sales.deliveries[':id'].draft.$get({ param: { id } }),
    )
  },
  async createDraft(input) {
    return apiData(
      api.sales.deliveries.$post({ json: input as never }),
    )
  },
  async replaceDraft(id, input) {
    return apiData(
      api.sales.deliveries[':id'].$put({
        param: { id },
        json: input as never,
      }),
    )
  },
}

export function createSalesDeliveryDraftAdapter(
  gateway: SalesDeliveryDraftGateway,
): AggregateDraftAdapter<
  SalesDeliveryDraftInput,
  SalesDeliverySavedDraft
> {
  return {
    loadDraft: (id) => gateway.loadDraft(id),
    async createDraft(input) {
      const wire = salesDeliveryDraftInput(input)
      return gateway.createDraft(wire)
    },
    async replaceDraft(id, input) {
      const wire = salesDeliveryDraftInput(input)
      return gateway.replaceDraft(id, wire)
    },
  }
}

export const salesDeliveryDraftAdapter = createSalesDeliveryDraftAdapter(
  productionSalesDeliveryDraftGateway,
)

export const salesDeliveryClient = resourceClient('salDeliveries', {
  async query(input) {
    const result = await apiData(
      api.sales.deliveries.query.$post({ json: resourceListBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.sales.deliveries[':id'].$get({ param: { id } }),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.sales.deliveries[':id'].$delete({
        param: { id }}),
    )
  },
})

export const salesDeliveryItemClient = resourceClient('salDeliveryItems', {
  async query(input) {
    const result = await apiData(
      api.sales['delivery-items'].query.$post({
        json: resourceListBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.sales['delivery-items'][':id'].$get({
        param: { id }}),
    )) as Row
  },
})

export const salesDeliveryPackBoxClient = resourceClient('salDeliveryPackBoxes', {
  async query(input) {
    const result = await apiData(
      api.sales['delivery-pack-boxes'].query.$post({
        json: resourceListBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.sales['delivery-pack-boxes'][':id'].$get({
        param: { id }}),
    )) as Row
  },
})

export const salesDeliveryPackLineClient = resourceClient('salDeliveryPackLines', {
  async query(input) {
    const result = await apiData(
      api.sales['delivery-pack-lines'].query.$post({
        json: resourceListBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.sales['delivery-pack-lines'][':id'].$get({
        param: { id }}),
    )) as Row
  },
})

export const purchaseReceiptClient = resourceClient('purReceipts', {
  async query(input) {
    const result = await apiData(
      api.purchase.receipts.query.$post({ json: resourceListBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.purchase.receipts[':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.purchase.receipts.$post({
        json: input as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.purchase.receipts[':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.purchase.receipts[':id'].$delete({
        param: { id }}),
    )
  },
})

export const purchaseReceiptItemClient = resourceClient('purReceiptItems', {
  async query(input) {
    const result = await apiData(
      api.purchase['receipt-items'].query.$post({
        json: resourceListBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.purchase['receipt-items'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.purchase['receipt-items'].$post({
        json: decimalWireInput(input, ['qty']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.purchase['receipt-items'][':id'].$patch({
        param: { id },
        json: decimalWireInput(input, ['qty']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.purchase['receipt-items'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const purchaseOutsourcedIssueClient = resourceClient(
  'purOutsourcedIssues',
  {
    async query(input) {
      const result = await apiData(
        api.purchase['outsourced-issues'].query.$post({
          json: resourceListBody(input)}),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        api.purchase['outsourced-issues'][':id'].$get({
          param: { id }}),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        api.purchase['outsourced-issues'].$post({
          json: input as never}),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.purchase['outsourced-issues'][':id'].$patch({
          param: { id },
          json: input as never}),
      )) as Row
    },
    async delete(id) {
      await apiData(
        api.purchase['outsourced-issues'][':id'].$delete({
          param: { id }}),
      )
    },
  },
)

export const purchaseOutsourcedIssueItemClient = resourceClient(
  'purOutsourcedIssueItems',
  {
    async query(input) {
      const result = await apiData(
        api.purchase['outsourced-issue-items'].query.$post({
          json: resourceListBody(input)}),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        api.purchase['outsourced-issue-items'][':id'].$get({
          param: { id }}),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        api.purchase['outsourced-issue-items'].$post({
          json: decimalWireInput(input, [
            'qty',
          ]) as never}),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.purchase['outsourced-issue-items'][':id'].$patch({
          param: { id },
          json: decimalWireInput(input, [
            'qty',
          ]) as never}),
      )) as Row
    },
    async delete(id) {
      await apiData(
        api.purchase['outsourced-issue-items'][':id'].$delete({
          param: { id }}),
      )
    },
  },
)

export const purchaseOutsourcedReceiptClient = resourceClient(
  'purOutsourcedReceipts',
  {
    async query(input) {
      const result = await apiData(
        api.purchase['outsourced-receipts'].query.$post({
          json: resourceListBody(input)}),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        api.purchase['outsourced-receipts'][':id'].$get({
          param: { id }}),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        api.purchase['outsourced-receipts'].$post({
          json: input as never}),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.purchase['outsourced-receipts'][':id'].$patch({
          param: { id },
          json: input as never}),
      )) as Row
    },
    async delete(id) {
      await apiData(
        api.purchase['outsourced-receipts'][':id'].$delete({
          param: { id }}),
      )
    },
  },
)

export const purchaseOutsourcedReceiptItemClient = resourceClient(
  'purOutsourcedReceiptItems',
  {
    async query(input) {
      const result = await apiData(
        api.purchase['outsourced-receipt-items'].query.$post({
          json: resourceListBody(input)}),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        api.purchase['outsourced-receipt-items'][':id'].$get({
          param: { id }}),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        api.purchase['outsourced-receipt-items'].$post({
          json: decimalWireInput(input, [
            'qty',
          ]) as never}),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.purchase['outsourced-receipt-items'][':id'].$patch({
          param: { id },
          json: decimalWireInput(input, [
            'qty',
          ]) as never}),
      )) as Row
    },
    async delete(id) {
      await apiData(
        api.purchase['outsourced-receipt-items'][':id'].$delete({
          param: { id }}),
      )
    },
  },
)

export const purchaseOutsourcedReceiptItemMaterialClient = resourceClient(
  'purOutsourcedReceiptItemMaterials',
  {
    async query(input) {
      const result = await apiData(
        api.purchase['outsourced-receipt-item-materials'].query.$post({
          json: resourceListBody(input)}),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        api.purchase['outsourced-receipt-item-materials'][':id'].$get({
          param: { id }}),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        api.purchase['outsourced-receipt-item-materials'].$post({
          json: decimalWireInput(input, [
            'qty',
          ]) as never}),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.purchase['outsourced-receipt-item-materials'][':id'].$patch({
          param: { id },
          json: decimalWireInput(input, [
            'qty',
          ]) as never}),
      )) as Row
    },
    async delete(id) {
      await apiData(
        api.purchase['outsourced-receipt-item-materials'][':id'].$delete({
          param: { id }}),
      )
    },
  },
)

export const purchaseOutsourcedReceiptItemByproductClient = resourceClient(
  'purOutsourcedReceiptItemByproducts',
  {
    async query(input) {
      const result = await apiData(
        api.purchase['outsourced-receipt-item-byproducts'].query.$post({
          json: resourceListBody(input)}),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        api.purchase['outsourced-receipt-item-byproducts'][':id'].$get({
          param: { id }}),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        api.purchase['outsourced-receipt-item-byproducts'].$post({
          json: decimalWireInput(input, [
            'qty',
          ]) as never}),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.purchase['outsourced-receipt-item-byproducts'][':id'].$patch({
          param: { id },
          json: decimalWireInput(input, [
            'qty',
          ]) as never}),
      )) as Row
    },
    async delete(id) {
      await apiData(
        api.purchase['outsourced-receipt-item-byproducts'][':id'].$delete({
          param: { id }}),
      )
    },
  },
)
