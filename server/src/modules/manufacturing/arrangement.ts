/**
 * 履约安排：占量投影、剩余可安排、完成判定、手工库存/关闭安排
 */
import { decimal, toDecimalString } from '@synie/shared'
import { sql } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { ArrangementType, DemandItem } from './types.ts'
import { numStr, parsePositiveQty } from './helpers.ts'

export function remainingArrangeableBase(
  demandBase: string,
  arrangedBase: string,
  overArrangeRatio = '0',
): string {
  const cap = decimal(demandBase).mul(decimal(1).add(decimal(overArrangeRatio)))
  const rem = cap.sub(decimal(arrangedBase))
  return toDecimalString(rem.gt(0) ? rem : decimal(0))
}

export function hardRemainingArrangeable(demandBase: string, arrangedBase: string): string {
  const rem = decimal(demandBase).sub(decimal(arrangedBase))
  return toDecimalString(rem.gt(0) ? rem : decimal(0))
}

export function isDemandItemFulfilled(
  demandBase: string,
  arrangedBase: string,
  completedBase: string,
  overArrangeRatio = '0',
): boolean {
  const rem = remainingArrangeableBase(demandBase, arrangedBase, overArrangeRatio)
  return !decimal(rem).gt(0) && decimal(completedBase).gte(decimal(demandBase))
}

export async function loadOverArrangeRatio(db: DbHandle): Promise<string> {
  const row = await db
    .selectFrom('sal_setting')
    .select('demand_overorder_ratio')
    .executeTakeFirst()
  if (!row) return '0'
  return toDecimalString(decimal(String(row.demand_overorder_ratio)))
}

/** 从安排事实重算投影并刷新行状态 */
export async function recomputeDemandItemProjections(
  db: DbHandle,
  demandItemId: string,
): Promise<void> {
  const item = await db
    .selectFrom('mfg_demand_item')
    .select(['id', 'base_qty', 'status'])
    .where('id', '=', demandItemId)
    .forUpdate()
    .executeTakeFirst()
  if (!item) throw new ApiError('not_found', '需求行不存在')

  const sumRow = await sql<{
    arranged: string
    completed_manual: string
  }>`
    SELECT
      coalesce(sum(base_qty), 0)::text AS arranged,
      coalesce(sum(base_qty) FILTER (
        WHERE arrangement_type IN ('stock', 'close')
      ), 0)::text AS completed_manual
    FROM mfg_demand_arrangement
    WHERE demand_item_id = ${demandItemId}
  `.execute(db)

  // 生产入库完成量经工单；采购/委外已收在 item.received_qty
  const mfgDone = await sql<{ qty: string }>`
    SELECT coalesce(sum(wo.received_base_qty), 0)::text AS qty
    FROM mfg_work_order wo
    WHERE wo.demand_item_id = ${demandItemId} AND wo.status <> 'voided'
  `.execute(db)

  const itemExtras = await db
    .selectFrom('mfg_demand_item')
    .select(['ordered_qty', 'received_qty'])
    .where('id', '=', demandItemId)
    .executeTakeFirstOrThrow()

  const arranged = decimal(sumRow.rows[0]?.arranged ?? '0')
  const completed = decimal(mfgDone.rows[0]?.qty ?? '0')
    .add(decimal(String(itemExtras.received_qty)))
    .add(decimal(sumRow.rows[0]?.completed_manual ?? '0'))

  const ratio = await loadOverArrangeRatio(db)
  const fulfilled = isDemandItemFulfilled(
    String(item.base_qty),
    toDecimalString(arranged),
    toDecimalString(completed),
    ratio,
  )

  // 库内小写状态（DemandItemStatus 为 wire 大写，写库时用小写字面量）
  let nextStatus: 'pending' | 'scheduled' | 'completed'
  if (fulfilled) {
    nextStatus = 'completed'
  } else if (arranged.gt(0)) {
    nextStatus = 'scheduled'
  } else {
    nextStatus = 'pending'
  }

  await db
    .updateTable('mfg_demand_item')
    .set({
      arranged_qty: toDecimalString(arranged),
      completed_qty: toDecimalString(completed),
      status: nextStatus,
      updated_at: sql`(now() AT TIME ZONE 'utc')`,
    })
    .where('id', '=', demandItemId)
    .execute()
}

export async function assertCanArrange(
  db: DbHandle,
  demandItemId: string,
  addBaseQty: string,
  opts: { closeHardCap?: boolean } = {},
): Promise<void> {
  const item = await db
    .selectFrom('mfg_demand_item')
    .select(['base_qty', 'arranged_qty', 'status'])
    .where('id', '=', demandItemId)
    .forUpdate()
    .executeTakeFirst()
  if (!item) throw new ApiError('not_found', '需求行不存在')
  if (item.status === 'completed') {
    throw new ApiError('conflict', '已完成需求行不可再安排')
  }
  const ratio = opts.closeHardCap ? '0' : await loadOverArrangeRatio(db)
  const rem = remainingArrangeableBase(
    String(item.base_qty),
    String(item.arranged_qty),
    ratio,
  )
  if (decimal(addBaseQty).gt(decimal(rem))) {
    throw new ApiError(
      'conflict',
      opts.closeHardCap
        ? '关闭数量不能超过剩余可安排'
        : '已安排数量超过需求超安排比例允许上限',
    )
  }
}

/** 手工库存/关闭安排（录入数量按行单位，折 base） */
export async function createManualArrangement(
  db: DbHandle,
  input: {
    demandItemId: string
    companyId: string
    type: 'stock' | 'close'
    qty: string
    unitBaseQtyPerUnit: string
    remarks?: string | null
  },
): Promise<{ id: string; baseQty: string }> {
  const qty = parsePositiveQty(input.qty, 'qty')
  const baseQty = toDecimalString(decimal(qty).mul(decimal(input.unitBaseQtyPerUnit)))
  if (input.type === 'stock') {
    // 库存安排=从库存履约，仅库存类物料可做（需求行本身不限类型）
    const row = await sql<{ material_type: string }>`
      SELECT m.material_type
      FROM mfg_demand_item di
      JOIN inv_material m ON m.id = di.material_id
      WHERE di.id = ${input.demandItemId}::uuid
    `.execute(db)
    if (row.rows[0] && row.rows[0].material_type !== 'STOCK') {
      throw ApiError.validation('库存安排参数不合法', {
        materialId: ['仅库存类物料可做库存安排'],
      })
    }
  }
  await assertCanArrange(db, input.demandItemId, baseQty, {
    closeHardCap: input.type === 'close',
  })
  const row = await db
    .insertInto('mfg_demand_arrangement')
    .values({
      demand_item_id: input.demandItemId,
      company_id: input.companyId,
      arrangement_type: input.type,
      qty,
      base_qty: baseQty,
      work_order_id: null,
      purchase_order_item_id: null,
      remarks: input.remarks ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  await recomputeDemandItemProjections(db, input.demandItemId)
  return { id: row.id, baseQty: numStr(row.base_qty) }
}

export async function deleteManualArrangement(
  db: DbHandle,
  arrangementId: string,
): Promise<{ demandItemId: string }> {
  const row = await db
    .selectFrom('mfg_demand_arrangement')
    .selectAll()
    .where('id', '=', arrangementId)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw new ApiError('not_found', '安排不存在')
  if (row.arrangement_type !== 'stock' && row.arrangement_type !== 'close') {
    throw new ApiError('conflict', '仅库存/关闭安排可手工删除')
  }
  const demandItemId = row.demand_item_id
  await db.deleteFrom('mfg_demand_arrangement').where('id', '=', arrangementId).execute()
  await recomputeDemandItemProjections(db, demandItemId)
  return { demandItemId }
}

/** 工单创建时倒写生产安排 */
export async function upsertMakeArrangement(
  db: DbHandle,
  input: {
    demandItemId: string
    companyId: string
    workOrderId: string
    qty: string
    baseQty: string
  },
): Promise<void> {
  await assertCanArrange(db, input.demandItemId, input.baseQty)
  await db
    .insertInto('mfg_demand_arrangement')
    .values({
      demand_item_id: input.demandItemId,
      company_id: input.companyId,
      arrangement_type: 'make',
      qty: input.qty,
      base_qty: input.baseQty,
      work_order_id: input.workOrderId,
      purchase_order_item_id: null,
    })
    .execute()
  await recomputeDemandItemProjections(db, input.demandItemId)
}

export async function removeMakeArrangementByWorkOrder(
  db: DbHandle,
  workOrderId: string,
): Promise<void> {
  const row = await db
    .selectFrom('mfg_demand_arrangement')
    .select(['id', 'demand_item_id'])
    .where('work_order_id', '=', workOrderId)
    .executeTakeFirst()
  if (!row) return
  await db.deleteFrom('mfg_demand_arrangement').where('id', '=', row.id).execute()
  await recomputeDemandItemProjections(db, row.demand_item_id)
}

export function arrangementTypeLabel(t: ArrangementType): string {
  switch (t) {
    case 'make':
      return '生产'
    case 'purchase':
      return '采购'
    case 'outsource':
      return '委外'
    case 'stock':
      return '库存'
    case 'close':
      return '关闭'
  }
}

export function attachArrangementFields(item: DemandItem): DemandItem {
  const arranged = item.arrangedQty ?? '0'
  const completed = item.completedQty ?? '0'
  item.arrangedQty = arranged
  item.completedQty = completed
  item.remainingArrangeableQty = hardRemainingArrangeable(item.baseQty, arranged)
  item.remainingOrderableQty = item.remainingArrangeableQty
  return item
}
