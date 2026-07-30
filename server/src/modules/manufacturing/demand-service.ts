/**
 * 履约需求单：头/行生命周期、销售占用、完成与改履约方式
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
import {
  requirePermission,
  actorUserId,
  asDate,
  asDateOrNull,
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
  validateSalesSource,
} from './helpers.ts'
import {
  attachArrangementFields,
  createManualArrangement,
  deleteManualArrangement,
  hardRemainingArrangeable,
} from './arrangement.ts'
import { demandItemResourceMeta, demandResourceMeta } from './meta.ts'
import type {
  Demand,
  DemandItem,
  DemandItemStatus,
  DemandStatus,
  FulfillmentMethod,
  ListQueryInput,
  SalesOccupancy,
} from './types.ts'

const DEMAND_AUDIT = [
  'demand_no',
  'demand_date',
  'remarks',
  'status',
  'company_id',
  'created_by_id',
] as const

const ITEM_AUDIT = [
  'idx',
  'qty',
  'base_qty',
  'ordered_qty',
  'received_qty',
  'arranged_qty',
  'completed_qty',
  'need_date',
  'fulfillment_method',
  'status',
  'material_code',
  'material_name',
  'material_spec',
  'unit_name',
  'remarks',
  'demand_id',
  'company_id',
  'material_id',
  'unit_id',
  'sales_order_item_id',
] as const

export function createDemandService(db: Kysely<Database>, numbering: NumberingService) {
  async function createDemand(
    actor: Actor,
    input: {
      companyId: string
      demandNo?: string | null
      demandDate?: string | null
      remarks?: string | null
    },
  ): Promise<Demand> {
    requirePermission(actor, 'mfg.demand:create')
    if (!input.companyId) {
      throw ApiError.validation('履约需求单参数不合法', { companyId: ['必填'] })
    }
    requireCompanyAccess(actor, input.companyId)
    validateRemarks(input.remarks)
    return withTx(db, async (trx) => {
      const demandDate = input.demandDate ? toDateOnly(input.demandDate) : todayUTC()
      let no = (input.demandNo ?? '').trim()
      if (!no) {
        no = await numbering.nextInTx(trx, {
          resource: 'mfg.demand',
          values: { company_id: input.companyId, demand_date: demandDate },
        })
      }
      validateNo(no, 'demandNo')
      try {
        const row = await trx
          .insertInto('mfg_demand')
          .values({
            demand_no: no,
            demand_date: demandDate,
            remarks: input.remarks ?? null,
            status: 'draft',
            company_id: input.companyId,
            created_by_id: actorUserId(actor),
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapDemand(row)
        await writeAudit(trx, actor, {
          resource: 'mfg_demand',
          recordId: item.id,
          recordLabel: item.demandNo,
          actionType: 'create',
          actionName: 'create',
          companyId: item.companyId,
          changes: auditCreated(demandSnap(item), DEMAND_AUDIT),
        })
        return item
      } catch (err) {
        throw mfgWriteError('创建履约需求单失败', err)
      }
    })
  }

  async function getDemand(actor: Actor, id: string): Promise<Demand> {
    requirePermission(actor, 'mfg.demand:read')
    const item = await loadDemand(db, id, false)
    requireCompanyAccess(actor, item.companyId)
    return item
  }

  async function listDemands(actor: Actor, query: ListQueryInput) {
    requirePermission(actor, 'mfg.demand:read')
    const q = normalizeList(query)
    if (q.companyId) requireCompanyAccess(actor, q.companyId)
    const scope = q.companyId
      ? { empty: false as const, where: sql`company_id = ${q.companyId}` }
      : companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as Demand[] }
    return listFromSource({
      db,
      resource: demandResourceMeta(),
      source: sql` FROM mfg_demand`,
      select: sql`SELECT *`,
      defaultOrder: sql`"inserted_at" DESC, "id" DESC`,
      query: q,
      extraWhere: scope.where,
      mapRow: mapDemandRow,
    })
  }

  async function updateDemand(
    actor: Actor,
    id: string,
    input: {
      demandNo?: string
      demandDate?: string
      remarks?: string | null
      remarksPresent?: boolean
    },
  ): Promise<Demand> {
    requirePermission(actor, 'mfg.demand:update')
    return withTx(db, async (trx) => {
      const before = await loadDemand(trx, id, true)
      requireCompanyAccess(actor, before.companyId)
      if (before.status !== 'draft') {
        throw new ApiError('conflict', '仅草稿履约需求单可修改或删除')
      }
      const after: Demand = { ...before }
      if (input.demandNo !== undefined) after.demandNo = input.demandNo.trim()
      if (input.demandDate !== undefined) after.demandDate = toDateOnly(input.demandDate)
      if (input.remarksPresent) after.remarks = input.remarks ?? null
      validateNo(after.demandNo, 'demandNo')
      validateRemarks(after.remarks)
      const changes = auditDiff(demandSnap(before), demandSnap(after), DEMAND_AUDIT)
      if (Object.keys(changes).length === 0) return before
      try {
        await trx
          .updateTable('mfg_demand')
          .set({
            demand_no: after.demandNo,
            demand_date: after.demandDate,
            remarks: after.remarks,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .execute()
      } catch (err) {
        throw mfgWriteError('更新履约需求单失败', err)
      }
      const result = await loadDemand(trx, id, false)
      await writeAudit(trx, actor, {
        resource: 'mfg_demand',
        recordId: id,
        recordLabel: result.demandNo,
        actionType: 'update',
        actionName: 'update',
        companyId: result.companyId,
        changes,
      })
      return result
    })
  }

  async function deleteDemand(actor: Actor, id: string): Promise<void> {
    requirePermission(actor, 'mfg.demand:delete')
    await withTx(db, async (trx) => {
      const item = await loadDemand(trx, id, true)
      requireCompanyAccess(actor, item.companyId)
      if (item.status !== 'draft') {
        throw new ApiError('conflict', '仅草稿履约需求单可修改或删除')
      }
      try {
        await trx.deleteFrom('mfg_demand').where('id', '=', id).execute()
      } catch (err) {
        throw mfgWriteError('删除履约需求单失败', err)
      }
      await writeAudit(trx, actor, {
        resource: 'mfg_demand',
        recordId: id,
        recordLabel: item.demandNo,
        actionType: 'destroy',
        actionName: 'destroy',
        companyId: item.companyId,
        changes: auditDestroyed(demandSnap(item), DEMAND_AUDIT),
      })
    })
  }

  async function createDemandItem(
    actor: Actor,
    input: {
      demandId: string
      idx: number
      materialId: string
      unitId: string
      qty: string
      needDate?: string | null
      /** @deprecated 行级履约方式已取消，忽略写入 */
      fulfillmentMethod?: string | null
      salesOrderItemId?: string | null
      remarks?: string | null
    },
  ): Promise<DemandItem> {
    requirePermission(actor, 'mfg.demand:create')
    validateRemarks(input.remarks)
    return withTx(db, async (trx) => {
      const parent = await loadDemand(trx, input.demandId, true)
      requireCompanyAccess(actor, parent.companyId)
      if (parent.status !== 'draft') {
        throw new ApiError('conflict', '仅草稿履约需求单可编辑需求行')
      }
      const projection = await deriveItemProjection(
        trx,
        input.materialId,
        input.unitId,
        input.qty,
      )
      await validateSalesSource(trx, input.salesOrderItemId, parent.companyId)
      try {
        const row = await trx
          .insertInto('mfg_demand_item')
          .values({
            demand_id: parent.id,
            company_id: parent.companyId,
            idx: String(input.idx),
            material_id: input.materialId,
            unit_id: input.unitId,
            qty: toDecimalString(decimal(input.qty)),
            base_qty: projection.baseQty,
            need_date: input.needDate ? toDateOnly(input.needDate) : null,
            fulfillment_method: null,
            status: 'pending',
            sales_order_item_id: input.salesOrderItemId ?? null,
            material_code: projection.materialCode,
            material_name: projection.materialName,
            material_spec: projection.materialSpec,
            unit_name: projection.unitName,
            remarks: input.remarks ?? null,
            ordered_qty: '0',
            received_qty: '0',
            arranged_qty: '0',
            completed_qty: '0',
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const result = await loadDemandItem(trx, row.id, false)
        await writeAudit(trx, actor, {
          resource: 'mfg_demand_item',
          recordId: result.id,
          recordLabel: String(result.idx),
          actionType: 'create',
          actionName: 'create',
          companyId: result.companyId,
          changes: auditCreated(itemSnap(result), ITEM_AUDIT),
        })
        return result
      } catch (err) {
        throw mfgWriteError('创建需求行失败', err)
      }
    })
  }

  async function getDemandItem(actor: Actor, id: string): Promise<DemandItem> {
    requirePermission(actor, 'mfg.demand:read')
    const item = await loadDemandItem(db, id, false)
    requireCompanyAccess(actor, item.companyId)
    return item
  }

  async function listDemandItems(actor: Actor, query: ListQueryInput & { demandId?: string }) {
    requirePermission(actor, 'mfg.demand:read')
    const q = normalizeList(query)
    if (q.companyId) requireCompanyAccess(actor, q.companyId)
    const scope = q.companyId
      ? { empty: false as const, where: sql`company_id = ${q.companyId}` }
      : companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as DemandItem[] }
    const parts = [
      scope.where,
      query.demandId ? sql`demand_id = ${query.demandId}` : null,
    ].filter(Boolean)
    // 列表用物理列 + 计算投影
    return listFromSource({
      db,
      resource: demandItemResourceMeta(),
      source: sql` FROM (
        SELECT i.*,
          (i.arranged_qty > 0 AND i.status <> 'completed') AS ordered,
          greatest(i.base_qty - i.arranged_qty, 0) AS remaining_orderable_qty,
          greatest(i.base_qty - i.arranged_qty, 0) AS remaining_arrangeable_qty
        FROM mfg_demand_item i
      ) AS mfg_demand_item`,
      select: sql`SELECT *`,
      defaultOrder: sql`"idx" ASC, "id" ASC`,
      query: q,
      extraWhere: parts.length ? sql`${sql.join(parts as never, sql` AND `)}` : null,
      mapRow: mapDemandItemRow,
    })
  }

  async function updateDemandItem(
    actor: Actor,
    id: string,
    input: {
      idx?: number
      materialId?: string
      unitId?: string
      qty?: string
      needDate?: string | null
      needDatePresent?: boolean
      fulfillmentMethod?: string
      salesOrderItemId?: string | null
      salesOrderItemIdPresent?: boolean
      remarks?: string | null
      remarksPresent?: boolean
    },
  ): Promise<DemandItem> {
    requirePermission(actor, 'mfg.demand:update')
    return withTx(db, async (trx) => {
      const parentId = await trx
        .selectFrom('mfg_demand_item')
        .select('demand_id')
        .where('id', '=', id)
        .executeTakeFirst()
      if (!parentId) throw new ApiError('not_found', '需求行不存在')
      const parent = await loadDemand(trx, parentId.demand_id, true)
      requireCompanyAccess(actor, parent.companyId)
      if (parent.status !== 'draft') {
        throw new ApiError('conflict', '仅草稿履约需求单可编辑需求行')
      }
      const before = await loadDemandItem(trx, id, true)
      const after = { ...before }
      if (input.idx !== undefined) after.idx = input.idx
      if (input.materialId !== undefined) after.materialId = input.materialId
      if (input.unitId !== undefined) after.unitId = input.unitId
      if (input.qty !== undefined) after.qty = input.qty
      if (input.needDatePresent) {
        after.needDate = input.needDate ? toDateOnly(input.needDate) : null
      }
      // 行级履约方式已取消：忽略 fulfillmentMethod 写入
      if (input.salesOrderItemIdPresent) {
        after.salesOrderItemId = input.salesOrderItemId ?? null
      }
      if (input.remarksPresent) after.remarks = input.remarks ?? null
      validateRemarks(after.remarks)
      const projection = await deriveItemProjection(
        trx,
        after.materialId,
        after.unitId,
        after.qty,
      )
      after.baseQty = projection.baseQty
      after.materialCode = projection.materialCode
      after.materialName = projection.materialName
      after.materialSpec = projection.materialSpec
      after.unitName = projection.unitName
      after.qty = toDecimalString(decimal(after.qty))
      await validateSalesSource(trx, after.salesOrderItemId, parent.companyId)
      const changes = auditDiff(itemSnap(before), itemSnap(after), ITEM_AUDIT)
      if (Object.keys(changes).length > 0) {
        try {
          await trx
            .updateTable('mfg_demand_item')
            .set({
              idx: String(after.idx),
              material_id: after.materialId,
              unit_id: after.unitId,
              qty: after.qty,
              base_qty: after.baseQty,
              need_date: after.needDate,
              fulfillment_method: after.fulfillmentMethod ?? null,
              sales_order_item_id: after.salesOrderItemId,
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
          throw mfgWriteError('更新需求行失败', err)
        }
        await writeAudit(trx, actor, {
          resource: 'mfg_demand_item',
          recordId: id,
          recordLabel: String(after.idx),
          actionType: 'update',
          actionName: 'update',
          companyId: after.companyId,
          changes,
        })
      }
      return loadDemandItem(trx, id, false)
    })
  }

  async function deleteDemandItem(actor: Actor, id: string): Promise<void> {
    requirePermission(actor, 'mfg.demand:update')
    await withTx(db, async (trx) => {
      const parentId = await trx
        .selectFrom('mfg_demand_item')
        .select('demand_id')
        .where('id', '=', id)
        .executeTakeFirst()
      if (!parentId) throw new ApiError('not_found', '需求行不存在')
      const parent = await loadDemand(trx, parentId.demand_id, true)
      requireCompanyAccess(actor, parent.companyId)
      if (parent.status !== 'draft') {
        throw new ApiError('conflict', '仅草稿履约需求单可编辑需求行')
      }
      const item = await loadDemandItem(trx, id, true)
      await trx.deleteFrom('mfg_demand_item').where('id', '=', id).execute()
      await writeAudit(trx, actor, {
        resource: 'mfg_demand_item',
        recordId: id,
        recordLabel: String(item.idx),
        actionType: 'destroy',
        actionName: 'destroy',
        companyId: item.companyId,
        changes: auditDestroyed(itemSnap(item), ITEM_AUDIT),
      })
    })
  }

  async function confirmDemand(actor: Actor, id: string): Promise<Demand> {
    requirePermission(actor, 'mfg.demand:confirm')
    return withTx(db, async (trx) => {
      const before = await loadDemand(trx, id, true)
      requireCompanyAccess(actor, before.companyId)
      if (before.status !== 'draft') {
        throw new ApiError('conflict', '仅草稿履约需求单可确认')
      }
      const count = await trx
        .selectFrom('mfg_demand_item')
        .select(db.fn.countAll<string>().as('c'))
        .where('demand_id', '=', id)
        .executeTakeFirstOrThrow()
      if (Number(count.c) === 0) {
        throw new ApiError('conflict', '确认前必须至少填写一行需求行')
      }
      const sourceRows = await trx
        .selectFrom('mfg_demand_item')
        .select(['sales_order_item_id', 'base_qty'])
        .where('demand_id', '=', id)
        .where('sales_order_item_id', 'is not', null)
        .execute()
      const groups = new Map<string, ReturnType<typeof decimal>>()
      for (const r of sourceRows) {
        const sid = r.sales_order_item_id!
        const prev = groups.get(sid) ?? decimal(0)
        groups.set(sid, prev.add(String(r.base_qty)))
      }
      const sortedIds = [...groups.keys()].sort()
      for (const salesId of sortedIds) {
        const so = await trx
          .selectFrom('sal_order_item as i')
          .innerJoin('sal_order as o', 'o.id', 'i.order_id')
          .select(['i.base_qty', 'i.company_id', 'o.status'])
          .where('i.id', '=', salesId)
          .forUpdate()
          .executeTakeFirst()
        if (!so) throw new ApiError('conflict', '销售订单条目不存在')
        if (so.company_id !== before.companyId) {
          throw new ApiError('conflict', '销售订单条目不属于本公司')
        }
        if (so.status !== 'audited') {
          throw new ApiError('conflict', '仅已审核未关闭的销售订单条目可纳入')
        }
        const occ = await sql<{ occupied: string }>`
          SELECT coalesce(sum(i.base_qty), 0)::text AS occupied
          FROM mfg_demand_item i
          JOIN mfg_demand d ON d.id = i.demand_id
          WHERE i.sales_order_item_id = ${salesId}
            AND i.demand_id <> ${id}
            AND d.status = 'confirmed'
        `.execute(trx)
        const occupied = decimal(occ.rows[0]?.occupied ?? '0')
        const add = groups.get(salesId)!
        const ordered = decimal(String(so.base_qty))
        if (occupied.add(add).gt(ordered)) {
          throw new ApiError(
            'conflict',
            `超出销售订单可占用数量(已占用${occupied},剩余${ordered.sub(occupied)},本单${add})`,
          )
        }
      }
      await trx
        .updateTable('mfg_demand')
        .set({ status: 'confirmed', updated_at: sql`(now() AT TIME ZONE 'utc')` })
        .where('id', '=', id)
        .execute()
      const after = { ...before, status: 'confirmed' as DemandStatus }
      await writeAudit(trx, actor, {
        resource: 'mfg_demand',
        recordId: id,
        recordLabel: after.demandNo,
        actionType: 'update',
        actionName: 'confirm',
        companyId: after.companyId,
        changes: auditDiff(demandSnap(before), demandSnap(after), DEMAND_AUDIT),
      })
      return loadDemand(trx, id, false)
    })
  }

  async function closeDemand(actor: Actor, id: string): Promise<Demand> {
    requirePermission(actor, 'mfg.demand:close')
    return transitionDemand(actor, id, 'close', 'confirmed', 'closed', '仅已确认履约需求单可关闭')
  }

  async function voidDemand(actor: Actor, id: string): Promise<Demand> {
    requirePermission(actor, 'mfg.demand:void')
    return withTx(db, async (trx) => {
      const before = await loadDemand(trx, id, true)
      requireCompanyAccess(actor, before.companyId)
      if (before.status !== 'confirmed') {
        throw new ApiError('conflict', '仅已确认履约需求单可作废;草稿请直接删除')
      }
      await trx
        .selectFrom('mfg_demand_item')
        .select('id')
        .where('demand_id', '=', id)
        .orderBy('id')
        .forUpdate()
        .execute()
      const activeWork = await sql<{ ok: boolean }>`
        SELECT EXISTS(
          SELECT 1 FROM mfg_work_order WHERE demand_id = ${id} AND status <> 'voided'
        ) AS ok
      `.execute(trx)
      if (activeWork.rows[0]?.ok) {
        throw new ApiError('conflict', '存在未作废生产工单,不可作废需求单')
      }
      const activePurchase = await sql<{ ok: boolean }>`
        SELECT EXISTS(
          SELECT 1 FROM pur_order_item oi
          JOIN pur_order o ON o.id = oi.order_id
          JOIN mfg_demand_item i ON i.id = oi.demand_line_id
          WHERE i.demand_id = ${id} AND o.status IN ('audited', 'closed')
        ) AS ok
      `.execute(trx)
      if (activePurchase.rows[0]?.ok) {
        throw new ApiError('conflict', '存在已审核未作废采购/委外订单,不可作废需求单')
      }
      await trx
        .updateTable('mfg_demand')
        .set({ status: 'voided', updated_at: sql`(now() AT TIME ZONE 'utc')` })
        .where('id', '=', id)
        .execute()
      const after = { ...before, status: 'voided' as DemandStatus }
      await writeAudit(trx, actor, {
        resource: 'mfg_demand',
        recordId: id,
        recordLabel: after.demandNo,
        actionType: 'update',
        actionName: 'void',
        companyId: after.companyId,
        changes: auditDiff(demandSnap(before), demandSnap(after), DEMAND_AUDIT),
      })
      return after
    })
  }

  async function transitionDemand(
    actor: Actor,
    id: string,
    action: string,
    from: DemandStatus,
    to: DemandStatus,
    message: string,
  ): Promise<Demand> {
    return withTx(db, async (trx) => {
      const before = await loadDemand(trx, id, true)
      requireCompanyAccess(actor, before.companyId)
      if (before.status !== from) throw new ApiError('conflict', message)
      await trx
        .updateTable('mfg_demand')
        .set({ status: to, updated_at: sql`(now() AT TIME ZONE 'utc')` })
        .where('id', '=', id)
        .execute()
      const after = { ...before, status: to }
      await writeAudit(trx, actor, {
        resource: 'mfg_demand',
        recordId: id,
        recordLabel: after.demandNo,
        actionType: 'update',
        actionName: action,
        companyId: after.companyId,
        changes: auditDiff(demandSnap(before), demandSnap(after), DEMAND_AUDIT),
      })
      return after
    })
  }

  /**
   * 兼容旧「点完成」：对剩余可安排量创建一条库存安排（不扣库存）。
   * 新 UI 应直接用 createArrangement(stock|close)。
   */
  async function completeDemandItem(actor: Actor, id: string): Promise<DemandItem> {
    requirePermission(actor, 'mfg.demand:update')
    return withTx(db, async (trx) => {
      const parentId = await trx
        .selectFrom('mfg_demand_item')
        .select('demand_id')
        .where('id', '=', id)
        .executeTakeFirst()
      if (!parentId) throw new ApiError('not_found', '需求行不存在')
      const parent = await loadDemand(trx, parentId.demand_id, true)
      const before = await loadDemandItem(trx, id, true)
      requireCompanyAccess(actor, before.companyId)
      if (parent.status !== 'confirmed') {
        throw new ApiError('conflict', '仅已确认未关闭需求单上的行可登记库存安排')
      }
      const rem = hardRemainingArrangeable(before.baseQty, before.arrangedQty)
      if (!decimal(rem).gt(0)) {
        throw new ApiError('conflict', '无可安排剩余数量')
      }
      // rem 为 base；行 qty 与 base 同比例
      const factor = decimal(before.baseQty).eq(0)
        ? decimal(1)
        : decimal(before.qty).div(decimal(before.baseQty))
      const qtyInLineUnit = toDecimalString(decimal(rem).mul(factor))
      await createManualArrangement(trx, {
        demandItemId: id,
        companyId: before.companyId,
        type: 'stock',
        qty: qtyInLineUnit,
        unitBaseQtyPerUnit: decimal(before.qty).eq(0)
          ? '1'
          : toDecimalString(decimal(before.baseQty).div(decimal(before.qty))),
        remarks: '兼容点完成→库存安排',
      })
      return loadDemandItem(trx, id, false)
    })
  }

  async function changeFulfillment(
    _actor: Actor,
    _id: string,
    _methodWire: string,
  ): Promise<DemandItem> {
    throw new ApiError(
      'conflict',
      '已取消行级履约方式，请使用安排（生产/采购/委外/库存/关闭）',
    )
  }

  async function createArrangement(
    actor: Actor,
    input: {
      demandItemId: string
      arrangementType: 'stock' | 'close'
      qty: string
      remarks?: string | null
    },
  ): Promise<DemandItem> {
    requirePermission(actor, 'mfg.demand:update')
    return withTx(db, async (trx) => {
      const parentId = await trx
        .selectFrom('mfg_demand_item')
        .select('demand_id')
        .where('id', '=', input.demandItemId)
        .executeTakeFirst()
      if (!parentId) throw new ApiError('not_found', '需求行不存在')
      const parent = await loadDemand(trx, parentId.demand_id, true)
      const before = await loadDemandItem(trx, input.demandItemId, true)
      requireCompanyAccess(actor, before.companyId)
      if (parent.status !== 'confirmed') {
        throw new ApiError('conflict', '仅已确认未关闭需求单上的行可手工安排')
      }
      const unitBase =
        decimal(before.qty).eq(0)
          ? '1'
          : toDecimalString(decimal(before.baseQty).div(decimal(before.qty)))
      await createManualArrangement(trx, {
        demandItemId: input.demandItemId,
        companyId: before.companyId,
        type: input.arrangementType,
        qty: input.qty,
        unitBaseQtyPerUnit: unitBase,
        remarks: input.remarks,
      })
      const after = await loadDemandItem(trx, input.demandItemId, false)
      await writeAudit(trx, actor, {
        resource: 'mfg_demand_item',
        recordId: after.id,
        recordLabel: String(after.idx),
        actionType: 'update',
        actionName: `arrange_${input.arrangementType}`,
        companyId: after.companyId,
        changes: auditDiff(itemSnap(before), itemSnap(after), ITEM_AUDIT),
      })
      return after
    })
  }

  async function removeArrangement(actor: Actor, arrangementId: string): Promise<DemandItem> {
    requirePermission(actor, 'mfg.demand:update')
    return withTx(db, async (trx) => {
      const { demandItemId } = await deleteManualArrangement(trx, arrangementId)
      const item = await loadDemandItem(trx, demandItemId, false)
      requireCompanyAccess(actor, item.companyId)
      return item
    })
  }

  async function listArrangements(actor: Actor, demandItemId: string) {
    requirePermission(actor, 'mfg.demand:read')
    const item = await loadDemandItem(db, demandItemId, false)
    requireCompanyAccess(actor, item.companyId)
    const rows = await db
      .selectFrom('mfg_demand_arrangement')
      .selectAll()
      .where('demand_item_id', '=', demandItemId)
      .orderBy('inserted_at', 'asc')
      .execute()
    return rows.map((r) => ({
      id: r.id,
      demandItemId: r.demand_item_id,
      companyId: r.company_id,
      arrangementType: r.arrangement_type,
      qty: numStr(r.qty),
      baseQty: numStr(r.base_qty),
      workOrderId: r.work_order_id,
      purchaseOrderItemId: r.purchase_order_item_id,
      remarks: r.remarks,
      insertedAt: new Date(r.inserted_at),
      updatedAt: new Date(r.updated_at),
    }))
  }

  async function salesOccupancies(
    actor: Actor,
    ids: string[],
  ): Promise<SalesOccupancy[]> {
    requirePermission(actor, 'mfg.demand:read')
    if (ids.length === 0) return []
    const rows = await sql<{
      id: string
      ordered: string
      occupied: string
    }>`
      SELECT i.id,
        i.base_qty::text AS ordered,
        coalesce(sum(di.base_qty) FILTER (WHERE d.status = 'confirmed'), 0)::text AS occupied
      FROM sal_order_item i
      LEFT JOIN mfg_demand_item di ON di.sales_order_item_id = i.id
      LEFT JOIN mfg_demand d ON d.id = di.demand_id
      WHERE i.id = ANY(${ids}::uuid[])
      GROUP BY i.id, i.base_qty
      ORDER BY i.id
    `.execute(db)
    return rows.rows.map((r) => {
      const ordered = decimal(r.ordered)
      const occupied = decimal(r.occupied)
      return {
        salesOrderItemId: r.id,
        orderedBaseQty: toDecimalString(ordered),
        occupiedBaseQty: toDecimalString(occupied),
        remainingBaseQty: toDecimalString(ordered.sub(occupied)),
      }
    })
  }

  return {
    createDemand,
    getDemand,
    listDemands,
    updateDemand,
    deleteDemand,
    createDemandItem,
    getDemandItem,
    listDemandItems,
    updateDemandItem,
    deleteDemandItem,
    confirmDemand,
    closeDemand,
    voidDemand,
    completeDemandItem,
    changeFulfillment,
    createArrangement,
    removeArrangement,
    listArrangements,
    salesOccupancies,
    /** 供工单/入库事务内使用 */
    loadDemand,
    loadDemandItem,
  }
}

export type DemandService = ReturnType<typeof createDemandService>

export async function loadDemand(
  db: DbHandle,
  id: string,
  lock: boolean,
): Promise<Demand> {
  let q = db.selectFrom('mfg_demand').selectAll().where('id', '=', id)
  if (lock) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  if (!row) throw new ApiError('not_found', '履约需求单不存在')
  return mapDemand(row)
}

export async function loadDemandItem(
  db: DbHandle,
  id: string,
  lock: boolean,
): Promise<DemandItem> {
  let q = db.selectFrom('mfg_demand_item').selectAll().where('id', '=', id)
  if (lock) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  if (!row) throw new ApiError('not_found', '需求行不存在')
  return mapDemandItem(row)
}

function mapDemand(row: {
  id: string
  demand_no: string
  demand_date: Date | string
  remarks: string | null
  status: string
  company_id: string
  created_by_id: string | null
  inserted_at: Date
  updated_at: Date
}): Demand {
  return {
    id: row.id,
    demandNo: row.demand_no,
    demandDate: asDate(row.demand_date),
    remarks: row.remarks,
    status: row.status as DemandStatus,
    companyId: row.company_id,
    createdById: row.created_by_id,
    insertedAt: new Date(row.inserted_at),
    updatedAt: new Date(row.updated_at),
  }
}

function mapDemandRow(r: Record<string, unknown>): Demand {
  return mapDemand({
    id: String(r.id),
    demand_no: String(r.demand_no),
    demand_date: r.demand_date as Date,
    remarks: r.remarks == null ? null : String(r.remarks),
    status: String(r.status),
    company_id: String(r.company_id),
    created_by_id: r.created_by_id == null ? null : String(r.created_by_id),
    inserted_at: r.inserted_at as Date,
    updated_at: r.updated_at as Date,
  })
}

function mapDemandItem(row: {
  id: string
  demand_id: string
  company_id: string
  idx: string | number | bigint
  material_id: string
  unit_id: string
  qty: unknown
  base_qty: unknown
  ordered_qty: unknown
  received_qty: unknown
  arranged_qty?: unknown
  completed_qty?: unknown
  need_date: Date | string | null
  fulfillment_method: string | null
  status: string
  sales_order_item_id: string | null
  material_code: string
  material_name: string
  material_spec: string | null
  unit_name: string
  remarks: string | null
  inserted_at: Date
  updated_at: Date
}): DemandItem {
  const orderedQty = numStr(row.ordered_qty)
  const baseQty = numStr(row.base_qty)
  const arrangedQty = numStr(row.arranged_qty ?? '0')
  const completedQty = numStr(row.completed_qty ?? '0')
  const status = row.status as DemandItemStatus
  const item: DemandItem = {
    id: row.id,
    demandId: row.demand_id,
    companyId: row.company_id,
    idx: asInt(row.idx),
    materialId: row.material_id,
    unitId: row.unit_id,
    qty: numStr(row.qty),
    baseQty,
    orderedQty,
    receivedQty: numStr(row.received_qty),
    arrangedQty,
    completedQty,
    remainingArrangeableQty: hardRemainingArrangeable(baseQty, arrangedQty),
    needDate: asDateOrNull(row.need_date),
    fulfillmentMethod: row.fulfillment_method
      ? (row.fulfillment_method as FulfillmentMethod)
      : null,
    status,
    salesOrderItemId: row.sales_order_item_id,
    materialCode: row.material_code,
    materialName: row.material_name,
    materialSpec: row.material_spec,
    unitName: row.unit_name,
    remarks: row.remarks,
    ordered: decimal(arrangedQty).gt(0) && status !== 'completed',
    remainingOrderableQty: hardRemainingArrangeable(baseQty, arrangedQty),
    insertedAt: new Date(row.inserted_at),
    updatedAt: new Date(row.updated_at),
  }
  return attachArrangementFields(item)
}

function mapDemandItemRow(r: Record<string, unknown>): DemandItem {
  const item = mapDemandItem({
    id: String(r.id),
    demand_id: String(r.demand_id),
    company_id: String(r.company_id),
    idx: r.idx as number,
    material_id: String(r.material_id),
    unit_id: String(r.unit_id),
    qty: r.qty,
    base_qty: r.base_qty,
    ordered_qty: r.ordered_qty,
    received_qty: r.received_qty,
    arranged_qty: r.arranged_qty,
    completed_qty: r.completed_qty,
    need_date: r.need_date as Date | null,
    fulfillment_method: r.fulfillment_method == null ? null : String(r.fulfillment_method),
    status: String(r.status),
    sales_order_item_id: r.sales_order_item_id == null ? null : String(r.sales_order_item_id),
    material_code: String(r.material_code),
    material_name: String(r.material_name),
    material_spec: r.material_spec == null ? null : String(r.material_spec),
    unit_name: String(r.unit_name),
    remarks: r.remarks == null ? null : String(r.remarks),
    inserted_at: r.inserted_at as Date,
    updated_at: r.updated_at as Date,
  })
  if (r.ordered !== undefined) item.ordered = Boolean(r.ordered)
  if (r.remaining_orderable_qty !== undefined) {
    item.remainingOrderableQty = numStr(r.remaining_orderable_qty)
  }
  if (r.remaining_arrangeable_qty !== undefined) {
    item.remainingArrangeableQty = numStr(r.remaining_arrangeable_qty)
  }
  return item
}

function demandSnap(item: Demand) {
  return {
    demand_no: item.demandNo,
    demand_date: item.demandDate,
    remarks: item.remarks,
    status: item.status,
    company_id: item.companyId,
    created_by_id: item.createdById,
  }
}

function itemSnap(item: DemandItem) {
  return {
    idx: item.idx,
    qty: item.qty,
    base_qty: item.baseQty,
    ordered_qty: item.orderedQty,
    received_qty: item.receivedQty,
    arranged_qty: item.arrangedQty,
    completed_qty: item.completedQty,
    need_date: item.needDate,
    fulfillment_method: item.fulfillmentMethod,
    status: item.status,
    material_code: item.materialCode,
    material_name: item.materialName,
    material_spec: item.materialSpec,
    unit_name: item.unitName,
    remarks: item.remarks,
    demand_id: item.demandId,
    company_id: item.companyId,
    material_id: item.materialId,
    unit_id: item.unitId,
    sales_order_item_id: item.salesOrderItemId,
  }
}
