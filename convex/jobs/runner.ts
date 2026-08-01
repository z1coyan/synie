"use node"

import { makeFunctionReference } from 'convex/server'
import { internalAction } from '../_generated/server'

type DueJob = { _id: string; kind: string }
const scheduleRef = makeFunctionReference<'mutation', { now: number; token: string }, { jobs: string[] }>('domains/market/domain:scheduleTick')
const dueRef = makeFunctionReference<'query', { now: number; limit?: number }, DueJob[]>('jobs/domain:due')
const marketRef = makeFunctionReference<'action', { jobId: string }, unknown>('domains/market/actions:runQueued')
const cleanupRef = makeFunctionReference<'action', { jobId: string }, unknown>('files/maintenance:runCleanupJob')
const reconcileRef = makeFunctionReference<'action', { jobId: string }, unknown>('files/maintenance:runReconciliationJob')
const bankImportRef = makeFunctionReference<'action', { jobId: string }, unknown>('domains/finance/bankImportActions:resume')
const attendanceImportRef = makeFunctionReference<'action', { jobId: string }, unknown>('domains/hr/attendanceImportActions:resume')

/**
 * One-minute durable dispatcher. It only schedules small job ids; provider data
 * remains in S3/Convex and each worker must acquire its own persisted lease.
 */
export const tick = internalAction({
  args: {}, returns: undefined,
  handler: async (ctx) => {
    const now = Date.now()
    await ctx.runMutation(scheduleRef, { now, token: crypto.randomUUID() })
    const due = await ctx.runQuery(dueRef, { now, limit: 50 })
    for (const job of due) {
      if (job.kind === 'market_refresh') {
        await ctx.scheduler.runAfter(0, marketRef, { jobId: job._id })
      } else if (job.kind === 'file_cleanup') {
        await ctx.scheduler.runAfter(0, cleanupRef, { jobId: job._id })
      } else if (job.kind === 's3_reconcile') {
        await ctx.scheduler.runAfter(0, reconcileRef, { jobId: job._id })
      } else if (job.kind === 'bank_import_parse' || job.kind === 'bank_import_commit') {
        await ctx.scheduler.runAfter(0, bankImportRef, { jobId: job._id })
      } else if (job.kind === 'attendance_import_parse' || job.kind === 'attendance_import_commit') {
        await ctx.scheduler.runAfter(0, attendanceImportRef, { jobId: job._id })
      }
    }
  },
})
