/**
 * 履约需求：领域纯函数、投影映射、确认/作废 effect、工单派生受信任写、
 * 以及非标准动作（dispatch/安排/销售占用）。
 * 与 demand-service（标准派生装配）分离，便于把 service 压到行数预算内。
 */
import { decimal, toDecimalString } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { loadAuthorized } from '~/db/load.ts'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { syncDrawingAttachments } from '~/modules/trading/common.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { AuthzTarget } from '~/platform/meta/resource-authz.ts'
import type { StandardChildService } from '~/platform/standard/child.ts'
import { mapRow } from '~/platform/standard/fields.ts'
import {
  attachArrangementFields,
  createManualArrangement,
  deleteManualArrangement,
  hardRemainingArrangeable,
} from './arrangement.ts'
import { mfgWriteError, numStr } from './helpers.ts'
import { demandItemResourceMeta, demandResourceMeta } from './meta.ts'
import type {
  Demand,
  DemandAssignType,
  DemandItem,
  FulfillmentMethod,
  SalesOccupancy,
} from './types.ts'

export const DEMAND_RESOURCE = 'mfgDemands'
export const DEMAND_ITEM_RESOURCE = 'mfgDemandItems'

export const DEMAND_TABLE = 'mfg_demand'
export const DEMAND_ITEM_TABLE = 'mfg_demand_item'

export const DEMAND_AUDIT = auditFieldsOf(demandResourceMeta())
export const ITEM_AUDIT = auditFieldsOf(demandItemResourceMeta())

const ASSIGN_TYPES: readonly DemandAssignType[] = ['PURCHASE', 'MAKE', 'STOCK', 'CLOSE']

/** 指派类型入参归一（接受大小写；空即缺）：草稿保存即必填；wire 形大写 */
export function parseAssignType(value: string | null | undefined): DemandAssignType {
  const v = (value ?? '').trim().toUpperCase()
  if ((ASSIGN_TYPES as readonly string[]).includes(v)) return v as DemandAssignType
  throw ApiError.validation('履约需求单参数不合法', {
    assignType: ['必填,只能为 采购/生产/库存/关闭'],
  })
}

/** 指派类型 ⇔ 下发车间联动：生产必填车间，其余类型必须为空 */
export function assertAssignLink(
  assignType: DemandAssignType,
  assignedDeptId: string | null,
): void {
  if (assignType === 'MAKE' && assignedDeptId == null) {
    throw ApiError.validation('履约需求单参数不合法', {
      assignedDeptId: ['指派类型为生产时下发车间必填'],
    })
  }
  if (assignType !== 'MAKE' && assignedDeptId != null) {
    throw ApiError.validation('履约需求单参数不合法', {
      assignedDeptId: ['仅指派类型为生产时可填下发车间'],
    })
  }
}

/**
 * 下发车间校验：同公司 + 未停用。空值即「未下发」，不校验。
 */
export async function resolveAssignedDept(
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

/** 确认占量：校验销售来源条目可占用 */
export async function effectConfirmOccupy(
  trx: DbHandle,
  before: Record<string, unknown>,
): Promise<void> {
  const id = String(before.id)
  const companyId = String(before.companyId)
  const count = await trx
    .selectFrom('mfg_demand_item')
    .select((eb) => eb.fn.countAll<string>().as('c'))
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
    if (so.company_id !== companyId) {
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
    // 占用上限 = 订购 base + 该条目已审核销售退货量（挂源行部分）——客户退回后仍欠客户的量
    // （ADR 2026-08-09；无退货时退化为订购 base）。校验时点不变（确认时）
    const ret = await sql<{ q: string }>`
      SELECT coalesce(sum(ri.base_qty), 0)::text AS q
      FROM sal_return_item ri
      JOIN sal_return rh ON rh.id = ri.return_id
      WHERE ri.order_item_id = ${salesId}
        AND rh.status = 'audited'
    `.execute(trx)
    const limit = ordered.add(decimal(ret.rows[0]?.q ?? '0'))
    if (occupied.add(add).gt(limit)) {
      throw new ApiError(
        'conflict',
        `超出销售订单可占用数量(已占用${occupied},剩余${limit.sub(occupied)},本单${add})`,
      )
    }
  }
}

/** 作废下游拦截：未作废工单 / 已审核采购占量 */
export async function effectVoidDownstream(
  trx: DbHandle,
  before: Record<string, unknown>,
): Promise<void> {
  const id = String(before.id)
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
}

export function presentHead(row: Record<string, unknown>): Demand {
  return row as unknown as Demand
}

export function presentItem(row: Record<string, unknown>): DemandItem {
  const item = row as unknown as DemandItem
  if (item.remainingArrangeableQty == null || item.remainingOrderableQty == null) {
    return attachArrangementFields(item)
  }
  return item
}

export function mapItemExtras(row: Record<string, unknown>) {
  return {
    ordered: Boolean(row.ordered),
    remainingOrderableQty: numStr(row.remaining_orderable_qty),
    remainingArrangeableQty: numStr(row.remaining_arrangeable_qty),
  }
}

export function demandSnap(item: Demand) {
  return {
    demand_no: item.demandNo,
    demand_date: item.demandDate,
    assign_type: String(item.assignType).toLowerCase(),
    need_date: item.needDate,
    remarks: item.remarks,
    status: String(item.status).toLowerCase(),
    company_id: item.companyId,
    assigned_dept_id: item.assignedDeptId,
    created_by_id: item.createdById,
  }
}

export function itemSnap(item: DemandItem) {
  return {
    idx: item.idx,
    qty: item.qty,
    base_qty: item.baseQty,
    ordered_qty: item.orderedQty,
    received_qty: item.receivedQty,
    arranged_qty: item.arrangedQty,
    completed_qty: item.completedQty,
    need_date: item.needDate,
    fulfillment_method: item.fulfillmentMethod
      ? String(item.fulfillmentMethod).toLowerCase()
      : null,
    status: String(item.status).toLowerCase(),
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
    source_work_order_id: item.sourceWorkOrderId,
  }
}

export function mapDemandRecord(r: Record<string, unknown>): Demand {
  return mapRow(demandResourceMeta(), r) as unknown as Demand
}

export function mapDemandItemRecord(r: Record<string, unknown>): DemandItem {
  const item = mapRow(demandItemResourceMeta(), r) as unknown as DemandItem
  if (item.idx != null) item.idx = Number(item.idx)
  if (r.ordered !== undefined) item.ordered = Boolean(r.ordered)
  if (r.remaining_orderable_qty !== undefined) {
    item.remainingOrderableQty = numStr(r.remaining_orderable_qty)
  }
  if (r.remaining_arrangeable_qty !== undefined) {
    item.remainingArrangeableQty = numStr(r.remaining_arrangeable_qty)
  }
  if (item.remainingArrangeableQty == null) {
    attachArrangementFields(item)
  }
  if (item.fulfillmentMethod != null) {
    item.fulfillmentMethod = String(item.fulfillmentMethod).toUpperCase() as FulfillmentMethod
  }
  return item
}

function mapDemand(row: {
  id: string
  demand_no: string
  demand_date: Date | string
  assign_type: string
  need_date: Date | string | null
  remarks: string | null
  status: string
  company_id: string
  assigned_dept_id: string | null
  created_by_id: string | null
  inserted_at: Date
  updated_at: Date
}): Demand {
  return mapDemandRecord(row as unknown as Record<string, unknown>)
}

function mapDemandItem(row: Record<string, unknown>): DemandItem {
  return attachArrangementFields(mapDemandItemRecord(row))
}

/** 按 Permit 取需求单（可锁）；不命中一律 not_found。工单/入库服务共用 */
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

export async function parentOf(
  trx: DbHandle,
  permit: Permit,
  demandTarget: AuthzTarget,
  itemId: string,
): Promise<Demand> {
  const row = await trx
    .selectFrom('mfg_demand_item')
    .select('demand_id')
    .where('id', '=', itemId)
    .executeTakeFirst()
  if (!row) throw new ApiError('not_found', '需求行不存在')
  return loadDemandAuthorized(trx, permit, demandTarget, row.demand_id, true)
}

/** 派生需求行（受信任写输入） */
export interface DerivedDemandLine {
  idx: number
  materialId: string
  unitId: string
  qty: string
  baseQty: string
  needDate: string
  sourceWorkOrderId: string | null
  /** 销售来源（退货补货派生写入；与 sourceWorkOrderId 互斥，DB CHECK 兜底） */
  salesOrderItemId?: string | null
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitName: string
  /** 行备注（退货补货派生写来源线索；工单派生为空） */
  remarks?: string | null
}

/**
 * 受信任写：工单「生成物料需求」/销售退货「生成补货需求单」动作内直接落需求单头+行。
 */
export async function insertDerivedDemand(
  trx: DbHandle,
  actor: Permit['actor'],
  input: {
    companyId: string
    demandNo: string
    demandDate: string
    remarks: string
    assignType: DemandAssignType | 'purchase' | 'make' | 'stock' | 'close'
    assignedDeptId: string | null
    /** 退货补货来源留痕（销售退货派生写入） */
    sourceReturnId?: string | null
    lines: DerivedDemandLine[]
  },
): Promise<{ id: string; demandNo: string; assignedDeptId: string | null }> {
  const assignDb = String(input.assignType).toLowerCase()
  try {
    const head = await trx
      .insertInto('mfg_demand')
      .values({
        demand_no: input.demandNo,
        demand_date: input.demandDate,
        assign_type: assignDb,
        remarks: input.remarks,
        status: 'draft',
        company_id: input.companyId,
        assigned_dept_id: input.assignedDeptId,
        source_return_id: input.sourceReturnId ?? null,
        created_by_id: actor.userId || null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    const demand = mapDemand(head)
    await writeAudit(trx, actor, {
      resource: 'mfg_demand',
      recordId: demand.id,
      recordLabel: demand.demandNo,
      actionType: 'create',
      actionName: 'create',
      companyId: demand.companyId,
      changes: auditCreated(demandSnap(demand), DEMAND_AUDIT),
    })
    for (const line of input.lines) {
      const row = await trx
        .insertInto('mfg_demand_item')
        .values({
          demand_id: demand.id,
          company_id: input.companyId,
          idx: String(line.idx),
          material_id: line.materialId,
          unit_id: line.unitId,
          qty: line.qty,
          base_qty: line.baseQty,
          need_date: line.needDate,
          fulfillment_method: null,
          status: 'pending',
          sales_order_item_id: line.salesOrderItemId ?? null,
          source_work_order_id: line.sourceWorkOrderId,
          material_code: line.materialCode,
          material_name: line.materialName,
          material_spec: line.materialSpec,
          unit_name: line.unitName,
          remarks: line.remarks ?? null,
          ordered_qty: '0',
          received_qty: '0',
          arranged_qty: '0',
          completed_qty: '0',
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      await syncDrawingAttachments(trx, 'mfg_demand_item', row.id, line.materialId, input.companyId)
      const item = mapDemandItem(row as unknown as Record<string, unknown>)
      await writeAudit(trx, actor, {
        resource: 'mfg_demand_item',
        recordId: item.id,
        recordLabel: String(item.idx),
        actionType: 'create',
        actionName: 'create',
        companyId: item.companyId,
        changes: auditCreated(itemSnap(item), ITEM_AUDIT),
      })
    }
    return { id: demand.id, demandNo: demand.demandNo, assignedDeptId: demand.assignedDeptId }
  } catch (err) {
    throw mfgWriteError('生成物料需求失败', err)
  }
}

/**
 * 受信任写：工单作废/删除的派生级联。
 */
export async function cascadeDeleteDerivedDrafts(
  trx: DbHandle,
  actor: Permit['actor'],
  workOrderId: string,
): Promise<{ deletedDemandNos: string[]; confirmedDemandNos: string[] }> {
  const heads = await trx
    .selectFrom('mfg_demand')
    .selectAll()
    .where('id', 'in', (qb) =>
      qb
        .selectFrom('mfg_demand_item')
        .select('demand_id')
        .where('source_work_order_id', '=', workOrderId)
        .distinct(),
    )
    .execute()
  const deletedDemandNos: string[] = []
  const confirmedDemandNos: string[] = []
  for (const head of heads) {
    if (head.status === 'confirmed') {
      confirmedDemandNos.push(head.demand_no)
      continue
    }
    if (head.status !== 'draft') continue
    await sql`
      DELETE FROM sys_attachment
      WHERE owner_type = 'mfg_demand_item'
        AND owner_id IN (SELECT id FROM mfg_demand_item WHERE demand_id = ${head.id}::uuid)
    `.execute(trx)
    await trx.deleteFrom('mfg_demand').where('id', '=', head.id).execute()
    const demand = mapDemand(head)
    await writeAudit(trx, actor, {
      resource: 'mfg_demand',
      recordId: demand.id,
      recordLabel: demand.demandNo,
      actionType: 'destroy',
      actionName: 'destroy',
      companyId: demand.companyId,
      changes: auditDestroyed(demandSnap(demand), DEMAND_AUDIT),
    })
    deletedDemandNos.push(demand.demandNo)
  }
  return { deletedDemandNos, confirmedDemandNos }
}

/** 非标准动作：dispatch / 安排 / 销售占用（手写编排，不进聚合草稿） */
export function createDemandSideActions(
  db: Kysely<Database>,
  demandTarget: AuthzTarget,
  itemTarget: AuthzTarget,
  items: StandardChildService<DemandItem>,
) {
  async function dispatchDemand(
    permit: Permit,
    id: string,
    input: { assignType?: string | null; assignedDeptId?: string | null },
  ): Promise<Demand> {
    return withTx(db, async (trx) => {
      const before = await loadDemandAuthorized(trx, permit, demandTarget, id, true)
      if (before.status !== 'CONFIRMED') {
        throw new ApiError('conflict', '仅已确认未关闭履约需求单可下发或改派')
      }
      const assignType =
        input.assignType !== undefined ? parseAssignType(input.assignType) : before.assignType
      const deptId =
        input.assignedDeptId !== undefined
          ? await resolveAssignedDept(trx, before.companyId, input.assignedDeptId)
          : before.assignedDeptId
      assertAssignLink(assignType, deptId)
      const after: Demand = { ...before, assignType, assignedDeptId: deptId }
      const changes = auditDiff(demandSnap(before), demandSnap(after), DEMAND_AUDIT)
      if (Object.keys(changes).length === 0) return before
      await trx
        .updateTable('mfg_demand')
        .set({
          assign_type: assignType.toLowerCase(),
          assigned_dept_id: deptId,
          updated_at: sql`(now() AT TIME ZONE 'utc')`,
        })
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

  async function completeDemandItem(permit: Permit, id: string): Promise<DemandItem> {
    return withTx(db, async (trx) => {
      const parent = await parentOf(trx, permit, demandTarget, id)
      const before = await loadDemandItemAuthorized(trx, permit, itemTarget, id, true)
      if (parent.status !== 'CONFIRMED') {
        throw new ApiError('conflict', '仅已确认未关闭需求单上的行可登记库存安排')
      }
      const rem = hardRemainingArrangeable(before.baseQty, before.arrangedQty)
      if (!decimal(rem).gt(0)) throw new ApiError('conflict', '无可安排剩余数量')
      const factor = decimal(before.baseQty).eq(0)
        ? decimal(1)
        : decimal(before.qty).div(decimal(before.baseQty))
      await createManualArrangement(trx, {
        demandItemId: id,
        companyId: before.companyId,
        type: 'stock',
        qty: toDecimalString(decimal(rem).mul(factor)),
        unitBaseQtyPerUnit: decimal(before.qty).eq(0)
          ? '1'
          : toDecimalString(decimal(before.baseQty).div(decimal(before.qty))),
        remarks: '兼容点完成→库存安排',
      })
      return presentItem(await items.getOn(trx, permit, id))
    })
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
      const parent = await parentOf(trx, permit, demandTarget, input.demandItemId)
      const before = await loadDemandItemAuthorized(trx, permit, itemTarget, input.demandItemId, true)
      if (parent.status !== 'CONFIRMED') {
        throw new ApiError('conflict', '仅已确认未关闭需求单上的行可手工安排')
      }
      const unitBase = decimal(before.qty).eq(0)
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
      const after = presentItem(await items.getOn(trx, permit, input.demandItemId))
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
      await loadDemandItemAuthorized(trx, permit, itemTarget, arrangement.demand_item_id, true)
      const { demandItemId } = await deleteManualArrangement(trx, arrangementId)
      return presentItem(await items.getOn(trx, permit, demandItemId))
    })
  }

  async function listArrangements(permit: Permit, demandItemId: string) {
    await items.get(permit, demandItemId)
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
    _permit: Permit,
    ids: string[],
  ): Promise<SalesOccupancy[]> {
    if (ids.length === 0) return []
    const rows = await sql<{ id: string; ordered: string; occupied: string }>`
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
    dispatchDemand,
    completeDemandItem,
    createArrangement,
    removeArrangement,
    listArrangements,
    salesOccupancies,
    changeFulfillment: async (_p: Permit, _id: string, _m: string): Promise<DemandItem> => {
      throw new ApiError(
        'conflict',
        '已取消行级履约方式，请使用安排（生产/采购/委外/库存/关闭）',
      )
    },
  }
}

