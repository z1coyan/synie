/**
 * 生产工单：由已确认需求行生成；完工回写在生产入库服务中。
 *
 * 授权全由平台承担（工单 07）：服务只收 Permit，行谓词由 `loadAuthorized`/`listAuthorized` 编译。
 * 归属部门形态（stamped）：创建时由平台写侧 `withOwnershipStamp` 按创建人部门盖 `owner_dept_id`，
 * 不可手填；无部门用户创建即 NULL（只有 all 范围看得见）。
 * 从需求行建单的路由额外要求 `mfg.demand:read`（guard allOf），故来源单据的行级可达性同样成立。
 */
import { decimal, isDecimalString, roundBaseQty, toDecimalString } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { InventoryEngine } from '~/engines/inventory/index.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { listAuthorized } from '~/db/list.ts'
import { loadAuthorized, withOwnershipStamp } from '~/db/load.ts'
import { utcToday } from '~/db/dates.ts'
import { syncDrawingAttachments } from '~/modules/trading/common.ts'
import {
  DEMAND_ITEM_RESOURCE,
  DEMAND_RESOURCE,
  cascadeDeleteDerivedDrafts,
  insertDerivedDemand,
  loadDemandAuthorized,
  loadDemandItemAuthorized,
  resolveAssignedDept,
} from './demand-service.ts'
import {
  asDateOrNull,
  deriveItemProjection,
  ensureMaterial,
  ensureUnitAllowed,
  mfgWriteError,
  normalizeList,
  numStr,
  parsePositiveQty,
  runeCount,
  trimOptional,
  validateNo,
} from './helpers.ts'
import {
  hardRemainingArrangeable,
  removeMakeArrangementByWorkOrder,
  upsertMakeArrangement,
} from './arrangement.ts'
import type { AuthzTarget } from '~/platform/meta/resource-authz.ts'
import { workOrderResourceMeta } from './meta.ts'
import type { ItemProjection } from './helpers.ts'
import type { Bom, ListQueryInput, WorkOrder, WorkOrderStatus } from './types.ts'

export const WORK_ORDER_RESOURCE = 'mfgWorkOrders'
const WORK_ORDER_TABLE = 'mfg_work_order'
const WO_AUDIT = auditFieldsOf(workOrderResourceMeta())

/** 生成物料需求请求行：未出现的配料行即「不需要」 */
export interface MaterialDemandLineInput {
  componentId: string
  /** 数量（行单位=快照配料行单位）；不设硬顶，允许大于毛需求 */
  qty: string
  target: { kind: 'dept'; deptId: string } | { kind: 'purchase' }
}

export interface MaterialDemandResult {
  /** 生成的需求单草稿（id + 单号 + 去向） */
  demands: Array<{ id: string; demandNo: string; assignedDeptId: string | null }>
  /** 服务端算出的每行毛需求回显（行单位） */
  lines: Array<{
    componentId: string
    materialId: string
    unitId: string
    grossQty: string
  }>
  /** 重复生成警告（票 04）：已有未删除派生草稿且未带 force——此时不生成，demands/lines 为空 */
  warning: { existingDraftDemandNos: string[] } | null
}

/** 「生成物料需求」弹窗取数行（票 02）：毛需求/参考库存/默认数量均折算到行单位，6 位 */
export interface MaterialDemandPreviewLine {
  componentId: string
  materialId: string
  unitId: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitName: string
  /** 毛需求 = 净用量 ×(1+损耗率,空按 1)× 工单 base 数量（理论耗用口径） */
  grossQty: string
  /** 参考库存：本公司全部仓库现货合计（库存引擎 balance 跨仓聚合），纯快照 */
  stockQty: string
  /** 默认数量 = 毛需求 − 参考库存（下限 0）；人可改、允许大于毛需求 */
  defaultQty: string
  /** 参考库存 ≥ 毛需求：默认去向「不需要」（仍可改） */
  covered: boolean
}

interface PreparedLine {
  componentId: string
  materialId: string
  unitId: string
  qty: string
  baseQty: string
  grossQty: string
  projection: ItemProjection
  deptId: string | null
}

export function createWorkOrderService(
  db: Kysely<Database>,
  numbering: NumberingService,
  registry: Registry,
  inventory: InventoryEngine,
) {
  const target = registry.authzTarget(WORK_ORDER_RESOURCE)
  const demandTarget = registry.authzTarget(DEMAND_RESOURCE)
  const demandItemTarget = registry.authzTarget(DEMAND_ITEM_RESOURCE)

  const lockWorkOrder = (trx: DbHandle, permit: Permit, id: string) =>
    loadWorkOrderAuthorized(trx, permit, target, id, true)

  async function createWorkOrder(
    permit: Permit,
    input: {
      demandItemId: string
      workOrderNo?: string | null
      /** 行单位数量；默认=剩余可安排折回行单位 */
      qty?: string | null
      /** 可选：本物料启用中 BOM，创建时快照 */
      bomId?: string | null
    },
  ): Promise<WorkOrder> {
    return withTx(db, async (trx) => {
      const item = await loadDemandItemAuthorized(
        trx,
        permit,
        demandItemTarget,
        input.demandItemId,
        true,
      )
      const parent = await loadDemandAuthorized(trx, permit, demandTarget, item.demandId, true)
      if (parent.status !== 'confirmed') {
        throw new ApiError('conflict', '仅已确认未关闭需求单的行可生成工单')
      }
      if (item.status === 'completed') {
        throw new ApiError('conflict', '已完成的需求行不可生成工单')
      }
      const remBase = hardRemainingArrangeable(item.baseQty, item.arrangedQty)
      if (!decimal(remBase).gt(0)) {
        throw new ApiError('conflict', '需求行无可安排剩余数量')
      }
      await ensureMaterial(trx, item.materialId, ['STOCK'], '生产工单')
      const factor = decimal(item.baseQty).eq(0)
        ? decimal(1)
        : decimal(item.qty).div(decimal(item.baseQty))
      const defaultQty = toDecimalString(decimal(remBase).mul(factor))
      const qty = parsePositiveQty(input.qty?.trim() ? input.qty : defaultQty, 'qty')
      const baseQty = toDecimalString(
        decimal(item.qty).eq(0)
          ? decimal(qty)
          : decimal(qty).mul(decimal(item.baseQty).div(decimal(item.qty))),
      )
      const needDate = item.needDate ?? utcToday()
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
          // 归属部门盖章由平台按 meta 声明并入（列名不在模块里写死）
          .values(
            withOwnershipStamp(
              {
                work_order_no: no,
                qty,
                base_qty: baseQty,
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
                bom_id: null,
                created_by_id: permit.actor.userId || null,
              },
              permit,
              target,
            ),
          )
          .returningAll()
          .executeTakeFirstOrThrow()
        await upsertMakeArrangement(trx, {
          demandItemId: item.id,
          companyId: item.companyId,
          workOrderId: row.id,
          qty,
          baseQty,
        })
        // 创建时复制物料图纸挂接（无图不拦）
        await syncDrawingAttachments(
          trx,
          'mfg_work_order',
          row.id,
          item.materialId,
          item.companyId,
        )
        if (input.bomId) {
          await copyBomSnapshotToWorkOrder(trx, row.id, input.bomId, item.materialId)
        }
        const result = await loadWorkOrderAuthorized(trx, permit, target, row.id, false)
        await writeAudit(trx, permit.actor, {
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

  async function getWorkOrder(permit: Permit, id: string): Promise<WorkOrder> {
    return loadWorkOrderAuthorized(db, permit, target, id, false)
  }

  async function listWorkOrders(permit: Permit, query: ListQueryInput) {
    const q = normalizeList(query)
    return listAuthorized({
      db,
      permit,
      target,
      alias: WORK_ORDER_TABLE,
      resource: workOrderResourceMeta(),
      source: sql` FROM (
        SELECT w.*,
          (w.base_qty - w.received_base_qty) AS remaining_base_qty
        FROM mfg_work_order w
      ) AS mfg_work_order`,
      select: sql`SELECT *`,
      defaultOrder: sql`"inserted_at" DESC, "id" DESC`,
      query: q,
      extraWhere: q.companyId ? sql`company_id = ${q.companyId}` : null,
      mapRow: mapWorkOrderRecord,
    })
  }

  async function updateWorkOrder(
    permit: Permit,
    id: string,
    input: { workOrderNo: string },
  ): Promise<WorkOrder> {
    const no = input.workOrderNo.trim()
    validateNo(no, 'workOrderNo')
    return withTx(db, async (trx) => {
      const before = await lockWorkOrder(trx, permit, id)
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
        await writeAudit(trx, permit.actor, {
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

  async function deleteWorkOrder(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const item = await lockWorkOrder(trx, permit, id)
      if (item.status !== 'in_progress' && item.status !== 'voided') {
        throw new ApiError('conflict', '仅进行中的生产工单可删除')
      }
      if (await hasAuditedOutput(trx, id)) {
        throw new ApiError('conflict', '存在已审核生产入库,不可删除工单')
      }
      try {
        await removeMakeArrangementByWorkOrder(trx, id)
        // 删除同作废级联（票 04）：先清本工单派生的草稿态需求单（头+行级联、写删除审计）；
        // 已确认派生单引用的工单由行 FK 天然拦截删除
        await cascadeDeleteDerivedDrafts(trx, permit.actor, id)
        await sql`
          DELETE FROM sys_attachment
          WHERE owner_type = 'mfg_work_order' AND owner_id = ${id}::uuid
        `.execute(trx)
        await trx.deleteFrom('mfg_work_order').where('id', '=', id).execute()
      } catch (err) {
        throw mfgWriteError('删除生产工单失败', err)
      }
      await writeAudit(trx, permit.actor, {
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

  async function voidWorkOrder(
    permit: Permit,
    id: string,
  ): Promise<{ workOrder: WorkOrder; confirmedDerivedDemandNos: string[] }> {
    return withTx(db, async (trx) => {
      const before = await lockWorkOrder(trx, permit, id)
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
      await removeMakeArrangementByWorkOrder(trx, id)
      // 作废级联（票 04）：物理删除本工单派生的草稿态需求单（头+行级联、写删除审计）；
      // 已确认派生单不动，单号带进响应警告名单（additive），只警告不拦截
      const cascade = await cascadeDeleteDerivedDrafts(trx, permit.actor, id)
      const after = { ...before, status: 'voided' as WorkOrderStatus }
      await writeAudit(trx, permit.actor, {
        resource: 'mfg_work_order',
        recordId: id,
        recordLabel: after.workOrderNo,
        actionType: 'update',
        actionName: 'void',
        companyId: after.companyId,
        changes: auditDiff(woSnap(before), woSnap(after), WO_AUDIT),
      })
      return { workOrder: after, confirmedDerivedDemandNos: cascade.confirmedDemandNos }
    })
  }

  /** 选 BOM：校验启用+本物料，快照复制；有已审核入库则拒 */
  async function applyBom(permit: Permit, workOrderId: string, bomId: string | null): Promise<WorkOrder> {
    return withTx(db, async (trx) => {
      const before = await lockWorkOrder(trx, permit, workOrderId)
      if (before.status !== 'in_progress') {
        throw new ApiError('conflict', '仅进行中的生产工单可改 BOM')
      }
      if (await hasAuditedOutput(trx, workOrderId)) {
        throw new ApiError('conflict', '存在已审核生产入库,不可改 BOM 快照')
      }
      if (!bomId) {
        await clearWorkOrderBomSnapshot(trx, workOrderId)
        await trx
          .updateTable('mfg_work_order')
          .set({ bom_id: null, updated_at: sql`(now() AT TIME ZONE 'utc')` })
          .where('id', '=', workOrderId)
          .execute()
        return loadWorkOrderAuthorized(trx, permit, target, workOrderId, false)
      }
      await copyBomSnapshotToWorkOrder(trx, workOrderId, bomId, before.materialId)
      const after = await loadWorkOrderAuthorized(trx, permit, target, workOrderId, false)
      await writeAudit(trx, permit.actor, {
        resource: 'mfg_work_order',
        recordId: workOrderId,
        recordLabel: after.workOrderNo,
        actionType: 'update',
        actionName: 'apply_bom',
        companyId: after.companyId,
        changes: { bom_id: { from: before.bomId, to: bomId } },
      })
      return after
    })
  }

  async function getBomSnapshot(permit: Permit, workOrderId: string) {
    const wo = await loadWorkOrderAuthorized(db, permit, target, workOrderId, false)
    const components = await db
      .selectFrom('mfg_work_order_component as c')
      .innerJoin('inv_material as m', 'm.id', 'c.material_id')
      .innerJoin('bas_unit as u', 'u.id', 'c.unit_id')
      .select([
        'c.id',
        'c.material_id',
        'c.unit_id',
        'c.quantity',
        'c.loss_rate',
        'c.note',
        'm.code as material_code',
        'm.name as material_name',
        'm.spec as material_spec',
        'u.name as unit_name',
      ])
      .where('c.work_order_id', '=', workOrderId)
      .orderBy('c.idx', 'asc')
      .execute()
    const routes = await db
      .selectFrom('mfg_work_order_route')
      .selectAll()
      .where('work_order_id', '=', workOrderId)
      .orderBy('seq', 'asc')
      .execute()
    const byproducts = await db
      .selectFrom('mfg_work_order_byproduct')
      .selectAll()
      .where('work_order_id', '=', workOrderId)
      .orderBy('idx', 'asc')
      .execute()
    return {
      bomId: wo.bomId,
      components: components.map((c) => ({
        id: c.id,
        materialId: c.material_id,
        unitId: c.unit_id,
        quantity: numStr(c.quantity),
        lossRate: c.loss_rate == null ? null : numStr(c.loss_rate),
        note: c.note,
        // 物料/单位名称快照 join（派生弹窗展示）；毛需求=理论耗用口径，服务端算好供默认数量
        materialCode: c.material_code,
        materialName: c.material_name,
        materialSpec: c.material_spec,
        unitName: c.unit_name,
        grossQty: grossRequirement(c.quantity, c.loss_rate, wo.baseQty),
      })),
      routes: routes.map((r) => ({
        id: r.id,
        operationId: r.operation_id,
        seq: Number(r.seq),
        requirement: r.requirement,
        isOutsourced: r.is_outsourced,
      })),
      byproducts: byproducts.map((b) => ({
        id: b.id,
        materialId: b.material_id,
        unitId: b.unit_id,
        quantity: numStr(b.quantity),
        note: b.note,
      })),
    }
  }

  /**
   * 工单内嵌创建 BOM：母物料锁=工单物料，保存即启用并快照到本工单。
   * 需同时具备 mfg.bom:create 与 mfg.work_order:update（路由 guard allOf 一次判定）。
   */
  async function createInlineBom(
    permit: Permit,
    workOrderId: string,
    input: {
      code?: string | null
      planName?: string | null
      note?: string | null
      components?: Array<{
        materialId: string
        unitId: string
        quantity: string
        lossRate?: string | null
        note?: string | null
      }>
      routes?: Array<{
        operationId: string
        seq: number
        requirement?: string | null
        isOutsourced?: boolean
      }>
      byproducts?: Array<{
        materialId: string
        unitId: string
        quantity: string
        note?: string | null
      }>
    },
  ): Promise<{ workOrder: WorkOrder; bom: Bom }> {
    return withTx(db, async (trx) => {
      const wo = await lockWorkOrder(trx, permit, workOrderId)
      if (wo.status !== 'in_progress') {
        throw new ApiError('conflict', '仅进行中的生产工单可内嵌创建 BOM')
      }
      if (await hasAuditedOutput(trx, workOrderId)) {
        throw new ApiError('conflict', '存在已审核生产入库,不可改 BOM 快照')
      }
      await ensureMaterial(trx, wo.materialId)
      const planName = trimOptional(input.planName)
      const note = trimOptional(input.note)
      let code = (input.code ?? '').trim()
      if (runeCount(code) > 32) {
        throw ApiError.validation('BOM参数不合法', { code: ['最多 32 个字符'] })
      }
      if (planName && runeCount(planName) > 64) {
        throw ApiError.validation('BOM参数不合法', { planName: ['最多 64 个字符'] })
      }
      if (note && runeCount(note) > 255) {
        throw ApiError.validation('BOM参数不合法', { note: ['最多 255 个字符'] })
      }
      if (!code) {
        code = await numbering.nextInTx(trx, {
          resource: 'mfg.bom',
          values: { material_id: wo.materialId },
        })
      }
      let bomRow
      try {
        bomRow = await trx
          .insertInto('mfg_bom')
          .values({
            code,
            plan_name: planName,
            note,
            material_id: wo.materialId,
            status: 'active',
          })
          .returningAll()
          .executeTakeFirstOrThrow()
      } catch (err) {
        throw mfgWriteError('创建BOM失败', err, [
          { code: '23505', message: 'BOM 编号已存在' },
        ])
      }
      const bom: Bom = {
        id: bomRow.id,
        code: bomRow.code,
        planName: bomRow.plan_name,
        note: bomRow.note,
        materialId: bomRow.material_id,
        status: 'active',
        insertedAt: new Date(bomRow.inserted_at),
        updatedAt: new Date(bomRow.updated_at),
      }
      await writeAudit(trx, permit.actor, {
        resource: 'mfg_bom',
        recordId: bom.id,
        recordLabel: bom.code,
        actionType: 'create',
        actionName: 'create_inline_from_work_order',
        changes: auditCreated(
          {
            code: bom.code,
            plan_name: bom.planName,
            note: bom.note,
            material_id: bom.materialId,
            status: bom.status,
          },
          ['code', 'plan_name', 'note', 'material_id', 'status'],
        ),
      })

      for (const c of input.components ?? []) {
        if (c.materialId === wo.materialId) {
          throw ApiError.validation('BOM行参数不合法', {
            materialId: ['行物料不能是 BOM 物料自身'],
          })
        }
        if (!isDecimalString(c.quantity) || !decimal(c.quantity).gt(0)) {
          throw ApiError.validation('BOM行参数不合法', { quantity: ['必须大于 0'] })
        }
        let lossRate: string | null = null
        if (c.lossRate != null && c.lossRate !== '') {
          if (!isDecimalString(c.lossRate) || decimal(c.lossRate).isNegative()) {
            throw ApiError.validation('BOM行参数不合法', {
              lossRate: ['须为非负十进制数字'],
            })
          }
          lossRate = toDecimalString(decimal(c.lossRate))
        }
        await ensureMaterial(trx, c.materialId, ['STOCK'], 'BOM行')
        await ensureUnitAllowed(trx, c.materialId, c.unitId)
        await trx
          .insertInto('mfg_bom_component')
          .values({
            bom_id: bom.id,
            material_id: c.materialId,
            unit_id: c.unitId,
            quantity: toDecimalString(decimal(c.quantity)),
            loss_rate: lossRate,
            note: trimOptional(c.note),
          })
          .execute()
      }
      for (const r of input.routes ?? []) {
        if (!Number.isInteger(r.seq)) {
          throw ApiError.validation('BOM路线参数不合法', { seq: ['须为整数'] })
        }
        await trx
          .insertInto('mfg_bom_route')
          .values({
            bom_id: bom.id,
            operation_id: r.operationId,
            seq: String(r.seq),
            requirement: trimOptional(r.requirement),
            is_outsourced: r.isOutsourced ?? false,
          })
          .execute()
      }
      for (const b of input.byproducts ?? []) {
        if (b.materialId === wo.materialId) {
          throw ApiError.validation('BOM行参数不合法', {
            materialId: ['副产品不能是 BOM 物料自身'],
          })
        }
        if (!isDecimalString(b.quantity) || !decimal(b.quantity).gt(0)) {
          throw ApiError.validation('BOM行参数不合法', { quantity: ['必须大于 0'] })
        }
        await ensureMaterial(trx, b.materialId, ['STOCK'], 'BOM行')
        await ensureUnitAllowed(trx, b.materialId, b.unitId)
        await trx
          .insertInto('mfg_bom_byproduct')
          .values({
            bom_id: bom.id,
            material_id: b.materialId,
            unit_id: b.unitId,
            quantity: toDecimalString(decimal(b.quantity)),
            note: trimOptional(b.note),
          })
          .execute()
      }

      // 清空旧快照并复制新 BOM
      await trx
        .deleteFrom('mfg_work_order_component')
        .where('work_order_id', '=', workOrderId)
        .execute()
      await trx.deleteFrom('mfg_work_order_route').where('work_order_id', '=', workOrderId).execute()
      await trx
        .deleteFrom('mfg_work_order_byproduct')
        .where('work_order_id', '=', workOrderId)
        .execute()
      const components = await trx
        .selectFrom('mfg_bom_component')
        .selectAll()
        .where('bom_id', '=', bom.id)
        .execute()
      const routes = await trx
        .selectFrom('mfg_bom_route')
        .selectAll()
        .where('bom_id', '=', bom.id)
        .orderBy('seq', 'asc')
        .execute()
      const byproducts = await trx
        .selectFrom('mfg_bom_byproduct')
        .selectAll()
        .where('bom_id', '=', bom.id)
        .execute()
      let idx = 0
      for (const c of components) {
        await trx
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
        await trx
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
        await trx
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
      await trx
        .updateTable('mfg_work_order')
        .set({ bom_id: bom.id, updated_at: sql`(now() AT TIME ZONE 'utc')` })
        .where('id', '=', workOrderId)
        .execute()
      const after = await loadWorkOrderAuthorized(trx, permit, target, workOrderId, false)
      await writeAudit(trx, permit.actor, {
        resource: 'mfg_work_order',
        recordId: workOrderId,
        recordLabel: after.workOrderNo,
        actionType: 'update',
        actionName: 'create_inline_bom',
        companyId: after.companyId,
        changes: { bom_id: { from: wo.bomId, to: bom.id } },
      })
      return { workOrder: after, bom }
    })
  }

  /**
   * 「生成物料需求」弹窗取数（票 02）：每配料行的毛需求与参考库存快照。
   * 参考库存只读复用库存引擎 balance——按 {公司,物料}（不指定仓库）聚合后跨仓合计，
   * 折算到行单位展示；纯快照，不写分录、不锁不扣不预留。默认数量=毛−参考库存（下限 0），
   * 参考库存足够的行带 covered 标记（默认去向「不需要」），均由服务端算好，前端不自行聚合。
   */
  async function getMaterialDemandPreview(
    permit: Permit,
    workOrderId: string,
  ): Promise<{ lines: MaterialDemandPreviewLine[] }> {
    const wo = await loadWorkOrderAuthorized(db, permit, target, workOrderId, false)
    const components = await db
      .selectFrom('mfg_work_order_component as c')
      .innerJoin('inv_material as m', 'm.id', 'c.material_id')
      .innerJoin('bas_unit as u', 'u.id', 'c.unit_id')
      .leftJoin('inv_material_unit as mu', (join) =>
        join.onRef('mu.material_id', '=', 'c.material_id').onRef('mu.unit_id', '=', 'c.unit_id'),
      )
      .select([
        'c.id',
        'c.material_id',
        'c.unit_id',
        'c.quantity',
        'c.loss_rate',
        'm.code as material_code',
        'm.name as material_name',
        'm.spec as material_spec',
        'm.default_unit_id',
        'u.name as unit_name',
        'mu.factor as conversion_factor',
      ])
      .where('c.work_order_id', '=', workOrderId)
      .orderBy('c.idx', 'asc')
      .execute()
    if (components.length === 0) return { lines: [] }

    // 库存引擎按 { companyId, materialId } 聚合（不指定仓库）后跨仓合计：base 单位，6 位
    const stockBaseByMaterial = new Map<string, string>()
    for (const materialId of [...new Set(components.map((c) => c.material_id))]) {
      const rows = await inventory.balance(db, {
        companyId: wo.companyId,
        materialId,
        hideZero: false,
      })
      let total = decimal(0)
      for (const r of rows) total = total.add(r.quantity)
      stockBaseByMaterial.set(materialId, toDecimalString(decimal(roundBaseQty(total))))
    }

    return {
      lines: components.map((c) => {
        const grossQty = grossRequirement(c.quantity, c.loss_rate, wo.baseQty)
        // 折算到行单位：默认单位即 base；转换单位 1 默认单位 = factor 行单位
        let stockQty = decimal(stockBaseByMaterial.get(c.material_id)!)
        if (c.unit_id !== c.default_unit_id) {
          if (c.conversion_factor == null || !decimal(String(c.conversion_factor)).gt(0)) {
            throw new ApiError('conflict', '配料行单位缺少物料单位转换系数')
          }
          stockQty = decimal(roundBaseQty(stockQty.mul(decimal(String(c.conversion_factor)))))
        }
        const gross = decimal(grossQty)
        const covered = !stockQty.lt(gross)
        const defaultQty = toDecimalString(
          decimal(roundBaseQty(covered ? decimal(0) : gross.sub(stockQty))),
        )
        return {
          componentId: c.id,
          materialId: c.material_id,
          unitId: c.unit_id,
          materialCode: c.material_code,
          materialName: c.material_name,
          materialSpec: c.material_spec,
          unitName: c.unit_name,
          grossQty,
          stockQty: toDecimalString(stockQty),
          defaultQty,
          covered,
        }
      }),
    }
  }

  /**
   * 生成物料需求（派生核心链路）：按 BOM 快照配料逐行校验后按去向分组，
   * 单事务生成多张履约需求单草稿（受信任写，不走公开建单端点），任一失败整体回滚。
   * 弹窗取数（毛需求/参考库存/默认数量）见 getMaterialDemandPreview。
   */
  async function generateMaterialDemand(
    permit: Permit,
    workOrderId: string,
    input: { lines: MaterialDemandLineInput[]; force?: boolean },
  ): Promise<MaterialDemandResult> {
    if (input.lines.length === 0) {
      throw ApiError.validation('物料需求参数不合法', { lines: ['至少选择一行配料'] })
    }
    return withTx(db, async (trx) => {
      const wo = await lockWorkOrder(trx, permit, workOrderId)
      if (wo.status !== 'in_progress') {
        throw new ApiError('conflict', '仅进行中的生产工单可生成物料需求')
      }
      // 重复生成警告（票 04）：已有未删除派生草稿且未带 force 时不生成，
      // 回警告标记（单号清单）；前端二次确认后带 force: true 重发才正常生成
      if (!input.force) {
        const existingDrafts = await trx
          .selectFrom('mfg_demand')
          .select('demand_no')
          .where('status', '=', 'draft')
          .where('id', 'in', (qb) =>
            qb
              .selectFrom('mfg_demand_item')
              .select('demand_id')
              .where('source_work_order_id', '=', workOrderId)
              .distinct(),
          )
          .orderBy('demand_no', 'asc')
          .execute()
        if (existingDrafts.length > 0) {
          return {
            demands: [],
            lines: [],
            warning: {
              existingDraftDemandNos: existingDrafts.map((r) => r.demand_no),
            },
          }
        }
      }
      const components = await trx
        .selectFrom('mfg_work_order_component')
        .selectAll()
        .where('work_order_id', '=', workOrderId)
        .orderBy('idx', 'asc')
        .execute()
      if (components.length === 0) {
        throw new ApiError('unprocessable', '工单未挂 BOM 快照，无法生成物料需求')
      }
      const byId = new Map(components.map((c) => [c.id, c]))

      // 逐行校验 + 服务端复算（不信任前端折算）
      const prepared: PreparedLine[] = []
      const seen = new Set<string>()
      for (const [i, line] of input.lines.entries()) {
        const component = byId.get(line.componentId)
        if (!component) {
          throw ApiError.validation('物料需求参数不合法', {
            [`lines[${i}].componentId`]: ['配料行不属于本工单'],
          })
        }
        if (seen.has(line.componentId)) {
          throw ApiError.validation('物料需求参数不合法', {
            [`lines[${i}].componentId`]: ['配料行重复'],
          })
        }
        seen.add(line.componentId)
        const qty = parsePositiveQty(line.qty, `lines[${i}].qty`)
        const deptId =
          line.target.kind === 'dept'
            ? await resolveAssignedDept(trx, wo.companyId, line.target.deptId)
            : null
        // 单位=快照配料行单位（限子物料默认/转换单位，复用既有单位校验与 base 复算）
        const projection = await deriveItemProjection(
          trx,
          component.material_id,
          component.unit_id,
          qty,
        )
        // 毛需求 = 净用量 ×(1+损耗率,空按 1)× 工单 base 数量（理论耗用口径，6 位）
        const grossQty = grossRequirement(component.quantity, component.loss_rate, wo.baseQty)
        prepared.push({
          componentId: line.componentId,
          materialId: component.material_id,
          unitId: component.unit_id,
          qty,
          baseQty: projection.baseQty,
          grossQty,
          projection,
          deptId,
        })
      }

      // 按去向分组：dept 相同合一张（头已填下发车间），purchase 合一张（下发为空）
      const groups = new Map<string, PreparedLine[]>()
      for (const p of prepared) {
        const key = p.deptId ? `dept:${p.deptId}` : 'purchase'
        const list = groups.get(key) ?? []
        list.push(p)
        groups.set(key, list)
      }

      const demandDate = utcToday()
      const remarks = `来源工单:${wo.workOrderNo}`
      const demands: MaterialDemandResult['demands'] = []
      for (const [key, lines] of groups) {
        const deptId = key.startsWith('dept:') ? key.slice('dept:'.length) : null
        const no = await numbering.nextInTx(trx, {
          resource: 'mfg.demand',
          values: { company_id: wo.companyId, demand_date: demandDate },
        })
        const created = await insertDerivedDemand(trx, permit.actor, {
          companyId: wo.companyId,
          demandNo: no,
          demandDate,
          remarks,
          assignedDeptId: deptId,
          lines: lines.map((p, i) => ({
            idx: i + 1,
            materialId: p.materialId,
            unitId: p.unitId,
            qty: p.qty,
            baseQty: p.baseQty,
            needDate: wo.needDate,
            sourceWorkOrderId: wo.id,
            materialCode: p.projection.materialCode,
            materialName: p.projection.materialName,
            materialSpec: p.projection.materialSpec,
            unitName: p.projection.unitName,
          })),
        })
        demands.push(created)
      }

      // 工单动作审计痕（含生成单号清单）
      await writeAudit(trx, permit.actor, {
        resource: 'mfg_work_order',
        recordId: wo.id,
        recordLabel: wo.workOrderNo,
        actionType: 'update',
        actionName: 'generate_material_demand',
        companyId: wo.companyId,
        changes: {
          derived_demands: { to: demands.map((d) => d.demandNo).join(', ') },
        },
      })
      return {
        demands,
        lines: prepared.map((p) => ({
          componentId: p.componentId,
          materialId: p.materialId,
          unitId: p.unitId,
          grossQty: p.grossQty,
        })),
        warning: null,
      }
    })
  }

  return {
    createWorkOrder,
    getWorkOrder,
    listWorkOrders,
    updateWorkOrder,
    deleteWorkOrder,
    voidWorkOrder,
    applyBom,
    getBomSnapshot,
    createInlineBom,
    getMaterialDemandPreview,
    generateMaterialDemand,
  }
}

export type WorkOrderService = ReturnType<typeof createWorkOrderService>

/** 按 Permit 取工单行（可锁）；不命中一律 not_found。生产入库服务共用 */
export async function loadWorkOrderAuthorized(
  db: DbHandle,
  permit: Permit,
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

async function clearWorkOrderBomSnapshot(db: DbHandle, workOrderId: string): Promise<void> {
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
async function copyBomSnapshotToWorkOrder(
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
    bomId: row.bom_id ?? null,
    createdById: row.created_by_id,
    ownerDeptId: row.owner_dept_id,
    insertedAt: new Date(row.inserted_at),
    updatedAt: new Date(row.updated_at),
  }
}

export function mapWorkOrderRecord(r: Record<string, unknown>): WorkOrder {
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
    bom_id: r.bom_id == null ? null : String(r.bom_id),
    created_by_id: r.created_by_id == null ? null : String(r.created_by_id),
    owner_dept_id: r.owner_dept_id == null ? null : String(r.owner_dept_id),
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
    owner_dept_id: item.ownerDeptId,
  }
}
