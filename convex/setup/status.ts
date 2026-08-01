import { v } from 'convex/values'
import { query } from '../_generated/server'
import { authComponent, createAuth } from '../auth'
import { readSetupPresence } from './state'

export function hasAnySetupUsers(
  hasAppUsers: boolean,
  authUsers: readonly unknown[],
  authAccounts: readonly unknown[],
): boolean {
  return hasAppUsers || authUsers.length > 0 || authAccounts.length > 0
}

/** Unauthenticated route guard; it exposes no identity data. */
export const get = query({
  args: {},
  returns: v.object({ initialized: v.boolean(), hasUsers: v.boolean() }),
  handler: async (ctx) => {
    const state = await readSetupPresence(ctx.db)
    const auth = createAuth(ctx)
    const adapter = authComponent.adapter(ctx)(auth.options)
    const [authUsers, authAccounts] = await Promise.all([
      adapter.findMany({ model: 'user', limit: 1 }),
      adapter.findMany({ model: 'account', limit: 1 }),
    ])
    return {
      initialized: state.initialized,
      // false 同时证明 ERP Actor 与 Better Auth user/account 都为空。
      hasUsers: hasAnySetupUsers(state.hasUsers, authUsers, authAccounts),
    }
  },
})
