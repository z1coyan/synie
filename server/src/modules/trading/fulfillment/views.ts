/** 履约 wire 呈现：标准服务返回值 → 路由/草稿 DTO。 */
import { decimal } from '@synie/shared'
import {
  asDate,
  asDateTime,
  asOptionalString,
  type TradingSide,
  upperStatus,
  wireRequiredDecimal,
} from '../common.ts'
import { mapHead } from './domain.ts'
import type {
  FulfillmentHeadDraftInput,
  PurchaseReceiptDraftDto,
  PurchaseReceiptDraftInput,
  PurchaseReceiptItemDto,
  SalesDraftDto,
  SalesDraftInput,
  SalesDraftItemDto,
  SalesDraftPackBoxDto,
  SalesDraftPackLineDto,
} from './types.ts'

function asIso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return new Date(String(value)).toISOString()
}

export function presentSalesHead(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    deliveryNo: String(row.deliveryNo ?? ''),
    deliveryDate: String(row.deliveryDate ?? ''),
    postingDate: row.postingDate == null ? null : String(row.postingDate),
    partyType: upperStatus(String(row.partyType ?? '')),
    partyId: String(row.partyId ?? ''),
    remarks: row.remarks == null ? null : String(row.remarks),
    status: upperStatus(String(row.status ?? 'DRAFT')),
    auditedAt: asIso(row.auditedAt),
    insertedAt: asIso(row.insertedAt)!,
    updatedAt: asIso(row.updatedAt)!,
    companyId: String(row.companyId ?? ''),
    warehouseId: row.warehouseId == null ? null : String(row.warehouseId),
    debitAccountId: String(row.debitAccountId ?? ''),
    creditAccountId: String(row.creditAccountId ?? ''),
    createdById: row.createdById == null ? null : String(row.createdById),
    auditedById: row.auditedById == null ? null : String(row.auditedById),
  }
}

export function presentPurchaseHead(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    receiptNo: String(row.receiptNo ?? ''),
    receiptDate: String(row.receiptDate ?? ''),
    postingDate: row.postingDate == null ? null : String(row.postingDate),
    partyType: upperStatus(String(row.partyType ?? '')),
    partyId: String(row.partyId ?? ''),
    remarks: row.remarks == null ? null : String(row.remarks),
    status: upperStatus(String(row.status ?? 'DRAFT')),
    auditedAt: asIso(row.auditedAt),
    insertedAt: asIso(row.insertedAt)!,
    updatedAt: asIso(row.updatedAt)!,
    companyId: String(row.companyId ?? ''),
    warehouseId: row.warehouseId == null ? null : String(row.warehouseId),
    debitAccountId: String(row.debitAccountId ?? ''),
    creditAccountId: String(row.creditAccountId ?? ''),
    createdById: row.createdById == null ? null : String(row.createdById),
    auditedById: row.auditedById == null ? null : String(row.auditedById),
  }
}

export function presentSalesItem(row: Record<string, unknown>): SalesDraftItemDto {
  const baseQty = String(row.baseQty ?? 0)
  const reconciled = String(row.reconciledQty ?? 0)
  const returned = String(row.returnedQty ?? 0)
  return {
    id: String(row.id),
    idx: Number(row.idx),
    qty: wireRequiredDecimal(String(row.qty ?? 0)),
    baseQty: wireRequiredDecimal(baseQty),
    materialCode: String(row.materialCode ?? ''),
    materialName: String(row.materialName ?? ''),
    materialSpec: row.materialSpec == null ? null : String(row.materialSpec),
    customerPartNo: row.customerPartNo == null ? null : String(row.customerPartNo),
    unitName: String(row.unitName ?? ''),
    orderNo: String(row.orderNo ?? ''),
    orderQty: wireRequiredDecimal(String(row.orderQty ?? 0)),
    orderBaseQty: wireRequiredDecimal(String(row.orderBaseQty ?? 0)),
    orderUnitName: String(row.orderUnitName ?? ''),
    orderPrice: wireRequiredDecimal(String(row.orderPrice ?? 0)),
    orderAmount: wireRequiredDecimal(String(row.orderAmount ?? 0)),
    orderBasePrice: wireRequiredDecimal(String(row.orderBasePrice ?? 0)),
    orderBaseAmount: wireRequiredDecimal(String(row.orderBaseAmount ?? 0)),
    orderTaxRate: wireRequiredDecimal(String(row.orderTaxRate ?? 0)),
    orderCurrencyCode: String(row.orderCurrencyCode ?? ''),
    reconciledQty: wireRequiredDecimal(reconciled),
    remarks: row.remarks == null ? null : String(row.remarks),
    insertedAt: asIso(row.insertedAt)!,
    updatedAt: asIso(row.updatedAt)!,
    deliveryId: String(row.deliveryId ?? ''),
    companyId: String(row.companyId ?? ''),
    orderItemId: String(row.orderItemId ?? ''),
    materialId: String(row.materialId ?? ''),
    unitId: String(row.unitId ?? ''),
    warehouseId: row.warehouseId == null ? null : String(row.warehouseId),
    deliveryNo: String(row.deliveryNo ?? ''),
    deliveryDate: row.deliveryDate == null ? '' : String(row.deliveryDate),
    deliveryStatus: upperStatus(String(row.deliveryStatus ?? 'DRAFT')),
    partyType: upperStatus(String(row.partyType ?? '')),
    partyId: String(row.partyId ?? ''),
    remainingReconcilableQty: wireRequiredDecimal(
      String(row.remainingReconcilableQty ?? decimal(baseQty).sub(reconciled)),
    ),
    returnedQty: wireRequiredDecimal(returned),
    remainingReturnableQty: wireRequiredDecimal(
      String(row.remainingReturnableQty ?? decimal(baseQty).sub(returned)),
    ),
  }
}

export function presentPurchaseItem(row: Record<string, unknown>): PurchaseReceiptItemDto {
  const baseQty = String(row.baseQty ?? 0)
  const reconciled = String(row.reconciledQty ?? 0)
  return {
    id: String(row.id),
    idx: Number(row.idx),
    qty: wireRequiredDecimal(String(row.qty ?? 0)),
    baseQty: wireRequiredDecimal(baseQty),
    materialCode: String(row.materialCode ?? ''),
    materialName: String(row.materialName ?? ''),
    materialSpec: row.materialSpec == null ? null : String(row.materialSpec),
    customerPartNo: row.customerPartNo == null ? null : String(row.customerPartNo),
    unitName: String(row.unitName ?? ''),
    orderNo: String(row.orderNo ?? ''),
    orderQty: wireRequiredDecimal(String(row.orderQty ?? 0)),
    orderBaseQty: wireRequiredDecimal(String(row.orderBaseQty ?? 0)),
    orderUnitName: String(row.orderUnitName ?? ''),
    orderPrice: wireRequiredDecimal(String(row.orderPrice ?? 0)),
    orderAmount: wireRequiredDecimal(String(row.orderAmount ?? 0)),
    orderBasePrice: wireRequiredDecimal(String(row.orderBasePrice ?? 0)),
    orderBaseAmount: wireRequiredDecimal(String(row.orderBaseAmount ?? 0)),
    orderTaxRate: wireRequiredDecimal(String(row.orderTaxRate ?? 0)),
    orderCurrencyCode: String(row.orderCurrencyCode ?? ''),
    reconciledQty: wireRequiredDecimal(reconciled),
    remarks: row.remarks == null ? null : String(row.remarks),
    insertedAt: asIso(row.insertedAt)!,
    updatedAt: asIso(row.updatedAt)!,
    receiptId: String(row.receiptId ?? ''),
    companyId: String(row.companyId ?? ''),
    orderItemId: String(row.orderItemId ?? ''),
    materialId: String(row.materialId ?? ''),
    unitId: String(row.unitId ?? ''),
    warehouseId: row.warehouseId == null ? null : String(row.warehouseId),
    receiptNo: String(row.receiptNo ?? ''),
    receiptDate: row.receiptDate == null ? '' : String(row.receiptDate),
    receiptStatus: upperStatus(String(row.receiptStatus ?? 'DRAFT')),
    partyType: upperStatus(String(row.partyType ?? '')),
    partyId: String(row.partyId ?? ''),
    remainingReconcilableQty: wireRequiredDecimal(
      String(row.remainingReconcilableQty ?? decimal(baseQty).sub(reconciled)),
    ),
  }
}

export function presentPackBox(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    boxNo: String(row.boxNo ?? ''),
    insertedAt: asIso(row.insertedAt)!,
    updatedAt: asIso(row.updatedAt)!,
    deliveryId: String(row.deliveryId ?? ''),
    companyId: String(row.companyId ?? ''),
  }
}

export function presentPackLine(row: Record<string, unknown>): SalesDraftPackLineDto {
  return {
    id: String(row.id),
    idx: Number(row.idx),
    packBoxId: String(row.packBoxId ?? ''),
    qty: wireRequiredDecimal(String(row.qty ?? 0)),
    baseQty: wireRequiredDecimal(String(row.baseQty ?? 0)),
    materialCode: String(row.materialCode ?? ''),
    materialName: String(row.materialName ?? ''),
    materialSpec: row.materialSpec == null ? null : String(row.materialSpec),
    customerPartNo: row.customerPartNo == null ? null : String(row.customerPartNo),
    unitName: String(row.unitName ?? ''),
    remarks: row.remarks == null ? null : String(row.remarks),
    insertedAt: asIso(row.insertedAt)!,
    updatedAt: asIso(row.updatedAt)!,
    deliveryId: String(row.deliveryId ?? ''),
    companyId: String(row.companyId ?? ''),
    materialId: String(row.materialId ?? ''),
    unitId: String(row.unitId ?? ''),
  }
}

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
  return {
    receiptNo: String(row.receipt_no ?? ''),
    receiptDate: asDate(row.receipt_date),
    receiptStatus: upperStatus(String(row.receipt_status ?? 'DRAFT')),
    partyType: upperStatus(String(row.party_type ?? '')),
    remainingReconcilableQty: wireRequiredDecimal(
      String(row.remaining_reconcilable_qty ?? decimal(baseQty).sub(reconciled)),
    ),
  }
}

export function mapHeadDto(side: TradingSide, row: Record<string, unknown>) {
  const h = mapHead(row)
  const numberKey = side === 'sales' ? 'deliveryNo' : 'receiptNo'
  const dateKey = side === 'sales' ? 'deliveryDate' : 'receiptDate'
  return {
    id: h.id,
    [numberKey]: h.no,
    [dateKey]: h.documentDate,
    postingDate: h.postingDate,
    partyType: upperStatus(h.partyType),
    partyId: h.partyId,
    remarks: h.remarks,
    status: h.status,
    auditedAt: h.auditedAt,
    insertedAt: h.insertedAt,
    updatedAt: h.updatedAt,
    companyId: h.companyId,
    warehouseId: h.warehouseId,
    debitAccountId: h.debitAccountId,
    creditAccountId: h.creditAccountId,
    createdById: h.createdById,
    auditedById: h.auditedById,
  }
}

export function mapItemDto(side: TradingSide, row: Record<string, unknown>) {
  const parentIdKey = side === 'sales' ? 'deliveryId' : 'receiptId'
  const parentNoKey = side === 'sales' ? 'deliveryNo' : 'receiptNo'
  const parentDateKey = side === 'sales' ? 'deliveryDate' : 'receiptDate'
  const parentStatusKey = side === 'sales' ? 'deliveryStatus' : 'receiptStatus'
  const baseQty = String(row.base_qty)
  const reconciled = String(row.reconciled_qty ?? 0)
  return {
    id: String(row.id),
    idx: Number(row.idx),
    qty: wireRequiredDecimal(String(row.qty)),
    baseQty: wireRequiredDecimal(baseQty),
    materialCode: String(row.material_code),
    materialName: String(row.material_name),
    materialSpec: asOptionalString(row.material_spec),
    customerPartNo: asOptionalString(row.customer_part_no),
    unitName: String(row.unit_name),
    orderNo: String(row.order_no),
    orderQty: wireRequiredDecimal(String(row.order_qty)),
    orderBaseQty: wireRequiredDecimal(String(row.order_base_qty)),
    orderUnitName: String(row.order_unit_name),
    orderPrice: wireRequiredDecimal(String(row.order_price)),
    orderAmount: wireRequiredDecimal(String(row.order_amount)),
    orderBasePrice: wireRequiredDecimal(String(row.order_base_price)),
    orderBaseAmount: wireRequiredDecimal(String(row.order_base_amount)),
    orderTaxRate: wireRequiredDecimal(String(row.order_tax_rate)),
    orderCurrencyCode: String(row.order_currency_code),
    reconciledQty: wireRequiredDecimal(reconciled),
    remarks: asOptionalString(row.remarks),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    [parentIdKey]: String(row[side === 'sales' ? 'delivery_id' : 'receipt_id'] ?? row.head_id),
    companyId: String(row.company_id),
    orderItemId: String(row.order_item_id),
    materialId: String(row.material_id),
    unitId: String(row.unit_id),
    warehouseId: row.warehouse_id ? String(row.warehouse_id) : null,
    [parentNoKey]: String(row[side === 'sales' ? 'delivery_no' : 'receipt_no'] ?? ''),
    [parentDateKey]: asDate(row[side === 'sales' ? 'delivery_date' : 'receipt_date']),
    [parentStatusKey]: upperStatus(
      String(row[side === 'sales' ? 'delivery_status' : 'receipt_status'] ?? 'DRAFT'),
    ),
    partyType: upperStatus(String(row.party_type)),
    partyId: String(row.party_id),
    remainingReconcilableQty: wireRequiredDecimal(
      String(row.remaining_reconcilable_qty ?? decimal(baseQty).sub(reconciled)),
    ),
    ...(side === 'sales'
      ? {
          returnedQty: wireRequiredDecimal(String(row.returned_qty ?? 0)),
          remainingReturnableQty: wireRequiredDecimal(
            String(
              row.remaining_returnable_qty ??
                decimal(baseQty).sub(decimal(String(row.returned_qty ?? 0))),
            ),
          ),
        }
      : {}),
  }
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
