/**
 * 对账单头/条目列表与写后 reload 共用投影。
 * 别名与 source 子查询必须逐字一致（via 链 EXISTS 依赖别名）。
 *
 * wire presenter 自 meta 派生（键集/键序/规范化唯一事实源是 spec.ts）：
 * - 条目来源锚点是双侧并集键（delivery/return/receipt/outsourcedReceipt 四键），
 *   字段描述符从两侧 meta 拼接；采购侧 wire 键序（returnItemId 在 receiptItemId 前）
 *   与 meta 物理序不同，以 fields 覆盖冻结
 * - 头 String(null)='null' 与合计 ?? 0 的历史怪癖以 values 钩子逐字保留
 */
import { sql, type RawBuilder } from 'kysely'
import type { FieldMeta } from '~/platform/meta/types.ts'
import { derivePresenter } from '~/platform/standard/present.ts'
import {
  asDate,
  ident,
  type TradingSide,
  upperStatus,
  wireRequiredDecimal,
} from '../common.ts'
import { reconciliationHeadMeta, reconciliationItemMeta, type ReconciliationSideSpec } from './spec.ts'
import type { ReconciliationHead, ReconciliationItem } from './types.ts'

export const HEAD_ALIAS = 'reconciliations'
export const ITEM_ALIAS = 'reconciliation_items'

export function headSource(spec: ReconciliationSideSpec): RawBuilder<unknown> {
  return sql` FROM (
    SELECT h.id,h.reconciliation_no,h.reconciliation_type,h.party_type,h.party_id,
      h.posting_date,h.remarks,h.status,h.inserted_at,h.updated_at,h.company_id,
      h.debit_account_id,h.credit_account_id,h.created_by_id,
      COALESCE(SUM(i.amount),0) AS gross_total,
      COALESCE(SUM(i.base_amount),0) AS base_gross_total
    FROM ${ident(spec.table)} h
    LEFT JOIN ${ident(spec.itemTable)} i ON i.reconciliation_id=h.id
    GROUP BY h.id
  ) ${sql.raw(HEAD_ALIAS)}`
}

export function headSelectExtra(): RawBuilder<unknown> {
  return sql`gross_total, base_gross_total`
}

export function headExtras(row: Record<string, unknown>): Record<string, unknown> {
  return {
    grossTotal: wireRequiredDecimal(String(row.gross_total ?? 0)),
    baseGrossTotal: wireRequiredDecimal(String(row.base_gross_total ?? 0)),
  }
}

export function itemSource(spec: ReconciliationSideSpec): RawBuilder<unknown> {
  if (spec.side === 'sales') {
    // 双来源同池（发货条目/销售退货条目恰一）：来源单号/日期与快照列 COALESCE 投影
    return sql` FROM (
      SELECT ri.id,ri.idx,ri.qty,ri.base_qty,ri.amount,ri.base_amount,ri.remarks,
        ri.inserted_at,ri.updated_at,ri.reconciliation_id,ri.company_id,
        ri.delivery_item_id,ri.return_item_id,r.reconciliation_no,
        r.status AS reconciliation_status,
        COALESCE(h.delivery_no,th.return_no) AS delivery_no,
        COALESCE(h.delivery_date,th.return_date) AS delivery_date,
        COALESCE(i.material_name,ti.material_name) AS material_name,
        COALESCE(i.unit_name,ti.unit_name) AS unit_name,
        COALESCE(i.order_currency_code,ti.order_currency_code) AS order_currency_code
      FROM sal_reconciliation_item ri
      JOIN sal_reconciliation r ON r.id=ri.reconciliation_id
      LEFT JOIN sal_delivery_item i ON i.id=ri.delivery_item_id
      LEFT JOIN sal_delivery h ON h.id=i.delivery_id
      LEFT JOIN sal_return_item ti ON ti.id=ri.return_item_id
      LEFT JOIN sal_return th ON th.id=ti.return_id
    ) ${sql.raw(ITEM_ALIAS)}`
  }
  // 三来源同池（入库/委外入库/采购退货恰一）：来源单号/日期与快照列 COALESCE 投影
  return sql` FROM (
    SELECT ri.id,ri.idx,ri.qty,ri.base_qty,ri.amount,ri.base_amount,ri.remarks,
      ri.inserted_at,ri.updated_at,ri.reconciliation_id,ri.company_id,
      ri.receipt_item_id,ri.outsourced_receipt_item_id,ri.return_item_id,
      r.reconciliation_no,r.status AS reconciliation_status,
      COALESCE(sh.receipt_no,oh.receipt_no,th.return_no) AS receipt_no,
      COALESCE(sh.receipt_date,oh.receipt_date,th.return_date) AS receipt_date,
      COALESCE(si.material_name,oi.material_name,ti.material_name) AS material_name,
      COALESCE(si.unit_name,oi.unit_name,ti.unit_name) AS unit_name,
      COALESCE(si.order_currency_code,oi.order_currency_code,ti.order_currency_code) AS order_currency_code
    FROM pur_reconciliation_item ri
    JOIN pur_reconciliation r ON r.id=ri.reconciliation_id
    LEFT JOIN pur_receipt_item si ON si.id=ri.receipt_item_id
    LEFT JOIN pur_receipt sh ON sh.id=si.receipt_id
    LEFT JOIN pur_outsourced_receipt_item oi ON oi.id=ri.outsourced_receipt_item_id
    LEFT JOIN pur_outsourced_receipt oh ON oh.id=oi.receipt_id
    LEFT JOIN pur_return_item ti ON ti.id=ri.return_item_id
    LEFT JOIN pur_return th ON th.id=ti.return_id
  ) ${sql.raw(ITEM_ALIAS)}`
}

export function itemSelectExtra(side: TradingSide): RawBuilder<unknown> {
  if (side === 'sales') {
    return sql`reconciliation_no, reconciliation_status, delivery_no, delivery_date, material_name, unit_name, order_currency_code`
  }
  return sql`reconciliation_no, reconciliation_status, receipt_no, receipt_date, material_name, unit_name, order_currency_code`
}

export function itemExtras(side: TradingSide, row: Record<string, unknown>): Record<string, unknown> {
  const numberKey = side === 'sales' ? 'deliveryNo' : 'receiptNo'
  const dateKey = side === 'sales' ? 'deliveryDate' : 'receiptDate'
  const sourceDate = side === 'sales' ? row.delivery_date : row.receipt_date
  const sourceNo =
    side === 'sales' ? String(row.delivery_no ?? '') : String(row.receipt_no ?? '')
  return {
    reconciliationNo: String(row.reconciliation_no),
    reconciliationStatus: upperStatus(String(row.reconciliation_status)),
    [numberKey]: sourceNo,
    [dateKey]: asDate(sourceDate),
    materialName: String(row.material_name),
    unitName: String(row.unit_name),
    orderCurrencyCode: String(row.order_currency_code),
  }
}

/** 写路径/wire 呈现：标准服务 Date → ISO；与迁前 mapHeadDto 字节对齐 */
const HEAD_META = reconciliationHeadMeta('sales')
const SALES_ITEM_META = reconciliationItemMeta('sales')
const PURCHASE_ITEM_META = reconciliationItemMeta('purchase')

const fieldOf = (fields: readonly FieldMeta[], apiName: string): FieldMeta => {
  const found = fields.find((f) => f.apiName === apiName)
  if (!found) throw new Error(`对账 wire 派生：缺字段 ${apiName}`)
  return found
}

// 条目 wire 键序（双侧一致）：deliveryItemId, returnItemId, receiptItemId, outsourcedReceiptItemId
const SALES_ITEM_FIELDS = SALES_ITEM_META.fields.flatMap((f) =>
  f.apiName === 'returnItemId'
    ? [
        f,
        fieldOf(PURCHASE_ITEM_META.fields, 'receiptItemId'),
        fieldOf(PURCHASE_ITEM_META.fields, 'outsourcedReceiptItemId'),
      ]
    : [f],
)
const PURCHASE_ITEM_FIELDS = PURCHASE_ITEM_META.fields.flatMap((f) => {
  if (f.apiName === 'receiptItemId') {
    return [
      fieldOf(SALES_ITEM_META.fields, 'deliveryItemId'),
      fieldOf(PURCHASE_ITEM_META.fields, 'returnItemId'),
      f,
    ]
  }
  if (f.apiName === 'returnItemId') return []
  return [f]
})

export const presentHead = derivePresenter<ReconciliationHead>(HEAD_META, {
  values: {
    // 历史怪癖逐字保留（字节冻结）：科目键无 null 分支、合计缺省回退 0
    debitAccountId: (row) => String(row.debitAccountId),
    creditAccountId: (row) => String(row.creditAccountId),
    grossTotal: (row) => wireRequiredDecimal(String(row.grossTotal ?? 0)),
    baseGrossTotal: (row) => wireRequiredDecimal(String(row.baseGrossTotal ?? 0)),
  },
})

const presentItemSales = derivePresenter<ReconciliationItem>(SALES_ITEM_META, {
  fields: SALES_ITEM_FIELDS,
  values: {
    // 异侧锚点键恒 null（迁前手写即硬编码，非透传；生产行本就不带这些键）
    receiptItemId: () => null,
    outsourcedReceiptItemId: () => null,
  },
})
const presentItemPurchase = derivePresenter<ReconciliationItem>(PURCHASE_ITEM_META, {
  fields: PURCHASE_ITEM_FIELDS,
  values: {
    deliveryItemId: () => null,
  },
})

export function presentItem(side: TradingSide, row: Record<string, unknown>): ReconciliationItem {
  return side === 'sales' ? presentItemSales(row) : presentItemPurchase(row)
}

/** 发票接缝：裸 SQL 行 → 与 presentHead 同形 */
export function mapHeadPropsFromDb(row: Record<string, unknown>): ReconciliationHead {
  return presentHead({
    id: row.id,
    reconciliationNo: row.reconciliation_no,
    reconciliationType: row.reconciliation_type,
    partyType: row.party_type,
    partyId: row.party_id,
    postingDate: row.posting_date,
    remarks: row.remarks,
    status: row.status,
    insertedAt: row.inserted_at,
    updatedAt: row.updated_at,
    companyId: row.company_id,
    debitAccountId: row.debit_account_id,
    creditAccountId: row.credit_account_id,
    createdById: row.created_by_id,
    grossTotal: row.gross_total,
    baseGrossTotal: row.base_gross_total,
  })
}
