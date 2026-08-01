import { v } from 'convex/values'
import { makeFunctionReference } from 'convex/server'
import { action } from '../_generated/server'

const currentUserRef = makeFunctionReference<'query', {}, { userId: string }>(
  'files/domain:currentUserForAction',
)
const planRef = makeFunctionReference<
  'query',
  { userId: string },
  { stage: string; completed: boolean }
>('setup/sample:planForAction')
const stageRef = makeFunctionReference<
  'mutation',
  { userId: string; expectedStage: string },
  { stage: string; completed: boolean }
>('setup/sample:runStage')

export const seed = action({
  args: {},
  returns: v.object({ stage: v.string(), completed: v.boolean() }),
  handler: async (ctx) => {
    const { userId } = await ctx.runQuery(currentUserRef, {})
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const plan = await ctx.runQuery(planRef, { userId })
      if (plan.completed) return plan
      const result = await ctx.runMutation(stageRef, {
        userId,
        expectedStage: plan.stage,
      })
      if (result.completed) return result
    }
    return ctx.runQuery(planRef, { userId })
  },
})
