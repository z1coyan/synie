/**
 * 生产工单侧动作：内嵌 BOM、物料需求预览/生成（跨资源编排，不进标准钩子）。
 */
import {
  decimal,
  isDecimalString,
  roundBaseQty,
  toDecimalString,
} from '@synie/shared'
import type { Kysely } from 'kysely'
import { utcToday } from '~/db/dates.ts'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { InventoryEngine } from '~/engines/inventory/index.ts'
import { auditCreated, writeAudit } from '~/platform/audit/write.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { AuthzTarget } from '~/platform/meta/resource-authz.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import type { StandardService } from '~/platform/standard/service.ts'
import {
  insertDerivedDemand,
  resolveAssignedDept,
} from './demand-service.ts'
import { runeLen } from '~/platform/posting/text.ts'
import { deriveItemProjection, ensureMaterial, ensureUnitAllowed, mfgWriteError, numStr, parsePositiveQty, trimOptional, type ItemProjection } from './helpers.ts'
import {
  copyBomSnapshotToWorkOrder,
  grossRequirement,
  hasAuditedOutput,
  loadWorkOrderAuthorized,
  presentWorkOrder,
} from './work-order-domain.ts'
import type { Bom, WorkOrder } from './types.ts'

/** 生成物料需求请求行：未出现的配料行即「不需要」 */
export interface MaterialDemandLineInput {
  componentId: string
  qty: string
  target: { kind: 'dept'; deptId: string } | { kind: 'purchase' }
}

export interface MaterialDemandResult {
  demands: Array<{ id: string; demandNo: string; assignedDeptId: string | null }>
  lines: Array<{
    componentId: string
    materialId: string
    unitId: string
    grossQty: string
  }>
  warning: { existingDraftDemandNos: string[] } | null
}

export interface MaterialDemandPreviewLine {
  componentId: string
  materialId: string
  unitId: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitName: string
  grossQty: string
  stockQty: string
  defaultQty: string
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

export interface InlineBomInput {
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
}

export function createWorkOrderSideActions(
  db: Kysely<Database>,
  numbering: NumberingService,
  inventory: InventoryEngine,
  workOrderTarget: AuthzTarget,
  heads: StandardService,
) {
  const lockWorkOrder = (trx: DbHandle, permit: Permit, id: string) =>
    loadWorkOrderAuthorized(trx, permit, workOrderTarget, id, true)

  async function createInlineBom(
    permit: Permit,
    workOrderId: string,
    input: InlineBomInput,
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
      if (planName && runeLen(planName) > 64) {
        throw ApiError.validation('BOM参数不合法', { planName: ['最多 64 个字符'] })
      }
      if (note && runeLen(note) > 255) {
        throw ApiError.validation('BOM参数不合法', { note: ['最多 255 个字符'] })
      }
      const code = await numbering.assignedInTx(trx, {
        resource: 'mfg.bom',
        field: 'code',
        provided: input.code,
        values: { material_id: wo.materialId },
      })
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
      // 物料投影四字段与标准服务 projection 同口径(统一物料单元格取数)
      const material = await trx
        .selectFrom('inv_material')
        .select(['code', 'name', 'spec', 'customer_part_no'])
        .where('id', '=', wo.materialId)
        .executeTakeFirstOrThrow()
      const bom: Bom = {
        id: bomRow.id,
        code: bomRow.code,
        planName: bomRow.plan_name,
        note: bomRow.note,
        materialId: bomRow.material_id,
        materialCode: material.code,
        materialName: material.name,
        materialSpec: material.spec,
        customerPartNo: material.customer_part_no,
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

      await copyBomSnapshotToWorkOrder(trx, workOrderId, bom.id, wo.materialId)
      const after = presentWorkOrder(await heads.getOn(trx, permit, workOrderId))
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

  async function getMaterialDemandPreview(
    permit: Permit,
    workOrderId: string,
  ): Promise<{ lines: MaterialDemandPreviewLine[] }> {
    const wo = presentWorkOrder(await heads.get(permit, workOrderId))
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

    const stockBaseByMaterial = new Map<string, string>()
    for (const materialId of [...new Set(components.map((c) => c.material_id))]) {
      // 公司全仓合计账面（Σ 未作废分录，无截至日）——引擎读原语
      const total = await inventory.onHand(db, { companyId: wo.companyId, materialId })
      stockBaseByMaterial.set(materialId, toDecimalString(decimal(roundBaseQty(total))))
    }

    return {
      lines: components.map((c) => {
        const grossQty = grossRequirement(c.quantity, c.loss_rate, wo.baseQty)
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
        const projection = await deriveItemProjection(
          trx,
          component.material_id,
          component.unit_id,
          qty,
        )
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
          assignType: deptId ? 'make' : 'purchase',
          assignedDeptId: deptId,
          lines: lines.map((p, i) => ({
            idx: i + 1,
            materialId: p.materialId,
            unitId: p.unitId,
            qty: p.qty,
            baseQty: p.baseQty,
            needDate: wo.needDate ?? demandDate,
            sourceWorkOrderId: wo.id,
            materialCode: p.projection.materialCode,
            materialName: p.projection.materialName,
            materialSpec: p.projection.materialSpec,
            unitName: p.projection.unitName,
          })),
        })
        demands.push(created)
      }

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

  return { createInlineBom, getMaterialDemandPreview, generateMaterialDemand }
}
