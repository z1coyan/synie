/**
 * sales.order 打印装配：头 + 条目，键名对齐打印字段目录。
 * 记录可达性按 Permit 的行过滤 fail-closed（`findAuthorized`，不可达即不产出该单）。
 * 业务知识（表查询 / 枚举标签）住在 trading/order，不进 platform。
 */
import { sql } from 'kysely'
import { decimal } from '@synie/shared'
import type { DbHandle } from '~/db/tx.ts'
import { findAuthorized } from '~/db/load.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { DocBuilder } from '~/platform/printing/docbuilder.ts'
import {
  enumLabel,
  formatBool,
  formatDate,
  formatDateTime,
  formatDecimal,
  formatInt,
  formatText,
} from '~/platform/printing/format.ts'
import type { BuiltDoc, PrintDoc } from '~/platform/printing/types.ts'

const SALES_ORDER_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  DRAFT: '草稿',
  audited: '已审核',
  AUDITED: '已审核',
  closed: '已关闭',
  CLOSED: '已关闭',
  voided: '已作废',
  VOIDED: '已作废',
}

const SALES_ORDER_TYPE_LABELS: Record<string, string> = {
  regular: '常规订单',
  REGULAR: '常规订单',
  sample: '样品订单',
  SAMPLE: '样品订单',
}

const PARTY_TYPE_LABELS: Record<string, string> = {
  supplier: '供应商',
  SUPPLIER: '供应商',
  customer: '客户',
  CUSTOMER: '客户',
  company: '内部公司',
  COMPANY: '内部公司',
  employee: '员工',
  EMPLOYEE: '员工',
}

const UNIT_TYPE_LABELS: Record<string, string> = {
  length: '长度',
  LENGTH: '长度',
  area: '面积',
  AREA: '面积',
  weight: '重量',
  WEIGHT: '重量',
  quantity: '数量',
  QUANTITY: '数量',
}

const QUOTATION_PRICING_MODE_LABELS: Record<string, string> = {
  fixed: '固定价',
  FIXED: '固定价',
  qty_tiered: '数量梯度',
  QTY_TIERED: '数量梯度',
}

interface HeadRow {
  order_no: string
  order_date: Date | string
  order_type: string
  party_type: string
  party_id: string
  party_name: string | null
  exchange_rate: string
  terms: string | null
  remarks: string | null
  status: string
  audited_at: Date | string | null
  company_id: string
  company_code: string
  company_name: string
  company_short: string
  currency_iso: string
  currency_name: string
  currency_sym: string | null
  currency_act: boolean
  creator_name: string | null
  creator_user: string | null
  creator_lang: string | null
  auditor_name: string | null
  auditor_user: string | null
  auditor_lang: string | null
  gross_total: string
  base_gross_total: string
}

interface ItemRow {
  idx: number | string
  qty: string
  base_qty: string
  shipped_qty: string
  price: string
  amount: string
  base_price: string
  base_amount: string
  tax_rate: string
  material_code: string
  material_name: string
  material_spec: string | null
  customer_part_no: string | null
  unit_name: string
  remarks: string | null
  m_code: string
  m_name: string
  m_spec: string | null
  m_customer_part_no: string | null
  m_active: boolean
  m_is_customer: boolean
  u_name: string
  u_symbol: string
  u_ratio: string
  u_is_base: boolean
  u_unit_type: string
  qi_idx: number | string | null
  qi_pricing_mode: string | null
  qi_price: string | null
  qi_tax_rate: string | null
  qi_material_code: string | null
  qi_material_name: string | null
  qi_material_spec: string | null
  qi_customer_part_no: string | null
  qi_unit_name: string | null
  qi_remarks: string | null
}

export function createSalesOrderDocBuilder(db: DbHandle, registry: Registry): DocBuilder {
  const target = registry.authzTarget('salOrders')
  return {
    label: () => '销售订单',
    async buildDocs(permit, ids) {
      const result: BuiltDoc[] = []
      for (const id of ids) {
        // 行可达性一次编译到 WHERE；不命中与不存在同为 not_found
        const reachable = await findAuthorized({ db, permit, target, table: 'sal_order', id })
        const head = reachable ? await loadHead(db, id) : undefined
        if (!head) {
          throw new ApiError('not_found', '部分单据不存在或无权查看')
        }
        const items = await loadItems(db, id)
        result.push({ sheetName: head.order_no, doc: toDoc(head, items) })
      }
      return result
    },
  }
}

/** 向 printing seam 注册 sales.order 装配（组合根调用） */
export function registerSalesOrderDocBuilder(
  printing: { registerDocBuilder: (resource: string, builder: DocBuilder) => void },
  db: DbHandle,
  registry: Registry,
): void {
  printing.registerDocBuilder('sales.order', createSalesOrderDocBuilder(db, registry))
}

async function loadHead(db: DbHandle, id: string): Promise<HeadRow | undefined> {
  const rows = await sql<HeadRow>`
SELECT o.order_no, o.order_date, o.order_type, o.party_type, o.party_id::text AS party_id,
  CASE o.party_type
    WHEN 'customer' THEN (SELECT name FROM sal_customers WHERE id = o.party_id)
    WHEN 'CUSTOMER' THEN (SELECT name FROM sal_customers WHERE id = o.party_id)
    WHEN 'supplier' THEN (SELECT name FROM pur_supplier WHERE id = o.party_id)
    WHEN 'SUPPLIER' THEN (SELECT name FROM pur_supplier WHERE id = o.party_id)
    WHEN 'company' THEN (SELECT name FROM bas_company WHERE id = o.party_id)
    WHEN 'COMPANY' THEN (SELECT name FROM bas_company WHERE id = o.party_id)
    WHEN 'employee' THEN (SELECT name FROM hr_employees WHERE id = o.party_id)
    WHEN 'EMPLOYEE' THEN (SELECT name FROM hr_employees WHERE id = o.party_id)
  END AS party_name,
  o.exchange_rate::text AS exchange_rate, o.terms, o.remarks, o.status, o.audited_at,
  o.company_id::text AS company_id, c.code AS company_code, c.name AS company_name, c.short_name AS company_short,
  cur.iso_code AS currency_iso, cur.name AS currency_name, cur.symbol AS currency_sym, cur.active AS currency_act,
  creator.name AS creator_name, creator.username::text AS creator_user, creator.preferred_language AS creator_lang,
  auditor.name AS auditor_name, auditor.username::text AS auditor_user, auditor.preferred_language AS auditor_lang,
  COALESCE((SELECT sum(i.amount) FROM sal_order_item i WHERE i.order_id = o.id), 0)::text AS gross_total,
  COALESCE((SELECT sum(i.base_amount) FROM sal_order_item i WHERE i.order_id = o.id), 0)::text AS base_gross_total
FROM sal_order o
JOIN bas_company c ON c.id = o.company_id
JOIN bas_currency cur ON cur.id = o.currency_id
LEFT JOIN sys_user creator ON creator.id = o.created_by_id
LEFT JOIN sys_user auditor ON auditor.id = o.audited_by_id
WHERE o.id = ${id}::uuid
`.execute(db)
  return rows.rows[0]
}

async function loadItems(db: DbHandle, orderId: string): Promise<ItemRow[]> {
  const rows = await sql<ItemRow>`
SELECT i.idx, i.qty::text AS qty, i.base_qty::text AS base_qty, i.shipped_qty::text AS shipped_qty,
  i.price::text AS price, i.amount::text AS amount, i.base_price::text AS base_price,
  i.base_amount::text AS base_amount, i.tax_rate::text AS tax_rate,
  i.material_code, i.material_name, i.material_spec, i.customer_part_no,
  i.unit_name, i.remarks,
  m.code AS m_code, m.name AS m_name, m.spec AS m_spec, m.customer_part_no AS m_customer_part_no,
  m.active AS m_active, m.is_customer_material AS m_is_customer,
  u.name AS u_name, u.symbol AS u_symbol, u.ratio::text AS u_ratio, u.is_base AS u_is_base, u.unit_type AS u_unit_type,
  qi.idx AS qi_idx, qi.pricing_mode AS qi_pricing_mode, qi.price::text AS qi_price, qi.tax_rate::text AS qi_tax_rate,
  qi.material_code AS qi_material_code, qi.material_name AS qi_material_name,
  qi.material_spec AS qi_material_spec, qi.customer_part_no AS qi_customer_part_no,
  qi.unit_name AS qi_unit_name, qi.remarks AS qi_remarks
FROM sal_order_item i
JOIN inv_material m ON m.id = i.material_id
JOIN bas_unit u ON u.id = i.unit_id
LEFT JOIN sal_quotation_item qi ON qi.id = i.quotation_item_id
WHERE i.order_id = ${orderId}::uuid
ORDER BY i.idx, i.id
`.execute(db)
  return rows.rows
}

function toDoc(head: HeadRow, items: ItemRow[]): PrintDoc {
  return {
    fields: headFields(head),
    loops: {
      items: items.map((item) => itemFields(head, item)),
    },
  }
}

function headFields(h: HeadRow): Record<string, string> {
  return {
    order_no: h.order_no,
    order_date: formatDate(h.order_date),
    order_type: enumLabel(SALES_ORDER_TYPE_LABELS, h.order_type),
    party_type: enumLabel(PARTY_TYPE_LABELS, h.party_type),
    'party.name': formatText(h.party_name),
    exchange_rate: formatDecimal(h.exchange_rate),
    terms: formatText(h.terms),
    remarks: formatText(h.remarks),
    status: enumLabel(SALES_ORDER_STATUS_LABELS, h.status),
    audited_at: formatDateTime(h.audited_at),
    gross_total: formatDecimal(h.gross_total),
    base_gross_total: formatDecimal(h.base_gross_total),
    'company.code': h.company_code,
    'company.name': h.company_name,
    'company.short_name': h.company_short,
    'currency.iso_code': h.currency_iso,
    'currency.name': h.currency_name,
    'currency.symbol': formatText(h.currency_sym),
    'currency.active': formatBool(h.currency_act),
    'created_by.name': formatText(h.creator_name),
    'created_by.username': formatText(h.creator_user),
    'created_by.preferred_language': formatText(h.creator_lang),
    'audited_by.name': formatText(h.auditor_name),
    'audited_by.username': formatText(h.auditor_user),
    'audited_by.preferred_language': formatText(h.auditor_lang),
  }
}

function itemFields(h: HeadRow, item: ItemRow): Record<string, string> {
  const remaining = decimal(item.base_qty).sub(decimal(item.shipped_qty)).toString()
  return {
    idx: formatInt(item.idx),
    qty: formatDecimal(item.qty),
    base_qty: formatDecimal(item.base_qty),
    shipped_qty: formatDecimal(item.shipped_qty),
    remaining_base_qty: formatDecimal(remaining),
    price: formatDecimal(item.price),
    amount: formatDecimal(item.amount),
    base_price: formatDecimal(item.base_price),
    base_amount: formatDecimal(item.base_amount),
    tax_rate: formatDecimal(item.tax_rate),
    material_code: item.material_code,
    material_name: item.material_name,
    material_spec: formatText(item.material_spec),
    customer_part_no: formatText(item.customer_part_no),
    unit_name: item.unit_name,
    remarks: formatText(item.remarks),
    order_date: formatDate(h.order_date),
    order_status: enumLabel(SALES_ORDER_STATUS_LABELS, h.status),
    party_type: enumLabel(PARTY_TYPE_LABELS, h.party_type),
    party_id: h.party_id,
    currency_code: h.currency_iso,
    'company.code': h.company_code,
    'company.name': h.company_name,
    'company.short_name': h.company_short,
    'material.code': item.m_code,
    'material.name': item.m_name,
    'material.spec': formatText(item.m_spec),
    'material.customer_part_no': formatText(item.m_customer_part_no),
    'material.active': formatBool(item.m_active),
    'material.is_customer_material': formatBool(item.m_is_customer),
    'unit.name': item.u_name,
    'unit.symbol': item.u_symbol,
    'unit.ratio': formatDecimal(item.u_ratio),
    'unit.is_base': formatBool(item.u_is_base),
    'unit.unit_type': enumLabel(UNIT_TYPE_LABELS, item.u_unit_type),
    'order.order_no': h.order_no,
    'order.order_date': formatDate(h.order_date),
    'order.order_type': enumLabel(SALES_ORDER_TYPE_LABELS, h.order_type),
    'order.party_type': enumLabel(PARTY_TYPE_LABELS, h.party_type),
    'order.status': enumLabel(SALES_ORDER_STATUS_LABELS, h.status),
    'order.terms': formatText(h.terms),
    'order.remarks': formatText(h.remarks),
    'order.exchange_rate': formatDecimal(h.exchange_rate),
    'order.audited_at': formatDateTime(h.audited_at),
    'quotation_item.idx': formatInt(item.qi_idx),
    'quotation_item.pricing_mode': enumLabel(
      QUOTATION_PRICING_MODE_LABELS,
      item.qi_pricing_mode,
    ),
    'quotation_item.price': formatDecimal(item.qi_price),
    'quotation_item.tax_rate': formatDecimal(item.qi_tax_rate),
    'quotation_item.material_code': formatText(item.qi_material_code),
    'quotation_item.material_name': formatText(item.qi_material_name),
    'quotation_item.material_spec': formatText(item.qi_material_spec),
    'quotation_item.customer_part_no': formatText(item.qi_customer_part_no),
    'quotation_item.unit_name': formatText(item.qi_unit_name),
    'quotation_item.remarks': formatText(item.qi_remarks),
  }
}
