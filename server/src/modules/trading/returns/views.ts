/** 销售退货 wire 呈现：标准服务返回值 → 路由/草稿 DTO。 */
import { decimal } from '@synie/shared'
import {
  asDate,
  asDateTime,
  asOptionalString,
  upperStatus,
  wireRequiredDecimal,
} from '../common.ts'
import { mapHead } from './domain.ts'
import type { ReturnDraftDto, ReturnDraftInput, ReturnItemDto } from './types.ts'

function asIso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return new Date(String(value)).toISOString()
}

function wireOptionalDecimal(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return wireRequiredDecimal(String(value))
}

export function presentReturnHead(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    returnNo: String(row.returnNo ?? ''),
    returnDate: String(row.returnDate ?? ''),
    postingDate: row.postingDate == null ? null : String(row.postingDate),
    partyType: upperStatus(String(row.partyType ?? '')),
    partyId: String(row.partyId ?? ''),
    currencyId: row.currencyId == null ? null : String(row.currencyId),
    exchangeRate: wireOptionalDecimal(row.exchangeRate),
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

export function presentReturnItem(row: Record<string, unknown>): ReturnItemDto {
  const baseQty = String(row.baseQty ?? 0)
  const reconciled = String(row.reconciledQty ?? 0)
  return {
    id: String(row.id),
    idx: Number(row.idx),
    qty: wireRequiredDecimal(String(row.qty ?? 0)),
    baseQty: wireRequiredDecimal(baseQty),
    materialCode: row.materialCode == null ? null : String(row.materialCode),
    materialName: row.materialName == null ? null : String(row.materialName),
    materialSpec: row.materialSpec == null ? null : String(row.materialSpec),
    customerPartNo: row.customerPartNo == null ? null : String(row.customerPartNo),
    unitName: row.unitName == null ? null : String(row.unitName),
    orderNo: row.orderNo == null ? null : String(row.orderNo),
    orderQty: wireOptionalDecimal(row.orderQty),
    orderBaseQty: wireOptionalDecimal(row.orderBaseQty),
    orderUnitName: row.orderUnitName == null ? null : String(row.orderUnitName),
    orderPrice: wireOptionalDecimal(row.orderPrice),
    orderAmount: wireOptionalDecimal(row.orderAmount),
    orderBasePrice: wireOptionalDecimal(row.orderBasePrice),
    orderBaseAmount: wireOptionalDecimal(row.orderBaseAmount),
    orderTaxRate: wireOptionalDecimal(row.orderTaxRate),
    orderCurrencyCode: row.orderCurrencyCode == null ? null : String(row.orderCurrencyCode),
    reconciledQty: wireRequiredDecimal(reconciled),
    remarks: row.remarks == null ? null : String(row.remarks),
    insertedAt: asIso(row.insertedAt)!,
    updatedAt: asIso(row.updatedAt)!,
    returnId: String(row.returnId ?? ''),
    companyId: String(row.companyId ?? ''),
    deliveryItemId: String(row.deliveryItemId ?? ''),
    orderItemId: row.orderItemId == null ? null : String(row.orderItemId),
    materialId: row.materialId == null ? null : String(row.materialId),
    unitId: row.unitId == null ? null : String(row.unitId),
    warehouseId: row.warehouseId == null ? null : String(row.warehouseId),
    returnNo: String(row.returnNo ?? ''),
    returnDate: row.returnDate == null ? '' : String(row.returnDate),
    returnStatus: upperStatus(String(row.returnStatus ?? 'DRAFT')),
    partyType: upperStatus(String(row.partyType ?? '')),
    partyId: String(row.partyId ?? ''),
    remainingReconcilableQty: wireRequiredDecimal(
      String(row.remainingReconcilableQty ?? decimal(baseQty).sub(reconciled)),
    ),
  }
}

export function presentReturnDraft(raw: Record<string, unknown>): ReturnDraftDto {
  const items = Array.isArray(raw.items)
    ? (raw.items as Record<string, unknown>[]).map((item) => presentReturnItem(item))
    : []
  return {
    ...presentReturnHead(raw),
    items,
  }
}

export function mapReturnItemExtras(row: Record<string, unknown>): Record<string, unknown> {
  const baseQty = String(row.base_qty ?? 0)
  const reconciled = String(row.reconciled_qty ?? 0)
  return {
    returnNo: String(row.return_no ?? ''),
    returnDate: asDate(row.return_date),
    returnStatus: upperStatus(String(row.return_status ?? 'DRAFT')),
    partyType: upperStatus(String(row.party_type ?? '')),
    remainingReconcilableQty: wireRequiredDecimal(
      String(row.remaining_reconcilable_qty ?? decimal(baseQty).sub(reconciled)),
    ),
  }
}

export function mapHeadDto(row: Record<string, unknown>) {
  const h = mapHead(row)
  return {
    id: h.id,
    returnNo: h.no,
    returnDate: h.documentDate,
    postingDate: h.postingDate,
    partyType: upperStatus(h.partyType),
    partyId: h.partyId,
    currencyId: h.currencyId,
    exchangeRate: h.exchangeRate,
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

export function returnHeadPayload(input: ReturnDraftInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    companyId: input.companyId,
    returnDate: input.documentDate ?? undefined,
    postingDate: input.postingDate ?? null,
    partyType: input.partyType,
    partyId: input.partyId,
    currencyId: input.currencyId ?? null,
    exchangeRate: input.exchangeRate ?? null,
    remarks: input.remarks ?? null,
    warehouseId: input.warehouseId ?? null,
    debitAccountId: input.debitAccountId,
    creditAccountId: input.creditAccountId,
  }
  if (input.no != null && String(input.no).trim() !== '') {
    payload.returnNo = input.no
  }
  return payload
}

export function returnDraftPayload(input: ReturnDraftInput): Record<string, unknown> {
  const payload = returnHeadPayload(input)
  if (Array.isArray(input.items)) {
    payload.items = input.items.map((item) => ({
      ...(item.id !== undefined ? { id: item.id } : {}),
      idx: item.idx,
      qty: item.qty,
      deliveryItemId: item.deliveryItemId ?? null,
      materialId: item.materialId ?? null,
      orderPrice: item.orderPrice ?? null,
      orderTaxRate: item.orderTaxRate ?? null,
      unitId: item.unitId ?? null,
      warehouseId: item.warehouseId,
      remarks: item.remarks ?? null,
    }))
  }
  return payload
}

/** 条目列表行（裸列投影）→ wire DTO */
export function mapItemDto(row: Record<string, unknown>): ReturnItemDto {
  const baseQty = String(row.base_qty)
  const reconciled = String(row.reconciled_qty ?? 0)
  return {
    id: String(row.id),
    idx: Number(row.idx),
    qty: wireRequiredDecimal(String(row.qty)),
    baseQty: wireRequiredDecimal(baseQty),
    materialCode: asOptionalString(row.material_code),
    materialName: asOptionalString(row.material_name),
    materialSpec: asOptionalString(row.material_spec),
    customerPartNo: asOptionalString(row.customer_part_no),
    unitName: asOptionalString(row.unit_name),
    orderNo: asOptionalString(row.order_no),
    orderQty: wireOptionalDecimal(row.order_qty),
    orderBaseQty: wireOptionalDecimal(row.order_base_qty),
    orderUnitName: asOptionalString(row.order_unit_name),
    orderPrice: wireOptionalDecimal(row.order_price),
    orderAmount: wireOptionalDecimal(row.order_amount),
    orderBasePrice: wireOptionalDecimal(row.order_base_price),
    orderBaseAmount: wireOptionalDecimal(row.order_base_amount),
    orderTaxRate: wireOptionalDecimal(row.order_tax_rate),
    orderCurrencyCode: asOptionalString(row.order_currency_code),
    reconciledQty: wireRequiredDecimal(reconciled),
    remarks: asOptionalString(row.remarks),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    returnId: String(row.return_id),
    companyId: String(row.company_id),
    deliveryItemId: String(row.delivery_item_id),
    orderItemId: asOptionalString(row.order_item_id),
    materialId: asOptionalString(row.material_id),
    unitId: asOptionalString(row.unit_id),
    warehouseId: row.warehouse_id ? String(row.warehouse_id) : null,
    returnNo: String(row.return_no ?? ''),
    returnDate: asDate(row.return_date),
    returnStatus: upperStatus(String(row.return_status ?? 'DRAFT')),
    partyType: upperStatus(String(row.party_type)),
    partyId: String(row.party_id),
    remainingReconcilableQty: wireRequiredDecimal(
      String(row.remaining_reconcilable_qty ?? decimal(baseQty).sub(reconciled)),
    ),
  }
}
