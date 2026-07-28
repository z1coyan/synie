/**
 * 订单履约投影：审核发货/入库时累加 shipped_qty/received_qty，作废回滚；含超发/超收容差。
 * 委外发料：累加 pur_order_item_material.issued_qty（超发不硬拦）。
 * 调用方持有 trx；本模块不自起事务。
 */
import { decimal, type Decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { ident, lowerParty, type TradingSide, wireRequiredDecimal } from '../common.ts'
import { orderSpec } from './spec.ts'

export interface FulfillmentLine {
  orderItemId: string
  baseQty: Decimal | string
}

export interface FulfillmentInput {
  companyId: string
  partyType: string
  partyId: string
  lines: FulfillmentLine[]
  /**
   * 委外入库传 true：只接受 is_outsourced 订单；标准采购入库不传（普通/委外均可）。
   * 对齐 Go FulfillmentInput.RequireOutsourced。
   */
  requireOutsourced?: boolean | null
}

export interface OutsourcedIssueLine {
  orderItemMaterialId: string
  baseQty: Decimal | string
}

export interface OutsourcedIssueInput {
  companyId: string
  partyType: string
  partyId: string
  lines: OutsourcedIssueLine[]
}

export async function postFulfillment(
  db: DbHandle,
  side: TradingSide,
  input: FulfillmentInput,
): Promise<void> {
  return adjustFulfillment(db, side, input, decimal(1), true)
}

export async function reverseFulfillment(
  db: DbHandle,
  side: TradingSide,
  input: FulfillmentInput,
): Promise<void> {
  return adjustFulfillment(db, side, input, decimal(-1), false)
}

/** 委外发料审核：累加发料清单行已发料量（材料默认单位；超发不硬拦） */
export async function postOutsourcedIssue(db: DbHandle, input: OutsourcedIssueInput): Promise<void> {
  return adjustOutsourcedIssue(db, input, decimal(1), true)
}

/** 委外发料作废：回滚已发料量 */
export async function reverseOutsourcedIssue(
  db: DbHandle,
  input: OutsourcedIssueInput,
): Promise<void> {
  return adjustOutsourcedIssue(db, input, decimal(-1), false)
}

/** 可履约上限 = baseQty × (1 + 容差比例)；供单测与实现共用 */
export function maxFulfillableQty(baseQty: Decimal | string, overshipRatio: Decimal | string): Decimal {
  return decimal(baseQty).mul(decimal(1).add(decimal(overshipRatio)))
}

async function adjustFulfillment(
  db: DbHandle,
  side: TradingSide,
  input: FulfillmentInput,
  direction: Decimal,
  verify: boolean,
): Promise<void> {
  const spec = orderSpec(side)
  const grouped = new Map<string, Decimal>()
  for (const line of input.lines) {
    const q = decimal(line.baseQty)
    if (!q.isPositive() && verify) {
      throw new ApiError('conflict', '履约数量必须大于零')
    }
    grouped.set(line.orderItemId, (grouped.get(line.orderItemId) ?? decimal(0)).add(q))
  }
  if (grouped.size === 0) return

  // lock order heads first (sorted), then items
  const itemIds = [...grouped.keys()].sort()
  const orderIds = new Set<string>()
  const itemOrder = new Map<string, string>()
  const outsourcedCol =
    side === 'purchase' ? 'o.is_outsourced' : 'false'
  for (const itemId of itemIds) {
    const row = await sql<{
      order_id: string
      company_id: string
      party_type: string
      party_id: string
      status: string
      is_outsourced: boolean
    }>`
      SELECT oi.order_id, o.company_id, o.party_type, o.party_id, o.status,
        ${sql.raw(outsourcedCol)} AS is_outsourced
      FROM ${ident(spec.itemTable)} oi
      JOIN ${ident(spec.headTable)} o ON o.id = oi.order_id
      WHERE oi.id = ${itemId}::uuid
      FOR UPDATE OF o, oi
    `.execute(db)
    const r = row.rows[0]
    if (!r) throw new ApiError('conflict', '来源订单条目不存在')
    if (r.company_id !== input.companyId) {
      throw new ApiError('conflict', '履约公司与订单不一致')
    }
    // EqualFold：对齐 Go strings.EqualFold（库内可能存 CUSTOMER / customer）
    if (lowerParty(r.party_type) !== lowerParty(input.partyType) || r.party_id !== input.partyId) {
      throw new ApiError('conflict', '履约对手与订单不一致')
    }
    if (verify && r.status.toLowerCase() !== 'audited') {
      throw new ApiError('conflict', '仅已审核订单可履约')
    }
    if (
      input.requireOutsourced !== undefined &&
      input.requireOutsourced !== null &&
      Boolean(r.is_outsourced) !== input.requireOutsourced
    ) {
      throw new ApiError('conflict', '来源订单委外类型与履约单不匹配')
    }
    orderIds.add(r.order_id)
    itemOrder.set(itemId, r.order_id)
  }

  let ratio = decimal(0)
  if (verify) {
    const col = side === 'sales' ? 'delivery_overship_ratio' : 'receipt_overreceive_ratio'
    const r = await sql<{ ratio: string }>`
      SELECT ${sql.raw(col)}::text AS ratio FROM sal_setting LIMIT 1
    `.execute(db)
    ratio = decimal(r.rows[0]?.ratio ?? '0')
  }

  const projCol = spec.projectionColumn
  const demandDeltas = new Map<string, Decimal>()
  for (const itemId of itemIds) {
    const demandSelect =
      side === 'purchase' ? 'demand_line_id::text AS demand_line_id' : 'NULL::text AS demand_line_id'
    const row = await sql<{ base_qty: string; projected: string; demand_line_id: string | null }>`
      SELECT base_qty::text AS base_qty, ${sql.raw(projCol)}::text AS projected, ${sql.raw(demandSelect)}
      FROM ${ident(spec.itemTable)} WHERE id = ${itemId}::uuid FOR UPDATE
    `.execute(db)
    const r = row.rows[0]
    if (!r) throw new ApiError('conflict', '来源订单条目不存在')
    const delta = grouped.get(itemId)!.mul(direction)
    const next = decimal(r.projected).add(delta)
    if (next.isNegative()) {
      throw new ApiError('conflict', '订单履约投影不能为负')
    }
    if (verify && next.gt(maxFulfillableQty(r.base_qty, ratio))) {
      throw new ApiError('conflict', '超出订单条目可履约数量')
    }
    await sql`
      UPDATE ${ident(spec.itemTable)}
      SET ${sql.raw(projCol)} = ${wireRequiredDecimal(next)},
          updated_at = (now() AT TIME ZONE 'utc')
      WHERE id = ${itemId}::uuid
    `.execute(db)
    if (r.demand_line_id) {
      demandDeltas.set(
        r.demand_line_id,
        (demandDeltas.get(r.demand_line_id) ?? decimal(0)).add(delta),
      )
    }
  }
  if (side === 'purchase' && demandDeltas.size > 0) {
    await adjustDemandReceived(db, demandDeltas)
  }
}

async function adjustOutsourcedIssue(
  db: DbHandle,
  input: OutsourcedIssueInput,
  direction: Decimal,
  verify: boolean,
): Promise<void> {
  const grouped = new Map<string, Decimal>()
  for (const line of input.lines) {
    const q = decimal(line.baseQty)
    if (!q.isPositive() && verify) {
      throw new ApiError('conflict', '履约数量必须大于零')
    }
    grouped.set(
      line.orderItemMaterialId,
      (grouped.get(line.orderItemMaterialId) ?? decimal(0)).add(q),
    )
  }
  if (grouped.size === 0) return

  const materialIds = [...grouped.keys()].sort()
  const itemOrders = new Map<string, string>()
  const orderSet = new Set<string>()
  for (const materialId of materialIds) {
    const row = await sql<{ order_id: string }>`
      SELECT i.order_id
      FROM pur_order_item_material m
      JOIN pur_order_item i ON i.id = m.order_item_id
      WHERE m.id = ${materialId}::uuid
    `.execute(db)
    const r = row.rows[0]
    if (!r) throw new ApiError('conflict', '来源发料清单行不存在')
    itemOrders.set(materialId, r.order_id)
    orderSet.add(r.order_id)
  }

  const orderIds = [...orderSet].sort()
  for (const orderId of orderIds) {
    const row = await sql<{
      status: string
      is_outsourced: boolean
      company_id: string
      party_type: string
      party_id: string
    }>`
      SELECT status, is_outsourced, company_id, party_type, party_id
      FROM pur_order WHERE id = ${orderId}::uuid FOR UPDATE
    `.execute(db)
    const r = row.rows[0]
    if (!r) throw new ApiError('conflict', '来源委外采购订单与发料单不匹配')
    if (verify && r.status.toLowerCase() !== 'audited') {
      throw new ApiError('conflict', '来源委外采购订单须为已审核')
    }
    if (
      !r.is_outsourced ||
      r.company_id !== input.companyId ||
      lowerParty(r.party_type) !== lowerParty(input.partyType) ||
      r.party_id !== input.partyId
    ) {
      throw new ApiError('conflict', '来源委外采购订单与发料单不匹配')
    }
  }

  for (const materialId of materialIds) {
    const row = await sql<{ order_id: string; issued_qty: string }>`
      SELECT i.order_id, m.issued_qty::text AS issued_qty
      FROM pur_order_item_material m
      JOIN pur_order_item i ON i.id = m.order_item_id
      WHERE m.id = ${materialId}::uuid
      FOR UPDATE OF m
    `.execute(db)
    const r = row.rows[0]
    if (!r) throw new ApiError('conflict', '来源发料清单行不存在')
    if (itemOrders.get(materialId) !== r.order_id) {
      throw new ApiError('conflict', '来源发料清单行已变化')
    }
    const next = decimal(r.issued_qty).add(grouped.get(materialId)!.mul(direction))
    if (next.isNegative()) {
      throw new ApiError('conflict', '订单发料投影不能为负')
    }
    await sql`
      UPDATE pur_order_item_material
      SET issued_qty = ${wireRequiredDecimal(next)},
          updated_at = (now() AT TIME ZONE 'utc')
      WHERE id = ${materialId}::uuid
    `.execute(db)
  }
}

/** 采购入库投影同步 mfg_demand_item.received_qty（对齐 Go adjustDemandReceived） */
async function adjustDemandReceived(db: DbHandle, deltas: Map<string, Decimal>): Promise<void> {
  const lineIds = [...deltas.keys()].sort()
  for (const lineId of lineIds) {
    const row = await sql<{ base_qty: string; received_qty: string }>`
      SELECT base_qty::text AS base_qty, received_qty::text AS received_qty
      FROM mfg_demand_item WHERE id = ${lineId}::uuid FOR UPDATE
    `.execute(db)
    const r = row.rows[0]
    if (!r) throw new ApiError('conflict', '来源履约需求行不存在')
    const next = decimal(r.received_qty).add(deltas.get(lineId)!)
    if (next.isNegative()) {
      throw new ApiError('conflict', '需求已收投影不能为负')
    }
    const status = next.gte(decimal(r.base_qty)) ? 'completed' : 'pending'
    await sql`
      UPDATE mfg_demand_item
      SET received_qty = ${wireRequiredDecimal(next)},
          status = ${status},
          updated_at = (now() AT TIME ZONE 'utc')
      WHERE id = ${lineId}::uuid
    `.execute(db)
  }
}
