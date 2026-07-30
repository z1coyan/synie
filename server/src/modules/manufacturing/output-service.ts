/**
 * 生产入库：草稿行维护 + 库存过账骨架 + 工单/需求完工回写
 * 引擎复用 engines/inventory，禁止直写分录表
 */
import { decimal, toDecimalString } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { InventoryEngine, StockLine } from '~/engines/inventory/types.ts'
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
import {
  auditInventoryDocInTx,
  voidInventoryDocInTx,
} from '~/modules/trading/posting.ts'
import {
  requirePermission,
  actorUserId,
  asDate,
  asInt,
  deriveItemProjection,
  mfgWriteError,
  normalizeList,
  numStr,
  requireCompanyAccess,

  todayUTC,
  toDateOnly,
  validateNo,
  validateRemarks,
  validateWarehouse,
} from './helpers.ts'
import { outputItemResourceMeta, outputResourceMeta } from './meta.ts'
import { loadWorkOrder } from './work-order-service.ts'
import type {
  ListQueryInput,
  Output,
  OutputItem,
  OutputStatus,
  WorkOrder,
  WorkOrderStatus,
} from './types.ts'

const OUT_AUDIT = [
  'output_no',
  'output_date',
  'remarks',
  'status',
  'audited_at',
  'company_id',
  'warehouse_id',
  'created_by_id',
  'audited_by_id',
] as const

const ITEM_AUDIT = [
  'idx',
  'qty',
  'base_qty',
  'material_code',
  'material_name',
  'material_spec',
  'unit_name',
  'remarks',
  'output_id',
  'company_id',
  'work_order_id',
  'material_id',
  'unit_id',
  'warehouse_id',
] as const

export function createOutputService(
  db: Kysely<Database>,
  numbering: NumberingService,
  inventory: InventoryEngine,
) {
  async function createOutput(
    actor: Actor,
    input: {
      companyId: string
      outputNo?: string | null
      outputDate?: string | null
      warehouseId?: string | null
      remarks?: string | null
    },
  ): Promise<Output> {
    requirePermission(actor, 'mfg.output:create')
    if (!input.companyId) {
      throw ApiError.validation('生产入库单参数不合法', { companyId: ['必填'] })
    }
    requireCompanyAccess(actor, input.companyId)
    validateRemarks(input.remarks)
    return withTx(db, async (trx) => {
      await validateWarehouse(trx, input.warehouseId, input.companyId)
      const outputDate = input.outputDate ? toDateOnly(input.outputDate) : todayUTC()
      let no = (input.outputNo ?? '').trim()
      if (!no) {
        no = await numbering.nextInTx(trx, {
          resource: 'mfg.output',
          values: { company_id: input.companyId, output_date: outputDate },
        })
      }
      validateNo(no, 'outputNo')
      try {
        const row = await trx
          .insertInto('mfg_output')
          .values({
            output_no: no,
            output_date: outputDate,
            remarks: input.remarks ?? null,
            status: 'draft',
            company_id: input.companyId,
            warehouse_id: input.warehouseId ?? null,
            created_by_id: actorUserId(actor),
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapOutput(row)
        await writeAudit(trx, actor, {
          resource: 'mfg_output',
          recordId: item.id,
          recordLabel: item.outputNo,
          actionType: 'create',
          actionName: 'create',
          companyId: item.companyId,
          changes: auditCreated(outSnap(item), OUT_AUDIT),
        })
        return item
      } catch (err) {
        throw mfgWriteError('创建生产入库单失败', err)
      }
    })
  }

  async function getOutput(actor: Actor, id: string): Promise<Output> {
    requirePermission(actor, 'mfg.output:read')
    const item = await loadOutput(db, id, false)
    requireCompanyAccess(actor, item.companyId)
    return item
  }

  async function listOutputs(actor: Actor, query: ListQueryInput) {
    requirePermission(actor, 'mfg.output:read')
    const q = normalizeList(query)
    if (q.companyId) requireCompanyAccess(actor, q.companyId)
    const scope = q.companyId
      ? { empty: false as const, where: sql`company_id = ${q.companyId}` }
      : companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as Output[] }
    return listFromSource({
      db,
      resource: outputResourceMeta(),
      source: sql` FROM mfg_output`,
      select: sql`SELECT *`,
      defaultOrder: sql`"inserted_at" DESC, "id" DESC`,
      query: q,
      extraWhere: scope.where,
      mapRow: mapOutputRow,
    })
  }

  async function updateOutput(
    actor: Actor,
    id: string,
    input: {
      outputNo?: string
      outputDate?: string
      warehouseId?: string | null
      warehouseIdPresent?: boolean
      remarks?: string | null
      remarksPresent?: boolean
    },
  ): Promise<Output> {
    requirePermission(actor, 'mfg.output:update')
    return withTx(db, async (trx) => {
      const before = await loadOutput(trx, id, true)
      requireCompanyAccess(actor, before.companyId)
      if (before.status !== 'draft') {
        throw new ApiError('conflict', '仅草稿生产入库单可修改或删除')
      }
      const after = { ...before }
      if (input.outputNo !== undefined) after.outputNo = input.outputNo.trim()
      if (input.outputDate !== undefined) after.outputDate = toDateOnly(input.outputDate)
      if (input.warehouseIdPresent) after.warehouseId = input.warehouseId ?? null
      if (input.remarksPresent) after.remarks = input.remarks ?? null
      validateNo(after.outputNo, 'outputNo')
      validateRemarks(after.remarks)
      await validateWarehouse(trx, after.warehouseId, after.companyId)
      const changes = auditDiff(outSnap(before), outSnap(after), OUT_AUDIT)
      if (Object.keys(changes).length > 0) {
        try {
          await trx
            .updateTable('mfg_output')
            .set({
              output_no: after.outputNo,
              output_date: after.outputDate,
              warehouse_id: after.warehouseId,
              remarks: after.remarks,
              updated_at: sql`(now() AT TIME ZONE 'utc')`,
            })
            .where('id', '=', id)
            .execute()
        } catch (err) {
          throw mfgWriteError('更新生产入库单失败', err)
        }
        await writeAudit(trx, actor, {
          resource: 'mfg_output',
          recordId: id,
          recordLabel: after.outputNo,
          actionType: 'update',
          actionName: 'update',
          companyId: after.companyId,
          changes,
        })
      }
      return after
    })
  }

  async function deleteOutput(actor: Actor, id: string): Promise<void> {
    requirePermission(actor, 'mfg.output:delete')
    await withTx(db, async (trx) => {
      const item = await loadOutput(trx, id, true)
      requireCompanyAccess(actor, item.companyId)
      if (item.status !== 'draft') {
        throw new ApiError('conflict', '仅草稿生产入库单可修改或删除')
      }
      try {
        await trx.deleteFrom('mfg_output').where('id', '=', id).execute()
      } catch (err) {
        throw mfgWriteError('删除生产入库单失败', err)
      }
      await writeAudit(trx, actor, {
        resource: 'mfg_output',
        recordId: id,
        recordLabel: item.outputNo,
        actionType: 'destroy',
        actionName: 'destroy',
        companyId: item.companyId,
        changes: auditDestroyed(outSnap(item), OUT_AUDIT),
      })
    })
  }

  async function createOutputItem(
    actor: Actor,
    input: {
      outputId: string
      idx: number
      workOrderId: string
      unitId: string
      qty: string
      warehouseId: string
      remarks?: string | null
    },
  ): Promise<OutputItem> {
    requirePermission(actor, 'mfg.output:create')
    validateRemarks(input.remarks)
    return withTx(db, async (trx) => {
      const parent = await loadOutput(trx, input.outputId, true)
      requireCompanyAccess(actor, parent.companyId)
      if (parent.status !== 'draft') {
        throw new ApiError('conflict', '仅草稿生产入库单可编辑单据行')
      }
      const workOrder = await loadWorkOrder(trx, input.workOrderId, false)
      if (workOrder.status === 'voided') {
        throw new ApiError('conflict', '生产工单已作废')
      }
      if (workOrder.companyId !== parent.companyId) {
        throw new ApiError('conflict', '生产工单不属于本公司')
      }
      await validateWarehouse(trx, input.warehouseId, parent.companyId)
      const projection = await deriveItemProjection(
        trx,
        workOrder.materialId,
        input.unitId,
        input.qty,
      )
      try {
        const row = await trx
          .insertInto('mfg_output_item')
          .values({
            output_id: parent.id,
            company_id: parent.companyId,
            idx: String(input.idx),
            work_order_id: input.workOrderId,
            material_id: workOrder.materialId,
            unit_id: input.unitId,
            warehouse_id: input.warehouseId,
            qty: toDecimalString(decimal(input.qty)),
            base_qty: projection.baseQty,
            material_code: workOrder.materialCode,
            material_name: workOrder.materialName,
            material_spec: workOrder.materialSpec,
            unit_name: projection.unitName,
            remarks: input.remarks ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const result = mapOutputItem(row)
        await writeAudit(trx, actor, {
          resource: 'mfg_output_item',
          recordId: result.id,
          recordLabel: String(result.idx),
          actionType: 'create',
          actionName: 'create',
          companyId: result.companyId,
          changes: auditCreated(itemSnap(result), ITEM_AUDIT),
        })
        return result
      } catch (err) {
        throw mfgWriteError('创建生产入库行失败', err)
      }
    })
  }

  async function getOutputItem(actor: Actor, id: string): Promise<OutputItem> {
    requirePermission(actor, 'mfg.output:read')
    const item = await loadOutputItem(db, id, false)
    requireCompanyAccess(actor, item.companyId)
    return item
  }

  async function listOutputItems(actor: Actor, query: ListQueryInput & { outputId?: string }) {
    requirePermission(actor, 'mfg.output:read')
    const q = normalizeList(query)
    if (q.companyId) requireCompanyAccess(actor, q.companyId)
    const scope = q.companyId
      ? { empty: false as const, where: sql`company_id = ${q.companyId}` }
      : companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as OutputItem[] }
    const parts = [
      scope.where,
      query.outputId ? sql`output_id = ${query.outputId}` : null,
    ].filter(Boolean)
    return listFromSource({
      db,
      resource: outputItemResourceMeta(),
      source: sql` FROM mfg_output_item`,
      select: sql`SELECT *`,
      defaultOrder: sql`"idx" ASC, "id" ASC`,
      query: q,
      extraWhere: parts.length ? sql`${sql.join(parts as never, sql` AND `)}` : null,
      mapRow: mapOutputItemRow,
    })
  }

  async function updateOutputItem(
    actor: Actor,
    id: string,
    input: {
      idx?: number
      workOrderId?: string
      unitId?: string
      qty?: string
      warehouseId?: string
      remarks?: string | null
      remarksPresent?: boolean
    },
  ): Promise<OutputItem> {
    requirePermission(actor, 'mfg.output:update')
    return withTx(db, async (trx) => {
      const parentId = await trx
        .selectFrom('mfg_output_item')
        .select('output_id')
        .where('id', '=', id)
        .executeTakeFirst()
      if (!parentId) throw new ApiError('not_found', '生产入库行不存在')
      const parent = await loadOutput(trx, parentId.output_id, true)
      requireCompanyAccess(actor, parent.companyId)
      if (parent.status !== 'draft') {
        throw new ApiError('conflict', '仅草稿生产入库单可编辑单据行')
      }
      const before = await loadOutputItem(trx, id, true)
      const after = { ...before }
      if (input.idx !== undefined) after.idx = input.idx
      if (input.workOrderId !== undefined) after.workOrderId = input.workOrderId
      if (input.unitId !== undefined) after.unitId = input.unitId
      if (input.qty !== undefined) after.qty = input.qty
      if (input.warehouseId !== undefined) after.warehouseId = input.warehouseId
      if (input.remarksPresent) after.remarks = input.remarks ?? null
      validateRemarks(after.remarks)
      const workOrder = await loadWorkOrder(trx, after.workOrderId, false)
      if (workOrder.status === 'voided') {
        throw new ApiError('conflict', '生产工单已作废')
      }
      if (workOrder.companyId !== parent.companyId) {
        throw new ApiError('conflict', '生产工单不属于本公司')
      }
      await validateWarehouse(trx, after.warehouseId, parent.companyId)
      const projection = await deriveItemProjection(
        trx,
        workOrder.materialId,
        after.unitId,
        after.qty,
      )
      after.baseQty = projection.baseQty
      after.materialId = workOrder.materialId
      after.materialCode = workOrder.materialCode
      after.materialName = workOrder.materialName
      after.materialSpec = workOrder.materialSpec
      after.unitName = projection.unitName
      after.qty = toDecimalString(decimal(after.qty))
      const changes = auditDiff(itemSnap(before), itemSnap(after), ITEM_AUDIT)
      if (Object.keys(changes).length > 0) {
        try {
          await trx
            .updateTable('mfg_output_item')
            .set({
              idx: String(after.idx),
              work_order_id: after.workOrderId,
              material_id: after.materialId,
              unit_id: after.unitId,
              warehouse_id: after.warehouseId,
              qty: after.qty,
              base_qty: after.baseQty,
              material_code: after.materialCode,
              material_name: after.materialName,
              material_spec: after.materialSpec,
              unit_name: after.unitName,
              remarks: after.remarks,
              updated_at: sql`(now() AT TIME ZONE 'utc')`,
            })
            .where('id', '=', id)
            .execute()
        } catch (err) {
          throw mfgWriteError('更新生产入库行失败', err)
        }
        await writeAudit(trx, actor, {
          resource: 'mfg_output_item',
          recordId: id,
          recordLabel: String(after.idx),
          actionType: 'update',
          actionName: 'update',
          companyId: after.companyId,
          changes,
        })
      }
      return loadOutputItem(trx, id, false)
    })
  }

  async function deleteOutputItem(actor: Actor, id: string): Promise<void> {
    requirePermission(actor, 'mfg.output:update')
    await withTx(db, async (trx) => {
      const parentId = await trx
        .selectFrom('mfg_output_item')
        .select('output_id')
        .where('id', '=', id)
        .executeTakeFirst()
      if (!parentId) throw new ApiError('not_found', '生产入库行不存在')
      const parent = await loadOutput(trx, parentId.output_id, true)
      requireCompanyAccess(actor, parent.companyId)
      if (parent.status !== 'draft') {
        throw new ApiError('conflict', '仅草稿生产入库单可编辑单据行')
      }
      const item = await loadOutputItem(trx, id, true)
      await trx.deleteFrom('mfg_output_item').where('id', '=', id).execute()
      await writeAudit(trx, actor, {
        resource: 'mfg_output_item',
        recordId: id,
        recordLabel: String(item.idx),
        actionType: 'destroy',
        actionName: 'destroy',
        companyId: item.companyId,
        changes: auditDestroyed(itemSnap(item), ITEM_AUDIT),
      })
    })
  }

  async function auditOutput(actor: Actor, id: string): Promise<Output> {
    requirePermission(actor, 'mfg.output:audit')
    return withTx(db, async (trx) => {
      // 投影用工单锁：collect 内装载，postProjection 闭包复用
      let lockedOrders: Map<string, LockedWorkOrder> | null = null
      return auditInventoryDocInTx(trx, actor, inventory, {
        voucherType: 'mfg.output',
        headTable: 'mfg_output',
        setPostingDate: false,
        lockDraft: async (t) => {
          const before = await loadOutput(t, id, true)
          requireCompanyAccess(actor, before.companyId)
          if (before.status !== 'draft') {
            throw new ApiError('conflict', '仅草稿生产入库单可审核')
          }
          return before
        },
        collect: async (t, before) => {
          const items = await loadOutputItemsForUpdate(t, id)
          lockedOrders = await lockOutputWorkOrders(t, items)
          await checkOutput(t, before, items, lockedOrders)
          const stockLines: StockLine[] = items.map((item) => ({
            warehouseId: item.warehouseId,
            materialId: item.materialId,
            quantity: item.baseQty,
            direction: 'in' as const,
            remarks: item.remarks ?? before.remarks,
          }))
          return { stockLines, postingDate: before.outputDate }
        },
        postProjection: async (t) => {
          if (!lockedOrders) throw new ApiError('internal', '生产入库投影未初始化')
          await updateWorkOrderProjection(t, lockedOrders, 1)
        },
        voucherOf: (h) => ({ id: h.id, no: h.outputNo, companyId: h.companyId }),
        reload: async (t, headId) => loadOutput(t, headId, false),
        snapshot: outSnap,
        auditFields: OUT_AUDIT,
      })
    })
  }

  async function voidOutput(actor: Actor, id: string): Promise<Output> {
    requirePermission(actor, 'mfg.output:void')
    return withTx(db, async (trx) => {
      let lockedOrders: Map<string, LockedWorkOrder> | null = null
      return voidInventoryDocInTx(trx, actor, inventory, {
        voucherType: 'mfg.output',
        headTable: 'mfg_output',
        lockAudited: async (t) => {
          const before = await loadOutput(t, id, true)
          requireCompanyAccess(actor, before.companyId)
          if (before.status !== 'audited') {
            throw new ApiError('conflict', '仅已审核生产入库单可作废')
          }
          const items = await loadOutputItemsForUpdate(t, id)
          lockedOrders = await lockOutputWorkOrders(t, items)
          return before
        },
        reverseProjection: async (t) => {
          if (!lockedOrders) throw new ApiError('internal', '生产入库投影未初始化')
          await updateWorkOrderProjection(t, lockedOrders, -1)
        },
        voucherOf: (h) => ({ id: h.id, no: h.outputNo, companyId: h.companyId }),
        reload: async (t, headId) => loadOutput(t, headId, false),
        snapshot: outSnap,
        auditFields: OUT_AUDIT,
      })
    })
  }

  return {
    createOutput,
    getOutput,
    listOutputs,
    updateOutput,
    deleteOutput,
    createOutputItem,
    getOutputItem,
    listOutputItems,
    updateOutputItem,
    deleteOutputItem,
    auditOutput,
    voidOutput,
  }
}

export type OutputService = ReturnType<typeof createOutputService>

async function loadOutput(db: DbHandle, id: string, lock: boolean): Promise<Output> {
  let q = db.selectFrom('mfg_output').selectAll().where('id', '=', id)
  if (lock) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  if (!row) throw new ApiError('not_found', '生产入库单不存在')
  return mapOutput(row)
}

async function loadOutputItem(db: DbHandle, id: string, lock: boolean): Promise<OutputItem> {
  let q = db.selectFrom('mfg_output_item').selectAll().where('id', '=', id)
  if (lock) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  if (!row) throw new ApiError('not_found', '生产入库行不存在')
  return mapOutputItem(row)
}

async function loadOutputItemsForUpdate(db: DbHandle, outputId: string): Promise<OutputItem[]> {
  const rows = await db
    .selectFrom('mfg_output_item')
    .selectAll()
    .where('output_id', '=', outputId)
    .orderBy('idx', 'asc')
    .orderBy('id', 'asc')
    .forUpdate()
    .execute()
  return rows.map(mapOutputItem)
}

interface LockedWorkOrder {
  item: WorkOrder
  add: ReturnType<typeof decimal>
}

async function lockOutputWorkOrders(
  db: DbHandle,
  items: OutputItem[],
): Promise<Map<string, LockedWorkOrder>> {
  const quantities = new Map<string, ReturnType<typeof decimal>>()
  const firstIdx = new Map<string, number>()
  for (const item of items) {
    const prev = quantities.get(item.workOrderId) ?? decimal(0)
    quantities.set(item.workOrderId, prev.add(item.baseQty))
    if (!firstIdx.has(item.workOrderId)) firstIdx.set(item.workOrderId, item.idx)
  }
  const result = new Map<string, LockedWorkOrder>()
  const sorted = [...quantities.keys()].sort()
  for (const id of sorted) {
    try {
      const item = await loadWorkOrder(db, id, true)
      result.set(id, { item, add: quantities.get(id)! })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_found') {
        throw new ApiError('conflict', `第${firstIdx.get(id)}行:生产工单不存在`)
      }
      throw err
    }
  }
  return result
}

async function outputRatio(db: DbHandle): Promise<ReturnType<typeof decimal>> {
  const row = await sql<{ ratio: string }>`
    SELECT coalesce(
      (SELECT output_overreceive_ratio FROM mfg_setting ORDER BY inserted_at, id LIMIT 1),
      0
    )::text AS ratio
  `.execute(db)
  return decimal(row.rows[0]?.ratio ?? '0')
}

async function checkOutput(
  db: DbHandle,
  output: Output,
  items: OutputItem[],
  orders: Map<string, LockedWorkOrder>,
): Promise<void> {
  if (items.length === 0) {
    throw new ApiError('conflict', '审核前必须至少填写一行入库条目')
  }
  const ratio = await outputRatio(db)
  for (const item of items) {
    const order = orders.get(item.workOrderId)!.item
    if (order.status === 'voided') {
      throw new ApiError('conflict', `第${item.idx}行:生产工单已作废,不可入库`)
    }
    if (order.companyId !== output.companyId) {
      throw new ApiError('conflict', `第${item.idx}行:生产工单不属于本公司`)
    }
    if (order.materialId !== item.materialId) {
      throw new ApiError('conflict', `第${item.idx}行:物料与生产工单不一致`)
    }
    try {
      await validateWarehouse(db, item.warehouseId, output.companyId)
    } catch (err) {
      if (err instanceof ApiError) {
        throw new ApiError('conflict', `第${item.idx}行:${err.message}`)
      }
      throw err
    }
  }
  const ids = [...orders.keys()].sort()
  for (const id of ids) {
    const group = orders.get(id)!
    const maxAllowed = decimal(group.item.baseQty).mul(decimal(1).add(ratio))
    const after = decimal(group.item.receivedBaseQty).add(group.add)
    if (after.gt(maxAllowed)) {
      throw new ApiError(
        'conflict',
        `超出生产入库容差(已入${group.item.receivedBaseQty}+本单${toDecimalString(group.add)} > 工单${group.item.baseQty}×(1+${toDecimalString(ratio)}))`,
      )
    }
  }
}

async function updateWorkOrderProjection(
  db: DbHandle,
  orders: Map<string, LockedWorkOrder>,
  direction: 1 | -1,
): Promise<void> {
  const ids = [...orders.keys()].sort()
  for (const id of ids) {
    const order = orders.get(id)!.item
    const next = decimal(order.receivedBaseQty).add(orders.get(id)!.add.mul(direction))
    if (next.isNegative()) {
      throw new ApiError('conflict', '生产工单已入数量不能为负')
    }
    let orderStatus: WorkOrderStatus = 'in_progress'
    if (!next.lt(decimal(order.baseQty))) {
      orderStatus = 'completed'
    }
    try {
      await db
        .updateTable('mfg_work_order')
        .set({
          received_base_qty: toDecimalString(next),
          status: orderStatus,
          updated_at: sql`(now() AT TIME ZONE 'utc')`,
        })
        .where('id', '=', id)
        .execute()
    } catch (err) {
      throw mfgWriteError('更新生产工单已入投影失败', err)
    }
    const { recomputeDemandItemProjections } = await import('./arrangement.ts')
    await recomputeDemandItemProjections(db, order.demandItemId)
  }
}

function mapOutput(row: {
  id: string
  output_no: string
  output_date: Date | string
  remarks: string | null
  status: string
  audited_at: Date | null
  company_id: string
  warehouse_id: string | null
  created_by_id: string | null
  audited_by_id: string | null
  inserted_at: Date
  updated_at: Date
}): Output {
  return {
    id: row.id,
    outputNo: row.output_no,
    outputDate: asDate(row.output_date),
    remarks: row.remarks,
    status: row.status as OutputStatus,
    auditedAt: row.audited_at ? new Date(row.audited_at) : null,
    companyId: row.company_id,
    warehouseId: row.warehouse_id,
    createdById: row.created_by_id,
    auditedById: row.audited_by_id,
    insertedAt: new Date(row.inserted_at),
    updatedAt: new Date(row.updated_at),
  }
}

function mapOutputRow(r: Record<string, unknown>): Output {
  return mapOutput({
    id: String(r.id),
    output_no: String(r.output_no),
    output_date: r.output_date as Date,
    remarks: r.remarks == null ? null : String(r.remarks),
    status: String(r.status),
    audited_at: r.audited_at == null ? null : (r.audited_at as Date),
    company_id: String(r.company_id),
    warehouse_id: r.warehouse_id == null ? null : String(r.warehouse_id),
    created_by_id: r.created_by_id == null ? null : String(r.created_by_id),
    audited_by_id: r.audited_by_id == null ? null : String(r.audited_by_id),
    inserted_at: r.inserted_at as Date,
    updated_at: r.updated_at as Date,
  })
}

function mapOutputItem(row: {
  id: string
  output_id: string
  company_id: string
  idx: string | number | bigint
  work_order_id: string
  material_id: string
  unit_id: string
  warehouse_id: string
  qty: unknown
  base_qty: unknown
  material_code: string
  material_name: string
  material_spec: string | null
  unit_name: string
  remarks: string | null
  inserted_at: Date
  updated_at: Date
}): OutputItem {
  return {
    id: row.id,
    outputId: row.output_id,
    companyId: row.company_id,
    idx: asInt(row.idx),
    workOrderId: row.work_order_id,
    materialId: row.material_id,
    unitId: row.unit_id,
    warehouseId: row.warehouse_id,
    qty: numStr(row.qty),
    baseQty: numStr(row.base_qty),
    materialCode: row.material_code,
    materialName: row.material_name,
    materialSpec: row.material_spec,
    unitName: row.unit_name,
    remarks: row.remarks,
    insertedAt: new Date(row.inserted_at),
    updatedAt: new Date(row.updated_at),
  }
}

function mapOutputItemRow(r: Record<string, unknown>): OutputItem {
  return mapOutputItem({
    id: String(r.id),
    output_id: String(r.output_id),
    company_id: String(r.company_id),
    idx: r.idx as number,
    work_order_id: String(r.work_order_id),
    material_id: String(r.material_id),
    unit_id: String(r.unit_id),
    warehouse_id: String(r.warehouse_id),
    qty: r.qty,
    base_qty: r.base_qty,
    material_code: String(r.material_code),
    material_name: String(r.material_name),
    material_spec: r.material_spec == null ? null : String(r.material_spec),
    unit_name: String(r.unit_name),
    remarks: r.remarks == null ? null : String(r.remarks),
    inserted_at: r.inserted_at as Date,
    updated_at: r.updated_at as Date,
  })
}

function outSnap(item: Output) {
  return {
    output_no: item.outputNo,
    output_date: item.outputDate,
    remarks: item.remarks,
    status: item.status,
    audited_at: item.auditedAt,
    company_id: item.companyId,
    warehouse_id: item.warehouseId,
    created_by_id: item.createdById,
    audited_by_id: item.auditedById,
  }
}

function itemSnap(item: OutputItem) {
  return {
    idx: item.idx,
    qty: item.qty,
    base_qty: item.baseQty,
    material_code: item.materialCode,
    material_name: item.materialName,
    material_spec: item.materialSpec,
    unit_name: item.unitName,
    remarks: item.remarks,
    output_id: item.outputId,
    company_id: item.companyId,
    work_order_id: item.workOrderId,
    material_id: item.materialId,
    unit_id: item.unitId,
    warehouse_id: item.warehouseId,
  }
}

