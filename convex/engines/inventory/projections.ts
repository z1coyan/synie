import type { Id } from '../../_generated/dataModel'
import type { DomainMutationCtx } from '../../lib/mutationContext'
import type { QueryCtx } from '../../_generated/server'
import { checkedAdd, postingMonth } from '../shared'

export type InventoryProjectionKey = {
  companyId: string
  warehouseId: Id<'warehouses'>
  materialId: Id<'materials'>
}

export async function readCurrent(
  ctx: DomainMutationCtx,
  generation: number,
  key: InventoryProjectionKey,
) {
  return ctx.db
    .query('inventoryCurrentBalances')
    .withIndex('by_key', (query) =>
      query
        .eq('generation', generation)
        .eq('companyId', key.companyId)
        .eq('warehouseId', key.warehouseId)
        .eq('materialId', key.materialId),
    )
    .unique()
}

export async function applyInventoryDelta(
  ctx: DomainMutationCtx,
  generation: number,
  key: InventoryProjectionKey,
  date: string,
  delta: bigint,
): Promise<void> {
  const now = Date.now()
  const current = await readCurrent(ctx, generation, key)
  if (current) await ctx.db.patch(current._id, { baseQty: checkedAdd(current.baseQty, delta), updatedAt: now })
  else await ctx.db.insert('inventoryCurrentBalances', { generation, ...key, baseQty: delta, updatedAt: now })

  const daily = await ctx.db
    .query('inventoryDailyDeltas')
    .withIndex('by_key_date', (query) =>
      query.eq('generation', generation).eq('companyId', key.companyId).eq('warehouseId', key.warehouseId)
        .eq('materialId', key.materialId).eq('postingDate', date),
    )
    .unique()
  if (daily) await ctx.db.patch(daily._id, { baseQty: checkedAdd(daily.baseQty, delta) })
  else await ctx.db.insert('inventoryDailyDeltas', { generation, ...key, postingDate: date, baseQty: delta })

  const month = postingMonth(date)
  const monthly = await ctx.db
    .query('inventoryMonthlyDeltas')
    .withIndex('by_key_month', (query) =>
      query.eq('generation', generation).eq('companyId', key.companyId).eq('warehouseId', key.warehouseId)
        .eq('materialId', key.materialId).eq('postingMonth', month),
    )
    .unique()
  if (monthly) await ctx.db.patch(monthly._id, { baseQty: checkedAdd(monthly.baseQty, delta) })
  else await ctx.db.insert('inventoryMonthlyDeltas', { generation, ...key, postingMonth: month, baseQty: delta })
}

/** Reads <= 2,400 month buckets + 31 current-month day buckets, never stock facts. */
export async function inventoryAsOf(
  ctx: QueryCtx,
  generation: number,
  key: InventoryProjectionKey,
  date: string,
): Promise<{ baseQty: bigint; scannedBuckets: number }> {
  const month = postingMonth(date)
  const [months, days] = await Promise.all([
    ctx.db.query('inventoryMonthlyDeltas').withIndex('by_key_month', (query) =>
      query.eq('generation', generation).eq('companyId', key.companyId).eq('warehouseId', key.warehouseId)
        .eq('materialId', key.materialId).lt('postingMonth', month),
    ).take(2_400),
    ctx.db.query('inventoryDailyDeltas').withIndex('by_key_date', (query) =>
      query.eq('generation', generation).eq('companyId', key.companyId).eq('warehouseId', key.warehouseId)
        .eq('materialId', key.materialId).gte('postingDate', `${month}-01`).lte('postingDate', date),
    ).take(31),
  ])
  let baseQty = 0n
  for (const row of [...months, ...days]) baseQty = checkedAdd(baseQty, row.baseQty)
  return { baseQty, scannedBuckets: months.length + days.length }
}
