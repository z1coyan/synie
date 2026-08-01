"use node"

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { action } from '../_generated/server'
import { synieError } from '../lib/errors'

declare const process: { env: Record<string, string | undefined> }

const cleanupRef = makeFunctionReference<'action', {}, unknown>('files/maintenance:scheduleCleanup')
const reconciliationRef = makeFunctionReference<'action', {}, unknown>('files/maintenance:scheduleReconciliation')

function equalSecret(candidate: string, expected: string): boolean {
  const left = new TextEncoder().encode(candidate)
  const right = new TextEncoder().encode(expected)
  const length = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

function requireProbeSecret(candidate: string): void {
  const expected = process.env.SYNIE_RESOURCE_SPIKE_SECRET
  if (!expected || !equalSecret(candidate, expected)) {
    throw synieError('forbidden', '资源迁移测试入口不可用')
  }
}

/**
 * 仅供临时 self-host 验收栈使用。生产未配置 spike secret 时入口保持关闭。
 * 业务代码只能由 cron/job runner 调用对应 internal actions。
 */
export const runFileMaintenance = action({
  args: { spikeSecret: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireProbeSecret(args.spikeSecret)
    const cleanup = await ctx.runAction(cleanupRef, {})
    const reconciliation = await ctx.runAction(reconciliationRef, {})
    return { cleanup, reconciliation }
  },
})
