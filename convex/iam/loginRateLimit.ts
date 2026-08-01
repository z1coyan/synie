import { v } from 'convex/values'
import { internalMutation } from '../_generated/server'

const WINDOW_MS = 5 * 60 * 1_000
const MAX_FAILURES = 10

export const consume = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const now = Date.now()
    const current = await ctx.db
      .query('authLoginAttempts')
      .withIndex('by_key', (query) => query.eq('key', key))
      .unique()
    if (!current || now - current.windowStartedAt >= WINDOW_MS) {
      if (current) {
        await ctx.db.patch(current._id, { failures: 1, windowStartedAt: now, updatedAt: now })
      } else {
        await ctx.db.insert('authLoginAttempts', {
          key,
          failures: 1,
          windowStartedAt: now,
          updatedAt: now,
        })
      }
      return true
    }
    if (current.failures >= MAX_FAILURES) return false
    await ctx.db.patch(current._id, { failures: current.failures + 1, updatedAt: now })
    return true
  },
})

export const reset = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const current = await ctx.db
      .query('authLoginAttempts')
      .withIndex('by_key', (query) => query.eq('key', key))
      .unique()
    if (current) await ctx.db.delete(current._id)
  },
})
