/**
 * 制造主数据：工序 / 工艺模板 / BOM（配料·路线·副产品）
 * 行为对齐 server-go/internal/domain/manufacturing/master
 *
 * 全部 global 形态（工序/工艺模板/BOM 三张表都无 company_id，全公司共享一套工艺主数据）。
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit——
 * 列表 `listAuthorized`、单条与写前取行 `loadAuthorized(forUpdate)`。
 * BOM 状态机与「行物料不能是母物料」等是领域不变量，留在本文件抛 conflict/validation。
 */
import { decimal, isDecimalString, toDecimalString } from '@synie/shared'
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
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { AuthzTarget } from '~/platform/meta/resource-authz.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'
import { listAuthorized } from '~/db/list.ts'
import { loadAuthorized } from '~/db/load.ts'
import {
  ensureMaterial,
  ensureUnitAllowed,
  mfgWriteError,
  normalizeList,
  numStr,
  runeCount,
  trimOptional,
} from './helpers.ts'
import type { ListQueryInput } from './types.ts'
import {
  bomByproductResourceMeta,
  bomComponentResourceMeta,
  bomResourceMeta,
  bomRouteResourceMeta,
  operationResourceMeta,
  processTemplateItemResourceMeta,
  processTemplateResourceMeta,
} from './meta.ts'
import type {
  Bom,
  BomByproduct,
  BomComponent,
  BomRoute,
  BomStatus,
  Operation,
  ProcessTemplate,
  TemplateItem,
} from './types.ts'

export const OPERATION_RESOURCE = 'mfgOperations'
export const TEMPLATE_RESOURCE = 'mfgProcessTemplates'
export const TEMPLATE_ITEM_RESOURCE = 'mfgProcessTemplateItems'
export const BOM_RESOURCE = 'mfgBoms'
export const BOM_COMPONENT_RESOURCE = 'mfgBomComponents'
export const BOM_ROUTE_RESOURCE = 'mfgBomRoutes'
export const BOM_BYPRODUCT_RESOURCE = 'mfgBomByproducts'

const OP_TABLE = 'mfg_operation'
const TPL_TABLE = 'mfg_process_template'
const TPL_ITEM_TABLE = 'mfg_process_template_item'
const BOM_TABLE = 'mfg_bom'
const COMP_TABLE = 'mfg_bom_component'
const ROUTE_TABLE = 'mfg_bom_route'
const BYP_TABLE = 'mfg_bom_byproduct'

const OP_AUDIT = auditFieldsOf(operationResourceMeta())
const TPL_AUDIT = auditFieldsOf(processTemplateResourceMeta())
const BOM_AUDIT = auditFieldsOf(bomResourceMeta())
const COMP_AUDIT = auditFieldsOf(bomComponentResourceMeta())
const ROUTE_AUDIT = auditFieldsOf(bomRouteResourceMeta())
const TPL_ITEM_AUDIT = auditFieldsOf(processTemplateItemResourceMeta())
const BYP_AUDIT = auditFieldsOf(bomByproductResourceMeta())

export function createMasterService(
  db: Kysely<Database>,
  numbering: NumberingService,
  registry: Registry,
) {
  const opTarget = registry.authzTarget(OPERATION_RESOURCE)
  const tplTarget = registry.authzTarget(TEMPLATE_RESOURCE)
  const tplItemTarget = registry.authzTarget(TEMPLATE_ITEM_RESOURCE)
  const bomTarget = registry.authzTarget(BOM_RESOURCE)
  const compTarget = registry.authzTarget(BOM_COMPONENT_RESOURCE)
  const routeTarget = registry.authzTarget(BOM_ROUTE_RESOURCE)
  const bypTarget = registry.authzTarget(BOM_BYPRODUCT_RESOURCE)

  /** 授权取行（不命中一律 not_found）；forUpdate 即写路径的行锁 */
  const rowOf = (
    handle: DbHandle,
    permit: Permit,
    target: AuthzTarget,
    table: string,
    id: string,
    notFound: string,
    forUpdate = false,
  ) =>
    loadAuthorized({ db: handle, permit, target, table, id, forUpdate, notFoundMessage: notFound })

  const lockOperation = async (trx: DbHandle, permit: Permit, id: string): Promise<Operation> =>
    mapOperation((await rowOf(trx, permit, opTarget, OP_TABLE, id, '工序不存在', true)) as never)

  const lockTemplate = async (
    trx: DbHandle,
    permit: Permit,
    id: string,
  ): Promise<ProcessTemplate> =>
    mapTemplate(
      (await rowOf(trx, permit, tplTarget, TPL_TABLE, id, '工艺模板不存在', true)) as never,
    )

  const lockBom = async (trx: DbHandle, permit: Permit, id: string): Promise<Bom> => {
    if (!id) throw ApiError.validation('BOM行参数不合法', { bomId: ['必填'] })
    return mapBom((await rowOf(trx, permit, bomTarget, BOM_TABLE, id, 'BOM不存在', true)) as never)
  }

  // —— 工序 ——
  async function createOperation(
    permit: Permit,
    input: { code?: string | null; name: string; note?: string | null },
  ): Promise<Operation> {
    const { code, name, note } = normalizeHead(input.code ?? '', input.name, input.note, '工序')
    return withTx(db, async (trx) => {
      let finalCode = code
      if (!finalCode) {
        finalCode = await numbering.nextInTx(trx, { resource: 'mfg.operation' })
      }
      try {
        const row = await trx
          .insertInto('mfg_operation')
          .values({ code: finalCode, name, note })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapOperation(row)
        await writeAudit(trx, permit.actor, {
          resource: 'mfg_operation',
          recordId: item.id,
          recordLabel: item.code,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(opSnap(item), OP_AUDIT),
        })
        return item
      } catch (err) {
        throw mfgWriteError('创建工序失败', err, [
          { code: '23505', message: '工序编号已存在' },
        ])
      }
    })
  }

  async function getOperation(permit: Permit, id: string): Promise<Operation> {
    return mapOperation((await rowOf(db, permit, opTarget, OP_TABLE, id, '工序不存在')) as never)
  }

  async function listOperations(permit: Permit, query: ListQueryInput) {
    return listSimple(
      db,
      permit,
      opTarget,
      OP_TABLE,
      operationResourceMeta(),
      query,
      mapOperationRow,
      sql`"code" ASC, "id" ASC`,
    )
  }

  async function updateOperation(
    permit: Permit,
    id: string,
    input: { name?: string; note?: string | null; notePresent?: boolean },
  ): Promise<Operation> {
    return withTx(db, async (trx) => {
      const before = await lockOperation(trx, permit, id)
      const name = input.name !== undefined ? input.name : before.name
      const note = input.notePresent ? (input.note ?? null) : before.note
      const n = normalizeHead(before.code, name, note, '工序')
      try {
        const row = await trx
          .updateTable('mfg_operation')
          .set({ name: n.name, note: n.note, updated_at: sql`(now() AT TIME ZONE 'utc')` })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const after = mapOperation(row)
        const changes = auditDiff(opSnap(before), opSnap(after), OP_AUDIT)
        if (Object.keys(changes).length > 0) {
          await writeAudit(trx, permit.actor, {
            resource: 'mfg_operation',
            recordId: id,
            recordLabel: after.code,
            actionType: 'update',
            actionName: 'update',
            changes,
          })
        }
        return after
      } catch (err) {
        throw mfgWriteError('更新工序失败', err)
      }
    })
  }

  async function deleteOperation(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const item = await lockOperation(trx, permit, id)
      const ref = await sql<{ ok: boolean }>`
        SELECT EXISTS(
          SELECT 1 FROM mfg_bom_route WHERE operation_id = ${id}
          UNION ALL SELECT 1 FROM mfg_process_template_item WHERE operation_id = ${id}
        ) AS ok
      `.execute(trx)
      if (ref.rows[0]?.ok) {
        throw new ApiError('conflict', '工序已被工艺路线或工艺模板引用,不能删除')
      }
      try {
        await trx.deleteFrom('mfg_operation').where('id', '=', id).execute()
      } catch (err) {
        throw mfgWriteError('删除工序失败', err, [
          { code: '23503', message: '工序已被工艺路线或工艺模板引用,不能删除' },
        ])
      }
      await writeAudit(trx, permit.actor, {
        resource: 'mfg_operation',
        recordId: id,
        recordLabel: item.code,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(opSnap(item), OP_AUDIT),
      })
    })
  }

  // —— 工艺模板 ——
  async function createTemplate(
    permit: Permit,
    input: { code?: string | null; name: string; note?: string | null },
  ): Promise<ProcessTemplate> {
    const { code, name, note } = normalizeHead(input.code ?? '', input.name, input.note, '工艺模板')
    return withTx(db, async (trx) => {
      let finalCode = code
      if (!finalCode) {
        finalCode = await numbering.nextInTx(trx, { resource: 'mfg.route_template' })
      }
      try {
        const row = await trx
          .insertInto('mfg_process_template')
          .values({ code: finalCode, name, note })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapTemplate(row)
        await writeAudit(trx, permit.actor, {
          resource: 'mfg_process_template',
          recordId: item.id,
          recordLabel: item.code,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(opSnap(item), TPL_AUDIT),
        })
        return item
      } catch (err) {
        throw mfgWriteError('创建工艺模板失败', err, [
          { code: '23505', message: '工艺模板编号已存在' },
        ])
      }
    })
  }

  async function getTemplate(permit: Permit, id: string): Promise<ProcessTemplate> {
    return mapTemplate((await rowOf(db, permit, tplTarget, TPL_TABLE, id, '工艺模板不存在')) as never)
  }

  async function listTemplates(permit: Permit, query: ListQueryInput) {
    return listSimple(
      db,
      permit,
      tplTarget,
      TPL_TABLE,
      processTemplateResourceMeta(),
      query,
      mapTemplateRow,
      sql`"code" ASC, "id" ASC`,
    )
  }

  async function updateTemplate(
    permit: Permit,
    id: string,
    input: { name?: string; note?: string | null; notePresent?: boolean },
  ): Promise<ProcessTemplate> {
    return withTx(db, async (trx) => {
      const before = await lockTemplate(trx, permit, id)
      const name = input.name !== undefined ? input.name : before.name
      const note = input.notePresent ? (input.note ?? null) : before.note
      const n = normalizeHead(before.code, name, note, '工艺模板')
      const row = await trx
        .updateTable('mfg_process_template')
        .set({ name: n.name, note: n.note, updated_at: sql`(now() AT TIME ZONE 'utc')` })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
      const after = mapTemplate(row)
      const changes = auditDiff(opSnap(before), opSnap(after), TPL_AUDIT)
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, permit.actor, {
          resource: 'mfg_process_template',
          recordId: id,
          recordLabel: after.code,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
      }
      return after
    })
  }

  async function deleteTemplate(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const item = await lockTemplate(trx, permit, id)
      try {
        await trx.deleteFrom('mfg_process_template').where('id', '=', id).execute()
      } catch (err) {
        throw mfgWriteError('删除工艺模板失败', err, [
          { code: '23503', message: '工艺模板已被引用,不可删除' },
        ])
      }
      await writeAudit(trx, permit.actor, {
        resource: 'mfg_process_template',
        recordId: id,
        recordLabel: item.code,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(opSnap(item), TPL_AUDIT),
      })
    })
  }

  // —— 工艺模板行 ——
  async function createTemplateItem(
    permit: Permit,
    input: {
      templateId: string
      operationId: string
      seq: number
      requirement?: string | null
      isOutsourced?: boolean
    },
  ): Promise<TemplateItem> {
    const route = normalizeRoute(input)
    if (!input.templateId) {
      throw ApiError.validation('工艺模板行参数不合法', { templateId: ['必填'] })
    }
    return withTx(db, async (trx) => {
      await lockTemplate(trx, permit, input.templateId)
      try {
        const row = await trx
          .insertInto('mfg_process_template_item')
          .values({
            template_id: input.templateId,
            operation_id: route.operationId,
            seq: String(route.seq),
            requirement: route.requirement,
            is_outsourced: route.isOutsourced,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapTemplateItem(row)
        await writeAudit(trx, permit.actor, {
          resource: 'mfg_process_template_item',
          recordId: item.id,
          recordLabel: item.id,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(tplItemSnap(item), TPL_ITEM_AUDIT),
        })
        return item
      } catch (err) {
        throw mfgWriteError('创建工艺模板行失败', err, [
          { code: '23503', message: '工序或工艺模板不存在' },
        ])
      }
    })
  }

  async function getTemplateItem(permit: Permit, id: string): Promise<TemplateItem> {
    return mapTemplateItem(
      (await rowOf(db, permit, tplItemTarget, TPL_ITEM_TABLE, id, '工艺模板行不存在')) as never,
    )
  }

  async function listTemplateItems(permit: Permit, query: ListQueryInput & { templateId?: string }) {
    return listChildren(
      db,
      permit,
      tplItemTarget,
      TPL_ITEM_TABLE,
      processTemplateItemResourceMeta(),
      query,
      'template_id',
      query.templateId,
      mapTemplateItemRow,
      sql`"seq" ASC, "id" ASC`,
    )
  }

  async function updateTemplateItem(
    permit: Permit,
    id: string,
    input: {
      operationId?: string
      seq?: number
      requirement?: string | null
      requirementPresent?: boolean
      isOutsourced?: boolean
    },
  ): Promise<TemplateItem> {
    return withTx(db, async (trx) => {
      const parent = await trx
        .selectFrom('mfg_process_template_item')
        .select('template_id')
        .where('id', '=', id)
        .executeTakeFirst()
      if (!parent) throw new ApiError('not_found', '工艺模板行不存在')
      await lockTemplate(trx, permit, parent.template_id)
      const beforeRow = await trx
        .selectFrom('mfg_process_template_item')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!beforeRow) throw new ApiError('not_found', '工艺模板行不存在')
      const before = mapTemplateItem(beforeRow)
      const route = normalizeRoute({
        operationId: input.operationId ?? before.operationId,
        seq: input.seq ?? before.seq,
        requirement: input.requirementPresent ? (input.requirement ?? null) : before.requirement,
        isOutsourced: input.isOutsourced ?? before.isOutsourced,
      })
      try {
        const row = await trx
          .updateTable('mfg_process_template_item')
          .set({
            operation_id: route.operationId,
            seq: String(route.seq),
            requirement: route.requirement,
            is_outsourced: route.isOutsourced,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const after = mapTemplateItem(row)
        const changes = auditDiff(tplItemSnap(before), tplItemSnap(after), TPL_ITEM_AUDIT)
        if (Object.keys(changes).length > 0) {
          await writeAudit(trx, permit.actor, {
            resource: 'mfg_process_template_item',
            recordId: id,
            recordLabel: id,
            actionType: 'update',
            actionName: 'update',
            changes,
          })
        }
        return after
      } catch (err) {
        throw mfgWriteError('更新工艺模板行失败', err, [
          { code: '23503', message: '工序不存在' },
        ])
      }
    })
  }

  async function deleteTemplateItem(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const parent = await trx
        .selectFrom('mfg_process_template_item')
        .select('template_id')
        .where('id', '=', id)
        .executeTakeFirst()
      if (!parent) throw new ApiError('not_found', '工艺模板行不存在')
      await lockTemplate(trx, permit, parent.template_id)
      const row = await trx
        .selectFrom('mfg_process_template_item')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!row) throw new ApiError('not_found', '工艺模板行不存在')
      const item = mapTemplateItem(row)
      await trx.deleteFrom('mfg_process_template_item').where('id', '=', id).execute()
      await writeAudit(trx, permit.actor, {
        resource: 'mfg_process_template_item',
        recordId: id,
        recordLabel: id,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(tplItemSnap(item), TPL_ITEM_AUDIT),
      })
    })
  }

  // —— BOM ——
  async function createBom(
    permit: Permit,
    input: {
      code?: string | null
      materialId: string
      planName?: string | null
      note?: string | null
      /** 默认 draft；工单内嵌创建可传 active 以便立即选入 */
      status?: BomStatus | null
    },
  ): Promise<Bom> {
    const n = normalizeBom(input.code ?? '', input.planName, input.note, input.materialId)
    const status = parseBomStatus(input.status ?? 'draft', { allowDraft: true })
    return withTx(db, async (trx) => {
      await ensureMaterial(trx, input.materialId)
      let code = n.code
      if (!code) {
        code = await numbering.nextInTx(trx, {
          resource: 'mfg.bom',
          values: { material_id: input.materialId },
        })
      }
      try {
        const row = await trx
          .insertInto('mfg_bom')
          .values({
            code,
            plan_name: n.planName,
            note: n.note,
            material_id: input.materialId,
            status,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapBom(row)
        await writeAudit(trx, permit.actor, {
          resource: 'mfg_bom',
          recordId: item.id,
          recordLabel: item.code,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(bomSnap(item), BOM_AUDIT),
        })
        return item
      } catch (err) {
        throw mfgWriteError('创建BOM失败', err, [{ code: '23505', message: 'BOM 编号已存在' }])
      }
    })
  }

  async function getBom(permit: Permit, id: string): Promise<Bom> {
    return mapBom((await rowOf(db, permit, bomTarget, BOM_TABLE, id, 'BOM不存在')) as never)
  }

  async function listBoms(permit: Permit, query: ListQueryInput) {
    return listSimple(
      db,
      permit,
      bomTarget,
      BOM_TABLE,
      bomResourceMeta(),
      query,
      mapBomRow,
      sql`"code" ASC, "id" ASC`,
    )
  }

  async function updateBom(
    permit: Permit,
    id: string,
    input: {
      planName?: string | null
      planNamePresent?: boolean
      note?: string | null
      notePresent?: boolean
    },
  ): Promise<Bom> {
    return withTx(db, async (trx) => {
      const before = await lockBom(trx, permit, id)
      const planName = input.planNamePresent ? (input.planName ?? null) : before.planName
      const note = input.notePresent ? (input.note ?? null) : before.note
      const n = normalizeBom(before.code, planName, note, before.materialId)
      const row = await trx
        .updateTable('mfg_bom')
        .set({
          plan_name: n.planName,
          note: n.note,
          updated_at: sql`(now() AT TIME ZONE 'utc')`,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
      const after = mapBom(row)
      const changes = auditDiff(bomSnap(before), bomSnap(after), BOM_AUDIT)
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, permit.actor, {
          resource: 'mfg_bom',
          recordId: id,
          recordLabel: after.code,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
      }
      return after
    })
  }

  async function deleteBom(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const item = await lockBom(trx, permit, id)
      if (item.status !== 'draft') {
        throw new ApiError('conflict', '仅草稿 BOM 可删除；启用过的请停用')
      }
      try {
        await trx.deleteFrom('mfg_bom').where('id', '=', id).execute()
      } catch (err) {
        throw mfgWriteError('删除BOM失败', err, [
          { code: '23503', message: 'BOM已被业务数据引用,不可删除' },
        ])
      }
      await writeAudit(trx, permit.actor, {
        resource: 'mfg_bom',
        recordId: id,
        recordLabel: item.code,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(bomSnap(item), BOM_AUDIT),
      })
    })
  }

  /** 草稿/停用 → 启用 */
  async function activateBom(permit: Permit, id: string): Promise<Bom> {
    return setBomStatus(permit, id, 'active', 'activate')
  }

  /** 启用 → 停用 */
  async function deactivateBom(permit: Permit, id: string): Promise<Bom> {
    return setBomStatus(permit, id, 'inactive', 'deactivate')
  }

  async function setBomStatus(
    permit: Permit,
    id: string,
    next: BomStatus,
    actionName: string,
  ): Promise<Bom> {
    return withTx(db, async (trx) => {
      const before = await lockBom(trx, permit, id)
      if (before.status === next) return before
      if (next === 'active') {
        if (before.status !== 'draft' && before.status !== 'inactive') {
          throw new ApiError('conflict', '当前状态不可启用')
        }
      } else if (next === 'inactive') {
        if (before.status !== 'active') {
          throw new ApiError('conflict', '仅启用中 BOM 可停用')
        }
      } else {
        throw new ApiError('conflict', '不支持将该状态设为草稿')
      }
      const row = await trx
        .updateTable('mfg_bom')
        .set({ status: next, updated_at: sql`(now() AT TIME ZONE 'utc')` })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
      const after = mapBom(row)
      await writeAudit(trx, permit.actor, {
        resource: 'mfg_bom',
        recordId: id,
        recordLabel: after.code,
        actionType: 'update',
        actionName,
        changes: auditDiff(bomSnap(before), bomSnap(after), BOM_AUDIT),
      })
      return after
    })
  }

  // —— 配料行 ——
  async function createComponent(
    permit: Permit,
    input: {
      bomId: string
      materialId: string
      unitId: string
      quantity: string
      lossRate?: string | null
      note?: string | null
    },
  ): Promise<BomComponent> {
    return withTx(db, async (trx) => {
      const bom = await lockBom(trx, permit, input.bomId)
      const quantity = parseQty(input.quantity)
      const lossRate = parseLossRate(input.lossRate)
      validateLine(bom.materialId, input.materialId, quantity, lossRate)
      await ensureMaterial(trx, input.materialId, ['STOCK'], 'BOM行')
      await ensureUnitAllowed(trx, input.materialId, input.unitId)
      try {
        const row = await trx
          .insertInto('mfg_bom_component')
          .values({
            bom_id: input.bomId,
            material_id: input.materialId,
            unit_id: input.unitId,
            quantity,
            loss_rate: lossRate,
            note: trimOptional(input.note),
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapComponent(row)
        await writeAudit(trx, permit.actor, {
          resource: 'mfg_bom_component',
          recordId: item.id,
          recordLabel: item.id,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(compSnap(item), COMP_AUDIT),
        })
        return item
      } catch (err) {
        throw mfgWriteError('创建BOM配料行失败', err, [
          { code: '23503', message: 'BOM、物料或单位不存在' },
        ])
      }
    })
  }

  async function getComponent(permit: Permit, id: string): Promise<BomComponent> {
    return mapComponent(
      (await rowOf(db, permit, compTarget, COMP_TABLE, id, 'BOM配料行不存在')) as never,
    )
  }

  async function listComponents(permit: Permit, query: ListQueryInput & { bomId?: string }) {
    return listChildren(
      db,
      permit,
      compTarget,
      COMP_TABLE,
      bomComponentResourceMeta(),
      query,
      'bom_id',
      query.bomId,
      mapComponentRow,
      sql`"inserted_at" ASC, "id" ASC`,
    )
  }

  async function updateComponent(
    permit: Permit,
    id: string,
    input: {
      bomId?: string
      materialId?: string
      unitId?: string
      quantity?: string
      lossRate?: string | null
      lossRatePresent?: boolean
      note?: string | null
      notePresent?: boolean
    },
  ): Promise<BomComponent> {
    return withTx(db, async (trx) => {
      const beforeRow = await trx
        .selectFrom('mfg_bom_component')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!beforeRow) throw new ApiError('not_found', 'BOM配料行不存在')
      const before = mapComponent(beforeRow)
      if (input.bomId && input.bomId !== before.bomId) {
        throw ApiError.validation('制造主数据锚点不可修改', { bomId: ['创建后不可换BOM'] })
      }
      const bom = await lockBom(trx, permit, before.bomId)
      const materialId = input.materialId ?? before.materialId
      const unitId = input.unitId ?? before.unitId
      const quantity = input.quantity !== undefined ? parseQty(input.quantity) : before.quantity
      const lossRate = input.lossRatePresent
        ? parseLossRate(input.lossRate)
        : before.lossRate
      const note = input.notePresent ? trimOptional(input.note) : before.note
      validateLine(bom.materialId, materialId, quantity, lossRate)
      await ensureMaterial(trx, materialId, ['STOCK'], 'BOM行')
      await ensureUnitAllowed(trx, materialId, unitId)
      try {
        const row = await trx
          .updateTable('mfg_bom_component')
          .set({
            material_id: materialId,
            unit_id: unitId,
            quantity,
            loss_rate: lossRate,
            note,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const after = mapComponent(row)
        const changes = auditDiff(compSnap(before), compSnap(after), COMP_AUDIT)
        if (Object.keys(changes).length > 0) {
          await writeAudit(trx, permit.actor, {
            resource: 'mfg_bom_component',
            recordId: id,
            recordLabel: id,
            actionType: 'update',
            actionName: 'update',
            changes,
          })
        }
        return after
      } catch (err) {
        throw mfgWriteError('更新BOM配料行失败', err, [
          { code: '23503', message: '物料或单位不存在' },
        ])
      }
    })
  }

  async function deleteComponent(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const beforeRow = await trx
        .selectFrom('mfg_bom_component')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!beforeRow) throw new ApiError('not_found', 'BOM配料行不存在')
      await lockBom(trx, permit, beforeRow.bom_id)
      const item = mapComponent(beforeRow)
      await trx.deleteFrom('mfg_bom_component').where('id', '=', id).execute()
      await writeAudit(trx, permit.actor, {
        resource: 'mfg_bom_component',
        recordId: id,
        recordLabel: id,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(compSnap(item), COMP_AUDIT),
      })
    })
  }

  // —— 工艺路线行 ——
  async function createRoute(
    permit: Permit,
    input: {
      bomId: string
      operationId: string
      seq: number
      requirement?: string | null
      isOutsourced?: boolean
    },
  ): Promise<BomRoute> {
    const route = normalizeRoute(input)
    return withTx(db, async (trx) => {
      await lockBom(trx, permit, input.bomId)
      try {
        const row = await trx
          .insertInto('mfg_bom_route')
          .values({
            bom_id: input.bomId,
            operation_id: route.operationId,
            seq: String(route.seq),
            requirement: route.requirement,
            is_outsourced: route.isOutsourced,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapRoute(row)
        await writeAudit(trx, permit.actor, {
          resource: 'mfg_bom_route',
          recordId: item.id,
          recordLabel: item.id,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(routeSnap(item), ROUTE_AUDIT),
        })
        return item
      } catch (err) {
        throw mfgWriteError('创建BOM工艺路线行失败', err, [
          { code: '23503', message: 'BOM或工序不存在' },
        ])
      }
    })
  }

  async function getRoute(permit: Permit, id: string): Promise<BomRoute> {
    return mapRoute(
      (await rowOf(db, permit, routeTarget, ROUTE_TABLE, id, 'BOM工艺路线行不存在')) as never,
    )
  }

  async function listRoutes(permit: Permit, query: ListQueryInput & { bomId?: string }) {
    return listChildren(
      db,
      permit,
      routeTarget,
      ROUTE_TABLE,
      bomRouteResourceMeta(),
      query,
      'bom_id',
      query.bomId,
      mapRouteRow,
      sql`"seq" ASC, "id" ASC`,
    )
  }

  async function updateRoute(
    permit: Permit,
    id: string,
    input: {
      operationId?: string
      seq?: number
      requirement?: string | null
      requirementPresent?: boolean
      isOutsourced?: boolean
    },
  ): Promise<BomRoute> {
    return withTx(db, async (trx) => {
      const beforeRow = await trx
        .selectFrom('mfg_bom_route')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!beforeRow) throw new ApiError('not_found', 'BOM工艺路线行不存在')
      await lockBom(trx, permit, beforeRow.bom_id)
      const before = mapRoute(beforeRow)
      const route = normalizeRoute({
        operationId: input.operationId ?? before.operationId,
        seq: input.seq ?? before.seq,
        requirement: input.requirementPresent ? (input.requirement ?? null) : before.requirement,
        isOutsourced: input.isOutsourced ?? before.isOutsourced,
      })
      try {
        const row = await trx
          .updateTable('mfg_bom_route')
          .set({
            operation_id: route.operationId,
            seq: String(route.seq),
            requirement: route.requirement,
            is_outsourced: route.isOutsourced,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const after = mapRoute(row)
        const changes = auditDiff(routeSnap(before), routeSnap(after), ROUTE_AUDIT)
        if (Object.keys(changes).length > 0) {
          await writeAudit(trx, permit.actor, {
            resource: 'mfg_bom_route',
            recordId: id,
            recordLabel: id,
            actionType: 'update',
            actionName: 'update',
            changes,
          })
        }
        return after
      } catch (err) {
        throw mfgWriteError('更新BOM工艺路线行失败', err, [
          { code: '23503', message: '工序不存在' },
        ])
      }
    })
  }

  async function deleteRoute(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const beforeRow = await trx
        .selectFrom('mfg_bom_route')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!beforeRow) throw new ApiError('not_found', 'BOM工艺路线行不存在')
      await lockBom(trx, permit, beforeRow.bom_id)
      const item = mapRoute(beforeRow)
      await trx.deleteFrom('mfg_bom_route').where('id', '=', id).execute()
      await writeAudit(trx, permit.actor, {
        resource: 'mfg_bom_route',
        recordId: id,
        recordLabel: id,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(routeSnap(item), ROUTE_AUDIT),
      })
    })
  }

  // —— 副产品 ——
  async function createByproduct(
    permit: Permit,
    input: {
      bomId: string
      materialId: string
      unitId: string
      quantity: string
      note?: string | null
    },
  ): Promise<BomByproduct> {
    return withTx(db, async (trx) => {
      const bom = await lockBom(trx, permit, input.bomId)
      const quantity = parseQty(input.quantity)
      validateLine(bom.materialId, input.materialId, quantity, null)
      await ensureMaterial(trx, input.materialId, ['STOCK'], 'BOM行')
      await ensureUnitAllowed(trx, input.materialId, input.unitId)
      try {
        const row = await trx
          .insertInto('mfg_bom_byproduct')
          .values({
            bom_id: input.bomId,
            material_id: input.materialId,
            unit_id: input.unitId,
            quantity,
            note: trimOptional(input.note),
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapByproduct(row)
        await writeAudit(trx, permit.actor, {
          resource: 'mfg_bom_byproduct',
          recordId: item.id,
          recordLabel: item.id,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(bypSnap(item), BYP_AUDIT),
        })
        return item
      } catch (err) {
        throw mfgWriteError('创建BOM副产品行失败', err, [
          { code: '23503', message: 'BOM、物料或单位不存在' },
        ])
      }
    })
  }

  async function getByproduct(permit: Permit, id: string): Promise<BomByproduct> {
    return mapByproduct(
      (await rowOf(db, permit, bypTarget, BYP_TABLE, id, 'BOM副产品行不存在')) as never,
    )
  }

  async function listByproducts(permit: Permit, query: ListQueryInput & { bomId?: string }) {
    return listChildren(
      db,
      permit,
      bypTarget,
      BYP_TABLE,
      bomByproductResourceMeta(),
      query,
      'bom_id',
      query.bomId,
      mapByproductRow,
      sql`"inserted_at" ASC, "id" ASC`,
    )
  }

  async function updateByproduct(
    permit: Permit,
    id: string,
    input: {
      bomId?: string
      materialId?: string
      unitId?: string
      quantity?: string
      note?: string | null
      notePresent?: boolean
    },
  ): Promise<BomByproduct> {
    return withTx(db, async (trx) => {
      const beforeRow = await trx
        .selectFrom('mfg_bom_byproduct')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!beforeRow) throw new ApiError('not_found', 'BOM副产品行不存在')
      const before = mapByproduct(beforeRow)
      if (input.bomId && input.bomId !== before.bomId) {
        throw ApiError.validation('制造主数据锚点不可修改', { bomId: ['创建后不可换BOM'] })
      }
      const bom = await lockBom(trx, permit, before.bomId)
      const materialId = input.materialId ?? before.materialId
      const unitId = input.unitId ?? before.unitId
      const quantity = input.quantity !== undefined ? parseQty(input.quantity) : before.quantity
      const note = input.notePresent ? trimOptional(input.note) : before.note
      validateLine(bom.materialId, materialId, quantity, null)
      await ensureMaterial(trx, materialId, ['STOCK'], 'BOM行')
      await ensureUnitAllowed(trx, materialId, unitId)
      try {
        const row = await trx
          .updateTable('mfg_bom_byproduct')
          .set({
            material_id: materialId,
            unit_id: unitId,
            quantity,
            note,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const after = mapByproduct(row)
        const changes = auditDiff(bypSnap(before), bypSnap(after), BYP_AUDIT)
        if (Object.keys(changes).length > 0) {
          await writeAudit(trx, permit.actor, {
            resource: 'mfg_bom_byproduct',
            recordId: id,
            recordLabel: id,
            actionType: 'update',
            actionName: 'update',
            changes,
          })
        }
        return after
      } catch (err) {
        throw mfgWriteError('更新BOM副产品行失败', err, [
          { code: '23503', message: '物料或单位不存在' },
        ])
      }
    })
  }

  async function deleteByproduct(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const beforeRow = await trx
        .selectFrom('mfg_bom_byproduct')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!beforeRow) throw new ApiError('not_found', 'BOM副产品行不存在')
      await lockBom(trx, permit, beforeRow.bom_id)
      const item = mapByproduct(beforeRow)
      await trx.deleteFrom('mfg_bom_byproduct').where('id', '=', id).execute()
      await writeAudit(trx, permit.actor, {
        resource: 'mfg_bom_byproduct',
        recordId: id,
        recordLabel: id,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(bypSnap(item), BYP_AUDIT),
      })
    })
  }

  /** 从工艺模板快照带入路线（BOM 尚无路线行时） */
  async function applyRouteTemplate(
    permit: Permit,
    bomId: string,
    templateId: string,
  ): Promise<BomRoute[]> {
    return withTx(db, async (trx) => {
      const bom = await lockBom(trx, permit, bomId)
      await lockTemplate(trx, permit, templateId)
      const countRow = await trx
        .selectFrom('mfg_bom_route')
        .select(db.fn.countAll<string>().as('c'))
        .where('bom_id', '=', bomId)
        .executeTakeFirstOrThrow()
      if (Number(countRow.c) !== 0) {
        throw new ApiError('conflict', '已有工艺路线,不能从模板带入')
      }
      const items = await trx
        .selectFrom('mfg_process_template_item')
        .selectAll()
        .where('template_id', '=', templateId)
        .orderBy('seq', 'asc')
        .orderBy('id', 'asc')
        .execute()
      const result: BomRoute[] = []
      for (const tpl of items) {
        const row = await trx
          .insertInto('mfg_bom_route')
          .values({
            bom_id: bomId,
            operation_id: tpl.operation_id,
            seq: String(tpl.seq),
            requirement: tpl.requirement,
            is_outsourced: tpl.is_outsourced,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapRoute(row)
        await writeAudit(trx, permit.actor, {
          resource: 'mfg_bom_route',
          recordId: item.id,
          recordLabel: item.id,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(routeSnap(item), ROUTE_AUDIT),
        })
        result.push(item)
      }
      await writeAudit(trx, permit.actor, {
        resource: 'mfg_bom',
        recordId: bom.id,
        recordLabel: bom.code,
        actionType: 'update',
        actionName: 'apply_route_template',
        changes: { template_id: { from: null, to: templateId } },
      })
      return result
    })
  }

  return {
    createOperation,
    getOperation,
    listOperations,
    updateOperation,
    deleteOperation,
    createTemplate,
    getTemplate,
    listTemplates,
    updateTemplate,
    deleteTemplate,
    createTemplateItem,
    getTemplateItem,
    listTemplateItems,
    updateTemplateItem,
    deleteTemplateItem,
    createBom,
    getBom,
    listBoms,
    updateBom,
    deleteBom,
    activateBom,
    deactivateBom,
    createComponent,
    getComponent,
    listComponents,
    updateComponent,
    deleteComponent,
    createRoute,
    getRoute,
    listRoutes,
    updateRoute,
    deleteRoute,
    createByproduct,
    getByproduct,
    listByproducts,
    updateByproduct,
    deleteByproduct,
    applyRouteTemplate,
  }
}

export type MasterService = ReturnType<typeof createMasterService>

// —— mappers & validators ——

function normalizeHead(
  code: string,
  name: string,
  note: string | null | undefined,
  label: string,
): { code: string; name: string; note: string | null } {
  const c = code.trim()
  const n = name.trim()
  const nt = trimOptional(note)
  const fields: Record<string, string[]> = {}
  if (runeCount(c) > 32) fields.code = ['最多 32 个字符']
  if (!n || runeCount(n) > 64) fields.name = ['不能为空且最多 64 个字符']
  if (nt && runeCount(nt) > 255) fields.note = ['最多 255 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation(`${label}参数不合法`, fields)
  }
  return { code: c, name: n, note: nt }
}

function normalizeBom(
  code: string,
  planName: string | null | undefined,
  note: string | null | undefined,
  materialId: string,
): { code: string; planName: string | null; note: string | null } {
  const c = code.trim()
  const p = trimOptional(planName)
  const n = trimOptional(note)
  const fields: Record<string, string[]> = {}
  if (runeCount(c) > 32) fields.code = ['最多 32 个字符']
  if (!materialId) fields.materialId = ['必填']
  if (p && runeCount(p) > 64) fields.planName = ['最多 64 个字符']
  if (n && runeCount(n) > 255) fields.note = ['最多 255 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('BOM参数不合法', fields)
  }
  return { code: c, planName: p, note: n }
}

function normalizeRoute(input: {
  operationId: string
  seq: number
  requirement?: string | null
  isOutsourced?: boolean
}): { operationId: string; seq: number; requirement: string | null; isOutsourced: boolean } {
  const requirement = trimOptional(input.requirement)
  const fields: Record<string, string[]> = {}
  if (!input.operationId) fields.operationId = ['必填']
  if (requirement && runeCount(requirement) > 512) fields.requirement = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('工艺路线行参数不合法', fields)
  }
  return {
    operationId: input.operationId,
    seq: input.seq,
    requirement,
    isOutsourced: input.isOutsourced ?? false,
  }
}

function parseQty(raw: string): string {
  if (!isDecimalString(raw) || !decimal(raw).gt(0)) {
    throw ApiError.validation('BOM行参数不合法', { quantity: ['必须大于 0'] })
  }
  return toDecimalString(decimal(raw))
}

function parseLossRate(raw: string | null | undefined): string | null {
  if (raw == null || raw === '') return null
  if (!isDecimalString(raw)) {
    throw ApiError.validation('BOM行参数不合法', { lossRate: ['必须为有效十进制数字'] })
  }
  const v = decimal(raw)
  if (v.isNegative()) {
    throw ApiError.validation('BOM行参数不合法', { lossRate: ['不能为负'] })
  }
  return toDecimalString(v)
}

function validateLine(
  bomMaterial: string,
  material: string,
  quantity: string,
  lossRate: string | null,
): void {
  const fields: Record<string, string[]> = {}
  if (!material) fields.materialId = ['必填']
  else if (material === bomMaterial) fields.materialId = ['行物料不能是 BOM 物料自身']
  if (!decimal(quantity).gt(0)) fields.quantity = ['必须大于 0']
  if (lossRate != null && decimal(lossRate).isNegative()) fields.lossRate = ['不能为负']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('BOM行参数不合法', fields)
  }
}

/** 裸表列表：alias 即表名（`FROM 表` 无别名），授权谓词由 listAuthorized 自动 AND */
async function listSimple<T>(
  db: DbHandle,
  permit: Permit,
  target: AuthzTarget,
  table: string,
  resource: ResourceMeta,
  query: ListQueryInput,
  mapRow: (r: Record<string, unknown>) => T,
  defaultOrder: ReturnType<typeof sql>,
) {
  normalizeList(query)
  return listAuthorized({
    db,
    permit,
    target,
    alias: table,
    resource,
    source: sql` FROM ${sql.raw(table)}`,
    select: sql`SELECT *`,
    defaultOrder,
    query,
    mapRow,
  })
}

/** 子行列表：via 链的 EXISTS 递归母单（母单谓词），父键筛选是领域条件 */
async function listChildren<T>(
  db: DbHandle,
  permit: Permit,
  target: AuthzTarget,
  table: string,
  resource: ResourceMeta,
  query: ListQueryInput,
  parentCol: string,
  parentId: string | undefined,
  mapRow: (r: Record<string, unknown>) => T,
  defaultOrder: ReturnType<typeof sql>,
) {
  normalizeList(query)
  return listAuthorized({
    db,
    permit,
    target,
    alias: table,
    resource,
    source: sql` FROM ${sql.raw(table)}`,
    select: sql`SELECT *`,
    defaultOrder,
    query,
    extraWhere: parentId ? sql`${sql.raw(`"${parentCol}"`)} = ${parentId}` : null,
    mapRow,
  })
}

function mapOperation(row: {
  id: string
  code: string
  name: string
  note: string | null
  inserted_at: Date
  updated_at: Date
}): Operation {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    note: row.note,
    insertedAt: new Date(row.inserted_at),
    updatedAt: new Date(row.updated_at),
  }
}

function mapOperationRow(r: Record<string, unknown>): Operation {
  return mapOperation({
    id: String(r.id),
    code: String(r.code),
    name: String(r.name),
    note: r.note == null ? null : String(r.note),
    inserted_at: r.inserted_at as Date,
    updated_at: r.updated_at as Date,
  })
}

function mapTemplate(row: {
  id: string
  code: string
  name: string
  note: string | null
  inserted_at: Date
  updated_at: Date
}): ProcessTemplate {
  return mapOperation(row)
}

function mapTemplateRow(r: Record<string, unknown>): ProcessTemplate {
  return mapOperationRow(r)
}

function mapTemplateItem(row: {
  id: string
  seq: string | number | bigint
  requirement: string | null
  is_outsourced: boolean
  template_id: string
  operation_id: string
  inserted_at: Date
  updated_at: Date
}): TemplateItem {
  return {
    id: row.id,
    seq: Number(row.seq),
    requirement: row.requirement,
    isOutsourced: row.is_outsourced,
    templateId: row.template_id,
    operationId: row.operation_id,
    insertedAt: new Date(row.inserted_at),
    updatedAt: new Date(row.updated_at),
  }
}

function mapTemplateItemRow(r: Record<string, unknown>): TemplateItem {
  return mapTemplateItem({
    id: String(r.id),
    seq: r.seq as number,
    requirement: r.requirement == null ? null : String(r.requirement),
    is_outsourced: Boolean(r.is_outsourced),
    template_id: String(r.template_id),
    operation_id: String(r.operation_id),
    inserted_at: r.inserted_at as Date,
    updated_at: r.updated_at as Date,
  })
}

function mapBom(row: {
  id: string
  code: string
  plan_name: string | null
  note: string | null
  material_id: string
  status: string
  inserted_at: Date
  updated_at: Date
}): Bom {
  return {
    id: row.id,
    code: row.code,
    planName: row.plan_name,
    note: row.note,
    materialId: row.material_id,
    status: row.status as BomStatus,
    insertedAt: new Date(row.inserted_at),
    updatedAt: new Date(row.updated_at),
  }
}

function mapBomRow(r: Record<string, unknown>): Bom {
  return mapBom({
    id: String(r.id),
    code: String(r.code),
    plan_name: r.plan_name == null ? null : String(r.plan_name),
    note: r.note == null ? null : String(r.note),
    material_id: String(r.material_id),
    status: String(r.status ?? 'active'),
    inserted_at: r.inserted_at as Date,
    updated_at: r.updated_at as Date,
  })
}

function parseBomStatus(
  raw: string,
  opts: { allowDraft: boolean },
): BomStatus {
  const s = raw.trim().toLowerCase()
  if (s === 'draft' && opts.allowDraft) return 'draft'
  if (s === 'active') return 'active'
  if (s === 'inactive') return 'inactive'
  throw ApiError.validation('BOM参数不合法', { status: ['状态不合法'] })
}

function mapComponent(row: {
  id: string
  quantity: unknown
  loss_rate: unknown
  note: string | null
  bom_id: string
  material_id: string
  unit_id: string
  inserted_at: Date
  updated_at: Date
}): BomComponent {
  return {
    id: row.id,
    quantity: numStr(row.quantity),
    lossRate: row.loss_rate == null ? null : numStr(row.loss_rate),
    note: row.note,
    bomId: row.bom_id,
    materialId: row.material_id,
    unitId: row.unit_id,
    insertedAt: new Date(row.inserted_at),
    updatedAt: new Date(row.updated_at),
  }
}

function mapComponentRow(r: Record<string, unknown>): BomComponent {
  return mapComponent({
    id: String(r.id),
    quantity: r.quantity,
    loss_rate: r.loss_rate,
    note: r.note == null ? null : String(r.note),
    bom_id: String(r.bom_id),
    material_id: String(r.material_id),
    unit_id: String(r.unit_id),
    inserted_at: r.inserted_at as Date,
    updated_at: r.updated_at as Date,
  })
}

function mapRoute(row: {
  id: string
  seq: string | number | bigint
  requirement: string | null
  is_outsourced: boolean
  bom_id: string
  operation_id: string
  inserted_at: Date
  updated_at: Date
}): BomRoute {
  return {
    id: row.id,
    seq: Number(row.seq),
    requirement: row.requirement,
    isOutsourced: row.is_outsourced,
    bomId: row.bom_id,
    operationId: row.operation_id,
    insertedAt: new Date(row.inserted_at),
    updatedAt: new Date(row.updated_at),
  }
}

function mapRouteRow(r: Record<string, unknown>): BomRoute {
  return mapRoute({
    id: String(r.id),
    seq: r.seq as number,
    requirement: r.requirement == null ? null : String(r.requirement),
    is_outsourced: Boolean(r.is_outsourced),
    bom_id: String(r.bom_id),
    operation_id: String(r.operation_id),
    inserted_at: r.inserted_at as Date,
    updated_at: r.updated_at as Date,
  })
}

function mapByproduct(row: {
  id: string
  quantity: unknown
  note: string | null
  bom_id: string
  material_id: string
  unit_id: string
  inserted_at: Date
  updated_at: Date
}): BomByproduct {
  return {
    id: row.id,
    quantity: numStr(row.quantity),
    note: row.note,
    bomId: row.bom_id,
    materialId: row.material_id,
    unitId: row.unit_id,
    insertedAt: new Date(row.inserted_at),
    updatedAt: new Date(row.updated_at),
  }
}

function mapByproductRow(r: Record<string, unknown>): BomByproduct {
  return mapByproduct({
    id: String(r.id),
    quantity: r.quantity,
    note: r.note == null ? null : String(r.note),
    bom_id: String(r.bom_id),
    material_id: String(r.material_id),
    unit_id: String(r.unit_id),
    inserted_at: r.inserted_at as Date,
    updated_at: r.updated_at as Date,
  })
}

function opSnap(item: { code: string; name: string; note: string | null }) {
  return { code: item.code, name: item.name, note: item.note }
}

function bomSnap(item: Bom) {
  return {
    code: item.code,
    plan_name: item.planName,
    note: item.note,
    material_id: item.materialId,
    status: item.status,
  }
}

function compSnap(item: BomComponent) {
  return {
    quantity: item.quantity,
    loss_rate: item.lossRate,
    note: item.note,
    bom_id: item.bomId,
    material_id: item.materialId,
    unit_id: item.unitId,
  }
}

function routeSnap(item: BomRoute) {
  return {
    seq: item.seq,
    requirement: item.requirement,
    is_outsourced: item.isOutsourced,
    bom_id: item.bomId,
    operation_id: item.operationId,
  }
}

function tplItemSnap(item: TemplateItem) {
  return {
    seq: item.seq,
    requirement: item.requirement,
    is_outsourced: item.isOutsourced,
    template_id: item.templateId,
    operation_id: item.operationId,
  }
}

function bypSnap(item: BomByproduct) {
  return {
    quantity: item.quantity,
    note: item.note,
    bom_id: item.bomId,
    material_id: item.materialId,
    unit_id: item.unitId,
  }
}
