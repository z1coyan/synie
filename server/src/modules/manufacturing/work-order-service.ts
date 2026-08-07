/**
 * 生产工单：由已确认需求行生成；完工回写在生产入库服务中。
 *
 * W5（D12）：头 createStandardService + *InTx；void → workflow；
 * 配料/路线/副产品仅 BOM 快照整包写（不进 child/aggregate/CASES）。
 * create / applyBom / createInlineBom / generateMaterialDemand 仍手写编排。
 *
 * 授权全由平台承担：服务只收 Permit。
 * 归属部门形态（stamped）：创建时平台 ownershipStamp 盖 owner_dept_id。
 */
import { decimal, toDecimalString, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { InventoryEngine } from '~/engines/inventory/index.ts'
import { writeAudit } from '~/platform/audit/write.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import {
  createStandardService,
  type StandardItem,
} from '~/platform/standard/service.ts'
import { syncDrawingAttachments } from '~/modules/trading/common.ts'
import {
  DEMAND_ITEM_RESOURCE,
  DEMAND_RESOURCE,
  cascadeDeleteDerivedDrafts,
  loadDemandAuthorized,
  loadDemandItemAuthorized,
} from './demand-service.ts'
import {
  ensureMaterial,
  normalizeList,
  numStr,
  parsePositiveQty,
  validateNo,
} from './helpers.ts'
import {
  hardRemainingArrangeable,
  removeMakeArrangementByWorkOrder,
  upsertMakeArrangement,
} from './arrangement.ts'
import {
  WORK_ORDER_RESOURCE,
  WORK_ORDER_SOURCE,
  WORK_ORDER_TABLE,
  clearWorkOrderBomSnapshot,
  copyBomSnapshotToWorkOrder,
  grossRequirement,
  hasAuditedOutput,
  loadWorkOrderAuthorized,
  mapWorkOrderExtras,
  presentWorkOrder,
} from './work-order-domain.ts'
import { createWorkOrderSideActions } from './work-order-side.ts'
import type { ListQueryInput, WorkOrder } from './types.ts'

export {
  WORK_ORDER_RESOURCE,
  WORK_ORDER_TABLE,
  grossRequirement,
  hasAuditedOutput,
  loadWorkOrderAuthorized,
  loadWorkOrderForProjection,
  mapWorkOrder,
  mapWorkOrderRecord,
  presentWorkOrder,
} from './work-order-domain.ts'

export type {
  MaterialDemandLineInput,
  MaterialDemandPreviewLine,
  MaterialDemandResult,
} from './work-order-side.ts'

/** void effect 带回 confirmedDerivedDemandNos（transition 只返头） */
const voidCascadeBox = new Map<string, string[]>()

export function createWorkOrderService(
  db: Kysely<Database>,
  numbering: NumberingService,
  registry: Registry,
  inventory: InventoryEngine,
) {
  const demandTarget = registry.authzTarget(DEMAND_RESOURCE)
  const demandItemTarget = registry.authzTarget(DEMAND_ITEM_RESOURCE)
  const workOrderTarget = registry.authzTarget(WORK_ORDER_RESOURCE)

  const heads = createStandardService<StandardItem>({
    db,
    registry,
    resource: WORK_ORDER_RESOURCE,
    notFound: '生产工单不存在',
    defaultOrder: sql`"inserted_at" DESC, "id" DESC`,
    writeErrors: [
      {
        code: '23505',
        constraint: 'mfg_work_order_unique_work_order_no',
        message: '工单号已存在',
      },
      {
        code: '23505',
        constraint: 'mfg_work_order_active_demand_item',
        message: '该需求行已有未作废生产工单',
      },
      { code: '23505', message: '制造数据已存在' },
      { code: '23503', message: '制造数据已被业务引用,不可删除' },
    ],
    numbering: { service: numbering, field: 'workOrderNo' },
    projection: {
      source: WORK_ORDER_SOURCE,
      alias: WORK_ORDER_TABLE,
      mapExtra: mapWorkOrderExtras,
    },
    extraWhere: ({ query }) => {
      const companyId = typeof query.companyId === 'string' ? query.companyId : null
      return { where: companyId ? sql`company_id = ${companyId}` : null }
    },
    hooks: {
      validate: ({ action, before }) => {
        // 可删含已作废；可改仅进行中（与旧门对齐）
        if (
          action === 'update' &&
          before &&
          String(before.status).toUpperCase() !== 'IN_PROGRESS'
        ) {
          throw new ApiError('conflict', '仅进行中的生产工单可修改')
        }
      },
      beforeDelete: async (trx, { permit, item }) => {
        const id = String(item.id)
        if (await hasAuditedOutput(trx, id)) {
          throw new ApiError('conflict', '存在已审核生产入库,不可删除工单')
        }
        await removeMakeArrangementByWorkOrder(trx, id)
        await cascadeDeleteDerivedDrafts(trx, permit.actor, id)
        await sql`
          DELETE FROM sys_attachment
          WHERE owner_type = 'mfg_work_order' AND owner_id = ${id}::uuid
        `.execute(trx)
      },
    },
    workflow: {
      // 进行中可改/删；已作废可删（旧行为）
      mutableStatuses: ['IN_PROGRESS', 'VOIDED'],
      mutableMessage: '仅进行中的生产工单可删除',
      transitions: [
        {
          key: 'void',
          label: '作废',
          from: ['IN_PROGRESS'],
          to: 'VOIDED',
          guardMessage: '仅进行中的生产工单可作废',
          effect: async (trx, { permit, before }) => {
            const id = String(before.id)
            if (await hasAuditedOutput(trx, id)) {
              throw new ApiError('conflict', '存在已审核生产入库,不可作废工单')
            }
            await removeMakeArrangementByWorkOrder(trx, id)
            const cascade = await cascadeDeleteDerivedDrafts(trx, permit.actor, id)
            voidCascadeBox.set(id, cascade.confirmedDemandNos)
          },
        },
      ],
    },
  })

  const side = createWorkOrderSideActions(
    db,
    numbering,
    inventory,
    workOrderTarget,
    heads,
  )

  const lockWorkOrder = (trx: DbHandle, permit: Permit, id: string) =>
    loadWorkOrderAuthorized(trx, permit, workOrderTarget, id, true)

  async function createWorkOrder(
    permit: Permit,
    input: {
      demandItemId: string
      workOrderNo?: string | null
      qty?: string | null
      bomId?: string | null
    },
  ): Promise<WorkOrder> {
    // D6：编号系统生成；路由仍可选手填字段，非空则 400（与标准 create 同文案）
    if (input.workOrderNo != null && String(input.workOrderNo).trim() !== '') {
      throw ApiError.validation('编号由系统生成,不接受手填', {
        workOrderNo: ['编号由系统生成,不接受手填'],
      })
    }
    return withTx(db, async (trx) => {
      const item = await loadDemandItemAuthorized(
        trx,
        permit,
        demandItemTarget,
        input.demandItemId,
        true,
      )
      const parent = await loadDemandAuthorized(trx, permit, demandTarget, item.demandId, true)
      if (parent.status !== 'CONFIRMED') {
        throw new ApiError('conflict', '仅已确认未关闭需求单的行可生成工单')
      }
      if (item.status === 'COMPLETED') {
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
      const created = await heads.createInTx(trx, permit, {
        companyId: item.companyId,
        demandId: item.demandId,
        demandItemId: item.id,
        materialId: item.materialId,
        unitId: item.unitId,
        qty,
        baseQty,
        receivedBaseQty: '0',
        needDate: item.needDate,
        materialCode: item.materialCode,
        materialName: item.materialName,
        materialSpec: item.materialSpec,
        unitName: item.unitName,
        status: 'IN_PROGRESS',
        bomId: null,
        createdById: permit.actor.userId || null,
      })
      await upsertMakeArrangement(trx, {
        demandItemId: item.id,
        companyId: item.companyId,
        workOrderId: String(created.id),
        qty,
        baseQty,
      })
      await syncDrawingAttachments(
        trx,
        'mfg_work_order',
        String(created.id),
        item.materialId,
        item.companyId,
      )
      if (input.bomId) {
        await copyBomSnapshotToWorkOrder(trx, String(created.id), input.bomId, item.materialId)
      }
      return presentWorkOrder(await heads.getOn(trx, permit, String(created.id)))
    })
  }

  async function getWorkOrder(permit: Permit, id: string): Promise<WorkOrder> {
    return presentWorkOrder(await heads.get(permit, id))
  }

  async function listWorkOrders(permit: Permit, query: ListQueryInput) {
    const q = normalizeList(query)
    const result = await heads.list(permit, q as Partial<ListQuery>)
    return {
      count: result.count,
      results: result.results.map((r) => presentWorkOrder(r)),
    }
  }

  async function updateWorkOrder(
    permit: Permit,
    id: string,
    input: { workOrderNo: string },
  ): Promise<WorkOrder> {
    const no = input.workOrderNo.trim()
    validateNo(no, 'workOrderNo')
    // 编号 readonly：空 patch 走可变门 + 无差异短路；仍校验「创建后不可改」
    const before = presentWorkOrder(await heads.get(permit, id))
    if (before.status !== 'in_progress') {
      throw new ApiError('conflict', '仅进行中的生产工单可修改')
    }
    if (no !== before.workOrderNo) {
      throw ApiError.validation('生产工单参数不合法', {
        workOrderNo: ['编号创建后不可修改'],
      })
    }
    return presentWorkOrder(await heads.update(permit, id, {}))
  }

  async function deleteWorkOrder(permit: Permit, id: string): Promise<void> {
    await heads.remove(permit, id)
  }

  async function voidWorkOrder(
    permit: Permit,
    id: string,
  ): Promise<{ workOrder: WorkOrder; confirmedDerivedDemandNos: string[] }> {
    try {
      const after = presentWorkOrder(await heads.transition(permit, id, 'void'))
      const confirmedDerivedDemandNos = voidCascadeBox.get(id) ?? []
      return { workOrder: after, confirmedDerivedDemandNos }
    } finally {
      voidCascadeBox.delete(id)
    }
  }

  /** 选 BOM：校验启用+本物料，快照复制；有已审核入库则拒 */
  async function applyBom(
    permit: Permit,
    workOrderId: string,
    bomId: string | null,
  ): Promise<WorkOrder> {
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
        return presentWorkOrder(await heads.getOn(trx, permit, workOrderId))
      }
      await copyBomSnapshotToWorkOrder(trx, workOrderId, bomId, before.materialId)
      const after = presentWorkOrder(await heads.getOn(trx, permit, workOrderId))
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
    const wo = presentWorkOrder(await heads.get(permit, workOrderId))
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

  return {
    createWorkOrder,
    getWorkOrder,
    listWorkOrders,
    updateWorkOrder,
    deleteWorkOrder,
    voidWorkOrder,
    applyBom,
    getBomSnapshot,
    ...side,
    /** 判官/调试：标准头（无聚合；D12 不加 CASES） */
    _headsForContract: () => heads,
  }
}

export type WorkOrderService = ReturnType<typeof createWorkOrderService>
