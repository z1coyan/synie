import { apiData, api } from '../api/client'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { createRowCommandAdapter } from './catalog/commands'
import type { AggregateDraftAdapter } from './catalog/types'
import type { ResourceQuery, ResourceTransport } from './types'

type FilterDocument = FilterState
type FulfillmentAuditRequest = Record<string, unknown>
export interface CompanyAccountDefaults {
  id: string
  deliveryDebitAccountId: string | null
  deliveryCreditAccountId: string | null
  receiptDebitAccountId: string | null
  receiptCreditAccountId: string | null
  [key: string]: unknown
}
type PurchaseReceiptCreate = Record<string, unknown>
type PurchaseReceiptUpdate = Record<string, unknown>
type PurchaseReceiptItemCreate =
  Record<string, unknown>
type PurchaseReceiptItemUpdate =
  Record<string, unknown>
type PurchaseOutsourcedIssueCreate =
  Record<string, unknown>
type PurchaseOutsourcedIssueUpdate =
  Record<string, unknown>
type PurchaseOutsourcedIssueItemCreate =
  Record<string, unknown>
type PurchaseOutsourcedIssueItemUpdate =
  Record<string, unknown>
type PurchaseOutsourcedReceiptCreate =
  Record<string, unknown>
type PurchaseOutsourcedReceiptUpdate =
  Record<string, unknown>
type PurchaseOutsourcedReceiptItemCreate =
  Record<string, unknown>
type PurchaseOutsourcedReceiptItemUpdate =
  Record<string, unknown>
type PurchaseOutsourcedReceiptItemMaterialCreate =
  Record<string, unknown>
type PurchaseOutsourcedReceiptItemMaterialUpdate =
  Record<string, unknown>
type PurchaseOutsourcedReceiptItemByproductCreate =
  Record<string, unknown>
type PurchaseOutsourcedReceiptItemByproductUpdate =
  Record<string, unknown>

function queryBody(input: ResourceQuery) {
  const filter = {
    ...(input.filter ?? {}),
    ...((input.fixedFilter ?? {}) as FilterState),
  }
  return {
    limit: input.limit,
    offset: input.offset,
    search: input.search || undefined,
    sort: input.sort ?? undefined,
    filter: filter as FilterDocument,
  }
}

function decimalInput(
  input: Record<string, unknown>,
  fields: readonly string[],
) {
  const result = { ...input }
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) continue
    const value = input[field]
    result[field] = value == null || value === '' ? null : String(value)
  }
  return result
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

function salesDeliveryDraftInput(input: Record<string, unknown>) {
  const items = Array.isArray(input.items)
    ? input.items.map((item) => decimalInput(item as Record<string, unknown>, ['qty']))
    : []
  const packBoxes = Array.isArray(input.packBoxes)
    ? input.packBoxes.map((box) => {
        const record = box as Record<string, unknown>
        return {
          ...record,
          lines: Array.isArray(record.lines)
            ? record.lines.map((line) =>
                decimalInput(line as Record<string, unknown>, ['qty']),
              )
            : [],
        }
      })
    : []
  return { ...input, items, packBoxes }
}

export async function fetchSalesCompanyAccountDefaults(
  companyId: string,
): Promise<CompanyAccountDefaults | null> {
  try {
    return await apiData<CompanyAccountDefaults>(
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
  audit: auditSalesDelivery,
  void: voidSalesDelivery,
})

export const purchaseReceiptCommandAdapter = createRowCommandAdapter({
  audit: auditPurchaseReceipt,
  void: voidPurchaseReceipt,
})

export const purchaseOutsourcedIssueCommandAdapter = createRowCommandAdapter({
  audit: auditPurchaseOutsourcedIssue,
  void: voidPurchaseOutsourcedIssue,
})

export const purchaseOutsourcedReceiptCommandAdapter = createRowCommandAdapter({
  audit: auditPurchaseOutsourcedReceipt,
  void: voidPurchaseOutsourcedReceipt,
})

/**
 * 销售发货聚合草稿 Adapter：完整 load + 原子 create/replace。
 * 表单走 draft，不暴露 RecordWriter 的 create/update。
 */
export type SalesDeliveryDraftInput = Record<string, unknown>
/** 权威 SavedDraft：表头 + 全部 items + 嵌套 packBoxes.lines */
export type SalesDeliverySavedDraft = Row & {
  items: Row[]
  packBoxes: Array<Row & { lines: Row[] }>
}

export const salesDeliveryDraftAdapter: AggregateDraftAdapter<
  SalesDeliveryDraftInput,
  SalesDeliverySavedDraft
> = {
  async loadDraft(id) {
    return (await apiData(
      // 领域专用完整草稿读取；不走分页子资源 query
      api.sales.deliveries[':id'].draft.$get({ param: { id } }),
    )) as SalesDeliverySavedDraft
  },
  async createDraft(input) {
    return (await apiData(
      api.sales.deliveries.$post({
        json: salesDeliveryDraftInput(input) as never,
      }),
    )) as SalesDeliverySavedDraft
  },
  async replaceDraft(id, input) {
    return (await apiData(
      api.sales.deliveries[':id'].$put({
        param: { id },
        json: salesDeliveryDraftInput(input) as never,
      }),
    )) as SalesDeliverySavedDraft
  },
}

export const salesDeliveryClient = resourceClient('salDeliveries', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.sales.deliveries.query.$post({ json: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.sales.deliveries[':id'].$get({ param: { id } }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.sales.deliveries[':id'].$delete({
        param: { id }}),
    )
  },
})

export const salesDeliveryItemClient = resourceClient('salDeliveryItems', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.sales['delivery-items'].query.$post({
        json: queryBody(input)}),
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
    const result = await apiData<{ count: number; results: Row[] }>(
      api.sales['delivery-pack-boxes'].query.$post({
        json: queryBody(input)}),
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
    const result = await apiData<{ count: number; results: Row[] }>(
      api.sales['delivery-pack-lines'].query.$post({
        json: queryBody(input)}),
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
    const result = await apiData<{ count: number; results: Row[] }>(
      api.purchase.receipts.query.$post({ json: queryBody(input) }),
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
    await apiData<void>(
      api.purchase.receipts[':id'].$delete({
        param: { id }}),
    )
  },
})

export const purchaseReceiptItemClient = resourceClient('purReceiptItems', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.purchase['receipt-items'].query.$post({
        json: queryBody(input)}),
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
        json: decimalInput(input, ['qty']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.purchase['receipt-items'][':id'].$patch({
        param: { id },
        json: decimalInput(input, ['qty']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.purchase['receipt-items'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const purchaseOutsourcedIssueClient = resourceClient(
  'purOutsourcedIssues',
  {
    async query(input) {
      const result = await apiData<{ count: number; results: Row[] }>(
        api.purchase['outsourced-issues'].query.$post({
          json: queryBody(input)}),
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
      await apiData<void>(
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
      const result = await apiData<{ count: number; results: Row[] }>(
        api.purchase['outsourced-issue-items'].query.$post({
          json: queryBody(input)}),
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
          json: decimalInput(input, [
            'qty',
          ]) as never}),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.purchase['outsourced-issue-items'][':id'].$patch({
          param: { id },
          json: decimalInput(input, [
            'qty',
          ]) as never}),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
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
      const result = await apiData<{ count: number; results: Row[] }>(
        api.purchase['outsourced-receipts'].query.$post({
          json: queryBody(input)}),
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
      await apiData<void>(
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
      const result = await apiData<{ count: number; results: Row[] }>(
        api.purchase['outsourced-receipt-items'].query.$post({
          json: queryBody(input)}),
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
          json: decimalInput(input, [
            'qty',
          ]) as never}),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.purchase['outsourced-receipt-items'][':id'].$patch({
          param: { id },
          json: decimalInput(input, [
            'qty',
          ]) as never}),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
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
      const result = await apiData<{ count: number; results: Row[] }>(
        api.purchase['outsourced-receipt-item-materials'].query.$post({
          json: queryBody(input)}),
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
          json: decimalInput(input, [
            'qty',
          ]) as never}),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.purchase['outsourced-receipt-item-materials'][':id'].$patch({
          param: { id },
          json: decimalInput(input, [
            'qty',
          ]) as never}),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
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
      const result = await apiData<{ count: number; results: Row[] }>(
        api.purchase['outsourced-receipt-item-byproducts'].query.$post({
          json: queryBody(input)}),
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
          json: decimalInput(input, [
            'qty',
          ]) as never}),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.purchase['outsourced-receipt-item-byproducts'][':id'].$patch({
          param: { id },
          json: decimalInput(input, [
            'qty',
          ]) as never}),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
        api.purchase['outsourced-receipt-item-byproducts'][':id'].$delete({
          param: { id }}),
      )
    },
  },
)
