import type { Row } from '~/components/synie-data-grid/types'
import type { AggregateDraftAdapter } from './catalog/types'
import { unboundCommandAdapter, unboundResourceClient, unavailableResourceOperation } from './unbound'

export interface CompanyAccountDefaults {
  id: string
  companyId: string
  deliveryDebitAccountId: string | null
  deliveryCreditAccountId: string | null
  receiptDebitAccountId: string | null
  receiptCreditAccountId: string | null
}

export const salesDeliveryClient = unboundResourceClient('salDeliveries')
export const salesDeliveryItemClient = unboundResourceClient('salDeliveryItems')
export const salesDeliveryPackBoxClient = unboundResourceClient('salDeliveryPackBoxes')
export const salesDeliveryPackLineClient = unboundResourceClient('salDeliveryPackLines')
export const purchaseReceiptClient = unboundResourceClient('purReceipts')
export const purchaseReceiptItemClient = unboundResourceClient('purReceiptItems')
export const purchaseOutsourcedIssueClient = unboundResourceClient('purOutsourcedIssues')
export const purchaseOutsourcedIssueItemClient = unboundResourceClient('purOutsourcedIssueItems')
export const purchaseOutsourcedReceiptClient = unboundResourceClient('purOutsourcedReceipts')
export const purchaseOutsourcedReceiptItemClient = unboundResourceClient('purOutsourcedReceiptItems')
export const purchaseOutsourcedReceiptItemMaterialClient = unboundResourceClient('purOutsourcedReceiptItemMaterials')
export const purchaseOutsourcedReceiptItemByproductClient = unboundResourceClient('purOutsourcedReceiptItemByproducts')

const deliveryEffects = ['salDeliveryItems', 'salOrderItems', 'invStockEntries', 'accGlEntries', 'scmOrderFlowItems']
const receiptEffects = ['purReceiptItems', 'purOrderItems', 'mfgDemandItems', 'invStockEntries', 'accGlEntries', 'scmOrderFlowItems']
const outsourcedIssueEffects = ['purOutsourcedIssueItems', 'purOrderItemMaterials', 'invStockEntries', 'scmOrderFlowItems']
const outsourcedReceiptEffects = ['purOutsourcedReceiptItems', 'purOrderItems', 'mfgDemandItems', 'invStockEntries', 'accGlEntries', 'scmOrderFlowItems']
export const salesDeliveryCommandAdapter = unboundCommandAdapter({
  audit: { target: 'row', affectedResources: deliveryEffects },
  void: { target: 'row', affectedResources: deliveryEffects },
})
export const purchaseReceiptCommandAdapter = unboundCommandAdapter({
  audit: { target: 'row', affectedResources: receiptEffects },
  void: { target: 'row', affectedResources: receiptEffects },
})
export const purchaseOutsourcedIssueCommandAdapter = unboundCommandAdapter({
  audit: { target: 'row', affectedResources: outsourcedIssueEffects },
  void: { target: 'row', affectedResources: outsourcedIssueEffects },
})
export const purchaseOutsourcedReceiptCommandAdapter = unboundCommandAdapter({
  audit: { target: 'row', affectedResources: outsourcedReceiptEffects },
  void: { target: 'row', affectedResources: outsourcedReceiptEffects },
})

export const auditSalesDelivery = unavailableResourceOperation
export const voidSalesDelivery = unavailableResourceOperation
export const auditPurchaseReceipt = unavailableResourceOperation
export const voidPurchaseReceipt = unavailableResourceOperation
export const auditPurchaseOutsourcedIssue = unavailableResourceOperation
export const voidPurchaseOutsourcedIssue = unavailableResourceOperation
export const auditPurchaseOutsourcedReceipt = unavailableResourceOperation
export const voidPurchaseOutsourcedReceipt = unavailableResourceOperation

export async function fetchSalesCompanyAccountDefaults(
  companyId: string,
): Promise<CompanyAccountDefaults | null> {
  const page = await companyAccountDefaultClient.query({
    profile: 'default',
    numItems: 1,
    cursor: null,
    fixedFilter: { companyId },
  })
  return (page.results[0] as unknown as CompanyAccountDefaults | undefined) ?? null
}

export interface SalesDeliveryDraftItemInput {
  id?: string; idx: number; qty: string; orderItemId: string
  unitId?: string | null; warehouseId: string; remarks?: string | null
}
export interface SalesDeliveryDraftPackLineInput {
  id?: string; idx: number; qty: string; materialId: string
  unitId?: string | null; remarks?: string | null
}
export interface SalesDeliveryDraftPackBoxInput {
  id?: string
  lines: SalesDeliveryDraftPackLineInput[]
}
export interface SalesDeliveryDraftInput {
  companyId: string; deliveryNo?: string | null; deliveryDate?: string | null
  postingDate?: string | null; partyType: string; partyId: string
  remarks?: string | null; warehouseId?: string | null
  debitAccountId: string; creditAccountId: string
  items: SalesDeliveryDraftItemInput[]
  packBoxes: SalesDeliveryDraftPackBoxInput[]
}
export type SalesDeliverySavedDraft = Row & {
  items: Row[]
  packBoxes: Array<Row & { lines: Row[] }>
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`销售发货草稿 ${path} 必须是对象`)
  }
  return value as Record<string, unknown>
}
function array(value: Record<string, unknown>, field: string, path: string): unknown[] {
  if (!Array.isArray(value[field])) throw new TypeError(`销售发货草稿 ${path} 必须显式提交数组`)
  return value[field]
}
export function salesDeliveryDraftInput(input: SalesDeliveryDraftInput): SalesDeliveryDraftInput {
  const draft = object(input, '根对象')
  const items = array(draft, 'items', 'items').map((value, index) => {
    const item = object(value, `items[${index}]`)
    return { ...item, qty: String(item.qty) } as unknown as SalesDeliveryDraftItemInput
  })
  const packBoxes = array(draft, 'packBoxes', 'packBoxes').map((value, boxIndex) => {
    const box = object(value, `packBoxes[${boxIndex}]`)
    const lines = array(box, 'lines', `packBoxes[${boxIndex}].lines`).map((line, lineIndex) => {
      const item = object(line, `packBoxes[${boxIndex}].lines[${lineIndex}]`)
      return { ...item, qty: String(item.qty) } as unknown as SalesDeliveryDraftPackLineInput
    })
    return { ...box, lines } as unknown as SalesDeliveryDraftPackBoxInput
  })
  return { ...input, items, packBoxes }
}

export interface SalesDeliveryDraftGateway {
  loadDraft(id: string): Promise<SalesDeliverySavedDraft>
  createDraft(input: SalesDeliveryDraftInput): Promise<SalesDeliverySavedDraft>
  replaceDraft(id: string, input: SalesDeliveryDraftInput): Promise<SalesDeliverySavedDraft>
}

export function createSalesDeliveryDraftAdapter(
  gateway: SalesDeliveryDraftGateway,
): AggregateDraftAdapter<SalesDeliveryDraftInput, SalesDeliverySavedDraft> {
  return {
    loadDraft: (id) => gateway.loadDraft(id),
    createDraft: async (input) => gateway.createDraft(salesDeliveryDraftInput(input)),
    replaceDraft: async (id, input) => gateway.replaceDraft(id, salesDeliveryDraftInput(input)),
  }
}

const unavailableDraftGateway: SalesDeliveryDraftGateway = {
  loadDraft: unavailableResourceOperation,
  createDraft: unavailableResourceOperation,
  replaceDraft: unavailableResourceOperation,
}
export const salesDeliveryDraftAdapter = createSalesDeliveryDraftAdapter(unavailableDraftGateway)

// Defined after the helper so its object is available when the function runs.
import { companyAccountDefaultClient } from './reconciliations'
