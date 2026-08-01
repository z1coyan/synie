import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import type { DataModel } from '../../_generated/dataModel'

type Ctx = GenericMutationCtx<DataModel> | GenericQueryCtx<DataModel>

const SCOPE = 'inventory-warehouse'

export async function warehouseRevision(ctx: Ctx, warehouseId: string): Promise<bigint> {
  const row = await ctx.db.query('domainRevisions').withIndex('by_scope_key', (q) =>
    q.eq('scope', SCOPE).eq('key', warehouseId),
  ).unique()
  return row?.revision ?? 0n
}

export async function bumpWarehouseRevision(
  ctx: GenericMutationCtx<DataModel>,
  warehouseId: string,
): Promise<bigint> {
  const row = await ctx.db.query('domainRevisions').withIndex('by_scope_key', (q) =>
    q.eq('scope', SCOPE).eq('key', warehouseId),
  ).unique()
  const revision = (row?.revision ?? 0n) + 1n
  if (row) await ctx.db.patch(row._id, { revision, updatedAt: Date.now() })
  else await ctx.db.insert('domainRevisions', {
    scope: SCOPE,
    key: warehouseId,
    revision,
    updatedAt: Date.now(),
  })
  return revision
}
