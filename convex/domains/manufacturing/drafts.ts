import { Decimal, roundBaseQty } from '@synie/shared'
import { v } from 'convex/values'
import { authedMutation, authedQuery } from '../../lib/auth'
import { canAccessCompany } from '../../lib/companyScope'
import { synieError } from '../../lib/errors'
import { requirePermission } from '../../lib/permissions'
import {
  createAggregate,
  loadAggregate,
  removeAggregate,
  replaceAggregate,
  type AggregatePolicy,
} from '../shared/aggregate'
import {
  childrenFor,
  getDomainRecord,
  hydrateStored,
  patchDomainStatus,
  unsafeStoredForMutation,
} from '../shared/records'
import { materialUnitSnapshot } from '../shared/snapshots'
import {
  createManualArrangement,
  listArrangements,
  removeMakeArrangement,
  removeManualArrangement,
  upsertMakeArrangement,
} from './arrangements'

type MutationCtx = Parameters<NonNullable<AggregatePolicy['nodes'][number]['derive']>>[0]

async function source(ctx: MutationCtx, resource: string, value: unknown) {
  if (typeof value !== 'string') throw synieError('validation', '来源记录不能为空')
  return hydrateStored(await unsafeStoredForMutation(ctx, resource, value))
}

async function assertWarehouse(ctx: MutationCtx, value: unknown, companyId: unknown): Promise<void> {
  if (value == null || value === '') return
  if (typeof value !== 'string') throw synieError('validation', '生产入库仓库不能为空')
  const normalized = ctx.db.normalizeId('warehouses', value)
  const warehouse = normalized ? await ctx.db.get(normalized) : null
  if (!warehouse) throw synieError('conflict', '生产入库仓库不存在')
  if (String(warehouse.companyId) !== String(companyId)) throw synieError('conflict', '生产入库仓库不属于本公司')
  if (!warehouse.isLeaf) throw synieError('conflict', '生产入库仅可使用叶子仓')
  if (!warehouse.active) throw synieError('conflict', '生产入库仓库已停用')
}

async function hasAuditedOutput(ctx: MutationCtx, workOrderId: string): Promise<boolean> {
  const references = await ctx.db.query('domainReferences').withIndex('by_target', (q) =>
    q.eq('targetResource', 'mfgWorkOrders').eq('targetRecordId', workOrderId),
  ).collect()
  for (const reference of references) {
    if (reference.sourceResource !== 'mfgOutputItems') continue
    const item = await source(ctx, 'mfgOutputItems', reference.sourceRecordId)
    if (typeof item.outputId !== 'string') continue
    const output = await source(ctx, 'mfgOutputs', item.outputId)
    if (output.status === 'AUDITED') return true
  }
  return false
}

const processTemplate: AggregatePolicy = {
  headResource: 'mfgProcessTemplates',
  nodes: [{ resource: 'mfgProcessTemplateItems', collection: 'items', parentField: 'templateId' }],
}

const bom: AggregatePolicy = {
  headResource: 'mfgBoms',
  deriveHead: async (_ctx, _actor, _input, previous) => {
    if (previous && previous.status !== 'DRAFT') throw synieError('conflict', '仅草稿 BOM 可修改')
    return previous ? { status: previous.status, materialId: previous.materialId } : {}
  },
  nodes: [
    {
      resource: 'mfgBomComponents', collection: 'components', parentField: 'bomId',
      derive: async (_ctx, { head, input }) => {
        if (input.materialId === head.materialId) throw synieError('validation', 'BOM 配料不能使用母物料自身')
        return {}
      },
    },
    { resource: 'mfgBomRoutes', collection: 'routes', parentField: 'bomId' },
    {
      resource: 'mfgBomByproducts', collection: 'byproducts', parentField: 'bomId',
      derive: async (_ctx, { head, input }) => {
        if (input.materialId === head.materialId) throw synieError('validation', 'BOM 副产品不能使用母物料自身')
        return {}
      },
    },
  ],
}

const demand: AggregatePolicy = {
  headResource: 'mfgDemands',
  deriveHead: async (_ctx, actor, _input, previous) => {
    if (previous && previous.status !== 'DRAFT') throw synieError('conflict', '仅草稿履约需求单可修改')
    return previous
      ? { companyId: previous.companyId, status: previous.status, createdById: previous.createdById }
      : { createdById: actor.userId }
  },
  nodes: [{
    resource: 'mfgDemandItems', collection: 'items', parentField: 'demandId',
    derive: async (ctx, { input, existing }) => {
      const snapshot = await materialUnitSnapshot(ctx, input.materialId, input.unitId, { field: 'qty', value: input.qty })
      return {
        ...snapshot,
        orderedQty: existing?.orderedQty ?? '0',
        receivedQty: existing?.receivedQty ?? '0',
        arrangedQty: existing?.arrangedQty ?? '0',
        completedQty: existing?.completedQty ?? '0',
        remainingOrderableQty: existing?.remainingOrderableQty ?? snapshot.baseQty,
        remainingArrangeableQty: existing?.remainingArrangeableQty ?? snapshot.baseQty,
        ordered: existing?.ordered ?? false,
        status: existing?.status ?? 'PENDING',
      }
    },
  }],
}

const workOrder: AggregatePolicy = {
  headResource: 'mfgWorkOrders',
  deriveHead: async (ctx, actor, input, previous) => {
    if (previous) {
      if (previous.status !== 'IN_PROGRESS') throw synieError('conflict', '仅进行中的生产工单可修改')
      if (await hasAuditedOutput(ctx, String(previous.id))) throw synieError('conflict', '存在已审核生产入库,不可修改工单快照')
      return {
        companyId: previous.companyId,
        demandId: previous.demandId,
        demandItemId: previous.demandItemId,
        materialId: previous.materialId,
        unitId: previous.unitId,
        qty: previous.qty,
        baseQty: previous.baseQty,
        receivedBaseQty: previous.receivedBaseQty,
        remainingBaseQty: previous.remainingBaseQty,
        needDate: previous.needDate,
        materialCode: previous.materialCode,
        materialName: previous.materialName,
        materialSpec: previous.materialSpec,
        unitName: previous.unitName,
        status: previous.status,
        createdById: previous.createdById,
      }
    }
    const demandItem = await source(ctx, 'mfgDemandItems', input.demandItemId)
    const demand = await source(ctx, 'mfgDemands', demandItem.demandId)
    if (demand.status !== 'CONFIRMED') throw synieError('conflict', '仅已确认未关闭需求单的行可生成工单')
    if (demandItem.status === 'COMPLETED') throw synieError('conflict', '已完成的需求行不可生成工单')
    const remainingBase = new Decimal(String(demandItem.baseQty)).sub(String(demandItem.arrangedQty ?? '0'))
    if (!remainingBase.gt(0)) throw synieError('conflict', '需求行无可安排剩余数量')
    const factor = new Decimal(String(demandItem.qty)).div(String(demandItem.baseQty))
    const qty = typeof input.qty === 'string' && input.qty.trim()
      ? input.qty
      : roundBaseQty(remainingBase.mul(factor))
    const snapshot = await materialUnitSnapshot(ctx, demandItem.materialId, demandItem.unitId, { field: 'qty', value: qty })
    if (input.bomId) {
      const selected = await source(ctx, 'mfgBoms', input.bomId)
      if (selected.status !== 'ACTIVE') throw synieError('conflict', '仅启用中的 BOM 可选入工单')
      if (selected.materialId !== demandItem.materialId) throw synieError('conflict', 'BOM 物料须与工单物料一致')
    }
    return {
      ...snapshot,
      companyId: demandItem.companyId,
      demandId: demandItem.demandId,
      demandItemId: demandItem.id,
      materialId: demandItem.materialId,
      unitId: demandItem.unitId,
      qty,
      needDate: demandItem.needDate,
      status: 'IN_PROGRESS',
      createdById: actor.userId,
      receivedBaseQty: '0',
      remainingBaseQty: snapshot.baseQty,
    }
  },
  nodes: [
    { resource: 'mfgWorkOrderComponents', collection: 'components', parentField: 'workOrderId' },
    { resource: 'mfgWorkOrderRoutes', collection: 'routes', parentField: 'workOrderId' },
    { resource: 'mfgWorkOrderByproducts', collection: 'byproducts', parentField: 'workOrderId' },
  ],
  afterSave: async (ctx, actor, head) => {
    if (typeof head.demandItemId !== 'string') return
    await upsertMakeArrangement(ctx, actor, {
      demandItemId: head.demandItemId,
      companyId: String(head.companyId),
      workOrderId: String(head.id),
      qty: String(head.qty),
      baseQty: String(head.baseQty),
    })
  },
}

const output: AggregatePolicy = {
  headResource: 'mfgOutputs',
  deriveHead: async (ctx, actor, input, previous) => {
    if (previous && previous.status !== 'DRAFT') throw synieError('conflict', '仅草稿生产入库单可修改')
    const companyId = previous?.companyId ?? input.companyId
    await assertWarehouse(ctx, input.warehouseId ?? previous?.warehouseId, companyId)
    return previous
      ? { companyId: previous.companyId, status: previous.status, createdById: previous.createdById }
      : { createdById: actor.userId }
  },
  nodes: [{
    resource: 'mfgOutputItems', collection: 'items', parentField: 'outputId',
    derive: async (ctx, { head, input }) => {
      const order = await source(ctx, 'mfgWorkOrders', input.workOrderId)
      if (order.status === 'VOIDED') throw synieError('conflict', '已作废工单不可生产入库')
      if (order.companyId !== head.companyId) throw synieError('conflict', '生产入库公司与工单不一致')
      const warehouseId = input.warehouseId ?? head.warehouseId
      await assertWarehouse(ctx, warehouseId, head.companyId)
      return {
        ...(await materialUnitSnapshot(ctx, order.materialId, input.unitId ?? order.unitId, { field: 'qty', value: input.qty })),
        materialId: order.materialId,
        warehouseId,
        outputNo: head.outputNo,
        outputDate: head.outputDate,
        outputStatus: head.status,
      }
    },
  }],
}

const policies = {
  mfgProcessTemplates: processTemplate,
  mfgBoms: bom,
  mfgDemands: demand,
  mfgWorkOrders: workOrder,
  mfgOutputs: output,
} as const

function policy(resource: string): AggregatePolicy {
  const result = policies[resource as keyof typeof policies]
  if (!result) throw synieError('validation', `资源 ${resource} 不是制造聚合草稿`)
  return result
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw synieError('validation', '制造聚合参数必须是对象')
  }
  return value as Record<string, unknown>
}

async function bomSnapshotInput(ctx: MutationCtx, bomId: string) {
  const selected = await source(ctx, 'mfgBoms', bomId)
  const components = await childrenFor(ctx, 'mfgBomComponents', bomId)
  const routes = await childrenFor(ctx, 'mfgBomRoutes', bomId)
  const byproducts = await childrenFor(ctx, 'mfgBomByproducts', bomId)
  return {
    selected,
    components: components.map((item, idx) => ({
      idx,
      materialId: item.materialId,
      unitId: item.unitId,
      quantity: item.quantity,
      lossRate: item.lossRate,
      note: item.note,
    })),
    routes: routes.map((item) => ({
      seq: item.seq,
      operationId: item.operationId,
      requirement: item.requirement,
      isOutsourced: item.isOutsourced,
    })),
    byproducts: byproducts.map((item, idx) => ({
      idx,
      materialId: item.materialId,
      unitId: item.unitId,
      quantity: item.quantity,
      note: item.note,
    })),
  }
}

async function normalizedCreateInput(ctx: MutationCtx, resource: string, raw: unknown): Promise<unknown> {
  const input = record(raw)
  if (resource !== 'mfgWorkOrders') return input
  if (typeof input.bomId === 'string') {
    const snapshot = await bomSnapshotInput(ctx, input.bomId)
    return { ...input, components: snapshot.components, routes: snapshot.routes, byproducts: snapshot.byproducts }
  }
  return {
    ...input,
    components: Array.isArray(input.components) ? input.components : [],
    routes: Array.isArray(input.routes) ? input.routes : [],
    byproducts: Array.isArray(input.byproducts) ? input.byproducts : [],
  }
}

export const loadDraft = authedQuery({ args: { resource: v.string(), id: v.string() }, returns: v.any(), handler: (ctx, args) => loadAggregate(ctx, ctx.actor, policy(args.resource), args.id) })
export const createDraft = authedMutation({
  args: { resource: v.string(), input: v.any() }, returns: v.any(),
  handler: async (ctx, args) => createAggregate(
    ctx,
    ctx.actor,
    policy(args.resource),
    await normalizedCreateInput(ctx, args.resource, args.input),
  ),
})
export const replaceDraft = authedMutation({ args: { resource: v.string(), id: v.string(), input: v.any() }, returns: v.any(), handler: (ctx, args) => replaceAggregate(ctx, ctx.actor, policy(args.resource), args.id, args.input) })
export const removeDraft = authedMutation({
  args: { resource: v.string(), id: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    const selected = policy(args.resource)
    if (args.resource === 'mfgWorkOrders') await removeMakeArrangement(ctx, ctx.actor, args.id)
    await removeAggregate(ctx, ctx.actor, selected, args.id)
    return null
  },
})

export const arrangements = authedQuery({
  args: { demandItemId: v.string() }, returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'mfg.demand:read')
    return listArrangements(ctx, ctx.actor, args.demandItemId)
  },
})

/** Replace a work-order BOM snapshot inside the same mutation as the head link. */
export const applyBom = authedMutation({
  args: { id: v.string(), bomId: v.union(v.string(), v.null()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'mfg.work_order:update')
    const current = await loadAggregate(ctx, ctx.actor, workOrder, args.id)
    const next = args.bomId
      ? await bomSnapshotInput(ctx, args.bomId)
      : { components: [], routes: [], byproducts: [] }
    return replaceAggregate(ctx, ctx.actor, workOrder, args.id, {
      ...current,
      bomId: args.bomId,
      components: next.components,
      routes: next.routes,
      byproducts: next.byproducts,
    })
  },
})

/**
 * Create, activate and select an inline BOM without exposing an intermediate
 * active BOM or a partially updated work-order snapshot.
 */
export const createInlineBom = authedMutation({
  args: { id: v.string(), input: v.any() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'mfg.work_order:update')
    requirePermission(ctx.actor, 'mfg.bom:create')
    const current = await loadAggregate(ctx, ctx.actor, workOrder, args.id)
    const input = record(args.input)
    const created = await createAggregate(ctx, ctx.actor, bom, {
      ...input,
      materialId: current.materialId,
      components: Array.isArray(input.components) ? input.components : [],
      routes: Array.isArray(input.routes) ? input.routes : [],
      byproducts: Array.isArray(input.byproducts) ? input.byproducts : [],
    })
    const activated = await patchDomainStatus(
      ctx,
      ctx.actor,
      'mfgBoms',
      String(created.id),
      'ACTIVE',
      'activate',
    )
    const snapshot = await bomSnapshotInput(ctx, String(created.id))
    const updated = await replaceAggregate(ctx, ctx.actor, workOrder, args.id, {
      ...current,
      bomId: created.id,
      components: snapshot.components,
      routes: snapshot.routes,
      byproducts: snapshot.byproducts,
    })
    return { workOrder: updated, bom: { ...created, ...activated } }
  },
})

export const bomSnapshot = authedQuery({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const current = await loadAggregate(ctx, ctx.actor, workOrder, args.id)
    return {
      bomId: current.bomId ?? null,
      components: current.components,
      routes: current.routes,
      byproducts: current.byproducts,
    }
  },
})

/** Copy a process template into an empty BOM route collection atomically. */
export const applyRouteTemplate = authedMutation({
  args: { bomId: v.string(), templateId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'mfg.bom:update')
    const current = await loadAggregate(ctx, ctx.actor, bom, args.bomId)
    if ((current.routes as unknown[]).length) throw synieError('conflict', '已有工艺路线,不能从模板带入')
    const template = await loadAggregate(ctx, ctx.actor, processTemplate, args.templateId)
    const routes = (template.items as Array<Record<string, unknown>>).map((item) => ({
      seq: item.seq,
      operationId: item.operationId,
      requirement: item.requirement,
      isOutsourced: item.isOutsourced,
    }))
    const updated = await replaceAggregate(ctx, ctx.actor, bom, args.bomId, { ...current, routes })
    return updated.routes
  },
})

export const salesItemOccupancies = authedQuery({
  args: { salesOrderItemIds: v.array(v.string()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'mfg.demand:read')
    if (args.salesOrderItemIds.length > 200) throw synieError('validation', '销售订单条目批量查询最多 200 条')
    const results = []
    for (const salesOrderItemId of [...new Set(args.salesOrderItemIds)].sort()) {
      const sales = await getDomainRecord(ctx, ctx.actor, 'salOrderItems', salesOrderItemId)
      if (!sales) continue
      let occupied = new Decimal(0)
      const references = await ctx.db.query('domainReferences').withIndex('by_target', (q) =>
        q.eq('targetResource', 'salOrderItems').eq('targetRecordId', salesOrderItemId),
      ).collect()
      for (const reference of references) {
        if (reference.sourceResource !== 'mfgDemandItems') continue
        const item = await getDomainRecord(ctx, ctx.actor, 'mfgDemandItems', reference.sourceRecordId)
        if (!item || typeof item.demandId !== 'string') continue
        const parent = await getDomainRecord(ctx, ctx.actor, 'mfgDemands', item.demandId)
        if (parent?.status === 'CONFIRMED') occupied = occupied.add(String(item.baseQty))
      }
      const ordered = new Decimal(String(sales.baseQty))
      results.push({
        salesOrderItemId,
        orderedBaseQty: roundBaseQty(ordered),
        occupiedBaseQty: roundBaseQty(occupied),
        remainingBaseQty: roundBaseQty(ordered.sub(occupied)),
      })
    }
    return results
  },
})

/** Indexed, bounded source pool for the demand sales-item picker. */
export const salesItemCandidates = authedQuery({
  args: { companyId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'mfg.demand:read')
    requirePermission(ctx.actor, 'sales.order:read')
    if (!canAccessCompany(ctx.actor, args.companyId)) throw synieError('not_found', '公司不存在')
    const projections = await ctx.db.query('domainQueryRows')
      .withIndex('by_resource_profile_company_sort', (q) =>
        q.eq('resource', 'salOrderItems').eq('profile', 'sort:orderDate').eq('companyId', args.companyId),
      )
      .order('desc')
      .take(200)
    const results = []
    for (const projection of projections) {
      const item = await getDomainRecord(ctx, ctx.actor, 'salOrderItems', projection.recordId)
      if (item?.orderStatus === 'AUDITED') results.push(item)
    }
    return results
  },
})

export const arrangeManual = authedMutation({
  args: { demandItemId: v.string(), arrangementType: v.union(v.literal('STOCK'), v.literal('CLOSE')), qty: v.string(), remarks: v.optional(v.union(v.string(), v.null())) },
  returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'mfg.demand:update')
    return createManualArrangement(ctx, ctx.actor, {
      demandItemId: args.demandItemId,
      type: args.arrangementType,
      qty: args.qty,
      remarks: args.remarks,
    })
  },
})

export const removeArrangement = authedMutation({
  args: { id: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'mfg.demand:update')
    await removeManualArrangement(ctx, ctx.actor, args.id)
    return null
  },
})
