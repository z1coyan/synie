import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import type { DataModel } from '../../_generated/dataModel'
import { synieError } from '../../lib/errors'

type Ctx = GenericMutationCtx<DataModel> | GenericQueryCtx<DataModel>

const SCOPE = 'inventory-warehouse'

export type StockCountWarehouseSnapshot = {
  snapshotWarehouseId: string
  warehouseRevision: bigint
  needsRefresh: boolean
}

/**
 * 盘点账面数和仓库 revision 属于同一个显式快照。
 * 普通保存只补齐首次快照；只有“刷新账面数”才能强制推进到当前仓库 revision。
 */
export async function freezeStockCountWarehouseSnapshot(
  current: Record<string, unknown>,
  warehouseId: string,
  readRevision: (snapshotWarehouseId: string) => Promise<bigint>,
  writeSnapshot: (snapshot: StockCountWarehouseSnapshot) => Promise<void>,
  force = false,
): Promise<StockCountWarehouseSnapshot> {
  const currentWarehouseId = typeof current.snapshotWarehouseId === 'string' && current.snapshotWarehouseId
    ? current.snapshotWarehouseId
    : null
  const currentRevision = typeof current.warehouseRevision === 'bigint'
    ? current.warehouseRevision
    : null
  const snapshotWarehouseId = force ? warehouseId : currentWarehouseId ?? warehouseId
  const warehouseRevision = force || currentRevision === null
    ? await readRevision(snapshotWarehouseId)
    : currentRevision
  const needsRefresh = force
    ? false
    : current.needsRefresh === true || (currentWarehouseId !== null && currentWarehouseId !== warehouseId)
  const snapshot = { snapshotWarehouseId, warehouseRevision, needsRefresh }
  if (
    force ||
    currentWarehouseId !== snapshotWarehouseId ||
    currentRevision !== warehouseRevision ||
    current.needsRefresh !== needsRefresh
  ) {
    await writeSnapshot(snapshot)
  }
  return snapshot
}

export function assertStockCountWarehouseSnapshotCurrent(
  internal: Record<string, unknown>,
  warehouseId: string,
  currentRevision: bigint,
): void {
  if (
    (internal.needsRefresh !== undefined && internal.needsRefresh !== false) ||
    internal.snapshotWarehouseId !== warehouseId ||
    typeof internal.warehouseRevision !== 'bigint' ||
    internal.warehouseRevision !== currentRevision
  ) {
    throw synieError('conflict', '盘点仓库已变更或快照后库存已有变动，请刷新账面数后重新审核')
  }
}

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
