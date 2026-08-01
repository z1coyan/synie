import { makeFunctionReference } from 'convex/server'
import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import { internalAction, internalMutation, internalQuery } from './_generated/server'
import { asDomainMutationCtx } from './lib/mutationContext'
import {
  activateVerifiedGeneration,
  applyGlRebuildChunk,
  applyInventoryRebuildChunk,
  startProjectionRebuild,
} from './engines/reconciliation/rebuild'

const pageResult = v.object({
  ids: v.array(v.string()),
  continueCursor: v.string(),
  isDone: v.boolean(),
})

export const start = internalMutation({
  args: { projection: v.union(v.literal('inventory'), v.literal('gl')) },
  returns: v.id('projectionRebuildSessions'),
  handler: async (ctx, args) => (await startProjectionRebuild(asDomainMutationCtx(ctx), args.projection))._id,
})

export const readStockPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: pageResult,
  handler: async (ctx, args) => {
    const result = await ctx.db.query('stockEntries').paginate(args.paginationOpts)
    return { ids: result.page.map((row) => row._id), continueCursor: result.continueCursor, isDone: result.isDone }
  },
})

export const readGlPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: pageResult,
  handler: async (ctx, args) => {
    const result = await ctx.db.query('glEntries').paginate(args.paginationOpts)
    return { ids: result.page.map((row) => row._id), continueCursor: result.continueCursor, isDone: result.isDone }
  },
})

export const applyStockPage = internalMutation({
  args: {
    sessionId: v.id('projectionRebuildSessions'),
    chunkKey: v.string(),
    ids: v.array(v.id('stockEntries')),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const facts = await Promise.all(args.ids.map((id) => ctx.db.get(id)))
    await applyInventoryRebuildChunk(asDomainMutationCtx(ctx), args.sessionId, args.chunkKey, facts.filter((row) => row !== null))
    return null
  },
})

export const applyGlPage = internalMutation({
  args: {
    sessionId: v.id('projectionRebuildSessions'),
    chunkKey: v.string(),
    ids: v.array(v.id('glEntries')),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const facts = await Promise.all(args.ids.map((id) => ctx.db.get(id)))
    await applyGlRebuildChunk(asDomainMutationCtx(ctx), args.sessionId, args.chunkKey, facts.filter((row) => row !== null))
    return null
  },
})

export const activate = internalMutation({
  args: {
    sessionId: v.id('projectionRebuildSessions'),
    expectedChunks: v.number(),
    expectedSourceRows: v.number(),
  },
  returns: v.number(),
  handler: (ctx, args) => activateVerifiedGeneration(
    asDomainMutationCtx(ctx),
    args.sessionId,
    args.expectedChunks,
    args.expectedSourceRows,
  ),
})

type Projection = 'inventory' | 'gl'
type Page = { ids: string[]; continueCursor: string; isDone: boolean }
const startRef = makeFunctionReference<'mutation', { projection: Projection }, string>('reconciliation:start')
const stockPageRef = makeFunctionReference<'query', { paginationOpts: { numItems: number; cursor: string | null } }, Page>('reconciliation:readStockPage')
const glPageRef = makeFunctionReference<'query', { paginationOpts: { numItems: number; cursor: string | null } }, Page>('reconciliation:readGlPage')
const applyStockRef = makeFunctionReference<'mutation', { sessionId: string; chunkKey: string; ids: string[] }, null>('reconciliation:applyStockPage')
const applyGlRef = makeFunctionReference<'mutation', { sessionId: string; chunkKey: string; ids: string[] }, null>('reconciliation:applyGlPage')
const activateRef = makeFunctionReference<'mutation', { sessionId: string; expectedChunks: number; expectedSourceRows: number }, number>('reconciliation:activate')

/** Internal administrator executor: immutable facts are paged in actions, each rebuild chunk is atomic/idempotent. */
export const rebuild = internalAction({
  args: { projection: v.union(v.literal('inventory'), v.literal('gl')) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const sessionId = await ctx.runMutation(startRef, { projection: args.projection })
    let cursor: string | null = null
    let chunks = 0
    let rows = 0
    do {
      const page: Page = await ctx.runQuery(args.projection === 'inventory' ? stockPageRef : glPageRef, {
        paginationOpts: { numItems: 256, cursor },
      })
      const chunkKey = `${chunks}:${cursor ?? 'start'}`
      if (args.projection === 'inventory') {
        await ctx.runMutation(applyStockRef, { sessionId, chunkKey, ids: page.ids })
      } else {
        await ctx.runMutation(applyGlRef, { sessionId, chunkKey, ids: page.ids })
      }
      chunks += 1
      rows += page.ids.length
      cursor = page.isDone ? null : page.continueCursor
      if (page.isDone) break
    } while (true)
    return ctx.runMutation(activateRef, {
      sessionId,
      expectedChunks: chunks,
      expectedSourceRows: rows,
    })
  },
})
