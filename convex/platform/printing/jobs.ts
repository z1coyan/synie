import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { internalMutation, internalQuery } from '../../_generated/server'
import { authedQuery } from '../../lib/auth'
import { actorForAppUser, requireActor } from '../../lib/actor'
import { canAccessCompany } from '../../lib/companyScope'
import { synieError } from '../../lib/errors'
import { requirePermission } from '../../lib/permissions'
import {
  printJobClaimDisposition,
  printJobRetryDelay,
  printJobShouldRetry,
} from './policy'

const printResource = v.union(v.literal('sales.order'), v.literal('mfg.work_order'))
const dispatchRef = makeFunctionReference<'action', { jobId: string }, unknown>('platform/printing/actions:dispatch')

function jobPresent(row: {
  _id: string; resource: string; templateId: string; status: string; attempts: number
  errorCode: string | null; filename: string; insertedAt: number; updatedAt: number; expiresAt: number
  outputArtifactId: string | null
}) {
  return {
    id: row._id,
    resource: row.resource,
    templateId: row.templateId,
    status: row.expiresAt <= Date.now() && row.status !== 'succeeded' ? 'expired' : row.status,
    attempts: row.attempts,
    errorCode: row.errorCode,
    filename: row.filename,
    hasOutput: Boolean(row.outputArtifactId),
    insertedAt: new Date(row.insertedAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    expiresAt: row.expiresAt,
  }
}

function authorizeScope(actor: Parameters<typeof canAccessCompany>[0], companyIds: string[]): void {
  if (companyIds.some((companyId) => !canAccessCompany(actor, companyId))) {
    throw synieError('forbidden', '无权访问该打印结果')
  }
}

export const createExportArtifact = internalMutation({
  args: {
    actorUserId: v.id('appUsers'), companyIds: v.array(v.string()), resource: printResource,
    permission: v.string(), requestKey: v.string(), objectKey: v.string(), filename: v.string(),
    contentType: v.string(), size: v.number(), sha256: v.string(), expiresAt: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await actorForAppUser(ctx, args.actorUserId)
    requirePermission(actor, args.permission)
    authorizeScope(actor, args.companyIds)
    const existing = await ctx.db.query('printArtifacts').withIndex('by_owner_request', (q) =>
      q.eq('ownerUserId', actor.userId).eq('kind', 'export_xlsx').eq('requestKey', args.requestKey),
    ).unique()
    if (existing && existing.expiresAt > Date.now()) return { artifact: existing, reused: true }
    const id = await ctx.db.insert('printArtifacts', {
      ownerUserId: actor.userId, companyIds: args.companyIds, resource: args.resource,
      permission: args.permission, kind: 'export_xlsx', requestKey: args.requestKey,
      objectKey: args.objectKey, filename: args.filename, contentType: args.contentType,
      size: args.size, sha256: args.sha256, expiresAt: args.expiresAt, insertedAt: Date.now(),
    })
    return { artifact: (await ctx.db.get(id))!, reused: false }
  },
})

export const createPrintJob = internalMutation({
  args: {
    actorUserId: v.id('appUsers'), companyIds: v.array(v.string()), resource: printResource,
    permission: v.string(), templateId: v.id('printTemplates'), idempotencyKey: v.string(),
    input: v.object({ objectKey: v.string(), filename: v.string(), contentType: v.string(), size: v.number(), sha256: v.string() }),
    outputObjectKey: v.string(), filename: v.string(), expiresAt: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await actorForAppUser(ctx, args.actorUserId)
    requirePermission(actor, args.permission)
    authorizeScope(actor, args.companyIds)
    const existing = await ctx.db.query('printJobs').withIndex('by_owner_idempotency', (q) =>
      q.eq('ownerUserId', actor.userId).eq('idempotencyKey', args.idempotencyKey),
    ).unique()
    if (existing && existing.expiresAt > Date.now()) return { job: jobPresent(existing), reused: true }
    const now = Date.now()
    const inputArtifactId = await ctx.db.insert('printArtifacts', {
      ownerUserId: actor.userId, companyIds: args.companyIds, resource: args.resource,
      permission: args.permission, kind: 'print_input_xlsx', requestKey: args.idempotencyKey,
      ...args.input, expiresAt: args.expiresAt, insertedAt: now,
    })
    const id = await ctx.db.insert('printJobs', {
      ownerUserId: actor.userId, companyIds: args.companyIds, resource: args.resource,
      permission: args.permission, templateId: args.templateId, idempotencyKey: args.idempotencyKey,
      status: 'queued', attempts: 0, maxAttempts: 5, nextAttemptAt: now,
      leaseToken: null, leaseExpiresAt: null, deadlineAt: null,
      inputArtifactId, outputArtifactId: null, outputObjectKey: args.outputObjectKey,
      filename: args.filename, errorCode: null, insertedAt: now, updatedAt: now,
      expiresAt: args.expiresAt,
    })
    await ctx.scheduler.runAfter(0, dispatchRef, { jobId: id })
    return { job: jobPresent((await ctx.db.get(id))!), reused: false }
  },
})

export const claim = internalMutation({
  args: { jobId: v.id('printJobs'), leaseToken: v.string(), now: v.number() }, returns: v.any(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job) return null
    const disposition = printJobClaimDisposition(job, args.now)
    if (disposition === 'expired') {
      await ctx.db.patch(job._id, { status: 'expired', leaseToken: null, leaseExpiresAt: null, updatedAt: args.now })
      return null
    }
    if (disposition === 'wait') return null
    if (disposition === 'exhausted') {
      await ctx.db.patch(job._id, { status: 'failed', errorCode: job.errorCode ?? 'attempts_exhausted', updatedAt: args.now })
      return null
    }
    const input = await ctx.db.get(job.inputArtifactId)
    if (!input || input.expiresAt <= args.now) {
      await ctx.db.patch(job._id, { status: 'failed', errorCode: 'input_expired', updatedAt: args.now })
      return null
    }
    const attempt = job.attempts + 1
    const deadlineAt = args.now + 120_000
    await ctx.db.patch(job._id, {
      status: 'running', attempts: attempt, leaseToken: args.leaseToken,
      leaseExpiresAt: deadlineAt + 15_000, deadlineAt, errorCode: null, updatedAt: args.now,
    })
    return {
      jobId: job._id, attempt, deadlineAt, leaseToken: args.leaseToken,
      input: { objectKey: input.objectKey, size: input.size, sha256: input.sha256 },
      outputObjectKey: job.outputObjectKey, ownerUserId: job.ownerUserId,
      companyIds: job.companyIds, resource: job.resource, permission: job.permission,
      filename: job.filename, expiresAt: job.expiresAt,
    }
  },
})

export const complete = internalMutation({
  args: {
    jobId: v.id('printJobs'), leaseToken: v.string(), attempt: v.number(),
    output: v.object({ objectKey: v.string(), size: v.number(), sha256: v.string(), contentType: v.string() }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job || job.status !== 'running' || job.leaseToken !== args.leaseToken || job.attempts !== args.attempt) {
      throw synieError('conflict', '打印任务 lease 已失效')
    }
    const outputArtifactId = await ctx.db.insert('printArtifacts', {
      ownerUserId: job.ownerUserId, companyIds: job.companyIds, resource: job.resource,
      permission: job.permission, kind: 'print_pdf', requestKey: job.idempotencyKey,
      objectKey: args.output.objectKey, filename: job.filename, contentType: args.output.contentType,
      size: args.output.size, sha256: args.output.sha256, expiresAt: job.expiresAt, insertedAt: Date.now(),
    })
    await ctx.db.patch(job._id, {
      status: 'succeeded', outputArtifactId, leaseToken: null, leaseExpiresAt: null,
      deadlineAt: null, errorCode: null, updatedAt: Date.now(),
    })
    return null
  },
})

export const fail = internalMutation({
  args: {
    jobId: v.id('printJobs'), leaseToken: v.string(), attempt: v.number(),
    code: v.string(), retryable: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job || job.status !== 'running' || job.leaseToken !== args.leaseToken || job.attempts !== args.attempt) return null
    const now = Date.now()
    const retry = printJobShouldRetry({
      retryable: args.retryable,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      expiresAt: job.expiresAt,
      now,
    })
    const delay = printJobRetryDelay(job.attempts)
    await ctx.db.patch(job._id, {
      status: retry ? 'retryable' : 'failed', leaseToken: null, leaseExpiresAt: null,
      deadlineAt: null, nextAttemptAt: now + (retry ? delay : 0),
      errorCode: args.code.slice(0, 80), updatedAt: now,
    })
    if (retry) await ctx.scheduler.runAfter(delay, dispatchRef, { jobId: job._id })
    return null
  },
})

export const getJob = authedQuery({
  args: { id: v.id('printJobs') }, returns: v.any(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id)
    if (!row || row.ownerUserId !== ctx.actor.userId) throw synieError('not_found', '打印任务不存在')
    requirePermission(ctx.actor, row.permission)
    authorizeScope(ctx.actor, row.companyIds)
    return jobPresent(row)
  },
})

export const authorizeArtifact = internalQuery({
  args: { id: v.id('printArtifacts') }, returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await requireActor(ctx)
    const row = await ctx.db.get(args.id)
    if (!row || row.ownerUserId !== actor.userId || row.expiresAt <= Date.now()) {
      throw synieError('not_found', '临时文件不存在或已过期')
    }
    requirePermission(actor, row.permission)
    authorizeScope(actor, row.companyIds)
    return row
  },
})

export const authorizeJobOutput = internalQuery({
  args: { id: v.id('printJobs') }, returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await requireActor(ctx)
    const job = await ctx.db.get(args.id)
    if (!job || job.ownerUserId !== actor.userId || job.status !== 'succeeded' || !job.outputArtifactId || job.expiresAt <= Date.now()) {
      throw synieError('not_found', '打印结果不存在或已过期')
    }
    requirePermission(actor, job.permission)
    authorizeScope(actor, job.companyIds)
    const artifact = await ctx.db.get(job.outputArtifactId)
    if (!artifact) throw synieError('not_found', '打印结果不存在或已过期')
    return artifact
  },
})

export const expiredArtifacts = internalQuery({
  args: { now: v.number(), limit: v.optional(v.number()) }, returns: v.any(),
  handler: async (ctx, args) => ctx.db.query('printArtifacts').withIndex('by_expiry', (q) =>
    q.lte('expiresAt', args.now),
  ).take(Math.min(args.limit ?? 200, 500)),
})

export const purgeArtifact = internalMutation({
  args: { id: v.id('printArtifacts') }, returns: v.null(),
  handler: async (ctx, args) => {
    const artifact = await ctx.db.get(args.id)
    if (artifact && artifact.expiresAt <= Date.now()) await ctx.db.delete(artifact._id)
    return null
  },
})

export const purgeJobs = internalMutation({
  args: { now: v.number(), limit: v.optional(v.number()) }, returns: v.number(),
  handler: async (ctx, args) => {
    const jobs = await ctx.db.query('printJobs').withIndex('by_expiry', (q) => q.lte('expiresAt', args.now))
      .take(Math.min(args.limit ?? 200, 500))
    for (const job of jobs) await ctx.db.delete(job._id)
    return jobs.length
  },
})

export const scheduleDue = internalMutation({
  args: {}, returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now()
    const queued = await ctx.db.query('printJobs').withIndex('by_status_next', (q) =>
      q.eq('status', 'queued').lte('nextAttemptAt', now),
    ).take(20)
    const retryable = await ctx.db.query('printJobs').withIndex('by_status_next', (q) =>
      q.eq('status', 'retryable').lte('nextAttemptAt', now),
    ).take(Math.max(0, 40 - queued.length))
    const running = await ctx.db.query('printJobs').withIndex('by_running_lease', (q) =>
      q.eq('status', 'running').lte('leaseExpiresAt', now),
    ).take(Math.max(0, 50 - queued.length - retryable.length))
    const jobs = [...queued, ...retryable, ...running]
    console.info(JSON.stringify({
      event: 'print_job_schedule',
      queued: queued.length,
      retryable: retryable.length,
      staleRunning: running.length,
      oldestAgeMs: jobs.length === 0 ? 0 : now - Math.min(...jobs.map((job) => job.insertedAt)),
    }))
    for (const job of jobs) await ctx.scheduler.runAfter(0, dispatchRef, { jobId: job._id })
    return jobs.length
  },
})
