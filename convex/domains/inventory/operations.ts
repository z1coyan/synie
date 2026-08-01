import { v } from 'convex/values'
import type { Id } from '../../_generated/dataModel'
import { activeGenerationInMutation, activeGenerationInQuery } from '../../engines/generation'
import { inventoryAsOf, readCurrent } from '../../engines/inventory/projections'
import { permissionedMutation, permissionedQuery } from '../../lib/auth'
import { canAccessCompany } from '../../lib/companyScope'
import { scaledInt64ToDecimal } from '../../lib/decimal'
import { synieError, validationError } from '../../lib/errors'
import { asDomainMutationCtx } from '../../lib/mutationContext'
import {
  childrenFor,
  domainInternalForMutation,
  hydrateStored,
  patchDomainComputed,
  patchDomainInternal,
  unsafeStoredForMutation,
} from '../shared/records'
import { freezeStockCountWarehouseSnapshot, warehouseRevision } from './revisions'

export const stockBalance = permissionedQuery('inv.stock_entry:read')({
  args: {
    companyId: v.string(),
    asOf: v.optional(v.string()),
    warehouseId: v.optional(v.id('warehouses')),
    materialId: v.optional(v.id('materials')),
    hideZero: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (!canAccessCompany(ctx.actor, args.companyId)) throw synieError('forbidden', '无权查看该公司库存')
    if (args.asOf && !/^\d{4}-\d{2}-\d{2}$/.test(args.asOf)) {
      throw validationError('库存余额参数不合法', { asOf: ['须为 YYYY-MM-DD 日期'] })
    }
    const generation = await activeGenerationInQuery(ctx, 'inventory')
    const candidates = await ctx.db.query('inventoryCurrentBalances').withIndex('by_key', (q) =>
      q.eq('generation', generation).eq('companyId', args.companyId),
    ).take(20_000)
    const results = []
    for (const row of candidates) {
      if (args.warehouseId && row.warehouseId !== args.warehouseId) continue
      if (args.materialId && row.materialId !== args.materialId) continue
      const quantity = args.asOf
        ? (await inventoryAsOf(ctx, generation, row, args.asOf)).baseQty
        : row.baseQty
      if ((args.hideZero ?? true) && quantity === 0n) continue
      const [warehouse, material] = await Promise.all([
        ctx.db.get(row.warehouseId),
        ctx.db.get(row.materialId),
      ])
      if (!warehouse || !material) continue
      const unit = await ctx.db.get(material.defaultUnitId)
      results.push({
        id: `${warehouse._id}:${material._id}`,
        warehouseId: warehouse._id,
        warehouseName: warehouse.name,
        materialId: material._id,
        materialCode: material.code,
        materialName: material.name,
        materialSpec: material.spec,
        unitName: unit?.name ?? '',
        quantity: scaledInt64ToDecimal(quantity, 6),
      })
    }
    results.sort((left, right) =>
      left.warehouseName.localeCompare(right.warehouseName, 'zh') ||
      left.materialCode.localeCompare(right.materialCode),
    )
    return { count: results.length, results }
  },
})

export const outsourcedWarehouses = permissionedQuery('inv.warehouse:read')({
  args: { partyType: v.union(v.literal('SUPPLIER'), v.literal('COMPANY')), partyId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query('warehouses').withIndex('by_party_name_key', (q) =>
      q.eq('partyType', args.partyType).eq('partyId', args.partyId),
    ).take(500)
    return rows
      .filter((row) => row.active && row.isLeaf && row.isOutsourced && canAccessCompany(ctx.actor, row.companyId))
      .map((row) => ({
        id: row._id, name: row.name, companyId: row.companyId, parentId: row.parentId,
        partyType: row.partyType, partyId: row.partyId, isLeaf: row.isLeaf,
        active: row.active, isOutsourced: row.isOutsourced,
      }))
  },
})

export const refreshStockCount = permissionedMutation('inv.stock_count:update')({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const stored = await unsafeStoredForMutation(ctx, 'invStockCounts', args.id)
    const head = hydrateStored(stored)
    if (head.status !== 'DRAFT') throw synieError('conflict', '仅草稿库存盘点单可刷新账面数量')
    const companyId = String(head.companyId ?? '')
    if (!canAccessCompany(ctx.actor, companyId)) throw synieError('forbidden', '无权操作该公司数据')
    const warehouseId = ctx.db.normalizeId('warehouses', String(head.warehouseId ?? ''))
    if (!warehouseId) throw synieError('validation', '盘点仓库不存在')
    const generation = await activeGenerationInMutation(asDomainMutationCtx(ctx), 'inventory')
    for (const item of await childrenFor(ctx, 'invStockCountItems', args.id)) {
      const materialId = ctx.db.normalizeId('materials', String(item.materialId ?? ''))
      if (!materialId) throw synieError('validation', '盘点物料不存在')
      const balance = await readCurrent(asDomainMutationCtx(ctx), generation, {
        companyId,
        warehouseId: warehouseId as Id<'warehouses'>,
        materialId: materialId as Id<'materials'>,
      })
      await patchDomainComputed(
        ctx,
        ctx.actor,
        'invStockCountItems',
        String(item.id),
        { bookQuantity: scaledInt64ToDecimal(balance?.baseQty ?? 0n, 6) },
        'sync_book_quantity',
      )
    }
    await patchDomainComputed(
      ctx,
      ctx.actor,
      'invStockCounts',
      args.id,
      { snapshotTakenAt: Date.now() },
      'refresh',
    )
    const internal = await domainInternalForMutation(ctx, 'invStockCounts', args.id)
    await freezeStockCountWarehouseSnapshot(
      internal,
      String(warehouseId),
      (snapshotWarehouseId) => warehouseRevision(ctx, snapshotWarehouseId),
      (snapshot) => patchDomainInternal(ctx, 'invStockCounts', args.id, snapshot),
      true,
    )
    return hydrateStored(await unsafeStoredForMutation(ctx, 'invStockCounts', args.id))
  },
})
