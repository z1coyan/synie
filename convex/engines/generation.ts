import type { DomainMutationCtx } from '../lib/mutationContext'
import type { QueryCtx } from '../_generated/server'

export type ProjectionName = 'inventory' | 'gl'

export async function activeGenerationInMutation(
  ctx: DomainMutationCtx,
  projection: ProjectionName,
): Promise<number> {
  const state = await ctx.db
    .query('projectionGenerations')
    .withIndex('by_projection', (query) => query.eq('projection', projection))
    .unique()
  if (state) return state.activeGeneration
  await ctx.db.insert('projectionGenerations', {
    projection,
    activeGeneration: 1,
    verifiedGeneration: 1,
    updatedAt: Date.now(),
  })
  return 1
}

export async function activeGenerationInQuery(ctx: QueryCtx, projection: ProjectionName): Promise<number> {
  return (
    await ctx.db
      .query('projectionGenerations')
      .withIndex('by_projection', (query) => query.eq('projection', projection))
      .unique()
  )?.activeGeneration ?? 1
}
