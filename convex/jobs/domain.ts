import type { GenericMutationCtx } from 'convex/server'
import { v } from 'convex/values'
import type { DataModel, Doc, Id } from '../_generated/dataModel'
import { internalMutation, internalQuery } from '../_generated/server'
import { authedQuery } from '../lib/auth'
import { paginationOptions, resourcePage } from '../lib/pagination'
import { requirePermission } from '../lib/permissions'
import { synieError } from '../lib/errors'
import { acquireLease, retryDelayMs } from './model'

type MutationCtx = GenericMutationCtx<DataModel>
type JobKind = Doc<'ioJobs'>['kind']

export async function createJob(ctx: MutationCtx, input: {
  kind: JobKind
  idempotencyKey: string
  subjectId?: string | null
  fileId?: Id<'files'> | null
  companyId?: string | null
  createdById?: Id<'appUsers'> | null
  phase: string
  progressTotal?: number
  parameters?: unknown
  maxAttempts?: number
}): Promise<Doc<'ioJobs'>> {
  const existing = await ctx.db.query('ioJobs').withIndex('by_idempotency', (q) =>
    q.eq('kind', input.kind).eq('idempotencyKey', input.idempotencyKey),
  ).unique()
  if (existing) return existing
  const now = Date.now()
  const id = await ctx.db.insert('ioJobs', {
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    subjectId: input.subjectId ?? null,
    fileId: input.fileId ?? null,
    companyId: input.companyId ?? null,
    createdById: input.createdById ?? null,
    status: 'queued',
    phase: input.phase,
    progressDone: 0,
    progressTotal: input.progressTotal ?? 0,
    leaseToken: null,
    leaseExpiresAt: null,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 5,
    nextAttemptAt: now,
    errorCode: null,
    errorMessage: null,
    parameters: input.parameters ?? {},
    insertedAt: now,
    updatedAt: now,
  })
  return (await ctx.db.get(id))!
}

export async function claimJob(ctx: MutationCtx, id: Id<'ioJobs'>, token: string, leaseMs = 60_000) {
  const job = await ctx.db.get(id)
  if (!job) throw synieError('not_found', '任务不存在')
  const next = acquireLease(job, Date.now(), token, leaseMs)
  await ctx.db.patch(job._id, { ...next, updatedAt: Date.now() })
  return (await ctx.db.get(job._id))!
}

export function requireJobLease(job: Doc<'ioJobs'> | null, token: string): asserts job is Doc<'ioJobs'> {
  if (!job || job.status !== 'running' || job.leaseToken !== token || (job.leaseExpiresAt ?? 0) < Date.now()) {
    throw synieError('conflict', '任务 lease 已失效')
  }
}

export async function recordJobFailure(ctx: MutationCtx, job: Doc<'ioJobs'>, code: string, message: string): Promise<void> {
  const dead = job.attempts >= job.maxAttempts
  await ctx.db.patch(job._id, {
    status: dead ? 'dead_letter' : 'failed',
    leaseToken: null,
    leaseExpiresAt: null,
    nextAttemptAt: Date.now() + retryDelayMs(job.attempts),
    errorCode: code.slice(0, 80),
    errorMessage: message.slice(0, 500),
    updatedAt: Date.now(),
  })
}

export const claim = internalMutation({
  args: { id: v.id('ioJobs'), token: v.string(), leaseMs: v.optional(v.number()) },
  returns: v.any(),
  handler: (ctx, args) => claimJob(ctx, args.id, args.token, args.leaseMs),
})

export const fail = internalMutation({
  args: { id: v.id('ioJobs'), token: v.string(), code: v.string(), message: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.id)
    requireJobLease(job, args.token)
    await recordJobFailure(ctx, job, args.code, args.message)
    return null
  },
})

export const due = internalQuery({
  args: { now: v.number(), limit: v.optional(v.number()) }, returns: v.any(),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 50, 100))
    const queued = await ctx.db.query('ioJobs').withIndex('by_status_next', (q) =>
      q.eq('status', 'queued').lte('nextAttemptAt', args.now),
    ).take(limit)
    if (queued.length >= limit) return queued
    const failed = await ctx.db.query('ioJobs').withIndex('by_status_next', (q) =>
      q.eq('status', 'failed').lte('nextAttemptAt', args.now),
    ).take(limit - queued.length)
    if (queued.length + failed.length >= limit) return [...queued, ...failed]
    const expired = await ctx.db.query('ioJobs').withIndex('by_lease', (q) =>
      q.eq('status', 'running').lte('leaseExpiresAt', args.now),
    ).take(limit - queued.length - failed.length)
    return [...queued, ...failed, ...expired]
  },
})

export const list = authedQuery({
  args: { numItems: v.number(), cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'sys.audit_log:read')
    const page = await ctx.db.query('ioJobs').withIndex('by_status_next').order('desc').paginate(paginationOptions(args))
    return resourcePage({ ...page, page: page.page.map((job) => ({
      id: job._id, kind: job.kind, status: job.status, phase: job.phase,
      progressDone: job.progressDone, progressTotal: job.progressTotal,
      attempts: job.attempts, errorCode: job.errorCode, errorMessage: job.errorMessage,
      insertedAt: new Date(job.insertedAt).toISOString(), updatedAt: new Date(job.updatedAt).toISOString(),
    })) })
  },
})
