import { v } from 'convex/values'
import { authedMutation, authedQuery } from '../../lib/auth'
import {
  createAggregate,
  loadAggregate,
  removeAggregate,
  replaceAggregate,
  type AggregatePolicy,
} from '../shared/aggregate'

const policy: AggregatePolicy = {
  headResource: 'accExpenseReports',
  nodes: [{ resource: 'accExpenseReportItems', collection: 'items', parentField: 'reportId' }],
}

export function createExpenseDraftInMutation(
  ctx: Parameters<typeof createAggregate>[0],
  actor: Parameters<typeof createAggregate>[1],
  input: unknown,
) {
  return createAggregate(ctx, actor, policy, input)
}

export const loadDraft = authedQuery({ args: { resource: v.literal('accExpenseReports'), id: v.string() }, returns: v.any(), handler: (ctx, args) => loadAggregate(ctx, ctx.actor, policy, args.id) })
export const createDraft = authedMutation({ args: { resource: v.literal('accExpenseReports'), input: v.any() }, returns: v.any(), handler: (ctx, args) => createExpenseDraftInMutation(ctx, ctx.actor, args.input) })
export const replaceDraft = authedMutation({ args: { resource: v.literal('accExpenseReports'), id: v.string(), input: v.any() }, returns: v.any(), handler: (ctx, args) => replaceAggregate(ctx, ctx.actor, policy, args.id, args.input) })
export const removeDraft = authedMutation({ args: { resource: v.literal('accExpenseReports'), id: v.string() }, returns: v.null(), handler: async (ctx, args) => { await removeAggregate(ctx, ctx.actor, policy, args.id); return null } })
