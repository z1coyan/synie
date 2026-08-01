import type { Doc, Id } from '../../_generated/dataModel'
import type { DomainMutationCtx } from '../../lib/mutationContext'
import { synieError } from '../../lib/errors'
import { applyGlProjection } from '../gl/projections'
import { applyInventoryDelta } from '../inventory/projections'

export async function startProjectionRebuild(
  ctx: DomainMutationCtx,
  projection: 'inventory' | 'gl',
): Promise<Doc<'projectionRebuildSessions'>> {
  const activeSession = await ctx.db.query('projectionRebuildSessions').withIndex('by_projection_state', (q) =>
    q.eq('projection', projection).eq('state', 'building'),
  ).unique()
  if (activeSession) return activeSession
  const state = await ctx.db.query('projectionGenerations').withIndex('by_projection', (q) =>
    q.eq('projection', projection),
  ).unique()
  const targetGeneration = (state?.activeGeneration ?? 1) + 1
  const id = await ctx.db.insert('projectionRebuildSessions', {
    projection,
    targetGeneration,
    state: 'building',
    completedChunks: 0,
    sourceRows: 0,
    liveRows: 0,
    startedAt: Date.now(),
    completedAt: null,
  })
  return (await ctx.db.get(id))!
}

async function claimChunk(
  ctx: DomainMutationCtx,
  session: Doc<'projectionRebuildSessions'>,
  chunkKey: string,
  sourceRows: number,
  liveRows: number,
): Promise<boolean> {
  const existing = await ctx.db.query('projectionRebuildChunks').withIndex('by_session_chunk', (q) =>
    q.eq('sessionId', session._id).eq('chunkKey', chunkKey),
  ).unique()
  if (existing) return false
  await ctx.db.insert('projectionRebuildChunks', {
    sessionId: session._id,
    chunkKey,
    sourceRows,
    liveRows,
    completedAt: Date.now(),
  })
  await ctx.db.patch(session._id, {
    completedChunks: session.completedChunks + 1,
    sourceRows: session.sourceRows + sourceRows,
    liveRows: session.liveRows + liveRows,
  })
  return true
}

export async function applyInventoryRebuildChunk(
  ctx: DomainMutationCtx,
  sessionId: Id<'projectionRebuildSessions'>,
  chunkKey: string,
  facts: readonly Doc<'stockEntries'>[],
): Promise<void> {
  const session = await ctx.db.get(sessionId)
  if (!session || session.projection !== 'inventory' || session.state !== 'building') {
    throw synieError('conflict', '库存投影重建会话不可写')
  }
  const live = facts.filter((fact) => !fact.cancelled)
  if (!(await claimChunk(ctx, session, chunkKey, facts.length, live.length))) return
  for (const fact of live) await applyInventoryDelta(ctx, session.targetGeneration, {
    companyId: fact.companyId,
    warehouseId: fact.warehouseId,
    materialId: fact.materialId,
  }, fact.postingDate, fact.signedBaseQty)
}

export async function applyGlRebuildChunk(
  ctx: DomainMutationCtx,
  sessionId: Id<'projectionRebuildSessions'>,
  chunkKey: string,
  facts: readonly Doc<'glEntries'>[],
): Promise<void> {
  const session = await ctx.db.get(sessionId)
  if (!session || session.projection !== 'gl' || session.state !== 'building') {
    throw synieError('conflict', '总账投影重建会话不可写')
  }
  const live = facts.filter((fact) => !fact.cancelled)
  if (!(await claimChunk(ctx, session, chunkKey, facts.length, live.length))) return
  for (const fact of live) await applyGlProjection(ctx, session.targetGeneration, {
    companyId: fact.companyId,
    accountId: fact.accountId,
    postingDate: fact.postingDate,
    debit: fact.debit,
    credit: fact.credit,
    partyType: fact.partyType,
    partyId: fact.partyId,
  })
}

export async function activateVerifiedGeneration(
  ctx: DomainMutationCtx,
  sessionId: Id<'projectionRebuildSessions'>,
  expectedChunks: number,
  expectedSourceRows: number,
): Promise<number> {
  const session = await ctx.db.get(sessionId)
  if (!session || session.state !== 'building') throw synieError('conflict', '投影重建会话不可切换')
  if (session.completedChunks !== expectedChunks || session.sourceRows !== expectedSourceRows) {
    throw synieError('conflict', '投影重建尚未覆盖全部事实')
  }
  const state = await ctx.db.query('projectionGenerations').withIndex('by_projection', (q) =>
    q.eq('projection', session.projection),
  ).unique()
  if (state && state.activeGeneration >= session.targetGeneration) throw synieError('conflict', '投影 generation 已推进')
  if (state) await ctx.db.patch(state._id, {
    activeGeneration: session.targetGeneration,
    verifiedGeneration: session.targetGeneration,
    updatedAt: Date.now(),
  })
  else await ctx.db.insert('projectionGenerations', {
    projection: session.projection,
    activeGeneration: session.targetGeneration,
    verifiedGeneration: session.targetGeneration,
    updatedAt: Date.now(),
  })
  await ctx.db.patch(session._id, { state: 'activated', completedAt: Date.now() })
  return session.targetGeneration
}
