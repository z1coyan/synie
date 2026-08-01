import { v } from 'convex/values'
import { authedMutation } from './lib/auth'
import { synieError } from './lib/errors'
import { DOMAIN_CANDIDATE_RESOURCES } from './domains/shared/candidates'
import { hydrateStored } from './domains/shared/records'
import { replaceDomainQueryRows } from './domains/shared/queryProfiles'

const storeValidator = v.union(
  v.literal('financeDocuments'),
  v.literal('tradingDocuments'),
  v.literal('manufacturingDocuments'),
)

/**
 * Super-admin repair/backfill seam for deployments created before candidate
 * projections existed. Call each store repeatedly with its returned cursor.
 * Legacy quotation/material snapshots are resolved from their authoritative
 * parents by candidateProjectionRows during this rebuild.
 */
export const rebuildPage = authedMutation({
  args: {
    store: storeValidator,
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    processed: v.number(),
    continueCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    if (!ctx.actor.superAdmin) throw synieError('forbidden', '只有超级管理员可重建候选投影')
    const page = await ctx.db.query(args.store).paginate({ numItems: 64, cursor: args.cursor ?? null })
    let processed = 0
    for (const row of page.page) {
      if (!DOMAIN_CANDIDATE_RESOURCES.has(row.resource)) continue
      const wire = hydrateStored(row as never)
      await replaceDomainQueryRows(ctx, row.resource, String(row._id), wire, {
        companyId: row.companyId,
        parentId: row.parentId,
        status: row.status,
      })
      processed += 1
    }
    return {
      processed,
      continueCursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
    }
  },
})
