/**
 * 销售退货草稿的 build 链：表单态 → wire input 的唯一实现。
 * 错误路径映射复用销售发货的通用工具（normalizedErrorPath / headerFieldErrors / rowErrors）。
 */
import type { Row } from '~/components/synie-data-grid/types'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { nullableString, requiredIndex, requiredString } from './draft-fields'
import type {
  PurchaseReturnDraftInput,
  PurchaseReturnDraftItemInput,
  SalesReturnDraftInput,
  SalesReturnDraftItemInput,
} from './returns'

/** 提交 mutation:源单行快照由发货条目锁定带出,手工行价税手填;后端再快照与折算 */
function itemInput(row: Row): SalesReturnDraftItemInput {
  const manual = row.deliveryItemId == null || row.deliveryItemId === ''
  return {
    ...(!isLocalRow(row) ? { id: String(row.id) } : {}),
    idx: requiredIndex(row.idx, '退货条目序号'),
    deliveryItemId: manual ? null : String(row.deliveryItemId),
    ...(manual
      ? {
          materialId: requiredString(row.materialId, '物料'),
          orderPrice: requiredString(row.orderPrice, '含税单价'),
          orderTaxRate: requiredString(row.orderTaxRate, '税率'),
        }
      : {}),
    unitId: nullableString(row.unitId),
    qty: requiredString(row.qty, '退货数量'),
    // 行仓可空:虚拟/资产行不入仓;库存类行缺仓由后端保存校验兜底(「库存类物料必须填写行仓」)
    warehouseId: nullableString(row.warehouseId),
    remarks: nullableString(row.remarks),
  }
}

export interface ReturnDraftIndex {
  itemRowIds: string[]
}

/** 提交 mutation(采购):源单行快照由入库条目锁定带出,手工行价税手填;后端再快照与折算 */
function purchaseItemInput(row: Row): PurchaseReturnDraftItemInput {
  const manual = row.receiptItemId == null || row.receiptItemId === ''
  return {
    ...(!isLocalRow(row) ? { id: String(row.id) } : {}),
    idx: requiredIndex(row.idx, '退货条目序号'),
    receiptItemId: manual ? null : String(row.receiptItemId),
    ...(manual
      ? {
          materialId: requiredString(row.materialId, '物料'),
          orderPrice: requiredString(row.orderPrice, '含税单价'),
          orderTaxRate: requiredString(row.orderTaxRate, '税率'),
        }
      : {}),
    unitId: nullableString(row.unitId),
    qty: requiredString(row.qty, '退货数量'),
    warehouseId: nullableString(row.warehouseId),
    remarks: nullableString(row.remarks),
  }
}

export function buildPurchaseReturnDraft(
  values: Record<string, unknown>,
  items: Row[],
): { draft: PurchaseReturnDraftInput; index: ReturnDraftIndex } {
  return {
    draft: {
      companyId: requiredString(values.companyId, '公司'),
      returnNo: nullableString(values.returnNo),
      returnDate: nullableString(values.returnDate),
      postingDate: nullableString(values.postingDate),
      partyType: requiredString(values.partyType, '对手类型'),
      partyId: requiredString(values.partyId, '对手'),
      currencyId: nullableString(values.currencyId),
      exchangeRate: nullableString(values.exchangeRate),
      remarks: nullableString(values.remarks),
      warehouseId: nullableString(values.warehouseId),
      debitAccountId: requiredString(values.debitAccountId, '借方科目'),
      creditAccountId: requiredString(values.creditAccountId, '贷方科目'),
      items: items.map(purchaseItemInput),
    },
    index: {
      itemRowIds: items.map((row) => String(row.id)),
    },
  }
}

export function buildReturnDraft(
  values: Record<string, unknown>,
  items: Row[],
): { draft: SalesReturnDraftInput; index: ReturnDraftIndex } {
  return {
    draft: {
      companyId: requiredString(values.companyId, '公司'),
      returnNo: nullableString(values.returnNo),
      returnDate: nullableString(values.returnDate),
      postingDate: nullableString(values.postingDate),
      partyType: requiredString(values.partyType, '对手类型'),
      partyId: requiredString(values.partyId, '对手'),
      currencyId: nullableString(values.currencyId),
      exchangeRate: nullableString(values.exchangeRate),
      remarks: nullableString(values.remarks),
      warehouseId: nullableString(values.warehouseId),
      debitAccountId: requiredString(values.debitAccountId, '借方科目'),
      creditAccountId: requiredString(values.creditAccountId, '贷方科目'),
      items: items.map(itemInput),
    },
    index: {
      itemRowIds: items.map((row) => String(row.id)),
    },
  }
}
