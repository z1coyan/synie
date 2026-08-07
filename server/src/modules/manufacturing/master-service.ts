/**
 * 制造主数据：工序 / 工艺模板 / BOM（配料·路线·副产品）
 *
 * W5 聚合迁移：头 createStandardService + 子行 createStandardChildService +
 * createAggregateService；BOM 启停 → workflow（D7）。applyRouteTemplate 仍手写编排。
 * 全部 global 形态（无 company_id）。编号 nextInTx 系统生成（D6）。
 * 领域 present/校验见 master-domain.ts。
 */
import { type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { writeAudit } from '~/platform/audit/write.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { createAggregateService, type AggregateService } from '~/platform/standard/aggregate.ts'
import {
  createStandardChildService,
  type StandardChildService,
} from '~/platform/standard/child.ts'
import {
  createStandardService,
  type StandardService,
} from '~/platform/standard/service.ts'
import { ensureMaterial, normalizeList } from './helpers.ts'
import {
  BOM_BYPRODUCT_RESOURCE,
  BOM_COMPONENT_RESOURCE,
  BOM_RESOURCE,
  BOM_ROUTE_RESOURCE,
  bomLineBeforeWrite,
  headCreatePayload,
  headUpdatePatch,
  MFG_DUP,
  MFG_REF,
  normalizeRouteDraft,
  OPERATION_RESOURCE,
  presentBom,
  presentBomRoute,
  presentByproduct,
  presentComponent,
  presentHead,
  presentRouteItem,
  presentTemplate,
  routeItemCreatePayload,
  routeItemUpdatePatch,
  TEMPLATE_ITEM_RESOURCE,
  TEMPLATE_RESOURCE,
  validateBomHead,
  validateHeadNote,
} from './master-domain.ts'
import type {
  Bom,
  BomByproduct,
  BomComponent,
  BomRoute,
  BomStatus,
  ListQueryInput,
  Operation,
  ProcessTemplate,
  TemplateItem,
} from './types.ts'

export {
  BOM_BYPRODUCT_RESOURCE,
  BOM_COMPONENT_RESOURCE,
  BOM_RESOURCE,
  BOM_ROUTE_RESOURCE,
  OPERATION_RESOURCE,
  TEMPLATE_ITEM_RESOURCE,
  TEMPLATE_RESOURCE,
} from './master-domain.ts'

export function createMasterService(
  db: Kysely<Database>,
  numbering: NumberingService,
  registry: Registry,
) {
  const operations = createStandardService<Operation>({
    db,
    registry,
    resource: OPERATION_RESOURCE,
    notFound: '工序不存在',
    defaultOrder: sql`"code" ASC, "id" ASC`,
    writeErrors: [
      { code: '23505', message: '工序编号已存在' },
      { code: '23503', message: '工序已被工艺路线或工艺模板引用,不能删除' },
    ],
    numbering: { service: numbering, field: 'code' },
    hooks: {
      validate: ({ action, draft }) => validateHeadNote('工序', draft, action),
      beforeDelete: async (trx, { item }) => {
        const ref = await sql<{ ok: boolean }>`
          SELECT EXISTS(
            SELECT 1 FROM mfg_bom_route WHERE operation_id = ${String(item.id)}
            UNION ALL SELECT 1 FROM mfg_process_template_item WHERE operation_id = ${String(item.id)}
          ) AS ok
        `.execute(trx)
        if (ref.rows[0]?.ok) {
          throw new ApiError('conflict', '工序已被工艺路线或工艺模板引用,不能删除')
        }
      },
    },
  })

  const templates = createStandardService<ProcessTemplate>({
    db,
    registry,
    resource: TEMPLATE_RESOURCE,
    notFound: '工艺模板不存在',
    defaultOrder: sql`"code" ASC, "id" ASC`,
    writeErrors: [
      { code: '23505', message: '工艺模板编号已存在' },
      { code: '23503', message: '工艺模板已被引用,不可删除' },
    ],
    numbering: { service: numbering, field: 'code' },
    hooks: {
      validate: ({ action, draft }) => validateHeadNote('工艺模板', draft, action),
    },
  })

  const templateItems = createStandardChildService<TemplateItem>({
    db,
    registry,
    resource: TEMPLATE_ITEM_RESOURCE,
    notFound: '工艺模板行不存在',
    defaultOrder: sql`"seq" ASC, "id" ASC`,
    writeErrors: [{ code: '23503', message: '工序或工艺模板不存在' }, MFG_DUP, MFG_REF],
    recordLabel: (item) => String(item.id),
    parent: {
      resource: TEMPLATE_RESOURCE,
      fkField: 'templateId',
      notFound: '工艺模板不存在',
    },
    extraWhere: ({ query }) => {
      const templateId = typeof query.templateId === 'string' ? query.templateId : null
      return { where: templateId ? sql`template_id = ${templateId}` : null }
    },
    hooks: {
      validate: ({ action, draft }) => normalizeRouteDraft(draft, action),
    },
  })

  const templateAggregate = createAggregateService({
    db,
    registry,
    head: templates,
    validationMessage: '工艺模板草稿参数不合法',
    children: [{ key: 'items', service: templateItems }],
  })

  const boms = createStandardService<Bom>({
    db,
    registry,
    resource: BOM_RESOURCE,
    notFound: 'BOM不存在',
    defaultOrder: sql`"code" ASC, "id" ASC`,
    writeErrors: [
      { code: '23505', message: 'BOM 编号已存在' },
      { code: '23503', message: 'BOM已被业务数据引用,不可删除' },
    ],
    numbering: { service: numbering, field: 'code' },
    hooks: {
      insertColumns: () => ({ status: 'draft' }),
      validate: ({ action, draft }) => validateBomHead(draft, action),
      beforeWrite: async (trx, { action, draft }) => {
        if (action === 'create') await ensureMaterial(trx, String(draft.materialId))
      },
      beforeDelete: async (_trx, { item }) => {
        if (String(item.status).toUpperCase() !== 'DRAFT') {
          throw new ApiError('conflict', '仅草稿 BOM 可删除；启用过的请停用')
        }
      },
    },
    workflow: {
      // 头/子行任意状态可改；仅草稿可删由 beforeDelete 收口
      mutableStatuses: ['DRAFT', 'ACTIVE', 'INACTIVE'],
      mutableMessage: '仅草稿 BOM 可删除；启用过的请停用',
      transitions: [
        {
          key: 'activate',
          label: '启用',
          from: ['DRAFT', 'INACTIVE'],
          to: 'ACTIVE',
          guardMessage: '当前状态不可启用',
        },
        {
          key: 'deactivate',
          label: '停用',
          from: ['ACTIVE'],
          to: 'INACTIVE',
          guardMessage: '仅启用中 BOM 可停用',
        },
      ],
    },
  })

  const components = createStandardChildService<BomComponent>({
    db,
    registry,
    resource: BOM_COMPONENT_RESOURCE,
    notFound: 'BOM配料行不存在',
    defaultOrder: sql`"inserted_at" ASC, "id" ASC`,
    writeErrors: [{ code: '23503', message: 'BOM、物料或单位不存在' }, MFG_DUP, MFG_REF],
    recordLabel: (item) => String(item.id),
    parent: { resource: BOM_RESOURCE, fkField: 'bomId', notFound: 'BOM不存在' },
    extraWhere: ({ query }) => {
      const bomId = typeof query.bomId === 'string' ? query.bomId : null
      return { where: bomId ? sql`bom_id = ${bomId}` : null }
    },
    hooks: {
      beforeWrite: async (trx, { action, draft, parent }) => {
        await bomLineBeforeWrite(trx, { action, draft, parent, withLoss: true })
      },
    },
  })

  const routes = createStandardChildService<BomRoute>({
    db,
    registry,
    resource: BOM_ROUTE_RESOURCE,
    notFound: 'BOM工艺路线行不存在',
    defaultOrder: sql`"seq" ASC, "id" ASC`,
    writeErrors: [{ code: '23503', message: 'BOM或工序不存在' }, MFG_DUP, MFG_REF],
    recordLabel: (item) => String(item.id),
    parent: { resource: BOM_RESOURCE, fkField: 'bomId', notFound: 'BOM不存在' },
    extraWhere: ({ query }) => {
      const bomId = typeof query.bomId === 'string' ? query.bomId : null
      return { where: bomId ? sql`bom_id = ${bomId}` : null }
    },
    hooks: {
      validate: ({ action, draft }) => normalizeRouteDraft(draft, action),
    },
  })

  const byproducts = createStandardChildService<BomByproduct>({
    db,
    registry,
    resource: BOM_BYPRODUCT_RESOURCE,
    notFound: 'BOM副产品行不存在',
    defaultOrder: sql`"inserted_at" ASC, "id" ASC`,
    writeErrors: [{ code: '23503', message: 'BOM、物料或单位不存在' }, MFG_DUP, MFG_REF],
    recordLabel: (item) => String(item.id),
    parent: { resource: BOM_RESOURCE, fkField: 'bomId', notFound: 'BOM不存在' },
    extraWhere: ({ query }) => {
      const bomId = typeof query.bomId === 'string' ? query.bomId : null
      return { where: bomId ? sql`bom_id = ${bomId}` : null }
    },
    hooks: {
      beforeWrite: async (trx, { action, draft, parent }) => {
        await bomLineBeforeWrite(trx, { action, draft, parent, withLoss: false })
      },
    },
  })

  const bomAggregate = createAggregateService({
    db,
    registry,
    head: boms,
    validationMessage: 'BOM草稿参数不合法',
    children: [
      { key: 'components', service: components },
      { key: 'routes', service: routes },
      { key: 'byproducts', service: byproducts },
    ],
  })

  async function activateBom(permit: Permit, id: string): Promise<Bom> {
    const before = presentBom(await boms.get(permit, id))
    if (before.status === 'active') return before
    return presentBom(await boms.transition(permit, id, 'activate'))
  }

  async function deactivateBom(permit: Permit, id: string): Promise<Bom> {
    const before = presentBom(await boms.get(permit, id))
    if (before.status === 'inactive') return before
    return presentBom(await boms.transition(permit, id, 'deactivate'))
  }

  async function createBom(
    permit: Permit,
    input: {
      code?: string | null
      materialId: string
      planName?: string | null
      note?: string | null
      status?: BomStatus | null
    },
  ): Promise<Bom> {
    const payload: Record<string, unknown> = {
      materialId: input.materialId,
      planName: input.planName ?? null,
      note: input.note ?? null,
    }
    if (input.code != null && String(input.code).trim() !== '') payload.code = input.code
    const wantActive =
      input.status != null && String(input.status).trim().toLowerCase() === 'active'
    return withTx(db, async (trx) => {
      const created = await boms.createInTx(trx, permit, payload)
      if (wantActive) {
        return presentBom(await boms.transitionInTx(trx, permit, String(created.id), 'activate'))
      }
      return presentBom(created)
    })
  }

  /** 从工艺模板快照带入路线（BOM 尚无路线行时）——跨资源编排，不进聚合草稿 */
  async function applyRouteTemplate(
    permit: Permit,
    bomId: string,
    templateId: string,
  ): Promise<BomRoute[]> {
    return withTx(db, async (trx) => {
      const bom = presentBom(await boms.updateInTx(trx, permit, bomId, {}))
      await templates.getOn(trx, permit, templateId)
      const existing = await routes.listByParentOn(trx, bomId)
      if (existing.length !== 0) {
        throw new ApiError('conflict', '已有工艺路线,不能从模板带入')
      }
      const tplItems = await templateItems.listByParentOn(trx, templateId)
      const result: BomRoute[] = []
      for (const tpl of tplItems) {
        const row = await routes.createInTx(trx, permit, {
          bomId,
          operationId: tpl.operationId,
          seq: tpl.seq,
          requirement: tpl.requirement,
          isOutsourced: tpl.isOutsourced,
        })
        result.push(presentBomRoute(row))
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
    createOperation: async (
      permit: Permit,
      input: { code?: string | null; name: string; note?: string | null },
    ) => presentHead(await operations.create(permit, headCreatePayload(input))),
    getOperation: async (permit: Permit, id: string) =>
      presentHead(await operations.get(permit, id)),
    listOperations: async (permit: Permit, query: ListQueryInput) => {
      const result = await operations.list(permit, normalizeList(query) as Partial<ListQuery>)
      return { count: result.count, results: result.results.map((r) => presentHead(r)) }
    },
    updateOperation: async (
      permit: Permit,
      id: string,
      input: { name?: string; note?: string | null; notePresent?: boolean },
    ) => presentHead(await operations.update(permit, id, headUpdatePatch(input))),
    deleteOperation: (permit: Permit, id: string) => operations.remove(permit, id),

    createTemplate: async (
      permit: Permit,
      input: { code?: string | null; name: string; note?: string | null },
    ) => presentTemplate(await templates.create(permit, headCreatePayload(input))),
    getTemplate: async (permit: Permit, id: string) =>
      presentTemplate(await templates.get(permit, id)),
    listTemplates: async (permit: Permit, query: ListQueryInput) => {
      const result = await templates.list(permit, normalizeList(query) as Partial<ListQuery>)
      return { count: result.count, results: result.results.map((r) => presentTemplate(r)) }
    },
    updateTemplate: async (
      permit: Permit,
      id: string,
      input: { name?: string; note?: string | null; notePresent?: boolean },
    ) => presentTemplate(await templates.update(permit, id, headUpdatePatch(input))),
    deleteTemplate: (permit: Permit, id: string) => templates.remove(permit, id),

    createTemplateItem: async (
      permit: Permit,
      input: {
        templateId: string
        operationId: string
        seq: number
        requirement?: string | null
        isOutsourced?: boolean
      },
    ) => presentRouteItem(await templateItems.create(permit, routeItemCreatePayload(input))),
    getTemplateItem: async (permit: Permit, id: string) =>
      presentRouteItem(await templateItems.get(permit, id)),
    listTemplateItems: async (permit: Permit, query: ListQueryInput & { templateId?: string }) => {
      const result = await templateItems.list(permit, {
        ...normalizeList(query),
        templateId: query.templateId,
      } as Partial<ListQuery> & { templateId?: string })
      return { count: result.count, results: result.results.map((r) => presentRouteItem(r)) }
    },
    updateTemplateItem: async (
      permit: Permit,
      id: string,
      input: {
        operationId?: string
        seq?: number
        requirement?: string | null
        requirementPresent?: boolean
        isOutsourced?: boolean
      },
    ) => presentRouteItem(await templateItems.update(permit, id, routeItemUpdatePatch(input))),
    deleteTemplateItem: (permit: Permit, id: string) => templateItems.remove(permit, id),

    createBom,
    getBom: async (permit: Permit, id: string) => presentBom(await boms.get(permit, id)),
    listBoms: async (permit: Permit, query: ListQueryInput) => {
      const result = await boms.list(permit, normalizeList(query) as Partial<ListQuery>)
      return { count: result.count, results: result.results.map((r) => presentBom(r)) }
    },
    updateBom: async (
      permit: Permit,
      id: string,
      input: {
        planName?: string | null
        planNamePresent?: boolean
        note?: string | null
        notePresent?: boolean
      },
    ) => {
      const patch: Record<string, unknown> = {}
      if (input.planNamePresent) patch.planName = input.planName ?? null
      if (input.notePresent) patch.note = input.note ?? null
      return presentBom(await boms.update(permit, id, patch))
    },
    deleteBom: (permit: Permit, id: string) => boms.remove(permit, id),
    activateBom,
    deactivateBom,

    createComponent: async (
      permit: Permit,
      input: {
        bomId: string
        materialId: string
        unitId: string
        quantity: string
        lossRate?: string | null
        note?: string | null
      },
    ) =>
      presentComponent(
        await components.create(permit, {
          bomId: input.bomId,
          materialId: input.materialId,
          unitId: input.unitId,
          quantity: input.quantity,
          lossRate: input.lossRate ?? null,
          note: input.note ?? null,
        }),
      ),
    getComponent: async (permit: Permit, id: string) =>
      presentComponent(await components.get(permit, id)),
    listComponents: async (permit: Permit, query: ListQueryInput & { bomId?: string }) => {
      const result = await components.list(permit, {
        ...normalizeList(query),
        bomId: query.bomId,
      } as Partial<ListQuery> & { bomId?: string })
      return { count: result.count, results: result.results.map((r) => presentComponent(r)) }
    },
    updateComponent: async (
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
    ) => {
      const patch: Record<string, unknown> = {}
      if (input.materialId !== undefined) patch.materialId = input.materialId
      if (input.unitId !== undefined) patch.unitId = input.unitId
      if (input.quantity !== undefined) patch.quantity = input.quantity
      if (input.lossRatePresent) patch.lossRate = input.lossRate ?? null
      if (input.notePresent) patch.note = input.note ?? null
      return presentComponent(await components.update(permit, id, patch))
    },
    deleteComponent: (permit: Permit, id: string) => components.remove(permit, id),

    createRoute: async (
      permit: Permit,
      input: {
        bomId: string
        operationId: string
        seq: number
        requirement?: string | null
        isOutsourced?: boolean
      },
    ) => presentBomRoute(await routes.create(permit, routeItemCreatePayload(input))),
    getRoute: async (permit: Permit, id: string) => presentBomRoute(await routes.get(permit, id)),
    listRoutes: async (permit: Permit, query: ListQueryInput & { bomId?: string }) => {
      const result = await routes.list(permit, {
        ...normalizeList(query),
        bomId: query.bomId,
      } as Partial<ListQuery> & { bomId?: string })
      return { count: result.count, results: result.results.map((r) => presentBomRoute(r)) }
    },
    updateRoute: async (
      permit: Permit,
      id: string,
      input: {
        operationId?: string
        seq?: number
        requirement?: string | null
        requirementPresent?: boolean
        isOutsourced?: boolean
      },
    ) => presentBomRoute(await routes.update(permit, id, routeItemUpdatePatch(input))),
    deleteRoute: (permit: Permit, id: string) => routes.remove(permit, id),

    createByproduct: async (
      permit: Permit,
      input: {
        bomId: string
        materialId: string
        unitId: string
        quantity: string
        note?: string | null
      },
    ) =>
      presentByproduct(
        await byproducts.create(permit, {
          bomId: input.bomId,
          materialId: input.materialId,
          unitId: input.unitId,
          quantity: input.quantity,
          note: input.note ?? null,
        }),
      ),
    getByproduct: async (permit: Permit, id: string) =>
      presentByproduct(await byproducts.get(permit, id)),
    listByproducts: async (permit: Permit, query: ListQueryInput & { bomId?: string }) => {
      const result = await byproducts.list(permit, {
        ...normalizeList(query),
        bomId: query.bomId,
      } as Partial<ListQuery> & { bomId?: string })
      return { count: result.count, results: result.results.map((r) => presentByproduct(r)) }
    },
    updateByproduct: async (
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
    ) => {
      const patch: Record<string, unknown> = {}
      if (input.materialId !== undefined) patch.materialId = input.materialId
      if (input.unitId !== undefined) patch.unitId = input.unitId
      if (input.quantity !== undefined) patch.quantity = input.quantity
      if (input.notePresent) patch.note = input.note ?? null
      return presentByproduct(await byproducts.update(permit, id, patch))
    },
    deleteByproduct: (permit: Permit, id: string) => byproducts.remove(permit, id),

    applyRouteTemplate,

    _templateAggregateForContract: (): AggregateService => templateAggregate,
    _bomAggregateForContract: (): AggregateService => bomAggregate,
    _operationsForContract: (): StandardService => operations as unknown as StandardService,
    _templatesForContract: (): StandardService => templates as unknown as StandardService,
    _bomsForContract: (): StandardService => boms as unknown as StandardService,
    _templateItemsForContract: (): StandardChildService =>
      templateItems as unknown as StandardChildService,
    _componentsForContract: (): StandardChildService =>
      components as unknown as StandardChildService,
  }
}

export type MasterService = ReturnType<typeof createMasterService>
