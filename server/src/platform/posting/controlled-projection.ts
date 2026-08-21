/**
 * 受控投影增量累加器（platform/posting · W0 领域基元）
 *
 * 5 个增量累加器（排序锁 + FOR UPDATE + 负数守卫 + 容差闸门内置）：
 * 1. 已发 — `sal_order_item.shipped_qty`（销售履约）
 * 2. 已收 — `pur_order_item.received_qty` + `mfg_demand_item.received_qty`（采购履约链）
 * 3. 已对账 — 发货/入库/委外入库行 `reconciled_qty`
 * 4. 已安排相关 — `mfg_demand_item.ordered_qty`；委外发料清单 `issued_qty`
 * 5. 工单入库 — `mfg_work_order.received_base_qty`
 *
 * `afterAdjust` 解环（D11）：实现处不 import manufacturing；
 * 需要倒写需求安排投影时由调用方注入 `recomputeDemandItemProjections`。
 * **不并** `recomputeDemandItemProjections`（重算式语义独立）。
 *
 * platform 自带 SQL，禁止 import `~/modules/*`。
 */
import { decimal, toDecimalString, type Decimal } from '@synie/shared'
import { sql } from 'kysely'
import { ident } from '~/db/ident.ts'
import type { DbHandle } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { lowerParty } from '~/platform/posting/text.ts'

// ---------------------------------------------------------------------------
// 公共原语
// ---------------------------------------------------------------------------

/** 单行投影调整完成后的领域副作用（可选） */
export type AfterAdjust = (
  db: DbHandle,
  ctx: {
    /** 被锁并更新的投影行主键（订单条目 / 需求行 / 工单等） */
    rowId: string
    /** 调整后的投影数量 */
    next: Decimal
    /** +1 审核累加 / −1 作废回滚（与现有 direction 一致） */
    direction: 1 | -1
  },
) => Promise<void>

function wireRequiredDecimal(value: Decimal | string | number): string {
  return toDecimalString(decimal(value))
}

/** 可履约上限 = baseQty × (1 + 容差比例)；供单测与实现共用 */
export function maxFulfillableQty(
  baseQty: Decimal | string,
  overshipRatio: Decimal | string,
): Decimal {
  return decimal(baseQty).mul(decimal(1).add(decimal(overshipRatio)))
}

export type TradingSide = 'sales' | 'purchase'

// ---------------------------------------------------------------------------
// 1+2 已发 / 已收：订单履约投影（shipped_qty / received_qty）
// ---------------------------------------------------------------------------

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
   */
  requireOutsourced?: boolean | null
}

export interface ControlledProjectionOptions {
  /**
   * 投影列 UPDATE 成功后、进入下一行之前调用。
   * 履约已收路径：`rowId` = `mfg_demand_item.id`。
   * 工单入库路径：`rowId` = `demandItemId`（重算键是需求行）。
   */
  afterAdjust?: AfterAdjust
  /**
   * 跳过「订单条目→需求行」已收回写（采购退货定案：需求行已完成/已收不随退货反转，
   * 只动订单条目 received_qty 投影；见 ADR 2026-08-09）。
   */
  skipDemandChain?: boolean
  /**
   * 覆盖 verify 默认（post=true/reverse=false）：退货作废加回已发/已收时传 false——
   * 加回不重验「订单已审核」与超发/超收上限（订单可能已关闭、缺口可能已被重发填满）。
   */
  verify?: boolean
}

const ORDER_FULFILLMENT: Record<
  TradingSide,
  {
    headTable: string
    itemTable: string
    projectionColumn: string
    ratioColumn: string
  }
> = {
  sales: {
    headTable: 'sal_order',
    itemTable: 'sal_order_item',
    projectionColumn: 'shipped_qty',
    ratioColumn: 'delivery_overship_ratio',
  },
  purchase: {
    headTable: 'pur_order',
    itemTable: 'pur_order_item',
    projectionColumn: 'received_qty',
    ratioColumn: 'receipt_overreceive_ratio',
  },
}

export async function postFulfillment(
  db: DbHandle,
  side: TradingSide,
  input: FulfillmentInput,
  options?: ControlledProjectionOptions,
): Promise<void> {
  return adjustFulfillment(db, side, input, decimal(1), options?.verify ?? true, options)
}

export async function reverseFulfillment(
  db: DbHandle,
  side: TradingSide,
  input: FulfillmentInput,
  options?: ControlledProjectionOptions,
): Promise<void> {
  return adjustFulfillment(db, side, input, decimal(-1), false, options)
}

async function adjustFulfillment(
  db: DbHandle,
  side: TradingSide,
  input: FulfillmentInput,
  direction: Decimal,
  verify: boolean,
  options?: ControlledProjectionOptions,
): Promise<void> {
  const spec = ORDER_FULFILLMENT[side]
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
  const outsourcedCol = side === 'purchase' ? 'o.is_outsourced' : 'false'
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
  }

  let ratio = decimal(0)
  if (verify) {
    const r = await sql<{ ratio: string }>`
      SELECT ${sql.raw(spec.ratioColumn)}::text AS ratio FROM sal_setting LIMIT 1
    `.execute(db)
    ratio = decimal(r.rows[0]?.ratio ?? '0')
  }

  const projCol = spec.projectionColumn
  const demandDeltas = new Map<string, Decimal>()
  const dirSign: 1 | -1 = direction.isNegative() ? -1 : 1
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
  if (side === 'purchase' && demandDeltas.size > 0 && options?.skipDemandChain !== true) {
    await adjustDemandReceivedQty(db, demandDeltas, {
      afterAdjust: options?.afterAdjust,
      direction: dirSign,
    })
  }
}

// ---------------------------------------------------------------------------
// 2 续 · 需求已收（mfg_demand_item.received_qty）
// ---------------------------------------------------------------------------

/**
 * 采购入库同步 `mfg_demand_item.received_qty`。
 * 状态/已完成量由调用方 `afterAdjust` 注入的 recompute 负责（不在此硬改 status）。
 */
export async function adjustDemandReceivedQty(
  db: DbHandle,
  deltas: Map<string, Decimal>,
  options?: ControlledProjectionOptions & { direction?: 1 | -1 },
): Promise<void> {
  const lineIds = [...deltas.keys()].sort()
  const direction: 1 | -1 = options?.direction ?? 1
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
    await sql`
      UPDATE mfg_demand_item
      SET received_qty = ${wireRequiredDecimal(next)},
          updated_at = (now() AT TIME ZONE 'utc')
      WHERE id = ${lineId}::uuid
    `.execute(db)
    if (options?.afterAdjust) {
      await options.afterAdjust(db, { rowId: lineId, next, direction })
    }
  }
}

// ---------------------------------------------------------------------------
// 3 已对账 — reconciled_qty
// ---------------------------------------------------------------------------

/**
 * 对账单生效/回退时，按对账行汇总 Δ 累加来源条目 `reconciled_qty`。
 * `side` 决定读 sal/pur 对账表；`direction` +1 占量 / −1 回滚。
 */
export async function adjustReconciledProjection(
  db: DbHandle,
  side: TradingSide,
  reconciliationId: string,
  direction: number,
): Promise<void> {
  type Proj = { id: string; delta: string; outsourced: boolean; returnItem?: boolean; idx: string }
  let rows: Proj[]
  if (side === 'sales') {
    // 双来源同池：发货条目或销售退货条目（恰一）；退货行 base_qty 存正，占量口径一致
    const r = await sql<Proj>`
      SELECT COALESCE(delivery_item_id, return_item_id)::text AS id, SUM(base_qty)::text AS delta,
        false AS outsourced, (return_item_id IS NOT NULL) AS "returnItem", MIN(idx)::text AS idx
      FROM sal_reconciliation_item WHERE reconciliation_id=${reconciliationId}::uuid
      GROUP BY delivery_item_id, return_item_id
    `.execute(db)
    rows = r.rows
  } else {
    // 三来源同池：采购入库/委外入库/采购退货条目（恰一）；委外退货为纯数量单不进池
    const r = await sql<Proj>`
      SELECT COALESCE(receipt_item_id, outsourced_receipt_item_id, return_item_id)::text AS id,
        SUM(base_qty)::text AS delta,
        (outsourced_receipt_item_id IS NOT NULL) AS outsourced,
        (return_item_id IS NOT NULL) AS "returnItem",
        MIN(idx)::text AS idx
      FROM pur_reconciliation_item WHERE reconciliation_id=${reconciliationId}::uuid
      GROUP BY receipt_item_id, outsourced_receipt_item_id, return_item_id
    `.execute(db)
    rows = r.rows
  }
  rows.sort((a, b) => a.id.localeCompare(b.id))
  for (const value of rows) {
    const delta = decimal(value.delta).mul(direction)
    if (value.returnItem) {
      // 退货条目（销售/采购同构）：母单须已审核未作废；守卫 0 ≤ reconciled+Δ ≤ base_qty
      const returnTable = side === 'sales' ? 'sal_return_item' : 'pur_return_item'
      const returnHeadTable = side === 'sales' ? 'sal_return' : 'pur_return'
      const parent = await sql<{ status: string }>`
        SELECT h.status FROM ${sql.raw(returnTable)} i
        JOIN ${sql.raw(returnHeadTable)} h ON h.id=i.return_id
        WHERE i.id=${value.id}::uuid FOR UPDATE OF h,i
      `.execute(db)
      if (!parent.rows[0]) throw new ApiError('conflict', '对账来源条目不存在')
      if (parent.rows[0].status !== 'audited') {
        throw new ApiError('conflict', '仅已审核且未作废来源条目可对账')
      }
      const tag = await sql`
        UPDATE ${sql.raw(returnTable)} SET
          reconciled_qty=reconciled_qty+${wireRequiredDecimal(delta)},
          updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${value.id}::uuid
          AND reconciled_qty+${wireRequiredDecimal(delta)}>=0
          AND reconciled_qty+${wireRequiredDecimal(delta)}<=base_qty
      `.execute(db)
      if (Number(tag.numAffectedRows ?? 0) !== 1) {
        throw new ApiError('conflict', `第${value.idx}行超出剩余可对账量`)
      }
      continue
    }
    if (value.outsourced) {
      const parent = await sql<{ receipt_id: string }>`
        SELECT receipt_id FROM pur_outsourced_receipt_item WHERE id=${value.id}::uuid
      `.execute(db)
      if (!parent.rows[0]) throw new ApiError('conflict', '对账来源条目不存在')
      const status = await sql<{ status: string }>`
        SELECT status FROM pur_outsourced_receipt WHERE id=${parent.rows[0].receipt_id}::uuid FOR UPDATE
      `.execute(db)
      if (status.rows[0]?.status !== 'audited') {
        throw new ApiError('conflict', '仅已审核委外入库行可对账')
      }
      const item = await sql<{ base_qty: string; reconciled_qty: string }>`
        SELECT base_qty::text, reconciled_qty::text
        FROM pur_outsourced_receipt_item WHERE id=${value.id}::uuid FOR UPDATE
      `.execute(db)
      if (!item.rows[0]) throw new ApiError('conflict', '对账来源条目不存在')
      const next = decimal(item.rows[0].reconciled_qty).add(delta)
      if (next.isNegative() || next.gt(decimal(item.rows[0].base_qty))) {
        throw new ApiError('conflict', '超出剩余可对账量')
      }
      await sql`
        UPDATE pur_outsourced_receipt_item SET
          reconciled_qty=reconciled_qty+${wireRequiredDecimal(delta)},
          updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${value.id}::uuid
          AND reconciled_qty+${wireRequiredDecimal(delta)}>=0
          AND reconciled_qty+${wireRequiredDecimal(delta)}<=base_qty
      `.execute(db)
      continue
    }
    const table = side === 'sales' ? 'sal_delivery_item' : 'pur_receipt_item'
    const parentTable = side === 'sales' ? 'sal_delivery' : 'pur_receipt'
    const parentFK = side === 'sales' ? 'delivery_id' : 'receipt_id'
    const parent = await sql<{ status: string }>`
      SELECT h.status FROM ${sql.raw(table)} i
      JOIN ${sql.raw(parentTable)} h ON h.id=i.${sql.raw(parentFK)}
      WHERE i.id=${value.id}::uuid FOR UPDATE OF h,i
    `.execute(db)
    if (!parent.rows[0]) throw new ApiError('conflict', '对账来源条目不存在')
    if (parent.rows[0].status !== 'audited') {
      throw new ApiError('conflict', '仅已审核且未作废来源条目可对账')
    }
    const tag = await sql`
      UPDATE ${sql.raw(table)} SET
        reconciled_qty=reconciled_qty+${wireRequiredDecimal(delta)},
        updated_at=(now() AT TIME ZONE 'utc')
      WHERE id=${value.id}::uuid
        AND reconciled_qty+${wireRequiredDecimal(delta)}>=0
        AND reconciled_qty+${wireRequiredDecimal(delta)}<=base_qty
    `.execute(db)
    if (Number(tag.numAffectedRows ?? 0) !== 1) {
      throw new ApiError('conflict', `第${value.idx}行超出剩余可对账量`)
    }
  }
}

// ---------------------------------------------------------------------------
// 4 已安排相关 — ordered_qty + 委外发料 issued_qty
// ---------------------------------------------------------------------------

/** 采购链投影：调整已下单数量（排序/单行 FOR UPDATE + 负数守卫） */
export async function adjustDemandOrdered(
  db: DbHandle,
  id: string,
  delta: string | number,
  options?: ControlledProjectionOptions,
): Promise<void> {
  const row = await sql<{ ordered_qty: string }>`
    SELECT ordered_qty::text AS ordered_qty
    FROM mfg_demand_item WHERE id = ${id}::uuid FOR UPDATE
  `.execute(db)
  const r = row.rows[0]
  if (!r) throw new ApiError('not_found', '需求行不存在')
  const next = decimal(r.ordered_qty).add(delta)
  if (next.isNegative()) {
    throw new ApiError('conflict', '已下单数量不能为负')
  }
  await sql`
    UPDATE mfg_demand_item
    SET ordered_qty = ${wireRequiredDecimal(next)},
        updated_at = (now() AT TIME ZONE 'utc')
    WHERE id = ${id}::uuid
  `.execute(db)
  if (options?.afterAdjust) {
    const direction: 1 | -1 = decimal(delta).isNegative() ? -1 : 1
    await options.afterAdjust(db, { rowId: id, next, direction })
  }
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

/** 委外发料审核：累加发料清单行已发料量（材料默认单位；超发不硬拦） */
export async function postOutsourcedIssue(
  db: DbHandle,
  input: OutsourcedIssueInput,
): Promise<void> {
  return adjustOutsourcedIssue(db, input, decimal(1), true)
}

/** 委外发料作废：回滚已发料量 */
export async function reverseOutsourcedIssue(
  db: DbHandle,
  input: OutsourcedIssueInput,
): Promise<void> {
  return adjustOutsourcedIssue(db, input, decimal(-1), false)
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

// ---------------------------------------------------------------------------
// 5 工单入库 — mfg_work_order.received_base_qty
// ---------------------------------------------------------------------------

export interface WorkOrderReceivedLine {
  workOrderId: string
  /** 重算键：需求行 id（afterAdjust.rowId） */
  demandItemId: string
  baseQty: Decimal | string
  receivedBaseQty: Decimal | string
  /** 本批绝对增量（方向由 direction 施加） */
  addQty: Decimal | string
}

/**
 * 生产入库审核/作废：累加工单 `received_base_qty` 并按是否达量翻转 in_progress/completed。
 * `afterAdjust.rowId` = demandItemId（与既有 recompute 调用一致）。
 */
export async function adjustWorkOrderReceived(
  db: DbHandle,
  lines: readonly WorkOrderReceivedLine[],
  direction: 1 | -1,
  options?: ControlledProjectionOptions,
): Promise<void> {
  const sorted = [...lines].sort((a, b) => a.workOrderId.localeCompare(b.workOrderId))
  for (const line of sorted) {
    const next = decimal(line.receivedBaseQty).add(decimal(line.addQty).mul(direction))
    if (next.isNegative()) {
      throw new ApiError('conflict', '生产工单已入数量不能为负')
    }
    let orderStatus = 'in_progress'
    if (!next.lt(decimal(line.baseQty))) {
      orderStatus = 'completed'
    }
    await sql`
      UPDATE mfg_work_order
      SET received_base_qty = ${wireRequiredDecimal(next)},
          status = ${orderStatus},
          updated_at = (now() AT TIME ZONE 'utc')
      WHERE id = ${line.workOrderId}::uuid
    `.execute(db)
    if (options?.afterAdjust) {
      await options.afterAdjust(db, {
        rowId: line.demandItemId,
        next,
        direction,
      })
    }
  }
}
