import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { aggregateDraftTransport } from './aggregate-draft-transport'
import { createRowCommandAdapter } from './catalog/commands'
import type { AggregateDraftAdapter } from './catalog/types'
import { restTransport } from './rest-transport'
import { decimalWireInput } from './resource-wire'

type FulfillmentAuditRequest = Record<string, unknown>
export interface CompanyAccountDefaults {
  id: string
  deliveryDebitAccountId: string | null
  deliveryCreditAccountId: string | null
  receiptDebitAccountId: string | null
  receiptCreditAccountId: string | null
  [key: string]: unknown
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
  /** 行仓:库存类物料必填(后端校验),虚拟行可空 */
  warehouseId: string | null
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

/**
 * 测试可注入的 gateway port：与 production 端点三连同形，
 * 供 wire 校验单测在无 HTTP 下录制 create/replace 请求。
 */
export interface SalesDeliveryDraftGateway {
  loadDraft(id: string): Promise<SalesDeliverySavedDraft>
  createDraft(input: SalesDeliveryDraftInput): Promise<SalesDeliverySavedDraft>
  replaceDraft(
    id: string,
    input: SalesDeliveryDraftInput,
  ): Promise<SalesDeliverySavedDraft>
}

/** 测试 Adapter：wire 后委托 gateway（不经 HTTP）。 */
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

/** production：标准草稿三连 + 领域 wire。 */
export const salesDeliveryDraftAdapter = aggregateDraftTransport<
  SalesDeliveryDraftInput,
  SalesDeliverySavedDraft
>(api.sales.deliveries, { wire: salesDeliveryDraftInput })

export const salesDeliveryClient = restTransport(
  'salDeliveries',
  api.sales.deliveries,
  { capabilities: { create: false, update: false } },
)

export const salesDeliveryItemClient = restTransport(
  'salDeliveryItems',
  api.sales['delivery-items'],
  { capabilities: { create: false, update: false, delete: false } },
)

export const salesDeliveryPackBoxClient = restTransport(
  'salDeliveryPackBoxes',
  api.sales['delivery-pack-boxes'],
  { capabilities: { create: false, update: false, delete: false } },
)

export const salesDeliveryPackLineClient = restTransport(
  'salDeliveryPackLines',
  api.sales['delivery-pack-lines'],
  { capabilities: { create: false, update: false, delete: false } },
)

export const purchaseReceiptClient = restTransport(
  'purReceipts',
  api.purchase.receipts,
)

export const purchaseReceiptItemClient = restTransport(
  'purReceiptItems',
  api.purchase['receipt-items'])

export const purchaseOutsourcedIssueClient = restTransport(
  'purOutsourcedIssues',
  api.purchase['outsourced-issues'],
)

export const purchaseOutsourcedIssueItemClient = restTransport(
  'purOutsourcedIssueItems',
  api.purchase['outsourced-issue-items'])

export const purchaseOutsourcedReceiptClient = restTransport(
  'purOutsourcedReceipts',
  api.purchase['outsourced-receipts'],
)

export const purchaseOutsourcedReceiptItemClient = restTransport(
  'purOutsourcedReceiptItems',
  api.purchase['outsourced-receipt-items'])

export const purchaseOutsourcedReceiptItemMaterialClient = restTransport(
  'purOutsourcedReceiptItemMaterials',
  api.purchase['outsourced-receipt-item-materials'])

export const purchaseOutsourcedReceiptItemByproductClient = restTransport(
  'purOutsourcedReceiptItemByproducts',
  api.purchase['outsourced-receipt-item-byproducts'])
