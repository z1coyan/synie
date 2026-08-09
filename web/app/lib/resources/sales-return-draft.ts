/**
 * 销售退货草稿的 build 链：表单态 → wire input 的唯一实现。
 * 错误路径映射复用销售发货的通用工具（normalizedErrorPath / headerFieldErrors / rowErrors）。
 */
import type { Row } from '~/components/synie-data-grid/types'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { nullableString, requiredIndex, requiredString } from './draft-fields'
import type { SalesReturnDraftInput, SalesReturnDraftItemInput } from './returns'

/** 提交 mutation:物料/订单快照由发货条目锁定带出,后端再快照与折算 */
function itemInput(row: Row): SalesReturnDraftItemInput {
  return {
    ...(!isLocalRow(row) ? { id: String(row.id) } : {}),
    idx: requiredIndex(row.idx, '退货条目序号'),
    deliveryItemId: requiredString(row.deliveryItemId, '发货条目'),
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
