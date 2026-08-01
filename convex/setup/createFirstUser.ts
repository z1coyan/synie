import { v } from 'convex/values'
import { mutation } from '../_generated/server'
import { createFirstUserTransaction } from './core'

/** Public only while setupState is absent; user creation remains server-controlled. */
export const createFirstUser = mutation({
  args: {
    username: v.string(),
    password: v.string(),
    name: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    user: v.object({
      id: v.id('appUsers'),
      username: v.string(),
      name: v.union(v.string(), v.null()),
    }),
  }),
  handler: (ctx, args) => createFirstUserTransaction(ctx, args),
})
