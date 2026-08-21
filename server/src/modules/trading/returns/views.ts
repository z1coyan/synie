/**
 * 退货 wire 呈现：meta 派生 presenter + 计算列/键并集钩子（销售/采购/委外对称）。
 *
 * 键集/键序/规范化规则唯一事实源是 spec.ts 的 meta：
 * - 头/条目 presenter 派生自销售侧（金额单）meta——三侧共享同一 wire 形状，
 *   委外侧缺金额键时派生值自然为 null（与迁前手写一致）
 * - 条目来源锚点是三侧并集键（deliveryItemId/receiptItemId/outsourcedReceiptItemId），
 *   字段描述符从各侧 meta 拼接，不重新声明类型
 * - remainingReconcilableQty / reconciledQty 的计算回退保留为逐键值钩子
 */
import { decimal } from '@synie/shared'
import type { FieldMeta } from '~/platform/meta/types.ts'
import { derivePresenter } from '~/platform/standard/present.ts'
import { asDate, upperStatus, wireRequiredDecimal } from '../common.ts'
import { returnHeadMeta, returnItemMeta, returnSpec, type ReturnKind } from './spec.ts'
import type { ReturnDraftDto, ReturnDraftInput, ReturnHeadDto, ReturnItemDto } from './types.ts'

// 三侧共享 wire 形状：派生基准取金额单（销售）meta
const HEAD_META = returnHeadMeta('sales')
const ITEM_META = returnItemMeta('sales')
const PURCHASE_ITEM_FIELDS = returnItemMeta('purchase').fields
const OUTSOURCED_ITEM_FIELDS = returnItemMeta('outsourced').fields

const fieldOf = (fields: readonly FieldMeta[], apiName: string): FieldMeta => {
  const found = fields.find((f) => f.apiName === apiName)
  if (!found) throw new Error(`退货 wire 派生：缺字段 ${apiName}`)
  return found
}

/** 条目键清单：销售侧 meta 字段序 + 来源锚点并集（三侧键同一位置） */
const ITEM_FIELDS = ITEM_META.fields.flatMap((f) =>
  f.apiName === 'deliveryItemId'
    ? [
        f,
        fieldOf(PURCHASE_ITEM_FIELDS, 'receiptItemId'),
        fieldOf(OUTSOURCED_ITEM_FIELDS, 'outsourcedReceiptItemId'),
      ]
    : [f],
)

export const presentReturnHead = derivePresenter<ReturnHeadDto>(HEAD_META)

export const presentReturnItem = derivePresenter<ReturnItemDto>(ITEM_META, {
  fields: ITEM_FIELDS,
  values: {
    // 委外侧无 reconciled 列：迁前手写回退 0，逐字保留
    reconciledQty: (row) => wireRequiredDecimal(String(row.reconciledQty ?? 0)),
    // 剩余可对账 = 折算数量 − 已对账（投影列缺省时回退，与 mapReturnItemExtras 同口径）
    remainingReconcilableQty: (row) =>
      wireRequiredDecimal(
        String(
          row.remainingReconcilableQty ??
            decimal(String(row.baseQty ?? 0)).sub(String(row.reconciledQty ?? 0)),
        ),
      ),
  },
})

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

export function returnDraftPayload(
  side: ReturnKind,
  input: ReturnDraftInput,
): Record<string, unknown> {
  const payload = returnHeadPayload(input)
  const sourceKey = returnSpec(side).sourceItemApi
  if (Array.isArray(input.items)) {
    payload.items = input.items.map((item) => ({
      ...(item.id !== undefined ? { id: item.id } : {}),
      idx: item.idx,
      qty: item.qty,
      [sourceKey]:
        (side === 'sales'
          ? item.deliveryItemId
          : side === 'purchase'
            ? item.receiptItemId
            : item.outsourcedReceiptItemId) ?? null,
      materialId: item.materialId ?? null,
      orderPrice: item.orderPrice ?? null,
      orderTaxRate: item.orderTaxRate ?? null,
      unitId: item.unitId ?? null,
      warehouseId: item.warehouseId ?? null,
      remarks: item.remarks ?? null,
    }))
  }
  return payload
}
