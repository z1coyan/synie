import { Decimal, roundAmount } from '@synie/shared'
import { v } from 'convex/values'
import { authedMutation, authedQuery } from '../../lib/auth'
import {
  createAggregate,
  loadAggregate,
  removeAggregate,
  replaceAggregate,
  type AggregatePolicy,
} from '../shared/aggregate'
import { patchDomainComputed } from '../shared/records'

const policy: AggregatePolicy = {
  headResource: 'accGlJournals',
  nodes: [{ resource: 'accGlJournalLines', collection: 'lines', parentField: 'journalId' }],
  afterSave: async (ctx, actor, head) => {
    const rows = await loadAggregate(ctx, actor, policy, String(head.id))
    const lines = rows.lines as Array<Record<string, unknown>>
    const debit = lines.reduce((sum, line) => sum.add(String(line.debit ?? '0')), new Decimal(0))
    const credit = lines.reduce((sum, line) => sum.add(String(line.credit ?? '0')), new Decimal(0))
    await patchDomainComputed(ctx, actor, 'accGlJournals', String(head.id), {
      debitTotal: roundAmount(debit),
      creditTotal: roundAmount(credit),
    }, 'recalculate')
  },
}

export const loadDraft = authedQuery({
  args: { resource: v.literal('accGlJournals'), id: v.string() }, returns: v.any(),
  handler: (ctx, args) => loadAggregate(ctx, ctx.actor, policy, args.id),
})

export const createDraft = authedMutation({
  args: { resource: v.literal('accGlJournals'), input: v.any() }, returns: v.any(),
  handler: (ctx, args) => createAggregate(ctx, ctx.actor, policy, args.input),
})

export const replaceDraft = authedMutation({
  args: { resource: v.literal('accGlJournals'), id: v.string(), input: v.any() }, returns: v.any(),
  handler: (ctx, args) => replaceAggregate(ctx, ctx.actor, policy, args.id, args.input),
})

export const removeDraft = authedMutation({
  args: { resource: v.literal('accGlJournals'), id: v.string() }, returns: v.null(),
  handler: async (ctx, args) => { await removeAggregate(ctx, ctx.actor, policy, args.id); return null },
})
