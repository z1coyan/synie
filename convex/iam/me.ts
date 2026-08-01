import { v } from 'convex/values'
import { authedQuery } from '../lib/auth'
import type { Actor } from '../lib/actor'

/** Pure wire projection: authentication-only fields such as internal email never enter it. */
export function actorToMe(actor: Actor) {
  return {
    user: { id: actor.userId, username: actor.username, name: actor.name },
    superAdmin: actor.superAdmin,
    allCompanies: actor.allCompanies,
    permissions: [...actor.permissions].sort(),
    companyIds: [...actor.companyIds].sort(),
  }
}

/** authedQuery calls requireActor for every invocation, so grants are never session-cached. */
export const get = authedQuery({
  args: {},
  returns: v.object({
    user: v.object({
      id: v.id('appUsers'),
      username: v.string(),
      name: v.union(v.string(), v.null()),
    }),
    superAdmin: v.boolean(),
    allCompanies: v.boolean(),
    permissions: v.array(v.string()),
    companyIds: v.array(v.string()),
  }),
  handler: async (ctx) => actorToMe(ctx.actor),
})
