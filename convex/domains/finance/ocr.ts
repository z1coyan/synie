import { v } from 'convex/values'
import { internalQuery } from '../../_generated/server'
import { actorForAppUser } from '../../lib/actor'
import { requirePermission } from '../../lib/permissions'

export const authorize = internalQuery({
  args: {
    userId: v.id('appUsers'),
    command: v.union(v.literal('invoice'), v.literal('acceptance'), v.literal('configured')),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await actorForAppUser(ctx, args.userId)
    requirePermission(actor, args.command === 'invoice'
      ? 'acc.vat_invoice:create'
      : args.command === 'acceptance'
        ? 'acc.bill_transaction:create'
        : 'acc.setting:read')
    return null
  },
})
