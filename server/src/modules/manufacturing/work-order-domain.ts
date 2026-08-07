/**
 * 生产工单领域：映射 / 投影 / BOM 快照助手 / 毛需求。
 * 与 work-order-service（标准头 + workflow + 编排）分离，压行数预算。
 *
 * D12：三子表仅 BOM 整包快照写，不进 standard child / aggregate。
 */
import { decimal, roundBaseQty, toDecimalString } from '@synie/shared'
import { sql } from 'kysely'
import { loadAuthorized } from '~/db/load.ts'
import type { DbHandle } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { AuthzTarget } from '~/platform/meta/resource-authz.ts'
import { asDateOrNull, numStr } from './helpers.ts'
import type { WorkOrder, WorkOrderStatus } from './types.ts'

export const WORK_ORDER_RESOURCE = 'mfgWorkOrders'
export const WORK_ORDER_TABLE = 'mfg_work_order'

/** 列表/单条投影：未完成量 = base − received */
export const WORK_ORDER_SOURCE = sql` FROM (
  SELECT w.*,
    (w.base_qty - w.received_base_qty) AS remaining_base_qty
  FROM mfg_work_order w
) AS mfg_work_order`

export function mapWorkOrderExtras(row: Record<string, unknown>) {
  return {
    remainingBaseQty:
      row.remaining_base_qty !== undefined
        ? numStr(row.remaining_base_qty)
        : undefined,
  }
}

/**
 * 标准内核 wire 形（枚举大写）→ 领域 WorkOrder（状态小写，与存量服务/测对齐）。
 * remainingBaseQty 优先取投影列，否则按 base−received 推算。
 */
export function presentWorkOrder(row: Record<string, unknown>): WorkOrder {
  const baseQty = numStr(row.baseQty ?? row.base_qty)
  const received = numStr(row.receivedBaseQty ?? row.received_base_qty)
  const remaining =
    row.remainingBaseQty !== undefined
      ? numStr(row.remainingBaseQty)
      : row.remaining_base_qty !== undefined
        ? numStr(row.remaining_base_qty)
        : toDecimalString(decimal(baseQty).sub(received))
  return {
    id: String(row.id),
    workOrderNo: String(row.workOrderNo ?? row.work_order_no),
    qty: numStr(row.qty),
    baseQty,
    receivedBaseQty: received,
    remainingBaseQty: remaining,
    needDate:
      row.needDate !== undefined
        ? (row.needDate as string | null)
        : asDateOrNull(row.need_date as Date | string | null),
    materialCode: String(row.materialCode ?? row.material_code),
    materialName: String(row.materialName ?? row.material_name),
    materialSpec:
      row.materialSpec !== undefined
        ? (row.materialSpec as string | null)
        : row.material_spec == null
          ? null
          : String(row.material_spec),
    unitName: String(row.unitName ?? row.unit_name),
    status: String(row.status).toLowerCase() as WorkOrderStatus,
    companyId: String(row.companyId ?? row.company_id),
    demandId: String(row.demandId ?? row.demand_id),
    demandItemId: String(row.demandItemId ?? row.demand_item_id),
    materialId: String(row.materialId ?? row.material_id),
    unitId: String(row.unitId ?? row.unit_id),
    bomId:
      row.bomId !== undefined
        ? (row.bomId as string | null)
        : row.bom_id == null
          ? null
          : String(row.bom_id),
    createdById:
      row.createdById !== undefined
        ? (row.createdById as string | null)
        : row.created_by_id == null
          ? null
          : String(row.created_by_id),
    ownerDeptId:
      row.ownerDeptId !== undefined
        ? (row.ownerDeptId as string | null)
        : row.owner_dept_id == null
          ? null
          : String(row.owner_dept_id),
    insertedAt: new Date((row.insertedAt ?? row.inserted_at) as Date | string),
    updatedAt: new Date((row.updatedAt ?? row.updated_at) as Date | string),
  }
}

export function mapWorkOrder(row: {
  id: string
  work_order_no: string
  qty: unknown
  base_qty: unknown
  received_base_qty: unknown
  need_date: Date | string | null
  material_code: string
  material_name: string
  material_spec: string | null
  unit_name: string
  status: string
  company_id: string
  demand_id: string
  demand_item_id: string
  material_id: string
  unit_id: string
  bom_id?: string | null
  created_by_id: string | null
  owner_dept_id: string | null
  inserted_at: Date
  updated_at: Date
}): WorkOrder {
  return presentWorkOrder(row as unknown as Record<string, unknown>)
}

export function mapWorkOrderRecord(r: Record<string, unknown>): WorkOrder {
  return presentWorkOrder(r)
}

/** 按 Permit 取工单行（可锁）；不命中一律 not_found。生产入库服务共用 */
export async function loadWorkOrderAuthorized(
  db: DbHandle,
  permit: import('~/platform/authz/core/index.ts').Permit,
  target: AuthzTarget,
  id: string,
  forUpdate: boolean,
): Promise<WorkOrder> {
  const row = await loadAuthorized({
    db,
    permit,
    target,
    table: WORK_ORDER_TABLE,
    id,
    forUpdate,
    notFoundMessage: '生产工单不存在',
  })
  return mapWorkOrderRecord(row)
}

/**
 * 受信任读：审核/作废的投影锁（已入数量回写）按工单 id 取行，
 * 授权已在入口对**单据**完成，投影是同事务内的系统写。
 */
export async function loadWorkOrderForProjection(
  db: DbHandle,
  id: string,
): Promise<WorkOrder> {
  const row = await db
    .selectFrom('mfg_work_order')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw new ApiError('not_found', '生产工单不存在')
  return mapWorkOrder(row)
}

/** 毛需求（理论耗用口径）：净用量 ×(1+损耗率,空按 1)× 工单 base 数量，6 位 */
export function grossRequirement(
  quantity: unknown,
  lossRate: unknown,
  workOrderBaseQty: string,
): string {
  const factor = lossRate == null ? decimal(1) : decimal(String(lossRate)).add(1)
  return toDecimalString(
    decimal(roundBaseQty(decimal(String(quantity)).mul(factor).mul(decimal(workOrderBaseQty)))),
  )
}

export async function hasAuditedOutput(db: DbHandle, workOrderId: string): Promise<boolean> {
  const row = await sql<{ ok: boolean }>`
    SELECT EXISTS(
      SELECT 1 FROM mfg_output_item i
      JOIN mfg_output o ON o.id = i.output_id
      WHERE i.work_order_id = ${workOrderId} AND o.status = 'audited'
    ) AS ok
  `.execute(db)
  return Boolean(row.rows[0]?.ok)
}

export async function clearWorkOrderBomSnapshot(
  db: DbHandle,
  workOrderId: string,
): Promise<void> {
  await db
    .deleteFrom('mfg_work_order_component')
    .where('work_order_id', '=', workOrderId)
    .execute()
  await db.deleteFrom('mfg_work_order_route').where('work_order_id', '=', workOrderId).execute()
  await db
    .deleteFrom('mfg_work_order_byproduct')
    .where('work_order_id', '=', workOrderId)
    .execute()
}

/** 校验启用+本物料后复制 BOM 子表到工单快照，并写 bom_id */
export async function copyBomSnapshotToWorkOrder(
  db: DbHandle,
  workOrderId: string,
  bomId: string,
  workOrderMaterialId: string,
): Promise<void> {
  const bom = await db
    .selectFrom('mfg_bom')
    .selectAll()
    .where('id', '=', bomId)
    .forUpdate()
    .executeTakeFirst()
  if (!bom) throw new ApiError('not_found', 'BOM不存在')
  if (bom.status !== 'active') {
    throw new ApiError('conflict', '仅启用中的 BOM 可选入工单')
  }
  if (bom.material_id !== workOrderMaterialId) {
    throw new ApiError('conflict', 'BOM 物料须与工单物料一致')
  }
  await clearWorkOrderBomSnapshot(db, workOrderId)
  const components = await db
    .selectFrom('mfg_bom_component')
    .selectAll()
    .where('bom_id', '=', bomId)
    .execute()
  const routes = await db
    .selectFrom('mfg_bom_route')
    .selectAll()
    .where('bom_id', '=', bomId)
    .orderBy('seq', 'asc')
    .execute()
  const byproducts = await db
    .selectFrom('mfg_bom_byproduct')
    .selectAll()
    .where('bom_id', '=', bomId)
    .execute()
  let idx = 0
  for (const c of components) {
    await db
      .insertInto('mfg_work_order_component')
      .values({
        work_order_id: workOrderId,
        material_id: c.material_id,
        unit_id: c.unit_id,
        quantity: String(c.quantity),
        loss_rate: c.loss_rate == null ? null : String(c.loss_rate),
        note: c.note,
        idx: String(idx++),
      })
      .execute()
  }
  for (const r of routes) {
    await db
      .insertInto('mfg_work_order_route')
      .values({
        work_order_id: workOrderId,
        operation_id: r.operation_id,
        seq: String(r.seq),
        requirement: r.requirement,
        is_outsourced: r.is_outsourced,
      })
      .execute()
  }
  idx = 0
  for (const b of byproducts) {
    await db
      .insertInto('mfg_work_order_byproduct')
      .values({
        work_order_id: workOrderId,
        material_id: b.material_id,
        unit_id: b.unit_id,
        quantity: String(b.quantity),
        note: b.note,
        idx: String(idx++),
      })
      .execute()
  }
  await db
    .updateTable('mfg_work_order')
    .set({ bom_id: bomId, updated_at: sql`(now() AT TIME ZONE 'utc')` })
    .where('id', '=', workOrderId)
    .execute()
}
