import type { Row } from '~/components/synie-data-grid/types'
import { isLocalRow } from '~/components/synie-editable-table/editable'

export type ReconciliationSide = 'sales' | 'purchase'

export interface ReconciliationDraftItem {
  id?: string
  idx: number
  qty: string
  remarks: string | null
  deliveryItemId?: string
  receiptItemId?: string | null
  outsourcedReceiptItemId?: string | null
}

export interface ReconciliationDraft {
  companyId: string
  reconciliationNo: string | null
  reconciliationType: string
  partyType: string
  partyId: string
  postingDate: string | null
  remarks: string | null
  debitAccountId: string
  creditAccountId: string
  items: ReconciliationDraftItem[]
}

export interface OutsourcedIssueDraftItem {
  id?: string
  idx: number
  orderItemMaterialId: string
  qty: string
  fromWarehouseId: string
  outsourcedWarehouseId: string
  remarks: string | null
}

export interface OutsourcedIssueDraft {
  companyId: string
  issueNo: string | null
  issueDate: string | null
  partyType: string
  partyId: string
  remarks: string | null
  fromWarehouseId: string | null
  outsourcedWarehouseId: string | null
  items: OutsourcedIssueDraftItem[]
}

export interface OutsourcedReceiptMaterialLineDraft {
  id?: string
  idx: number
  orderItemMaterialId: string
  qty: string
  outsourcedWarehouseId: string | null
  remarks: string | null
}

export interface OutsourcedReceiptByproductLineDraft {
  id?: string
  idx: number
  orderItemByproductId: string
  qty: string
  warehouseId: string | null
  remarks: string | null
}

export interface OutsourcedReceiptDraftItem {
  id?: string
  idx: number
  orderItemId: string
  unitId: string | null
  qty: string
  warehouseId: string
  remarks: string | null
  materialLines: OutsourcedReceiptMaterialLineDraft[]
  byproductLines: OutsourcedReceiptByproductLineDraft[]
}

export interface OutsourcedReceiptDraft {
  companyId: string
  receiptNo: string | null
  receiptDate: string | null
  postingDate: string | null
  partyType: string
  partyId: string
  remarks: string | null
  warehouseId: string | null
  outsourcedWarehouseId: string | null
  debitAccountId: string
  creditAccountId: string
  items: OutsourcedReceiptDraftItem[]
}

export type FlatSavedDraft = Row & { items: Row[] }
export type OutsourcedReceiptSavedItem = Row & {
  materialLines: Row[]
  byproductLines: Row[]
}
export type OutsourcedReceiptSavedDraft = Row & {
  items: OutsourcedReceiptSavedItem[]
}

function nullableString(value: unknown): string | null {
  return value == null || value === '' ? null : String(value)
}

function requiredString(value: unknown, label: string): string {
  const result = nullableString(value)
  if (result == null) throw new Error(`${label}不能为空`)
  return result
}

function rowIndex(value: unknown, label: string): number {
  const result = Number(value)
  if (!Number.isInteger(result) || result < 0) {
    throw new Error(`${label}必须是非负整数`)
  }
  return result
}

function persistedId(row: Row): { id?: string } {
  return isLocalRow(row) ? {} : { id: String(row.id) }
}

function reconciliationHead(values: Record<string, unknown>) {
  return {
    companyId: requiredString(values.companyId, '公司'),
    reconciliationNo: nullableString(values.reconciliationNo),
    reconciliationType: requiredString(values.reconciliationType, '对账类型'),
    partyType: requiredString(values.partyType, '对手类型'),
    partyId: requiredString(values.partyId, '对手'),
    postingDate: nullableString(values.postingDate),
    remarks: nullableString(values.remarks),
    debitAccountId: requiredString(values.debitAccountId, '借方科目'),
    creditAccountId: requiredString(values.creditAccountId, '贷方科目'),
  }
}

/** 只发送对账聚合 policy 接受的字段；快照金额均由后端重新派生。 */
export function buildReconciliationDraft(
  side: ReconciliationSide,
  values: Record<string, unknown>,
  rows: Row[],
): ReconciliationDraft {
  return {
    ...reconciliationHead(values),
    items: rows.map((row) => {
      const common = {
        ...persistedId(row),
        idx: rowIndex(row.idx, `第${String(row.idx)}行序号`),
        qty: requiredString(row.qty, `第${String(row.idx)}行数量`),
        remarks: nullableString(row.remarks),
      }
      if (side === 'sales') {
        return {
          ...common,
          deliveryItemId: requiredString(
            row.deliveryItemId,
            `第${String(row.idx)}行发货条目`,
          ),
        }
      }

      const receiptItemId = nullableString(row.receiptItemId)
      const outsourcedReceiptItemId = nullableString(
        row.outsourcedReceiptItemId,
      )
      if ((receiptItemId == null) === (outsourcedReceiptItemId == null)) {
        throw new Error(`第${String(row.idx)}行采购/委外入库条目必须且只能选择一个`)
      }
      return { ...common, receiptItemId, outsourcedReceiptItemId }
    }),
  }
}

/** 委外发料头与全部条目一次提交；本地行 id 不越过 Adapter seam。 */
export function buildOutsourcedIssueDraft(
  values: Record<string, unknown>,
  rows: Row[],
): OutsourcedIssueDraft {
  return {
    companyId: requiredString(values.companyId, '公司'),
    issueNo: nullableString(values.issueNo),
    issueDate: nullableString(values.issueDate),
    partyType: requiredString(values.partyType, '对手类型'),
    partyId: requiredString(values.partyId, '对手'),
    remarks: nullableString(values.remarks),
    fromWarehouseId: nullableString(values.fromWarehouseId),
    outsourcedWarehouseId: nullableString(values.outsourcedWarehouseId),
    items: rows.map((row) => ({
      ...persistedId(row),
      idx: rowIndex(row.idx, `第${String(row.idx)}行序号`),
      orderItemMaterialId: requiredString(
        row.orderItemMaterialId,
        `第${String(row.idx)}行发料清单`,
      ),
      qty: requiredString(row.qty, `第${String(row.idx)}行数量`),
      fromWarehouseId: requiredString(
        row.fromWarehouseId,
        `第${String(row.idx)}行调出仓`,
      ),
      outsourcedWarehouseId: requiredString(
        row.outsourcedWarehouseId,
        `第${String(row.idx)}行外协仓`,
      ),
      remarks: nullableString(row.remarks),
    })),
  }
}

function groupByParent(rows: Row[], label: string): Map<string, Row[]> {
  const result = new Map<string, Row[]>()
  for (const row of rows) {
    const parentId = requiredString(
      row.receiptItemId,
      `第${String(row.idx)}行${label}所属入库条目`,
    )
    const group = result.get(parentId) ?? []
    group.push(row)
    result.set(parentId, group)
  }
  return result
}

/**
 * 委外入库 wire tree 与后端 fulfillmentDrafts policy 完全同形：
 * items[].materialLines / items[].byproductLines，父引用由服务端派生。
 */
export function buildOutsourcedReceiptDraft(
  values: Record<string, unknown>,
  items: Row[],
  materialRows: Row[],
  byproductRows: Row[],
): OutsourcedReceiptDraft {
  const materialsByItem = groupByParent(materialRows, '材料扣减')
  const byproductsByItem = groupByParent(byproductRows, '副产物')
  const itemIds = new Set(items.map((row) => String(row.id)))
  for (const parentId of [
    ...materialsByItem.keys(),
    ...byproductsByItem.keys(),
  ]) {
    if (!itemIds.has(parentId)) {
      throw new Error(`委外入库子行引用了不属于当前草稿的入库条目 ${parentId}`)
    }
  }

  return {
    companyId: requiredString(values.companyId, '公司'),
    receiptNo: nullableString(values.receiptNo),
    receiptDate: nullableString(values.receiptDate),
    postingDate: nullableString(values.postingDate),
    partyType: requiredString(values.partyType, '对手类型'),
    partyId: requiredString(values.partyId, '对手'),
    remarks: nullableString(values.remarks),
    warehouseId: nullableString(values.warehouseId),
    outsourcedWarehouseId: nullableString(values.outsourcedWarehouseId),
    debitAccountId: requiredString(values.debitAccountId, '借方科目'),
    creditAccountId: requiredString(values.creditAccountId, '贷方科目'),
    items: items.map((row) => ({
      ...persistedId(row),
      idx: rowIndex(row.idx, `第${String(row.idx)}行序号`),
      orderItemId: requiredString(
        row.orderItemId,
        `第${String(row.idx)}行委外订单条目`,
      ),
      unitId: nullableString(row.unitId),
      qty: requiredString(row.qty, `第${String(row.idx)}行数量`),
      warehouseId: requiredString(
        row.warehouseId,
        `第${String(row.idx)}行入库仓`,
      ),
      remarks: nullableString(row.remarks),
      materialLines: (materialsByItem.get(String(row.id)) ?? []).map(
        (line) => ({
          ...persistedId(line),
          idx: rowIndex(line.idx, `第${String(line.idx)}行材料扣减序号`),
          orderItemMaterialId: requiredString(
            line.orderItemMaterialId,
            `第${String(line.idx)}行发料清单`,
          ),
          qty: requiredString(
            line.qty,
            `第${String(line.idx)}行材料扣减数量`,
          ),
          outsourcedWarehouseId: nullableString(line.outsourcedWarehouseId),
          remarks: nullableString(line.remarks),
        }),
      ),
      byproductLines: (byproductsByItem.get(String(row.id)) ?? []).map(
        (line) => ({
          ...persistedId(line),
          idx: rowIndex(line.idx, `第${String(line.idx)}行副产物序号`),
          orderItemByproductId: requiredString(
            line.orderItemByproductId,
            `第${String(line.idx)}行副产物清单`,
          ),
          qty: requiredString(
            line.qty,
            `第${String(line.idx)}行副产物数量`,
          ),
          warehouseId: nullableString(line.warehouseId),
          remarks: nullableString(line.remarks),
        }),
      ),
    })),
  }
}

function record(value: unknown, path: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path}不是有效对象`)
  }
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || row.id === '') {
    throw new Error(`${path}缺少 id`)
  }
  return row as Row
}

function rows(value: unknown, path: string): Row[] {
  if (!Array.isArray(value)) throw new Error(`${path}不是完整数组`)
  return value.map((item, index) => record(item, `${path}[${index}]`))
}

/** 对 Aggregate load 结果做 fail-closed 解码，避免空暂态被解释为整单删除。 */
export function decodeFlatSavedDraft(
  value: unknown,
  label: string,
): FlatSavedDraft {
  const head = record(value, label)
  return { ...head, items: rows(head.items, `${label}.items`) }
}

export function decodeOutsourcedReceiptSavedDraft(
  value: unknown,
): OutsourcedReceiptSavedDraft {
  const head = record(value, '委外入库草稿')
  const items = rows(head.items, '委外入库草稿.items').map((item, index) => ({
    ...item,
    materialLines: rows(
      item.materialLines,
      `委外入库草稿.items[${index}].materialLines`,
    ),
    byproductLines: rows(
      item.byproductLines,
      `委外入库草稿.items[${index}].byproductLines`,
    ),
  }))
  return { ...head, items }
}
