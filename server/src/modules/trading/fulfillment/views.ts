/**
 * 履约 wire 呈现：meta 派生 presenter + 计算列/键序钩子（销售发货 / 采购入库对称）。
 *
 * 键集/键序/规范化规则唯一事实源是 spec.ts 的 meta；模块只保留：
 * - returnedQty 键序钩子：物理列在 meta 中紧随 reconciledQty，wire 上既有位置在
 *   remainingReconcilableQty 之后（字节冻结），以 fields 覆盖改序
 * - remainingReconcilableQty / remainingReturnableQty 计算回退与 boxNo 整数转
 *   字符串的逐字保留（values 钩子）
 * - 投影 mapExtras（db 原生行 → wire 附加键）与草稿 payload 装配
 */
import { decimal } from '@synie/shared'
import type { FieldMeta } from '~/platform/meta/types.ts'
import { mapRow } from '~/platform/standard/fields.ts'
import { derivePresenter } from '~/platform/standard/present.ts'
import { asDate, type TradingSide, upperStatus, wireRequiredDecimal } from '../common.ts'
import { fulfillmentHeadMeta, fulfillmentItemMeta, packBoxMeta, packLineMeta } from './spec.ts'
import type {
  FulfillmentHeadDraftInput,
  PurchaseHeadDto,
  PurchaseReceiptDraftDto,
  PurchaseReceiptDraftInput,
  PurchaseReceiptItemDto,
  SalesDraftDto,
  SalesDraftInput,
  SalesDraftItemDto,
  SalesDraftPackBoxDto,
  SalesDraftPackLineDto,
  SalesHeadDto,
} from './types.ts'

const SALES_HEAD_META = fulfillmentHeadMeta('sales')
const PURCHASE_HEAD_META = fulfillmentHeadMeta('purchase')
const SALES_ITEM_META = fulfillmentItemMeta('sales')
const PURCHASE_ITEM_META = fulfillmentItemMeta('purchase')

/** returnedQty 改序：从 reconciledQty 后移到 remainingReturnableQty 前（wire 既有键序） */
function itemFieldsWireOrder(meta: { fields: readonly FieldMeta[] }): FieldMeta[] {
  const returned = meta.fields.find((f) => f.apiName === 'returnedQty')
  if (!returned) throw new Error('履约 wire 派生：缺 returnedQty 字段')
  const rest = meta.fields.filter((f) => f.apiName !== 'returnedQty')
  const anchor = rest.findIndex((f) => f.apiName === 'remainingReturnableQty')
  if (anchor < 0) throw new Error('履约 wire 派生：缺 remainingReturnableQty 字段')
  return [...rest.slice(0, anchor), returned, ...rest.slice(anchor)]
}

const remainingHooks = {
  // 剩余可对账 = 折算数量 − 已对账；剩余可退 = 折算数量 − 已退（投影列缺省时回退）
  remainingReconcilableQty: (row: Record<string, unknown>) =>
    wireRequiredDecimal(
      String(
        row.remainingReconcilableQty ??
          decimal(String(row.baseQty ?? 0)).sub(String(row.reconciledQty ?? 0)),
      ),
    ),
  remainingReturnableQty: (row: Record<string, unknown>) =>
    wireRequiredDecimal(
      String(
        row.remainingReturnableQty ??
          decimal(String(row.baseQty ?? 0)).sub(String(row.returnedQty ?? 0)),
      ),
    ),
}

export const presentSalesHead = derivePresenter<SalesHeadDto>(SALES_HEAD_META)
export const presentPurchaseHead = derivePresenter<PurchaseHeadDto>(PURCHASE_HEAD_META)

export const presentSalesItem = derivePresenter<SalesDraftItemDto>(SALES_ITEM_META, {
  fields: itemFieldsWireOrder(SALES_ITEM_META),
  values: remainingHooks,
})

export const presentPurchaseItem = derivePresenter<PurchaseReceiptItemDto>(PURCHASE_ITEM_META, {
  fields: itemFieldsWireOrder(PURCHASE_ITEM_META),
  values: remainingHooks,
})

export const presentPackBox = derivePresenter<Omit<SalesDraftPackBoxDto, 'lines'>>(packBoxMeta(), {
  values: {
    // 箱号列是 integer，wire 既有形状为字符串（字节冻结）
    boxNo: (row) => String(row.boxNo ?? ''),
  },
})

export const presentPackLine = derivePresenter<SalesDraftPackLineDto>(packLineMeta())

export function presentSalesDraft(raw: Record<string, unknown>): SalesDraftDto {
  const items = Array.isArray(raw.items)
    ? (raw.items as Record<string, unknown>[]).map((item) => presentSalesItem(item))
    : []
  const packBoxes: SalesDraftPackBoxDto[] = Array.isArray(raw.packBoxes)
    ? (raw.packBoxes as Record<string, unknown>[]).map((box) => {
        const lines = Array.isArray(box.lines)
          ? (box.lines as Record<string, unknown>[]).map((line) => presentPackLine(line))
          : []
        return { ...presentPackBox(box), lines }
      })
    : []
  return {
    ...presentSalesHead(raw),
    items,
    packBoxes,
  }
}

export function presentPurchaseDraft(raw: Record<string, unknown>): PurchaseReceiptDraftDto {
  const items = Array.isArray(raw.items)
    ? (raw.items as Record<string, unknown>[]).map((item) => presentPurchaseItem(item))
    : []
  return {
    ...presentPurchaseHead(raw),
    items,
  }
}

export function mapSalesItemExtras(row: Record<string, unknown>): Record<string, unknown> {
  const baseQty = String(row.base_qty ?? 0)
  const reconciled = String(row.reconciled_qty ?? 0)
  const returned = String(row.returned_qty ?? 0)
  return {
    deliveryNo: String(row.delivery_no ?? ''),
    deliveryDate: asDate(row.delivery_date),
    deliveryStatus: upperStatus(String(row.delivery_status ?? 'DRAFT')),
    partyType: upperStatus(String(row.party_type ?? '')),
    remainingReconcilableQty: wireRequiredDecimal(
      String(row.remaining_reconcilable_qty ?? decimal(baseQty).sub(reconciled)),
    ),
    remainingReturnableQty: wireRequiredDecimal(
      String(row.remaining_returnable_qty ?? decimal(baseQty).sub(returned)),
    ),
  }
}

export function mapPurchaseItemExtras(row: Record<string, unknown>): Record<string, unknown> {
  const baseQty = String(row.base_qty ?? 0)
  const reconciled = String(row.reconciled_qty ?? 0)
  const returned = String(row.returned_qty ?? 0)
  return {
    receiptNo: String(row.receipt_no ?? ''),
    receiptDate: asDate(row.receipt_date),
    receiptStatus: upperStatus(String(row.receipt_status ?? 'DRAFT')),
    partyType: upperStatus(String(row.party_type ?? '')),
    remainingReconcilableQty: wireRequiredDecimal(
      String(row.remaining_reconcilable_qty ?? decimal(baseQty).sub(reconciled)),
    ),
    remainingReturnableQty: wireRequiredDecimal(
      String(row.remaining_returnable_qty ?? decimal(baseQty).sub(returned)),
    ),
  }
}

/**
 * 销售发货条目列表（候选池筛选走 listMeta 弹射路径）：db 原生行 → wire DTO。
 * 迁前为逐键手写映射；现为 mapRow + 投影 extras + 派生 presenter 的复合，等价。
 */
export function mapItemDto(side: TradingSide, row: Record<string, unknown>) {
  const meta = side === 'sales' ? SALES_ITEM_META : PURCHASE_ITEM_META
  const wire = mapRow(meta, row)
  Object.assign(
    wire,
    side === 'sales' ? mapSalesItemExtras(row) : mapPurchaseItemExtras(row),
  )
  return side === 'sales' ? presentSalesItem(wire) : presentPurchaseItem(wire)
}

export function purchaseHeadPayload(input: FulfillmentHeadDraftInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    companyId: input.companyId,
    receiptDate: input.documentDate ?? undefined,
    postingDate: input.postingDate ?? null,
    partyType: input.partyType,
    partyId: input.partyId,
    remarks: input.remarks ?? null,
    warehouseId: input.warehouseId ?? null,
    debitAccountId: input.debitAccountId,
    creditAccountId: input.creditAccountId,
  }
  if (input.no != null && String(input.no).trim() !== '') {
    payload.receiptNo = input.no
  }
  return payload
}

export function purchaseDraftPayload(input: PurchaseReceiptDraftInput): Record<string, unknown> {
  const payload = purchaseHeadPayload(input)
  if (Array.isArray(input.items)) {
    payload.items = input.items.map((item) => ({
      ...(item.id !== undefined ? { id: item.id } : {}),
      idx: item.idx,
      qty: item.qty,
      orderItemId: item.orderItemId,
      unitId: item.unitId ?? null,
      warehouseId: item.warehouseId,
      remarks: item.remarks ?? null,
    }))
  }
  return payload
}

export function salesHeadPayload(input: FulfillmentHeadDraftInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    companyId: input.companyId,
    deliveryDate: input.documentDate ?? undefined,
    postingDate: input.postingDate ?? null,
    partyType: input.partyType,
    partyId: input.partyId,
    remarks: input.remarks ?? null,
    warehouseId: input.warehouseId ?? null,
    debitAccountId: input.debitAccountId,
    creditAccountId: input.creditAccountId,
  }
  if (input.no != null && String(input.no).trim() !== '') {
    payload.deliveryNo = input.no
  }
  return payload
}

export function salesDraftPayload(input: SalesDraftInput): Record<string, unknown> {
  const payload = salesHeadPayload(input)
  if (Array.isArray(input.items)) {
    payload.items = input.items.map((item) => ({
      ...(item.id !== undefined ? { id: item.id } : {}),
      idx: item.idx,
      qty: item.qty,
      orderItemId: item.orderItemId,
      unitId: item.unitId ?? null,
      warehouseId: item.warehouseId,
      remarks: item.remarks ?? null,
    }))
  }
  if (Array.isArray(input.packBoxes)) {
    payload.packBoxes = input.packBoxes.map((box) => ({
      ...(box.id !== undefined ? { id: box.id } : {}),
      lines: (box.lines ?? []).map((line) => ({
        ...(line.id !== undefined ? { id: line.id } : {}),
        idx: line.idx,
        qty: line.qty,
        materialId: line.materialId,
        unitId: line.unitId ?? null,
        remarks: line.remarks ?? null,
      })),
    }))
  }
  return payload
}
