/**
 * 生产工单：由已确认自制需求行生成；完工回写在生产入库服务中
 */
import { decimal, toDecimalString } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { companyScopeWhere, listFromSource } from '~/db/list.ts'
import { loadDemand, loadDemandItem } from './demand-service.ts'
import {
  actorUserId,
  asDateOrNull,
  mfgWriteError,
  normalizeList,
  numStr,
  requireCompanyAccess,
  setDemandItemStatus,
  todayUTC,
  validateNo,
} from './helpers.ts'
import { workOrderResourceMeta } from './meta.ts'
import type { ListQueryInput, WorkOrder, WorkOrderStatus } from './types.ts'

const WO_AUDIT = [
  'work_order_no',
  'qty',
  'base_qty',
  'received_base_qty',
  'need_date',
  'material_code',
  'material_name',
  'material_spec',
  'unit_name',
  'status',
  'company_id',
  'demand_id',
  'demand_item_id',
  'material_id',
  'unit_id',
  'created_by_id',
] as const

export function createWorkOrderService(db: Kysely<Database>, numbering: NumberingService) {
  async function createWorkOrder(
    actor: Actor,
    input: { demandItemId: string; workOrderNo?: string | null },
  ): Promise<WorkOrder> {
    return withTx(db, async (trx) => {
      const demandItemRow = await trx
        .selectFrom('mfg_demand_item')
        .select('demand_id')
        .where('id', '=', input.demandItemId)
        .executeTakeFirst()
      if (!demandItemRow) throw new ApiError('not_found', '需求行不存在')
      const parent = await loadDemand(trx, demandItemRow.demand_id, true)
      const item = await loadDemandItem(trx, input.demandItemId, true)
      requireCompanyAccess(actor, item.companyId)
      if (parent.status !== 'confirmed') {
        throw new ApiError('conflict', '仅已确认需求单的行可生成工单')
      }
      if (item.fulfillmentMethod !== 'make') {
        throw new ApiError('conflict', '仅自制行可生成生产工单')
      }
      if (item.status === 'completed') {
        throw new ApiError('conflict', '已完成的需求行不可生成工单')
      }
      const active = await sql<{ ok: boolean }>`
        SELECT EXISTS(
          SELECT 1 FROM mfg_work_order
          WHERE demand_item_id = ${item.id} AND status <> 'voided'
        ) AS ok
      `.execute(trx)
      if (active.rows[0]?.ok) {
        throw new ApiError('conflict', '该需求行已有未作废生产工单')
      }
      const needDate = item.needDate ?? todayUTC()
      let no = (input.workOrderNo ?? '').trim()
      if (!no) {
        no = await numbering.nextInTx(trx, {
          resource: 'mfg.work_order',
          values: { company_id: item.companyId, need_date: needDate },
        })
      }
      validateNo(no, 'workOrderNo')
      try {
        const row = await trx
          .insertInto('mfg_work_order')
          .values({
            work_order_no: no,
            qty: item.qty,
            base_qty: item.baseQty,
            received_base_qty: '0',
            need_date: item.needDate,
            material_code: item.materialCode,
            material_name: item.materialName,
            material_spec: item.materialSpec,
            unit_name: item.unitName,
            status: 'in_progress',
            company_id: item.companyId,
            demand_id: item.demandId,
            demand_item_id: item.id,
            material_id: item.materialId,
            unit_id: item.unitId,
            created_by_id: actorUserId(actor),
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        await setDemandItemStatus(trx, item.id, 'scheduled')
        const result = mapWorkOrder(row)
        await writeAudit(trx, actor, {
          resource: 'mfg_work_order',
          recordId: result.id,
          recordLabel: result.workOrderNo,
          actionType: 'create',
          actionName: 'create',
          companyId: result.companyId,
          changes: auditCreated(woSnap(result), WO_AUDIT),
        })
        return result
      } catch (err) {
        throw mfgWriteError('创建生产工单失败', err)
      }
    })
  }

  async function getWorkOrder(actor: Actor, id: string): Promise<WorkOrder> {
    const item = await loadWorkOrder(db, id, false)
    requireCompanyAccess(actor, item.companyId)
    return item
  }

  async function listWorkOrders(actor: Actor, query: ListQueryInput) {
    const q = normalizeList(query)
    if (q.companyId) requireCompanyAccess(actor, q.companyId)
    const scope = q.companyId
      ? { empty: false as const, where: sql`company_id = ${q.companyId}` }
      : companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as WorkOrder[] }
    return listFromSource({
      db,
      resource: workOrderResourceMeta(),
      source: sql` FROM (
        SELECT w.*,
          (w.base_qty - w.received_base_qty) AS remaining_base_qty
        FROM mfg_work_order w
      ) AS mfg_work_order`,
      select: sql`SELECT *`,
      defaultOrder: sql`"inserted_at" DESC, "id" DESC`,
      query: q,
      extraWhere: scope.where,
      mapRow: mapWorkOrderRow,
    })
  }

  async function updateWorkOrder(
    actor: Actor,
    id: string,
    input: { workOrderNo: string },
  ): Promise<WorkOrder> {
    const no = input.workOrderNo.trim()
    validateNo(no, 'workOrderNo')
    return withTx(db, async (trx) => {
      const before = await loadWorkOrder(trx, id, true)
      requireCompanyAccess(actor, before.companyId)
      if (before.status !== 'in_progress') {
        throw new ApiError('conflict', '仅进行中的生产工单可修改')
      }
      const after = { ...before, workOrderNo: no }
      const changes = auditDiff(woSnap(before), woSnap(after), WO_AUDIT)
      if (Object.keys(changes).length > 0) {
        try {
          await trx
            .updateTable('mfg_work_order')
            .set({ work_order_no: no, updated_at: sql`(now() AT TIME ZONE 'utc')` })
            .where('id', '=', id)
            .execute()
        } catch (err) {
          throw mfgWriteError('更新生产工单失败', err)
        }
        await writeAudit(trx, actor, {
          resource: 'mfg_work_order',
          recordId: id,
          recordLabel: no,
          actionType: 'update',
          actionName: 'update',
          companyId: after.companyId,
          changes,
        })
      }
      return after
    })
  }

  async function deleteWorkOrder(actor: Actor, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const item = await loadWorkOrder(trx, id, true)
      requireCompanyAccess(actor, item.companyId)
      if (item.status !== 'in_progress' && item.status !== 'voided') {
        throw new ApiError('conflict', '仅进行中的生产工单可删除')
      }
      if (await hasAuditedOutput(trx, id)) {
        throw new ApiError('conflict', '存在已审核生产入库,不可删除工单')
      }
      if (item.status === 'in_progress') {
        await setDemandItemStatus(trx, item.demandItemId, 'pending')
      }
      try {
        await trx.deleteFrom('mfg_work_order').where('id', '=', id).execute()
      } catch (err) {
        throw mfgWriteError('删除生产工单失败', err)
      }
      await writeAudit(trx, actor, {
        resource: 'mfg_work_order',
        recordId: id,
        recordLabel: item.workOrderNo,
        actionType: 'destroy',
        actionName: 'destroy',
        companyId: item.companyId,
        changes: auditDestroyed(woSnap(item), WO_AUDIT),
      })
    })
  }

  async function voidWorkOrder(actor: Actor, id: string): Promise<WorkOrder> {
    return withTx(db, async (trx) => {
      const before = await loadWorkOrder(trx, id, true)
      requireCompanyAccess(actor, before.companyId)
      if (before.status !== 'in_progress') {
        throw new ApiError('conflict', '仅进行中的生产工单可作废')
      }
      if (await hasAuditedOutput(trx, id)) {
        throw new ApiError('conflict', '存在已审核生产入库,不可作废工单')
      }
      await trx
        .updateTable('mfg_work_order')
        .set({ status: 'voided', updated_at: sql`(now() AT TIME ZONE 'utc')` })
        .where('id', '=', id)
        .execute()
      await setDemandItemStatus(trx, before.demandItemId, 'pending')
      const after = { ...before, status: 'voided' as WorkOrderStatus }
      await writeAudit(trx, actor, {
        resource: 'mfg_work_order',
        recordId: id,
        recordLabel: after.workOrderNo,
        actionType: 'update',
        actionName: 'void',
        companyId: after.companyId,
        changes: auditDiff(woSnap(before), woSnap(after), WO_AUDIT),
      })
      return after
    })
  }

  return {
    createWorkOrder,
    getWorkOrder,
    listWorkOrders,
    updateWorkOrder,
    deleteWorkOrder,
    voidWorkOrder,
  }
}

export type WorkOrderService = ReturnType<typeof createWorkOrderService>

export async function loadWorkOrder(
  db: DbHandle,
  id: string,
  lock: boolean,
): Promise<WorkOrder> {
  let q = db.selectFrom('mfg_work_order').selectAll().where('id', '=', id)
  if (lock) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  if (!row) throw new ApiError('not_found', '生产工单不存在')
  return mapWorkOrder(row)
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
  created_by_id: string | null
  inserted_at: Date
  updated_at: Date
}): WorkOrder {
  const baseQty = numStr(row.base_qty)
  const received = numStr(row.received_base_qty)
  return {
    id: row.id,
    workOrderNo: row.work_order_no,
    qty: numStr(row.qty),
    baseQty,
    receivedBaseQty: received,
    remainingBaseQty: toDecimalString(decimal(baseQty).sub(received)),
    needDate: asDateOrNull(row.need_date),
    materialCode: row.material_code,
    materialName: row.material_name,
    materialSpec: row.material_spec,
    unitName: row.unit_name,
    status: row.status as WorkOrderStatus,
    companyId: row.company_id,
    demandId: row.demand_id,
    demandItemId: row.demand_item_id,
    materialId: row.material_id,
    unitId: row.unit_id,
    createdById: row.created_by_id,
    insertedAt: new Date(row.inserted_at),
    updatedAt: new Date(row.updated_at),
  }
}

function mapWorkOrderRow(r: Record<string, unknown>): WorkOrder {
  const item = mapWorkOrder({
    id: String(r.id),
    work_order_no: String(r.work_order_no),
    qty: r.qty,
    base_qty: r.base_qty,
    received_base_qty: r.received_base_qty,
    need_date: r.need_date as Date | null,
    material_code: String(r.material_code),
    material_name: String(r.material_name),
    material_spec: r.material_spec == null ? null : String(r.material_spec),
    unit_name: String(r.unit_name),
    status: String(r.status),
    company_id: String(r.company_id),
    demand_id: String(r.demand_id),
    demand_item_id: String(r.demand_item_id),
    material_id: String(r.material_id),
    unit_id: String(r.unit_id),
    created_by_id: r.created_by_id == null ? null : String(r.created_by_id),
    inserted_at: r.inserted_at as Date,
    updated_at: r.updated_at as Date,
  })
  if (r.remaining_base_qty !== undefined) {
    item.remainingBaseQty = numStr(r.remaining_base_qty)
  }
  return item
}

function woSnap(item: WorkOrder) {
  return {
    work_order_no: item.workOrderNo,
    qty: item.qty,
    base_qty: item.baseQty,
    received_base_qty: item.receivedBaseQty,
    need_date: item.needDate,
    material_code: item.materialCode,
    material_name: item.materialName,
    material_spec: item.materialSpec,
    unit_name: item.unitName,
    status: item.status,
    company_id: item.companyId,
    demand_id: item.demandId,
    demand_item_id: item.demandItemId,
    material_id: item.materialId,
    unit_id: item.unitId,
    created_by_id: item.createdById,
  }
}
