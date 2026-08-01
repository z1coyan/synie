import { scaledInt64ToDecimal } from '@synie/shared'
import { v } from 'convex/values'
import type { Id } from '../../_generated/dataModel'
import { activeGenerationInMutation } from '../../engines/generation'
import { readCurrent } from '../../engines/inventory/projections'
import { authedMutation, authedQuery } from '../../lib/auth'
import { asDomainMutationCtx } from '../../lib/mutationContext'
import { synieError } from '../../lib/errors'
import {
  createAggregate,
  loadAggregate,
  removeAggregate,
  replaceAggregate,
  type AggregatePolicy,
  type AggregateRecord,
} from '../shared/aggregate'
import { domainInternalForMutation, patchDomainInternal } from '../shared/records'
import { materialUnitSnapshot } from '../shared/snapshots'
import { warehouseRevision } from './revisions'

async function materialLine(
  ctx: Parameters<NonNullable<AggregatePolicy['nodes'][number]['derive']>>[0],
  input: AggregateRecord,
) {
  return materialUnitSnapshot(ctx, input.materialId, input.unitId, { field: 'qty', value: input.qty })
}

const stockDoc: AggregatePolicy = {
  headResource: 'invStockDocs',
  nodes: [{
    resource: 'invStockDocItems', collection: 'items', parentField: 'stockDocId',
    derive: (ctx, { input }) => materialLine(ctx, input),
  }],
}

const stockTransfer: AggregatePolicy = {
  headResource: 'invStockTransfers',
  nodes: [{
    resource: 'invStockTransferItems', collection: 'items', parentField: 'stockTransferId',
    derive: async (ctx, { input, existing }) => ({
      ...(await materialLine(ctx, input)),
      receivedQty: existing?.receivedQty ?? '0',
    }),
  }],
}

const stockCount: AggregatePolicy = {
  headResource: 'invStockCounts',
  deriveHead: async (_ctx, _actor, _input, previous) => previous ? {} : { snapshotTakenAt: Date.now() },
  nodes: [{
    resource: 'invStockCountItems', collection: 'items', parentField: 'countId',
    derive: async (ctx, { head, input, existing }) => {
      if (existing) {
        if (input.materialId !== existing.materialId || input.unitId !== existing.unitId) {
          throw synieError('validation', '盘点快照条目不能更换物料或单位')
        }
        return {
          materialCode: existing.materialCode,
          materialName: existing.materialName,
          materialSpec: existing.materialSpec,
          unitName: existing.unitName,
          convertedCounted: input.countedQuantity == null
            ? existing.convertedCounted
            : (await materialUnitSnapshot(ctx, input.materialId, input.unitId, {
                field: 'countedQuantity', value: input.countedQuantity, allowZero: true,
              })).baseQty,
          bookQuantity: existing.bookQuantity,
        }
      }
      const snapshot = await materialUnitSnapshot(ctx, input.materialId, input.unitId,
        input.countedQuantity == null
          ? undefined
          : { field: 'countedQuantity', value: input.countedQuantity, allowZero: true })
      const generation = await activeGenerationInMutation(asDomainMutationCtx(ctx), 'inventory')
      const materialId = ctx.db.normalizeId('materials', String(input.materialId))
      const warehouseId = ctx.db.normalizeId('warehouses', String(head.warehouseId))
      if (!materialId || !warehouseId) throw synieError('validation', '盘点仓库或物料不存在')
      const balance = await readCurrent(asDomainMutationCtx(ctx), generation, {
        companyId: String(head.companyId),
        warehouseId: warehouseId as Id<'warehouses'>,
        materialId: materialId as Id<'materials'>,
      })
      return {
        ...snapshot,
        convertedCounted: input.countedQuantity == null ? null : snapshot.baseQty,
        bookQuantity: scaledInt64ToDecimal(balance?.baseQty ?? 0n, 6),
      }
    },
  }],
  afterSave: async (ctx, _actor, head) => {
    const internal = await domainInternalForMutation(ctx, 'invStockCounts', String(head.id))
    if (typeof internal.warehouseRevision === 'bigint') return
    await patchDomainInternal(ctx, 'invStockCounts', String(head.id), {
      warehouseRevision: await warehouseRevision(ctx, String(head.warehouseId)),
    })
  },
}

const policies = { invStockDocs: stockDoc, invStockTransfers: stockTransfer, invStockCounts: stockCount } as const
type Resource = keyof typeof policies

function policy(resource: string): AggregatePolicy {
  const result = policies[resource as Resource]
  if (!result) throw synieError('validation', `资源 ${resource} 不是库存聚合草稿`)
  return result
}

export function createInventoryDraftInMutation(
  ctx: Parameters<typeof createAggregate>[0],
  actor: Parameters<typeof createAggregate>[1],
  resource: string,
  input: unknown,
) {
  return createAggregate(ctx, actor, policy(resource), input)
}

export const loadDraft = authedQuery({
  args: { resource: v.string(), id: v.string() }, returns: v.any(),
  handler: (ctx, args) => loadAggregate(ctx, ctx.actor, policy(args.resource), args.id),
})
export const createDraft = authedMutation({
  args: { resource: v.string(), input: v.any() }, returns: v.any(),
  handler: (ctx, args) => createInventoryDraftInMutation(ctx, ctx.actor, args.resource, args.input),
})
export const replaceDraft = authedMutation({
  args: { resource: v.string(), id: v.string(), input: v.any() }, returns: v.any(),
  handler: (ctx, args) => replaceAggregate(ctx, ctx.actor, policy(args.resource), args.id, args.input),
})
export const removeDraft = authedMutation({
  args: { resource: v.string(), id: v.string() }, returns: v.null(),
  handler: async (ctx, args) => { await removeAggregate(ctx, ctx.actor, policy(args.resource), args.id); return null },
})
