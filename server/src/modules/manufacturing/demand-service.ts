/**
 * 履约需求单：头/行生命周期、销售占用、安排与下发车间。
 *
 * 授权全由平台承担（工单 07）：路由挂 `guard(资源, 动作)`，本服务只收 Permit——
 * 列表 `listAuthorized`、写前取行 `loadAuthorized`（不命中一律 not_found）、
 * create 走 `assertCompanyWritable`。模块内零鉴权代码。
 *
 * 下发车间（`assigned_dept_id`）是指派部门形态的业务字段：填写不受操作者部门约束
 * （计划员可下发任意车间），但必须与需求单同公司；草稿态随表单改，已确认后只能走 dispatch 动作。
 * 状态前置条件（草稿才能改等）是领域不变量，留在本文件抛 conflict。
 */
import { decimal, toDecimalString } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { listAuthorized } from '~/db/list.ts'
import { assertCompanyWritable, loadAuthorized } from '~/db/load.ts'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { AuthzTarget } from '~/platform/meta/resource-authz.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { utcToday } from '~/db/dates.ts'
import {
  asDate,
  asDateOrNull,
  asInt,
  deriveItemProjection,
  mfgWriteError,
  normalizeList,
  numStr,
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

export const DEMAND_RESOURCE = 'mfgDemands'
export const DEMAND_ITEM_RESOURCE = 'mfgDemandItems'

const DEMAND_TABLE = 'mfg_demand'
const DEMAND_ITEM_TABLE = 'mfg_demand_item'
const DEMAND_AUDIT = auditFieldsOf(demandResourceMeta())

const ITEM_AUDIT = auditFieldsOf(demandItemResourceMeta())

export function createDemandService(
  db: Kysely<Database>,
  numbering: NumberingService,
  registry: Registry,
) {
  const demandTarget = registry.authzTarget(DEMAND_RESOURCE)
  const itemTarget = registry.authzTarget(DEMAND_ITEM_RESOURCE)

  const lockDemand = (trx: DbHandle, permit: Permit, id: string) =>
    loadDemandAuthorized(trx, permit, demandTarget, id, true)
  const lockItem = (trx: DbHandle, permit: Permit, id: string) =>
    loadDemandItemAuthorized(trx, permit, itemTarget, id, true)

  /** 需求行的母单（授权按母单自身的行谓词判定；行不存在与不可达同为 not_found） */
  async function parentOf(trx: DbHandle, permit: Permit, itemId: string): Promise<Demand> {
    const row = await trx
      .selectFrom('mfg_demand_item')
      .select('demand_id')
      .where('id', '=', itemId)
      .executeTakeFirst()
    if (!row) throw new ApiError('not_found', '需求行不存在')
    return loadDemandAuthorized(trx, permit, demandTarget, row.demand_id, true)
  }

  async function createDemand(
    permit: Permit,
    input: {
      companyId: string
      demandNo?: string | null
      demandDate?: string | null
      remarks?: string | null
      assignedDeptId?: string | null
    },
  ): Promise<Demand> {
    if (!input.companyId) {
      throw ApiError.validation('履约需求单参数不合法', { companyId: ['必填'] })
    }
    assertCompanyWritable(permit, input.companyId, '公司不存在')
    validateRemarks(input.remarks)
    return withTx(db, async (trx) => {
      const assignedDeptId = await resolveAssignedDept(trx, input.companyId, input.assignedDeptId)
      const demandDate = input.demandDate ? toDateOnly(input.demandDate) : utcToday()
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
            assigned_dept_id: assignedDeptId,
            created_by_id: permit.actor.userId || null,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapDemand(row)
        await writeAudit(trx, permit.actor, {
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

  async function getDemand(permit: Permit, id: string): Promise<Demand> {
    return loadDemandAuthorized(db, permit, demandTarget, id, false)
  }

  async function listDemands(permit: Permit, query: ListQueryInput) {
    const q = normalizeList(query)
    return listAuthorized({
      db,
      permit,
      target: demandTarget,
      alias: DEMAND_TABLE,
      resource: demandResourceMeta(),
      source: sql` FROM mfg_demand`,
      select: sql`SELECT *`,
      defaultOrder: sql`"inserted_at" DESC, "id" DESC`,
      query: q,
      extraWhere: q.companyId ? sql`company_id = ${q.companyId}` : null,
      mapRow: mapDemandRecord,
    })
  }

  async function updateDemand(
    permit: Permit,
    id: string,
    input: {
      demandNo?: string
      demandDate?: string
      remarks?: string | null
      remarksPresent?: boolean
      assignedDeptId?: string | null
      assignedDeptIdPresent?: boolean
    },
  ): Promise<Demand> {
    return withTx(db, async (trx) => {
      const before = await lockDemand(trx, permit, id)
      if (before.status !== 'draft') {
        throw new ApiError('conflict', '仅草稿履约需求单可修改或删除')
      }
      const after: Demand = { ...before }
      if (input.demandNo !== undefined) after.demandNo = input.demandNo.trim()
      if (input.demandDate !== undefined) after.demandDate = toDateOnly(input.demandDate)
      if (input.remarksPresent) after.remarks = input.remarks ?? null
      if (input.assignedDeptIdPresent) {
        after.assignedDeptId = await resolveAssignedDept(
          trx,
          before.companyId,
          input.assignedDeptId,
        )
      }
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
            assigned_dept_id: after.assignedDeptId,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .execute()
      } catch (err) {
        throw mfgWriteError('更新履约需求单失败', err)
      }
      const result = await loadDemandAuthorized(trx, permit, demandTarget, id, false)
      await writeAudit(trx, permit.actor, {
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

  async function deleteDemand(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const item = await lockDemand(trx, permit, id)
      if (item.status !== 'draft') {
        throw new ApiError('conflict', '仅草稿履约需求单可修改或删除')
      }
      try {
        await trx.deleteFrom('mfg_demand').where('id', '=', id).execute()
      } catch (err) {
        throw mfgWriteError('删除履约需求单失败', err)
      }
      await writeAudit(trx, permit.actor, {
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
    permit: Permit,
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
    validateRemarks(input.remarks)
    return withTx(db, async (trx) => {
      const parent = await lockDemand(trx, permit, input.demandId)
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
        const result = mapDemandItem(row)
        await writeAudit(trx, permit.actor, {
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

  async function getDemandItem(permit: Permit, id: string): Promise<DemandItem> {
    return loadDemandItemAuthorized(db, permit, itemTarget, id, false)
  }

  async function listDemandItems(permit: Permit, query: ListQueryInput & { demandId?: string }) {
    const q = normalizeList(query)
    const parts = [
      q.companyId ? sql`company_id = ${q.companyId}` : null,
      query.demandId ? sql`demand_id = ${query.demandId}` : null,
    ].filter(Boolean)
    // 列表用物理列 + 计算投影
    return listAuthorized({
      db,
      permit,
      target: itemTarget,
      alias: DEMAND_ITEM_TABLE,
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
      mapRow: mapDemandItemRecord,
    })
  }

  async function updateDemandItem(
    permit: Permit,
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
    return withTx(db, async (trx) => {
      const parent = await parentOf(trx, permit, id)
      if (parent.status !== 'draft') {
        throw new ApiError('conflict', '仅草稿履约需求单可编辑需求行')
      }
      const before = await lockItem(trx, permit, id)
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
        await writeAudit(trx, permit.actor, {
          resource: 'mfg_demand_item',
          recordId: id,
          recordLabel: String(after.idx),
          actionType: 'update',
          actionName: 'update',
          companyId: after.companyId,
          changes,
        })
      }
      return loadDemandItemAuthorized(trx, permit, itemTarget, id, false)
    })
  }

  async function deleteDemandItem(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const parent = await parentOf(trx, permit, id)
      if (parent.status !== 'draft') {
        throw new ApiError('conflict', '仅草稿履约需求单可编辑需求行')
      }
      const item = await lockItem(trx, permit, id)
      await trx.deleteFrom('mfg_demand_item').where('id', '=', id).execute()
      await writeAudit(trx, permit.actor, {
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

  async function confirmDemand(permit: Permit, id: string): Promise<Demand> {
    return withTx(db, async (trx) => {
      const before = await lockDemand(trx, permit, id)
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
      await writeAudit(trx, permit.actor, {
        resource: 'mfg_demand',
        recordId: id,
        recordLabel: after.demandNo,
        actionType: 'update',
        actionName: 'confirm',
        companyId: after.companyId,
        changes: auditDiff(demandSnap(before), demandSnap(after), DEMAND_AUDIT),
      })
      return loadDemandAuthorized(trx, permit, demandTarget, id, false)
    })
  }

  async function closeDemand(permit: Permit, id: string): Promise<Demand> {
    return transitionDemand(permit, id, 'close', 'confirmed', 'closed', '仅已确认履约需求单可关闭')
  }

  async function voidDemand(permit: Permit, id: string): Promise<Demand> {
    return withTx(db, async (trx) => {
      const before = await lockDemand(trx, permit, id)
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
      await writeAudit(trx, permit.actor, {
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

  /**
   * 下发/改派车间：已确认未关闭才可用（状态守卫留在领域层，抛 conflict）。
   * 车间必须与需求单同公司且未停用；不受操作者自身部门约束。
   */
  async function dispatchDemand(
    permit: Permit,
    id: string,
    assignedDeptId: string,
  ): Promise<Demand> {
    return withTx(db, async (trx) => {
      const before = await lockDemand(trx, permit, id)
      if (before.status !== 'confirmed') {
        throw new ApiError('conflict', '仅已确认未关闭履约需求单可下发或改派车间')
      }
      const deptId = await resolveAssignedDept(trx, before.companyId, assignedDeptId)
      if (deptId === null) {
        throw ApiError.validation('履约需求单参数不合法', { assignedDeptId: ['必填'] })
      }
      const after: Demand = { ...before, assignedDeptId: deptId }
      const changes = auditDiff(demandSnap(before), demandSnap(after), DEMAND_AUDIT)
      if (Object.keys(changes).length === 0) return before
      await trx
        .updateTable('mfg_demand')
        .set({ assigned_dept_id: deptId, updated_at: sql`(now() AT TIME ZONE 'utc')` })
        .where('id', '=', id)
        .execute()
      await writeAudit(trx, permit.actor, {
        resource: 'mfg_demand',
        recordId: id,
        recordLabel: after.demandNo,
        actionType: 'update',
        actionName: 'dispatch',
        companyId: after.companyId,
        changes,
      })
      return after
    })
  }

  async function transitionDemand(
    permit: Permit,
    id: string,
    action: string,
    from: DemandStatus,
    to: DemandStatus,
    message: string,
  ): Promise<Demand> {
    return withTx(db, async (trx) => {
      const before = await lockDemand(trx, permit, id)
      if (before.status !== from) throw new ApiError('conflict', message)
      await trx
        .updateTable('mfg_demand')
        .set({ status: to, updated_at: sql`(now() AT TIME ZONE 'utc')` })
        .where('id', '=', id)
        .execute()
      const after = { ...before, status: to }
      await writeAudit(trx, permit.actor, {
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
  async function completeDemandItem(permit: Permit, id: string): Promise<DemandItem> {
    return withTx(db, async (trx) => {
      const parent = await parentOf(trx, permit, id)
      const before = await lockItem(trx, permit, id)
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
      return loadDemandItemAuthorized(trx, permit, itemTarget, id, false)
    })
  }

  async function changeFulfillment(
    _permit: Permit,
    _id: string,
    _methodWire: string,
  ): Promise<DemandItem> {
    throw new ApiError(
      'conflict',
      '已取消行级履约方式，请使用安排（生产/采购/委外/库存/关闭）',
    )
  }

  async function createArrangement(
    permit: Permit,
    input: {
      demandItemId: string
      arrangementType: 'stock' | 'close'
      qty: string
      remarks?: string | null
    },
  ): Promise<DemandItem> {
    return withTx(db, async (trx) => {
      const parent = await parentOf(trx, permit, input.demandItemId)
      const before = await lockItem(trx, permit, input.demandItemId)
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
      const after = await loadDemandItemAuthorized(trx, permit, itemTarget, input.demandItemId, false)
      await writeAudit(trx, permit.actor, {
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

  async function removeArrangement(permit: Permit, arrangementId: string): Promise<DemandItem> {
    return withTx(db, async (trx) => {
      const arrangement = await trx
        .selectFrom('mfg_demand_arrangement')
        .select('demand_item_id')
        .where('id', '=', arrangementId)
        .executeTakeFirst()
      if (!arrangement) throw new ApiError('not_found', '安排不存在')
      // 先过授权闸再删（不可达的行连安排存在性都不该泄露）
      await lockItem(trx, permit, arrangement.demand_item_id)
      const { demandItemId } = await deleteManualArrangement(trx, arrangementId)
      return loadDemandItemAuthorized(trx, permit, itemTarget, demandItemId, false)
    })
  }

  async function listArrangements(permit: Permit, demandItemId: string) {
    await loadDemandItemAuthorized(db, permit, itemTarget, demandItemId, false)
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

  /**
   * 销售条目占用量：对给定销售条目按**全部已确认需求单**聚合（业务真值，非记录列表），
   * 故不叠加行级可见性——否则可占用量会随读者范围虚高。码级判定由 guard 完成。
   */
  async function salesOccupancies(
    _permit: Permit,
    ids: string[],
  ): Promise<SalesOccupancy[]> {
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
    dispatchDemand,
    completeDemandItem,
    changeFulfillment,
    createArrangement,
    removeArrangement,
    listArrangements,
    salesOccupancies,
  }
}

export type DemandService = ReturnType<typeof createDemandService>

/**
 * 下发车间校验：同公司 + 未停用（新下发不允许指向停用部门，对齐用户挂部门口径）。
 * 空值即「未下发」，不校验。
 */
async function resolveAssignedDept(
  db: DbHandle,
  companyId: string,
  deptId: string | null | undefined,
): Promise<string | null> {
  if (deptId == null || deptId === '') return null
  const row = await db
    .selectFrom('sys_department')
    .select(['company_id', 'enabled'])
    .where('id', '=', deptId)
    .executeTakeFirst()
  if (!row) {
    throw ApiError.validation('履约需求单参数不合法', { assignedDeptId: ['部门不存在'] })
  }
  if (row.company_id !== companyId) {
    throw ApiError.validation('履约需求单参数不合法', {
      assignedDeptId: ['车间必须属于需求单所在公司'],
    })
  }
  if (!row.enabled) {
    throw ApiError.validation('履约需求单参数不合法', { assignedDeptId: ['车间已停用'] })
  }
  return deptId
}

/** 按 Permit 取需求单行（可锁）；不命中一律 not_found。工单/入库服务共用 */
export async function loadDemandAuthorized(
  db: DbHandle,
  permit: Permit,
  target: AuthzTarget,
  id: string,
  forUpdate: boolean,
): Promise<Demand> {
  const row = await loadAuthorized({
    db,
    permit,
    target,
    table: DEMAND_TABLE,
    id,
    forUpdate,
    notFoundMessage: '履约需求单不存在',
  })
  return mapDemandRecord(row)
}

/** 按 Permit 取需求行（可锁）；via 链把判定递归到母单自身的行谓词 */
export async function loadDemandItemAuthorized(
  db: DbHandle,
  permit: Permit,
  target: AuthzTarget,
  id: string,
  forUpdate: boolean,
): Promise<DemandItem> {
  const row = await loadAuthorized({
    db,
    permit,
    target,
    table: DEMAND_ITEM_TABLE,
    id,
    forUpdate,
    notFoundMessage: '需求行不存在',
  })
  return mapDemandItemRecord(row)
}

function mapDemand(row: {
  id: string
  demand_no: string
  demand_date: Date | string
  remarks: string | null
  status: string
  company_id: string
  assigned_dept_id: string | null
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
    assignedDeptId: row.assigned_dept_id,
    createdById: row.created_by_id,
    insertedAt: new Date(row.inserted_at),
    updatedAt: new Date(row.updated_at),
  }
}

export function mapDemandRecord(r: Record<string, unknown>): Demand {
  return mapDemand({
    id: String(r.id),
    demand_no: String(r.demand_no),
    demand_date: r.demand_date as Date,
    remarks: r.remarks == null ? null : String(r.remarks),
    status: String(r.status),
    company_id: String(r.company_id),
    assigned_dept_id: r.assigned_dept_id == null ? null : String(r.assigned_dept_id),
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

export function mapDemandItemRecord(r: Record<string, unknown>): DemandItem {
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
    assigned_dept_id: item.assignedDeptId,
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
