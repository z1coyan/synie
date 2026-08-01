import { scaledInt64ToDecimal } from '@synie/shared'
import { v } from 'convex/values'
import type { Id } from '../../_generated/dataModel'
import { activeGenerationInMutation } from '../../engines/generation'
import { readCurrent } from '../../engines/inventory/projections'
import { authedMutation, authedQuery } from '../../lib/auth'
import { canAccessCompany } from '../../lib/companyScope'
import { asDomainMutationCtx } from '../../lib/mutationContext'
import { synieError } from '../../lib/errors'
import { requirePermission } from '../../lib/permissions'
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
import { freezeStockCountWarehouseSnapshot, warehouseRevision } from './revisions'

async function materialLine(
  ctx: Parameters<NonNullable<AggregatePolicy['nodes'][number]['derive']>>[0],
  input: AggregateRecord,
) {
  return materialUnitSnapshot(ctx, input.materialId, input.unitId, { field: 'qty', value: input.qty })
}

type StockCountLoadAllItem = {
  materialId: string
  unitId: string
  countedQuantity: null
  remark: null
}

type StockCountDraftMode = 'create' | 'replace'

function aggregateInput(value: unknown): AggregateRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as AggregateRecord
    : null
}

/**
 * 旧盘点 create 的 loadAll 是一次性建行指令，不是可持久化的头字段。
 * replace 永远不执行整仓展开，避免编辑时用当前库存覆盖既有快照与实盘数。
 */
export async function prepareStockCountDraftInput(
  value: unknown,
  mode: StockCountDraftMode,
  loadWarehouseItems: (
    companyId: string,
    warehouseId: string,
  ) => Promise<StockCountLoadAllItem[]>,
): Promise<unknown> {
  if (mode === 'replace') return value
  const source = aggregateInput(value)
  if (!source) return value
  const input = { ...source }
  const loadAll = input.loadAll
  if (loadAll !== undefined && typeof loadAll !== 'boolean') {
    throw synieError('validation', '库存盘点单 loadAll 必须是布尔值')
  }
  if (loadAll === true) {
    if (input.items !== undefined && !Array.isArray(input.items)) {
      throw synieError('validation', '库存盘点单 items 必须是数组')
    }
    if (Array.isArray(input.items) && input.items.length > 0) {
      throw synieError('validation', '库存盘点单 items 不能与 loadAll 同时提供')
    }
    const companyId = typeof input.companyId === 'string' ? input.companyId.trim() : ''
    const warehouseId = typeof input.warehouseId === 'string' ? input.warehouseId.trim() : ''
    if (!companyId || !warehouseId) {
      throw synieError('validation', '库存盘点单整仓带出缺少公司或仓库')
    }
    input.items = await loadWarehouseItems(companyId, warehouseId)
  } else if (input.items === undefined) {
    // 对齐旧 create：未勾整仓且未传明细时创建显式空集合。
    input.items = []
  }
  delete input.loadAll
  return input
}

export function deriveStockCountHead(
  previous: AggregateRecord | null,
  now: () => number = Date.now,
): AggregateRecord {
  return previous ? {} : { snapshotTakenAt: now() }
}

export async function stockCountWarehouseItems(
  ctx: Parameters<typeof createAggregate>[0],
  companyId: string,
  warehouseId: string,
): Promise<StockCountLoadAllItem[]> {
  const normalizedWarehouseId = ctx.db.normalizeId('warehouses', warehouseId)
  if (!normalizedWarehouseId) throw synieError('validation', '库存盘点仓库不存在')
  const warehouse = await ctx.db.get(normalizedWarehouseId)
  if (!warehouse) throw synieError('validation', '库存盘点仓库不存在')
  if (warehouse.companyId !== companyId) throw synieError('validation', '库存盘点仓库不属于当前公司')
  if (!warehouse.isLeaf) throw synieError('validation', '库存盘点只能选择叶子仓库')
  if (!warehouse.active) throw synieError('validation', '库存盘点仓库已停用')
  const generation = await activeGenerationInMutation(asDomainMutationCtx(ctx), 'inventory')
  // 精确复合索引限定单仓；必须完整读取，超出 Convex 事务读限时整体失败，不能静默截断盘点清单。
  const balances = await ctx.db.query('inventoryCurrentBalances').withIndex('by_key', (q) =>
    q.eq('generation', generation).eq('companyId', companyId).eq('warehouseId', normalizedWarehouseId),
  ).collect()
  const projected = await Promise.all(
    balances.filter((balance) => balance.baseQty !== 0n).map(async (balance) => {
      const material = await ctx.db.get(balance.materialId)
      if (!material) throw synieError('validation', '库存余额关联物料不存在')
      return {
        code: material.code,
        materialId: String(balance.materialId),
        unitId: String(material.defaultUnitId),
      }
    }),
  )
  projected.sort((left, right) =>
    left.code.localeCompare(right.code) || left.materialId.localeCompare(right.materialId),
  )
  return projected.map(({ materialId, unitId }) => ({
    materialId,
    unitId,
    countedQuantity: null,
    remark: null,
  }))
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
  deriveHead: async (ctx, _actor, _input, previous) => {
    // 旧记录只有 revision 时，必须在头字段更新前记住原快照仓库。
    // 仓库后续即使被编辑，快照标记仍保持原值，直到用户显式刷新账面数。
    if (previous) {
      const internal = await domainInternalForMutation(ctx, 'invStockCounts', String(previous.id))
      if (typeof internal.snapshotWarehouseId !== 'string' || !internal.snapshotWarehouseId) {
        const previousWarehouseId = typeof previous.warehouseId === 'string' ? previous.warehouseId : ''
        if (!previousWarehouseId) throw synieError('internal', '库存盘点缺少原快照仓库')
        await patchDomainInternal(ctx, 'invStockCounts', String(previous.id), {
          snapshotWarehouseId: previousWarehouseId,
        })
      }
    }
    return deriveStockCountHead(previous)
  },
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
    await freezeStockCountWarehouseSnapshot(
      internal,
      String(head.warehouseId),
      (snapshotWarehouseId) => warehouseRevision(ctx, snapshotWarehouseId),
      (snapshot) => patchDomainInternal(ctx, 'invStockCounts', String(head.id), snapshot),
    )
  },
}

const policies = { invStockDocs: stockDoc, invStockTransfers: stockTransfer, invStockCounts: stockCount } as const
type Resource = keyof typeof policies

function policy(resource: string): AggregatePolicy {
  const result = policies[resource as Resource]
  if (!result) throw synieError('validation', `资源 ${resource} 不是库存聚合草稿`)
  return result
}

export async function createInventoryDraftInMutation(
  ctx: Parameters<typeof createAggregate>[0],
  actor: Parameters<typeof createAggregate>[1],
  resource: string,
  input: unknown,
) {
  const stockCountInput = resource === 'invStockCounts' ? aggregateInput(input) : null
  if (stockCountInput?.loadAll === true) {
    requirePermission(actor, 'inv.stock_count:create')
    const companyId = typeof stockCountInput.companyId === 'string' ? stockCountInput.companyId.trim() : ''
    if (companyId && !canAccessCompany(actor, companyId)) {
      throw synieError('forbidden', '无权操作该公司数据')
    }
  }
  const prepared = resource === 'invStockCounts'
    ? await prepareStockCountDraftInput(input, 'create', (companyId, warehouseId) =>
        stockCountWarehouseItems(ctx, companyId, warehouseId))
    : input
  return createAggregate(ctx, actor, policy(resource), prepared)
}

export async function replaceInventoryDraftInMutation(
  ctx: Parameters<typeof replaceAggregate>[0],
  actor: Parameters<typeof replaceAggregate>[1],
  resource: string,
  id: string,
  input: unknown,
) {
  const prepared = resource === 'invStockCounts'
    ? await prepareStockCountDraftInput(input, 'replace', async () => {
        throw synieError('internal', 'replace 不得执行盘点整仓展开')
      })
    : input
  return replaceAggregate(ctx, actor, policy(resource), id, prepared)
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
  handler: (ctx, args) => replaceInventoryDraftInMutation(ctx, ctx.actor, args.resource, args.id, args.input),
})
export const removeDraft = authedMutation({
  args: { resource: v.string(), id: v.string() }, returns: v.null(),
  handler: async (ctx, args) => { await removeAggregate(ctx, ctx.actor, policy(args.resource), args.id); return null },
})
