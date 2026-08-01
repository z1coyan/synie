import { Decimal, roundAmount } from '@synie/shared'
import { v } from 'convex/values'
import { authedMutation, authedQuery } from '../../lib/auth'
import { synieError } from '../../lib/errors'
import {
  createAggregate,
  loadAggregate,
  removeAggregate,
  replaceAggregate,
  type AggregatePolicy,
  type AggregateRecord,
} from '../shared/aggregate'
import { patchDomainComputed } from '../shared/records'

type JournalLineDeriveCtx = Parameters<NonNullable<AggregatePolicy['nodes'][number]['derive']>>[0]

/** 币种是科目快照字段，客户端无论 create/replace 都不能直接控制。 */
export async function deriveJournalLineAccount(
  ctx: JournalLineDeriveCtx,
  head: AggregateRecord,
  input: AggregateRecord,
): Promise<AggregateRecord> {
  const accountId = typeof input.accountId === 'string'
    ? ctx.db.normalizeId('accounts', input.accountId)
    : null
  const account = accountId ? await ctx.db.get(accountId) : null
  if (!account) throw synieError('validation', '科目不存在')
  if (String(account.companyId) !== String(head.companyId ?? '')) {
    throw synieError('validation', '科目必须属于凭证所在公司')
  }
  if (account.isGroup) throw synieError('validation', '汇总科目不能入账')
  if (!account.active) throw synieError('validation', '停用科目不能入账')
  return { currencyId: account.currencyId ?? null }
}

const policy: AggregatePolicy = {
  headResource: 'accGlJournals',
  nodes: [{
    resource: 'accGlJournalLines',
    collection: 'lines',
    parentField: 'journalId',
    derive: (ctx, { head, input }) => deriveJournalLineAccount(ctx, head, input),
  }],
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

export function createJournalDraftInMutation(
  ctx: Parameters<typeof createAggregate>[0],
  actor: Parameters<typeof createAggregate>[1],
  input: unknown,
) {
  return createAggregate(ctx, actor, policy, input)
}

export const loadDraft = authedQuery({
  args: { resource: v.literal('accGlJournals'), id: v.string() }, returns: v.any(),
  handler: (ctx, args) => loadAggregate(ctx, ctx.actor, policy, args.id),
})

export const createDraft = authedMutation({
  args: { resource: v.literal('accGlJournals'), input: v.any() }, returns: v.any(),
  handler: (ctx, args) => createJournalDraftInMutation(ctx, ctx.actor, args.input),
})

export const replaceDraft = authedMutation({
  args: { resource: v.literal('accGlJournals'), id: v.string(), input: v.any() }, returns: v.any(),
  handler: (ctx, args) => replaceAggregate(ctx, ctx.actor, policy, args.id, args.input),
})

export const removeDraft = authedMutation({
  args: { resource: v.literal('accGlJournals'), id: v.string() }, returns: v.null(),
  handler: async (ctx, args) => { await removeAggregate(ctx, ctx.actor, policy, args.id); return null },
})
