import { paginationOptsValidator } from 'convex/server'
import type { GenericQueryCtx } from 'convex/server'
import { v } from 'convex/values'
import { internalMutation, internalQuery } from '../_generated/server'
import type { DataModel, Doc, Id } from '../_generated/dataModel'
import { authedMutation, authedQuery } from '../lib/auth'
import { actorForAppUser, requireActor, type Actor } from '../lib/actor'
import { canAccessCompany } from '../lib/companyScope'
import { synieError } from '../lib/errors'
import { asDomainMutationCtx } from '../lib/mutationContext'
import { paginationOptions, resourcePage } from '../lib/pagination'
import { hasPermission, requirePermission } from '../lib/permissions'
import { claimJob, createJob, requireJobLease } from '../jobs/domain'
import { writeAudit } from '../platform/audit/write'
import {
  assertOwnerAttachmentCapacity,
  assertOwnerCategoryCapacity,
  boundedOwnerAttachments,
  normalizeAttachmentCategory,
} from './attachmentLimits'
import {
  ATTACHMENT_OWNER_TYPES,
  ownerReadPermission,
  ownerUsesCompanyScope,
  resolveOwner,
} from './owners'

const MAX_FILE_SIZE = 50 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/
const ATTACHMENT_AUTH_SCOPE_PROBE_LIMIT = 8

function filename(value: string): string {
  const clean = value.normalize('NFKC').replace(/[\u0000-\u001f/\\]/g, '_').trim()
  if (!clean || [...clean].length > 255) throw synieError('validation', '文件名不合法')
  return clean
}

function contentType(value: string): string {
  const clean = value.trim().toLowerCase()
  if (!clean || clean.length > 200 || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(clean)) {
    throw synieError('validation', '文件类型不合法')
  }
  return clean
}

function presentFile(row: {
  _id: Id<'files'>; filename: string; contentType: string | null; size: number
  sha256: string; objectKey: string; uploadedById: Id<'appUsers'>; insertedAt: number
}) {
  return {
    id: row._id,
    storage: 's3',
    key: row.objectKey,
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
    sha256: row.sha256,
    uploadedById: row.uploadedById,
    insertedAt: new Date(row.insertedAt).toISOString(),
  }
}

function fileAuditSnapshot(row: {
  objectKey: string; filename: string; contentType: string | null; size: number
  sha256: string; uploadedById: Id<'appUsers'>
}) {
  return {
    storage: 's3', key: row.objectKey, filename: row.filename,
    content_type: row.contentType, size: row.size, sha256: row.sha256,
    uploaded_by_id: row.uploadedById,
  }
}

function attachmentAuditSnapshot(row: {
  fileId: Id<'files'>; ownerType: string; ownerId: string
  category: string; companyId: string | null
}) {
  return {
    file_id: row.fileId, owner_type: row.ownerType, owner_id: row.ownerId,
    category: row.category, company_id: row.companyId,
  }
}

/** Stale-owner cleanup follows the frozen attachment scope. Live owner lookup
 * is intentionally not required, otherwise deleting an owner deadlocks both
 * the attachment and its file forever. */
export function actorCanManageFrozenAttachment(
  actor: Actor,
  row: { ownerType: string; companyId: string | null },
): boolean {
  const companyScoped = ownerUsesCompanyScope(row.ownerType)
  if (!hasPermission(actor, ownerReadPermission(row.ownerType))) return false
  if (companyScoped) {
    return typeof row.companyId === 'string' && row.companyId.length > 0 &&
      canAccessCompany(actor, row.companyId)
  }
  return row.companyId === null
}

export const createUploadIntent = authedMutation({
  args: {
    filename: v.string(), contentType: v.string(), size: v.number(), sha256: v.string(),
    ownerType: v.optional(v.string()), ownerId: v.optional(v.string()), category: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'sys.file:create')
    if (!Number.isSafeInteger(args.size) || args.size < 0 || args.size > MAX_FILE_SIZE) {
      throw synieError('validation', '文件大小必须在 0 到 50MB 之间')
    }
    const hash = args.sha256.toLowerCase()
    if (!SHA256.test(hash)) throw synieError('validation', '文件 SHA-256 不合法')
    const hasType = Boolean(args.ownerType)
    const hasId = Boolean(args.ownerId)
    if (hasType !== hasId) throw synieError('validation', 'ownerType 与 ownerId 必须同时提供')
    const category = normalizeAttachmentCategory(args.category)
    const companyId = hasType
      ? await resolveOwner(ctx, ctx.actor, args.ownerType!, args.ownerId!)
      : null
    if (hasType) {
      const attachments = await boundedOwnerAttachments(ctx, args.ownerType!, args.ownerId!)
      assertOwnerAttachmentCapacity(attachments.length)
      assertOwnerCategoryCapacity(attachments, category)
    }
    const now = Date.now()
    const date = new Date(now).toISOString().slice(0, 10)
    const objectId = crypto.randomUUID()
    const objectKey = `uploads/${date}/${objectId}`
    const finalObjectKey = `files/${date}/${objectId}`
    const id = await ctx.db.insert('uploadIntents', {
      objectKey,
      finalObjectKey,
      filename: filename(args.filename),
      contentType: contentType(args.contentType || 'application/octet-stream'),
      size: args.size,
      sha256: hash,
      uploadedById: ctx.actor.userId,
      ownerType: args.ownerType ?? null,
      ownerId: args.ownerId ?? null,
      category,
      companyId,
      status: 'pending',
      expiresAt: now + 10 * 60_000,
      insertedAt: now,
    })
    return { id, expiresAt: now + 10 * 60_000 }
  },
})

export const listAttachments = authedQuery({
  args: { ownerType: v.string(), ownerId: v.string(), category: v.optional(v.string()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'sys.file:read')
    await resolveOwner(ctx, ctx.actor, args.ownerType, args.ownerId)
    const allRows = await boundedOwnerAttachments(ctx, args.ownerType, args.ownerId)
    const category = args.category === undefined
      ? undefined
      : normalizeAttachmentCategory(args.category)
    const rows = category
      ? allRows.filter((row) => row.category === category)
      : allRows
    const results = []
    for (const attachment of rows) {
      const file = await ctx.db.get(attachment.fileId)
      if (!file || file.status !== 'ready') continue
      results.push({
        id: attachment._id,
        fileId: attachment.fileId,
        ownerType: attachment.ownerType,
        ownerId: attachment.ownerId,
        category: attachment.category,
        companyId: attachment.companyId,
        insertedAt: new Date(attachment.insertedAt).toISOString(),
        file: presentFile(file),
      })
    }
    return { count: results.length, results }
  },
})

export const listFileAttachments = authedQuery({
  args: { fileId: v.id('files') },
  returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'sys.file:read')
    const file = await ctx.db.get(args.fileId)
    if (!file || file.status !== 'ready') return { count: 0, results: [] }
    const rows = await ctx.db.query('attachments').withIndex('by_file', (q) => q.eq('fileId', args.fileId)).take(200)
    const results = []
    for (const attachment of rows) {
      let visible = false
      try {
        await resolveOwner(ctx, ctx.actor, attachment.ownerType, attachment.ownerId)
        visible = true
      } catch {
        visible = hasPermission(ctx.actor, 'sys.file:delete') &&
          actorCanManageFrozenAttachment(ctx.actor, attachment)
      }
      if (!visible) continue
      results.push({
        id: attachment._id,
        fileId: attachment.fileId,
        ownerType: attachment.ownerType,
        ownerId: attachment.ownerId,
        category: attachment.category,
        companyId: attachment.companyId,
        insertedAt: new Date(attachment.insertedAt).toISOString(),
        file: presentFile(file),
      })
    }
    return { count: results.length, results }
  },
})

export const attach = authedMutation({
  args: { fileId: v.id('files'), ownerType: v.string(), ownerId: v.string(), category: v.optional(v.string()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'sys.file:create')
    const file = await ctx.db.get(args.fileId)
    if (!file || file.status !== 'ready') throw synieError('not_found', '文件不存在')
    if (file.uploadedById !== ctx.actor.userId && !hasPermission(ctx.actor, 'sys.file:delete')) {
      throw synieError('forbidden', '只能挂接本人刚上传的文件')
    }
    const companyId = await resolveOwner(ctx, ctx.actor, args.ownerType, args.ownerId)
    const category = normalizeAttachmentCategory(args.category)
    const existing = await boundedOwnerAttachments(ctx, args.ownerType, args.ownerId)
    const duplicate = existing.find((row) => row.fileId === file._id && row.category === category)
    if (duplicate) return { id: duplicate._id, fileId: file._id, ownerType: args.ownerType, ownerId: args.ownerId, category, companyId, insertedAt: new Date(duplicate.insertedAt).toISOString() }
    assertOwnerAttachmentCapacity(existing.length)
    assertOwnerCategoryCapacity(existing, category)
    const insertedAt = Date.now()
    const id = await ctx.db.insert('attachments', { fileId: file._id, ownerType: args.ownerType, ownerId: args.ownerId, category, companyId, insertedAt })
    await writeAudit(asDomainMutationCtx(ctx), ctx.actor, {
      resource: 'sys_attachment', recordId: id, recordLabel: args.ownerType,
      companyId, action: 'create', changes: attachmentAuditSnapshot({
        fileId: file._id, ownerType: args.ownerType, ownerId: args.ownerId,
        category, companyId,
      }),
    })
    return { id, fileId: file._id, ownerType: args.ownerType, ownerId: args.ownerId, category, companyId, insertedAt: new Date(insertedAt).toISOString() }
  },
})

export const removeAttachment = authedMutation({
  args: { id: v.id('attachments') }, returns: v.null(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'sys.file:delete')
    const row = await ctx.db.get(args.id)
    if (!row) return null
    if (!actorCanManageFrozenAttachment(ctx.actor, row)) {
      throw synieError('forbidden', '无权删除其他公司的附件')
    }
    await ctx.db.delete(row._id)
    await writeAudit(asDomainMutationCtx(ctx), ctx.actor, {
      resource: 'sys_attachment', recordId: row._id, recordLabel: row.ownerType,
      companyId: row.companyId, action: 'destroy', changes: attachmentAuditSnapshot(row),
    })
    return null
  },
})

export const listFiles = authedQuery({
  args: { numItems: v.number(), cursor: v.optional(v.union(v.string(), v.null())) }, returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'sys.file:read')
    const page = await ctx.db.query('files').withIndex('by_time').order('desc').paginate(paginationOptions(args))
    return resourcePage({ ...page, page: page.page.filter((row) => row.status === 'ready').map(presentFile) })
  },
})

export const getFile = authedQuery({
  args: { id: v.id('files') }, returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'sys.file:read')
    const row = await ctx.db.get(args.id)
    return row?.status === 'ready' ? presentFile(row) : null
  },
})

export const intentForAction = internalQuery({
  args: { id: v.id('uploadIntents'), userId: v.id('appUsers') }, returns: v.any(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id)
    if (!row || row.uploadedById !== args.userId) throw synieError('not_found', '上传凭据不存在')
    return row
  },
})

export const currentUserForAction = internalQuery({
  args: {}, returns: v.object({ userId: v.id('appUsers') }),
  handler: async (ctx) => ({ userId: (await requireActor(ctx)).userId }),
})

export const finalizeIntent = internalMutation({
  args: { id: v.id('uploadIntents'), userId: v.id('appUsers') }, returns: v.any(),
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.id)
    if (!intent || intent.uploadedById !== args.userId) throw synieError('not_found', '上传凭据不存在')
    if (intent.status === 'finalized' && intent.fileId) {
      const existing = await ctx.db.get(intent.fileId)
      if (!existing) throw synieError('internal', '已完成上传缺少文件元数据')
      return { file: presentFile(existing), attachment: null }
    }
    if (intent.status !== 'pending' || intent.expiresAt < Date.now()) throw synieError('conflict', '上传凭据已失效')
    const actor = await actorForAppUser(ctx, args.userId)
    requirePermission(actor, 'sys.file:create')
    const category = normalizeAttachmentCategory(intent.category)
    let attachmentCompanyId: string | null = null
    if (intent.ownerType && intent.ownerId) {
      attachmentCompanyId = await resolveOwner(ctx, actor, intent.ownerType, intent.ownerId)
      if (attachmentCompanyId !== intent.companyId) {
        throw synieError('conflict', '附件宿主公司归属已变化，请重新上传')
      }
      const attachments = await boundedOwnerAttachments(ctx, intent.ownerType, intent.ownerId)
      assertOwnerAttachmentCapacity(attachments.length)
      assertOwnerCategoryCapacity(attachments, category)
    }
    const insertedAt = Date.now()
    const fileId = await ctx.db.insert('files', {
      objectKey: intent.finalObjectKey ?? intent.objectKey,
      filename: intent.filename, contentType: intent.contentType,
      size: intent.size, sha256: intent.sha256, uploadedById: intent.uploadedById,
      status: 'ready', insertedAt,
    })
    const file = (await ctx.db.get(fileId))!
    await writeAudit(asDomainMutationCtx(ctx), actor, {
      resource: 'sys_file', recordId: fileId, recordLabel: file.filename,
      action: 'create', changes: fileAuditSnapshot(file),
    })
    let attachment = null
    if (intent.ownerType && intent.ownerId) {
      const attachmentId = await ctx.db.insert('attachments', {
        fileId, ownerType: intent.ownerType, ownerId: intent.ownerId,
        category, companyId: attachmentCompanyId, insertedAt,
      })
      await writeAudit(asDomainMutationCtx(ctx), actor, {
        resource: 'sys_attachment', recordId: attachmentId,
        recordLabel: intent.ownerType, companyId: attachmentCompanyId,
        action: 'create', changes: attachmentAuditSnapshot({
          fileId, ownerType: intent.ownerType, ownerId: intent.ownerId,
          category, companyId: attachmentCompanyId,
        }),
      })
      attachment = { id: attachmentId, fileId, ownerType: intent.ownerType, ownerId: intent.ownerId, category, companyId: attachmentCompanyId, insertedAt: new Date(insertedAt).toISOString() }
    }
    await ctx.db.patch(intent._id, { status: 'finalized', fileId })
    return { file: presentFile(file), attachment }
  },
})

export const failIntent = internalMutation({
  args: { id: v.id('uploadIntents'), userId: v.id('appUsers'), code: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id)
    if (row && row.uploadedById === args.userId && row.status === 'pending') await ctx.db.patch(row._id, { status: 'failed', failureCode: args.code })
    return null
  },
})

async function attachmentScopeCandidates(
  ctx: GenericQueryCtx<DataModel>,
  fileId: Id<'files'>,
  ownerType: string,
  companyId: string | null | undefined,
): Promise<Doc<'attachments'>[]> {
  if (companyId === undefined) {
    return ctx.db.query('attachments').withIndex('by_file_owner_type_company', (query) =>
      query.eq('fileId', fileId).eq('ownerType', ownerType),
    ).take(ATTACHMENT_AUTH_SCOPE_PROBE_LIMIT)
  }
  return ctx.db.query('attachments').withIndex('by_file_owner_type_company', (query) =>
    query.eq('fileId', fileId).eq('ownerType', ownerType).eq('companyId', companyId),
  ).take(ATTACHMENT_AUTH_SCOPE_PROBE_LIMIT)
}

export async function actorCanAccessFileAttachment(
  ctx: GenericQueryCtx<DataModel>,
  actor: Actor,
  fileId: Id<'files'>,
): Promise<boolean> {
  const bypassCompanyScope = actor.superAdmin || actor.allCompanies
  for (const ownerType of ATTACHMENT_OWNER_TYPES) {
    if (!hasPermission(actor, ownerReadPermission(ownerType))) continue
    const scopes: readonly (string | null | undefined)[] = bypassCompanyScope
      ? [undefined]
      : ownerUsesCompanyScope(ownerType)
        ? actor.companyIds
        : [null]
    for (const companyId of scopes) {
      const candidates = await attachmentScopeCandidates(ctx, fileId, ownerType, companyId)
      for (const attachment of candidates) {
        try {
          await resolveOwner(ctx, actor, attachment.ownerType, attachment.ownerId)
          return true
        } catch {
          // A stale owner witness must not authorize the file; probe the next
          // bounded candidate in the same indexed permission/company scope.
        }
      }
    }
  }
  return false
}

export const authorizeDownload = internalQuery({
  args: { fileId: v.id('files'), userId: v.id('appUsers') }, returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await actorForAppUser(ctx, args.userId)
    requirePermission(actor, 'sys.file:read')
    const file = await ctx.db.get(args.fileId)
    if (!file || file.status !== 'ready') throw synieError('not_found', '文件不存在')
    const hasAttachment = await ctx.db.query('attachments')
      .withIndex('by_file', (query) => query.eq('fileId', file._id))
      .first()
    if (!hasAttachment) {
      if (file.uploadedById === actor.userId || actor.superAdmin) return file
      throw synieError('forbidden', '无权访问该文件')
    }
    if (await actorCanAccessFileAttachment(ctx, actor, file._id)) return file
    throw synieError('forbidden', '无权访问该文件')
  },
})

export const beginDelete = internalMutation({
  args: { fileId: v.id('files'), userId: v.id('appUsers') }, returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await actorForAppUser(ctx, args.userId)
    requirePermission(actor, 'sys.file:delete')
    const file = await ctx.db.get(args.fileId)
    if (!file) return null
    const startingDelete = file.status === 'ready'
    if (startingDelete) {
      const attached = await ctx.db.query('attachments').withIndex('by_file', (q) => q.eq('fileId', file._id)).first()
      if (attached) throw synieError('conflict', '文件仍被附件引用')
      await ctx.db.patch(file._id, { status: 'deleting' })
    }
    const existing = await ctx.db.query('fileDeleteJobs').withIndex('by_file', (q) => q.eq('fileId', file._id)).unique()
    if (!existing) await ctx.db.insert('fileDeleteJobs', {
      fileId: file._id, objectKey: file.objectKey, requestedById: actor.userId,
      status: 'pending', attempts: 0, nextAttemptAt: Date.now(), updatedAt: Date.now(),
    })
    if (startingDelete) {
      await writeAudit(asDomainMutationCtx(ctx), actor, {
        resource: 'sys_file', recordId: file._id, recordLabel: file.filename,
        action: 'destroy', changes: fileAuditSnapshot(file),
      })
    }
    return { objectKey: file.objectKey }
  },
})

export const finishDelete = internalMutation({
  args: { fileId: v.id('files') }, returns: v.null(),
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.fileId)
    if (file) await ctx.db.delete(file._id)
    const job = await ctx.db.query('fileDeleteJobs').withIndex('by_file', (q) => q.eq('fileId', args.fileId)).unique()
    if (job) await ctx.db.delete(job._id)
    return null
  },
})

export const failDelete = internalMutation({
  args: { fileId: v.id('files'), message: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.query('fileDeleteJobs').withIndex('by_file', (q) => q.eq('fileId', args.fileId)).unique()
    if (!job) return null
    const attempts = job.attempts + 1
    await ctx.db.patch(job._id, {
      status: 'failed', attempts, lastError: args.message.slice(0, 300),
      nextAttemptAt: Date.now() + Math.min(60 * 60_000, 5_000 * (2 ** Math.max(0, attempts - 1))),
      updatedAt: Date.now(),
    })
    return null
  },
})

export const expiredIntents = internalQuery({
  args: { now: v.number(), limit: v.optional(v.number()) }, returns: v.any(),
  handler: (ctx, args) => ctx.db.query('uploadIntents').withIndex('by_status_expiry', (q) =>
    q.eq('status', 'pending').lte('expiresAt', args.now),
  ).take(Math.max(1, Math.min(args.limit ?? 100, 500))),
})

export const expireIntent = internalMutation({
  args: { id: v.id('uploadIntents') }, returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id)
    if (row?.status === 'pending' && row.expiresAt <= Date.now()) {
      await ctx.db.patch(row._id, { status: 'failed', failureCode: 'expired_cleanup' })
    }
    return null
  },
})

export const dueDeleteJobs = internalQuery({
  args: { now: v.number(), limit: v.optional(v.number()) }, returns: v.any(),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 100, 500))
    const pending = await ctx.db.query('fileDeleteJobs').withIndex('by_status_next', (q) =>
      q.eq('status', 'pending'),
    ).take(limit)
    if (pending.length >= limit) return pending
    const failed = await ctx.db.query('fileDeleteJobs').withIndex('by_status_next', (q) =>
      q.eq('status', 'failed').lte('nextAttemptAt', args.now),
    ).take(limit - pending.length)
    return [...pending, ...failed]
  },
})

export const maintenanceObjectPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator }, returns: v.any(),
  handler: (ctx, args) => ctx.db.query('files').withIndex('by_time').paginate(args.paginationOpts),
})

export const pendingIntentKeys = internalQuery({
  args: { now: v.number() }, returns: v.array(v.string()),
  handler: async (ctx, args) => (await ctx.db.query('uploadIntents').withIndex('by_status_expiry', (q) =>
    q.eq('status', 'pending').gt('expiresAt', args.now),
  ).take(500)).map((row) => row.finalObjectKey ?? row.objectKey),
})

export const startMaintenance = internalMutation({
  args: {
    kind: v.union(v.literal('file_cleanup'), v.literal('s3_reconcile')),
    idempotencyKey: v.string(), token: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const job = await createJob(ctx, {
      kind: args.kind, idempotencyKey: args.idempotencyKey,
      phase: args.kind === 'file_cleanup' ? 'cleanup' : 'inventory', maxAttempts: 8,
    })
    if (job.status === 'succeeded') return { completed: true, result: job.result ?? null }
    const claimed = await claimJob(ctx, job._id, args.token, 10 * 60_000)
    return { completed: claimed.status !== 'running', jobId: claimed._id, token: args.token }
  },
})

export const finishMaintenance = internalMutation({
  args: { jobId: v.id('ioJobs'), token: v.string(), result: v.any() }, returns: v.any(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    requireJobLease(job, args.token)
    await ctx.db.patch(job._id, {
      status: 'succeeded', phase: 'completed', progressDone: 1, progressTotal: 1,
      leaseToken: null, leaseExpiresAt: null, errorCode: null, errorMessage: null,
      result: args.result, updatedAt: Date.now(),
    })
    return args.result
  },
})

export const startReconciliationRun = internalMutation({
  args: {}, returns: v.id('s3ReconciliationRuns'),
  handler: (ctx) => ctx.db.insert('s3ReconciliationRuns', {
    status: 'running', metadataCount: 0, objectCount: 0,
    missingObjectKeys: [], orphanObjectKeys: [], checksumMismatchFileIds: [],
    truncated: false, error: null, startedAt: Date.now(), completedAt: null,
  }),
})

export const finishReconciliationRun = internalMutation({
  args: {
    id: v.id('s3ReconciliationRuns'), status: v.union(v.literal('succeeded'), v.literal('failed')),
    metadataCount: v.number(), objectCount: v.number(), missingObjectKeys: v.array(v.string()),
    orphanObjectKeys: v.array(v.string()), checksumMismatchFileIds: v.array(v.string()),
    truncated: v.boolean(), error: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id)
    if (row) await ctx.db.patch(row._id, {
      status: args.status, metadataCount: args.metadataCount, objectCount: args.objectCount,
      missingObjectKeys: args.missingObjectKeys, orphanObjectKeys: args.orphanObjectKeys,
      checksumMismatchFileIds: args.checksumMismatchFileIds, truncated: args.truncated,
      error: args.error, completedAt: Date.now(),
    })
    return null
  },
})
