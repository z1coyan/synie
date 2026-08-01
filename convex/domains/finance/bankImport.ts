import { Decimal } from '@synie/shared'
import { paginationOptsValidator, type GenericMutationCtx } from 'convex/server'
import { v } from 'convex/values'
import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import { internalMutation, internalQuery } from '../../_generated/server'
import { authedMutation, authedQuery } from '../../lib/auth'
import { actorForAppUser } from '../../lib/actor'
import { canAccessCompany } from '../../lib/companyScope'
import { synieError, validationError } from '../../lib/errors'
import { paginationOptions, resourcePage } from '../../lib/pagination'
import { requirePermission } from '../../lib/permissions'
import { claimJob, createJob, requireJobLease } from '../../jobs/domain'
import {
  createDomainRecord,
  hydrateStored,
  patchDomainComputed,
  patchDomainInternal,
  patchDomainStatus,
  removeDomainRecord,
} from '../shared/records'
import { createBankTransactionRecord } from './banking'

type MutationCtx = GenericMutationCtx<DataModel>
type Wire = Record<string, unknown>

function stored(ctx: MutationCtx, id: string, resource: string) {
  const normalized = ctx.db.normalizeId('financeDocuments', id)
  return normalized ? ctx.db.get(normalized).then((row) => row?.resource === resource ? row : null) : Promise.resolve(null)
}

function bankRow(row: Doc<'bankImportRows'>, importId: string) {
  return {
    id: row._id, rowNo: row.rowNo, occurredAt: row.occurredAt,
    income: row.income, expense: row.expense, balance: row.balance,
    counterpartyName: row.counterpartyName, counterpartyAccount: row.counterpartyAccount,
    summary: row.summary, note: row.note, error: row.error,
    importId, transactionId: row.transactionId,
    insertedAt: new Date(row.insertedAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString(),
  }
}

async function parseJobForImport(ctx: { db: MutationCtx['db'] }, importId: string) {
  return ctx.db.query('ioJobs').withIndex('by_subject', (q) =>
    q.eq('kind', 'bank_import_parse').eq('subjectId', importId),
  ).unique()
}

export const startParse = internalMutation({
  args: {
    userId: v.id('appUsers'), companyId: v.string(), bankAccountId: v.string(),
    templateId: v.string(), fileId: v.id('files'), token: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await actorForAppUser(ctx, args.userId)
    requirePermission(actor, 'acc.bank_transaction:import')
    requirePermission(actor, 'sys.file:read')
    if (!canAccessCompany(actor, args.companyId)) throw synieError('not_found', '公司不存在')
    const [accountRow, templateRow, file] = await Promise.all([
      stored(ctx, args.bankAccountId, 'accBankAccounts'),
      stored(ctx, args.templateId, 'accBankImportTemplates'),
      ctx.db.get(args.fileId),
    ])
    if (!accountRow) throw validationError('流水导入记录', { bankAccountId: ['银行账户不存在'] })
    if (!templateRow) throw validationError('流水导入记录', { templateId: ['导入模板不存在'] })
    const account = hydrateStored(accountRow)
    const template = hydrateStored(templateRow)
    if (account.companyId !== args.companyId || account.active === false) {
      throw validationError('流水导入记录', { bankAccountId: ['银行账户不属于公司或已停用'] })
    }
    if (template.companyId !== args.companyId || template.bankAccountId !== args.bankAccountId) {
      throw validationError('流水导入记录', { templateId: ['导入模板必须属于所选银行账户'] })
    }
    if (!file || file.status !== 'ready') throw validationError('流水导入记录', { fileId: ['导入文件不存在'] })
    const idempotencyKey = `${args.userId}:${args.companyId}:${args.bankAccountId}:${args.templateId}:${args.fileId}:${file.sha256}`
    const job = await createJob(ctx, {
      kind: 'bank_import_parse', idempotencyKey, fileId: args.fileId,
      companyId: args.companyId, createdById: args.userId, phase: 'download',
      parameters: { bankAccountId: args.bankAccountId, templateId: args.templateId, template },
    })
    if (job.status === 'succeeded' && job.subjectId) {
      const existing = await stored(ctx, job.subjectId, 'accBankImports')
      if (existing) return { completed: true, record: hydrateStored(existing) }
    }
    const claimed = await claimJob(ctx, job._id, args.token, 10 * 60_000)
    return {
      completed: false, jobId: claimed._id, token: args.token,
      file: { objectKey: file.objectKey, size: file.size }, template,
    }
  },
})

export const stageChunk = internalMutation({
  args: { jobId: v.id('ioJobs'), token: v.string(), chunkNo: v.number(), hash: v.string(), rows: v.array(v.any()) },
  returns: v.object({ inserted: v.number() }),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    requireJobLease(job, args.token)
    if (job.kind !== 'bank_import_parse') throw synieError('conflict', '任务类型不匹配')
    const witness = await ctx.db.query('ioJobChunks').withIndex('by_job_chunk', (q) =>
      q.eq('jobId', job._id).eq('chunkNo', args.chunkNo),
    ).unique()
    if (witness) {
      if (witness.hash !== args.hash || witness.rowCount !== args.rows.length) throw synieError('conflict', '导入分块内容发生漂移')
      return { inserted: 0 }
    }
    const now = Date.now()
    for (const raw of args.rows) {
      const row = raw as Wire
      await ctx.db.insert('bankImportRows', {
        jobId: job._id,
        rowNo: Number(row.rowNo),
        occurredAt: typeof row.occurredAt === 'string' ? row.occurredAt : null,
        income: typeof row.income === 'string' ? row.income : null,
        expense: typeof row.expense === 'string' ? row.expense : null,
        balance: typeof row.balance === 'string' ? row.balance : null,
        counterpartyName: typeof row.counterpartyName === 'string' ? row.counterpartyName : null,
        counterpartyAccount: typeof row.counterpartyAccount === 'string' ? row.counterpartyAccount : null,
        summary: typeof row.summary === 'string' ? row.summary : null,
        note: typeof row.note === 'string' ? row.note : null,
        error: typeof row.error === 'string' ? row.error.slice(0, 500) : null,
        transactionId: null, insertedAt: now, updatedAt: now,
      })
    }
    await ctx.db.insert('ioJobChunks', { jobId: job._id, chunkNo: args.chunkNo, hash: args.hash, rowCount: args.rows.length, insertedAt: now })
    await ctx.db.patch(job._id, {
      phase: 'stage', progressDone: job.progressDone + args.rows.length,
      progressTotal: Math.max(job.progressTotal, job.progressDone + args.rows.length),
      leaseExpiresAt: now + 10 * 60_000, updatedAt: now,
    })
    return { inserted: args.rows.length }
  },
})

export const finishParse = internalMutation({
  args: {
    jobId: v.id('ioJobs'), token: v.string(), error: v.optional(v.string()),
    itemCount: v.number(), errorCount: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    requireJobLease(job, args.token)
    const actor = await actorForAppUser(ctx, job.createdById!)
    const parameters = job.parameters as Wire
    const record = await createDomainRecord(ctx, actor, 'accBankImports', {}, {
      permissionChecked: true,
      trustedDerived: {
        status: args.error ? 'FAILED' : 'PARSED', error: args.error?.slice(0, 500) ?? null,
        importedAt: null, companyId: job.companyId,
        bankAccountId: parameters.bankAccountId, templateId: parameters.templateId,
        fileId: job.fileId, importedById: null,
        itemCount: args.itemCount, errorCount: args.errorCount,
      },
    })
    await ctx.db.patch(job._id, {
      subjectId: String(record.id), status: 'succeeded', phase: args.error ? 'parse_failed' : 'parsed',
      progressDone: args.itemCount, progressTotal: args.itemCount,
      leaseToken: null, leaseExpiresAt: null, errorCode: null, errorMessage: null,
      result: { itemCount: args.itemCount, errorCount: args.errorCount }, updatedAt: Date.now(),
    })
    return record
  },
})

async function requireImport(ctx: any, actor: any, importId: string, status?: string) {
  requirePermission(actor, 'acc.bank_transaction:import')
  const normalized = ctx.db.normalizeId('financeDocuments', importId)
  const row = normalized ? await ctx.db.get(normalized) : null
  if (!row || row.resource !== 'accBankImports' || (row.companyId && !canAccessCompany(actor, row.companyId))) {
    throw synieError('not_found', '流水导入记录不存在')
  }
  if (status && row.status !== status) throw synieError('conflict', `仅「${status}」状态可执行该操作`)
  return row
}

export const listItems = authedQuery({
  args: { importId: v.string(), numItems: v.number(), cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireImport(ctx, ctx.actor, args.importId)
    const job = await ctx.db.query('ioJobs').withIndex('by_subject', (q) =>
      q.eq('kind', 'bank_import_parse').eq('subjectId', args.importId),
    ).unique()
    if (!job) return { count: 0, results: [], pageInfo: { continueCursor: null, isDone: true } }
    const page = await ctx.db.query('bankImportRows').withIndex('by_job_row', (q) => q.eq('jobId', job._id)).paginate(paginationOptions(args))
    return resourcePage({ ...page, page: page.page.map((row) => bankRow(row, args.importId)) })
  },
})

export const getItem = authedQuery({
  args: { id: v.id('bankImportRows') }, returns: v.any(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id)
    if (!row) return null
    const job = await ctx.db.get(row.jobId)
    if (!job?.subjectId) return null
    await requireImport(ctx, ctx.actor, job.subjectId)
    return bankRow(row, job.subjectId)
  },
})

function normalizedItem(previous: Doc<'bankImportRows'>, input: Wire) {
  const occurredAt = input.occurredAt === undefined ? previous.occurredAt : new Date(String(input.occurredAt)).toISOString()
  const income = input.income === undefined ? previous.income : input.income == null || input.income === '' ? null : String(input.income)
  const expense = input.expense === undefined ? previous.expense : input.expense == null || input.expense === '' ? null : String(input.expense)
  if ((income === null) === (expense === null)) throw validationError('流水导入行', { amount: ['收入或支出必须且只能填写一项'] })
  const selected = new Decimal(income ?? expense ?? '0')
  if (!selected.isFinite() || !selected.gt(0)) throw validationError('流水导入行', { amount: ['金额必须大于零'] })
  const text = (key: string, current: string | null, max: number) => {
    const value = input[key] === undefined ? current : input[key] == null || input[key] === '' ? null : String(input[key]).trim()
    if ((value?.length ?? 0) > max) throw validationError('流水导入行', { [key]: [`不能超过 ${max} 字符`] })
    return value
  }
  return {
    occurredAt, income, expense,
    balance: text('balance', previous.balance, 64),
    counterpartyName: text('counterpartyName', previous.counterpartyName, 128),
    counterpartyAccount: text('counterpartyAccount', previous.counterpartyAccount, 64),
    summary: text('summary', previous.summary, 255), note: text('note', previous.note, 255), error: null,
  }
}

export const updateItem = authedMutation({
  args: { id: v.id('bankImportRows'), input: v.any() }, returns: v.any(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id)
    if (!row) throw synieError('not_found', '流水导入行不存在')
    const job = await ctx.db.get(row.jobId)
    if (!job?.subjectId) throw synieError('not_found', '流水导入记录不存在')
    await requireImport(ctx, ctx.actor, job.subjectId, 'PARSED')
    const beforeError = row.error
    await ctx.db.patch(row._id, { ...normalizedItem(row, args.input as Wire), updatedAt: Date.now() })
    if (beforeError) {
      const parent = await requireImport(ctx, ctx.actor, job.subjectId)
      await patchDomainComputed(ctx, ctx.actor, 'accBankImports', job.subjectId, {
        errorCount: Math.max(0, Number(hydrateStored(parent).errorCount ?? 0) - 1),
      }, 'fix_import_row')
    }
    return bankRow((await ctx.db.get(row._id))!, job.subjectId)
  },
})

export const removeItem = authedMutation({
  args: { id: v.id('bankImportRows') }, returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id)
    if (!row) return null
    const job = await ctx.db.get(row.jobId)
    if (!job?.subjectId) throw synieError('not_found', '流水导入记录不存在')
    const parent = await requireImport(ctx, ctx.actor, job.subjectId, 'PARSED')
    const wire = hydrateStored(parent)
    await ctx.db.delete(row._id)
    await patchDomainComputed(ctx, ctx.actor, 'accBankImports', job.subjectId, {
      itemCount: Math.max(0, Number(wire.itemCount ?? 0) - 1),
      errorCount: Math.max(0, Number(wire.errorCount ?? 0) - (row.error ? 1 : 0)),
    }, 'remove_import_row')
    return null
  },
})

export const beginCommit = internalMutation({
  args: { userId: v.id('appUsers'), importId: v.string(), token: v.string() }, returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await actorForAppUser(ctx, args.userId)
    requirePermission(actor, 'acc.bank_transaction:create')
    const parent = await requireImport(ctx, actor, args.importId, 'PARSED')
    const parsedJob = await parseJobForImport(ctx, args.importId)
    if (!parsedJob) throw synieError('internal', '导入记录缺少解析任务')
    const bad = await ctx.db.query('bankImportRows').withIndex('by_job_row', (q) => q.eq('jobId', parsedJob._id)).filter((q) => q.neq(q.field('error'), null)).first()
    if (bad) throw validationError('流水导入记录', { items: [`第 ${bad.rowNo} 行仍有错误,请修正或删除`] })
    const total = Number(hydrateStored(parent).itemCount ?? 0)
    if (total < 1) throw validationError('流水导入记录', { items: ['没有可导入的行'] })
    const job = await createJob(ctx, {
      kind: 'bank_import_commit', idempotencyKey: args.importId, subjectId: args.importId,
      companyId: parent.companyId, createdById: args.userId, phase: 'commit', progressTotal: total,
      parameters: { parseJobId: parsedJob._id },
    })
    if (job.status === 'succeeded') return { completed: true, record: hydrateStored(parent) }
    await claimJob(ctx, job._id, args.token, 10 * 60_000)
    return { completed: false, jobId: job._id, parseJobId: parsedJob._id, total }
  },
})

export const rowsPage = internalQuery({
  args: { jobId: v.id('ioJobs'), paginationOpts: paginationOptsValidator }, returns: v.any(),
  handler: (ctx, args) => ctx.db.query('bankImportRows').withIndex('by_job_row', (q) => q.eq('jobId', args.jobId)).paginate(args.paginationOpts),
})

export const resumePlan = internalQuery({
  args: { jobId: v.id('ioJobs'), token: v.string() }, returns: v.any(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    requireJobLease(job, args.token)
    if (job.kind === 'bank_import_parse') {
      const file = job.fileId ? await ctx.db.get(job.fileId) : null
      if (!file || file.status !== 'ready') throw synieError('not_found', '银行流水文件不存在')
      const parameters = job.parameters as Wire
      return { kind: job.kind, file: { objectKey: file.objectKey }, template: parameters.template }
    }
    if (job.kind === 'bank_import_commit') {
      const parameters = job.parameters as { parseJobId: Id<'ioJobs'> }
      return { kind: job.kind, parseJobId: parameters.parseJobId }
    }
    throw synieError('internal', '银行导入任务类型不匹配')
  },
})

export const commitChunk = internalMutation({
  args: { jobId: v.id('ioJobs'), token: v.string(), rowIds: v.array(v.id('bankImportRows')) }, returns: v.number(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    requireJobLease(job, args.token)
    const actor = await actorForAppUser(ctx, job.createdById!)
    const parameters = job.parameters as { parseJobId: Id<'ioJobs'> }
    const parsedJob = await ctx.db.get(parameters.parseJobId)
    if (!parsedJob?.subjectId) throw synieError('internal', '解析任务缺少业务记录')
    const parentId = parsedJob.subjectId
    const parentKey = ctx.db.normalizeId('financeDocuments', parentId)
    const parent = parentKey ? await ctx.db.get(parentKey) : null
    if (!parent || parent.resource !== 'accBankImports') throw synieError('not_found', '流水导入记录不存在')
    const wire = hydrateStored(parent)
    let created = 0
    for (const id of args.rowIds) {
      const row = await ctx.db.get(id)
      if (!row || row.jobId !== parameters.parseJobId || row.transactionId) continue
      const transaction = await createBankTransactionRecord(ctx, actor, {
        occurredAt: row.occurredAt, income: row.income, expense: row.expense, balance: row.balance,
        counterpartyName: row.counterpartyName, counterpartyAccount: row.counterpartyAccount,
        summary: row.summary, note: row.note,
        companyId: wire.companyId, bankAccountId: wire.bankAccountId,
      })
      await patchDomainInternal(ctx, 'accBankTransactions', String(transaction.id), { bankImportId: parentId })
      await ctx.db.patch(row._id, { transactionId: String(transaction.id), updatedAt: Date.now() })
      created += 1
    }
    await ctx.db.patch(job._id, {
      progressDone: job.progressDone + created, leaseExpiresAt: Date.now() + 10 * 60_000, updatedAt: Date.now(),
    })
    return created
  },
})

export const finishCommit = internalMutation({
  args: { jobId: v.id('ioJobs'), token: v.string() }, returns: v.any(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    requireJobLease(job, args.token)
    const actor = await actorForAppUser(ctx, job.createdById!)
    const record = await patchDomainStatus(ctx, actor, 'accBankImports', job.subjectId!, 'IMPORTED', 'import', {
      importedAt: new Date().toISOString(), importedById: actor.userId,
    })
    await ctx.db.patch(job._id, {
      status: 'succeeded', phase: 'committed', progressDone: job.progressTotal,
      leaseToken: null, leaseExpiresAt: null, updatedAt: Date.now(),
    })
    return record
  },
})

export const beginRemoveImport = internalMutation({
  args: { userId: v.id('appUsers'), id: v.string() }, returns: v.object({ parseJobId: v.id('ioJobs') }),
  handler: async (ctx, args) => {
    const actor = await actorForAppUser(ctx, args.userId)
    const record = await requireImport(ctx, actor, args.id)
    if (record.status !== 'PARSED' && record.status !== 'DELETING') {
      throw synieError('conflict', '仅「PARSED」状态可删除流水导入记录')
    }
    const job = await parseJobForImport(ctx, args.id)
    if (!job) throw synieError('internal', '流水导入记录缺少解析任务')
    if (record.status === 'PARSED') {
      await patchDomainStatus(ctx, actor, 'accBankImports', args.id, 'DELETING', 'begin_delete')
    }
    return { parseJobId: job._id }
  },
})

export const removeImportRowChunk = internalMutation({
  args: { parseJobId: v.id('ioJobs') }, returns: v.object({ removed: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query('bankImportRows').withIndex('by_job_row', (q) =>
      q.eq('jobId', args.parseJobId),
    ).take(100)
    for (const row of rows) await ctx.db.delete(row._id)
    return { removed: rows.length, done: rows.length < 100 }
  },
})

export const finishRemoveImport = internalMutation({
  args: { userId: v.id('appUsers'), id: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await actorForAppUser(ctx, args.userId)
    await requireImport(ctx, actor, args.id, 'DELETING')
    await removeDomainRecord(ctx, actor, 'accBankImports', args.id, { permissionChecked: true })
    return null
  },
})
