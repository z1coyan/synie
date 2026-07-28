/**
 * 订单履约投影：审核发货/入库时累加 shipped_qty/received_qty，作废回滚；含超发/超收容差。
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
  for (const itemId of itemIds) {
    const row = await sql<{ order_id: string; company_id: string; party_type: string; party_id: string; status: string }>`
      SELECT oi.order_id, o.company_id, o.party_type, o.party_id, o.status
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
    if (r.party_type !== lowerParty(input.partyType) || r.party_id !== input.partyId) {
      throw new ApiError('conflict', '履约对手与订单不一致')
    }
    if (verify && r.status.toLowerCase() !== 'audited') {
      throw new ApiError('conflict', '仅已审核订单可履约')
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
  for (const itemId of itemIds) {
    const row = await sql<{ base_qty: string; projected: string }>`
      SELECT base_qty::text AS base_qty, ${sql.raw(projCol)}::text AS projected
      FROM ${ident(spec.itemTable)} WHERE id = ${itemId}::uuid FOR UPDATE
    `.execute(db)
    const r = row.rows[0]
    if (!r) throw new ApiError('conflict', '来源订单条目不存在')
    const delta = grouped.get(itemId)!.mul(direction)
    const next = decimal(r.projected).add(delta)
    if (next.isNegative()) {
      throw new ApiError('conflict', '订单履约投影不能为负')
    }
    if (verify && next.gt(decimal(r.base_qty).mul(decimal(1).add(ratio)))) {
      throw new ApiError('conflict', '超出订单条目可履约数量')
    }
    await sql`
      UPDATE ${ident(spec.itemTable)}
      SET ${sql.raw(projCol)} = ${wireRequiredDecimal(next)},
          updated_at = (now() AT TIME ZONE 'utc')
      WHERE id = ${itemId}::uuid
    `.execute(db)
  }
}
