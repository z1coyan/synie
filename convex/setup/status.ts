import { v } from 'convex/values'
import { query } from '../_generated/server'
import { readSetupPresence } from './state'

/** Unauthenticated route guard; it exposes no identity data. */
export const get = query({
  args: {},
  returns: v.object({ initialized: v.boolean(), hasUsers: v.boolean() }),
  handler: async (ctx) => {
    const state = await readSetupPresence(ctx.db)
    return { initialized: state.initialized, hasUsers: state.hasUsers }
  },
})
