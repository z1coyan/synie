/**
 * 订单头/条目列表与写后 reload 共用投影（别名与 source 子查询必须逐字一致）。
 * 履约累加投影见 projection.ts（postFulfillment 等）。
 */
import { sql, type RawBuilder } from 'kysely'
import {
  asDate,
  asDateTime,
  asOptionalString,
  codeNamedRef,
  ident,
  namedRef,
  type TradingSide,
  upperStatus,
  wireRequiredDecimal,
} from '../common.ts'
import { orderSpec, type OrderSideSpec } from './spec.ts'
import type { Order, OrderItem } from './types.ts'

export const HEAD_ALIAS = 'order_heads'
export const ITEM_ALIAS = 'order_items'

/** sales 须带 is_outsourced（非物理列）；purchase 物理列已在 SELECT 主体 */
export function headSelectExtra(side: TradingSide): RawBuilder<unknown> {
  if (side === 'sales') {
    return sql`is_outsourced, gross_total, base_gross_total, company_name, currency_code, currency_name, created_by_name, audited_by_name`
  }
  return sql`gross_total, base_gross_total, company_name, currency_code, currency_name, created_by_name, audited_by_name`
}

export function headSource(spec: OrderSideSpec): RawBuilder<unknown> {
  const outsourcedCol = spec.side === 'purchase' ? 'o.is_outsourced' : 'false'
  return sql` FROM (
    SELECT o.id,o.order_no,o.order_date,o.order_type,${sql.raw(outsourcedCol)} AS is_outsourced,
      o.party_type,o.party_id,o.exchange_rate,o.terms,o.remarks,o.status,o.audited_at,
      o.inserted_at,o.updated_at,o.company_id,o.currency_id,o.created_by_id,o.audited_by_id,
      coalesce((SELECT sum(i.amount) FROM ${ident(spec.itemTable)} i WHERE i.order_id=o.id),0) AS gross_total,
      coalesce((SELECT sum(i.base_amount) FROM ${ident(spec.itemTable)} i WHERE i.order_id=o.id),0) AS base_gross_total,
      c.name AS company_name,cur.iso_code AS currency_code,cur.name AS currency_name,
      creator.name AS created_by_name,auditor.name AS audited_by_name
    FROM ${ident(spec.headTable)} o
    JOIN bas_company c ON c.id=o.company_id
    JOIN bas_currency cur ON cur.id=o.currency_id
    LEFT JOIN sys_user creator ON creator.id=o.created_by_id
    LEFT JOIN sys_user auditor ON auditor.id=o.audited_by_id
  ) order_heads`
}

export function itemSource(spec: OrderSideSpec): RawBuilder<unknown> {
  const proj = spec.projectionColumn
  // 投影累加列必须用物理列名（shipped_qty/received_qty），供 standard SELECT 物理字段命中
  const extraCols =
    spec.side === 'purchase'
      ? `,i.bom_id,i.demand_line_id,i.demand_date,o.is_outsourced AS order_is_outsourced,
         bom.code AS bom_code,bom.plan_name AS bom_plan_name,d.demand_no`
      : ',null::uuid AS bom_id,null::uuid AS demand_line_id,null::date AS demand_date,false AS order_is_outsourced,null::text AS bom_code,null::text AS bom_plan_name,null::text AS demand_no'
  const joins =
    spec.side === 'purchase'
      ? `LEFT JOIN mfg_bom bom ON bom.id=i.bom_id
         LEFT JOIN mfg_demand_item dl ON dl.id=i.demand_line_id
         LEFT JOIN mfg_demand d ON d.id=dl.demand_id`
      : ''
  const quoteTable = spec.side === 'sales' ? 'sal_quotation_item' : 'pur_quotation_item'
  return sql` FROM (
    SELECT i.id,i.idx,i.qty,i.base_qty,i.${sql.raw(proj)} AS ${sql.raw(proj)},
      (i.base_qty - i.${sql.raw(proj)}) AS remaining_base_qty,i.price,i.amount,
      i.base_price,i.base_amount,i.tax_rate,i.material_code,i.material_name,i.material_spec,
      i.customer_part_no,i.unit_name,i.remarks,i.inserted_at,i.updated_at,i.order_id,i.company_id,
      i.material_id,i.unit_id,i.quotation_item_id,
      o.order_no,o.order_date,o.status AS order_status,o.party_type,o.party_id,
      cur.iso_code AS currency_code,c.name AS company_name,m.name AS material_live_name,
      u.name AS unit_live_name,qi.pricing_mode
      ${sql.raw(extraCols)}
    FROM ${ident(spec.itemTable)} i
    JOIN ${ident(spec.headTable)} o ON o.id=i.order_id
    JOIN bas_company c ON c.id=i.company_id
    JOIN bas_currency cur ON cur.id=o.currency_id
    JOIN inv_material m ON m.id=i.material_id
    JOIN bas_unit u ON u.id=i.unit_id
    LEFT JOIN ${ident(quoteTable)} qi ON qi.id=i.quotation_item_id
    ${sql.raw(joins)}
  ) order_items`
}

/** 条目投影 join 列（物理列 + calculated 之外；mapExtra 消费） */
export function itemSelectExtra(spec: OrderSideSpec): RawBuilder<unknown> {
  if (spec.side === 'purchase') {
    return sql`remaining_base_qty, order_no, order_date, order_status, party_type, party_id, currency_code, company_name, material_live_name, unit_live_name, pricing_mode, bom_code, bom_plan_name, demand_no, order_is_outsourced`
  }
  return sql`remaining_base_qty, order_no, order_date, order_status, party_type, party_id, currency_code, company_name, material_live_name, unit_live_name, pricing_mode`
}

export function headExtras(row: Record<string, unknown>): Record<string, unknown> {
  const companyId = String(row.company_id)
  const currencyId = String(row.currency_id)
  const createdById = row.created_by_id ? String(row.created_by_id) : null
  const auditedById = row.audited_by_id ? String(row.audited_by_id) : null
  return {
    isOutsourced: Boolean(row.is_outsourced),
    grossTotal: wireRequiredDecimal(String(row.gross_total ?? 0)),
    baseGrossTotal: wireRequiredDecimal(String(row.base_gross_total ?? 0)),
    company: namedRef(companyId, String(row.company_name)),
    currency: codeNamedRef(currencyId, String(row.currency_code), String(row.currency_name)),
    createdBy: createdById ? namedRef(createdById, String(row.created_by_name ?? '')) : null,
    auditedBy: auditedById ? namedRef(auditedById, String(row.audited_by_name ?? '')) : null,
    auditedAt: asDateTime(row.audited_at),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
  }
}

export function itemExtras(side: TradingSide, row: Record<string, unknown>): Record<string, unknown> {
  const companyId = String(row.company_id)
  const materialId = String(row.material_id)
  const unitId = String(row.unit_id)
  const orderId = String(row.order_id)
  const projCol = side === 'sales' ? 'shipped_qty' : 'received_qty'
  const projection = wireRequiredDecimal(String(row[projCol] ?? 0))
  const remaining = wireRequiredDecimal(String(row.remaining_base_qty ?? 0))
  const extra: Record<string, unknown> = {
    remainingBaseQty: remaining,
    orderNo: String(row.order_no),
    orderDate: asDate(row.order_date),
    orderStatus: upperStatus(String(row.order_status)),
    partyType: upperStatus(String(row.party_type)),
    partyId: String(row.party_id),
    currencyCode: String(row.currency_code),
    pricingMode: row.pricing_mode ? upperStatus(String(row.pricing_mode)) : null,
    order: { id: orderId, orderNo: String(row.order_no) },
    company: namedRef(companyId, String(row.company_name)),
    material: codeNamedRef(
      materialId,
      String(row.material_code),
      String(row.material_live_name ?? row.material_name),
    ),
    unit: namedRef(unitId, String(row.unit_live_name ?? row.unit_name)),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
  }
  if (side === 'sales') {
    extra.shippedQty = projection
  } else {
    extra.receivedQty = projection
    extra.bomId = row.bom_id ? String(row.bom_id) : null
    extra.bomCode = asOptionalString(row.bom_code)
    extra.bomPlanName = asOptionalString(row.bom_plan_name)
    extra.demandLineId = row.demand_line_id ? String(row.demand_line_id) : null
    extra.demandNo = asOptionalString(row.demand_no)
    extra.demandDate = row.demand_date ? asDate(row.demand_date) : null
    extra.orderIsOutsourced = Boolean(row.order_is_outsourced)
  }
  return extra
}

export function presentHead(row: Record<string, unknown>): Order {
  return row as Order
}

export function presentItem(row: Record<string, unknown>): OrderItem {
  return row as OrderItem
}
