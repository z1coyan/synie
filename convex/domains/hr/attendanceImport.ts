import { attendanceLocalDate } from '@synie/shared'
import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'
import type { Doc, Id } from '../../_generated/dataModel'
import { internalMutation, internalQuery } from '../../_generated/server'
import { authedQuery } from '../../lib/auth'
import { actorForAppUser } from '../../lib/actor'
import { asDomainMutationCtx } from '../../lib/mutationContext'
import { synieError } from '../../lib/errors'
import { paginationOptions, resourcePage } from '../../lib/pagination'
import { requirePermission } from '../../lib/permissions'
import { claimJob, createJob, requireJobLease } from '../../jobs/domain'
import { writeAudit } from '../../platform/audit/write'
import { nextInMutation } from '../../platform/numbering/service'
import { createDomainRecord, hydrateStored, patchDomainStatus, removeDomainRecord } from '../shared/records'

type Wire = Record<string, unknown>

async function parent(ctx: any, id: string) {
  const normalized = ctx.db.normalizeId('hrDocuments', id)
  const row = normalized ? await ctx.db.get(normalized) : null
  return row?.resource === 'hrAttendanceImports' ? row : null
}

async function parseJob(ctx: any, importId: string) {
  return ctx.db.query('ioJobs').withIndex('by_subject', (q: any) =>
    q.eq('kind', 'attendance_import_parse').eq('subjectId', importId),
  ).unique()
}

export const startParse = internalMutation({
  args: { userId: v.id('appUsers'), fileId: v.id('files'), token: v.string() }, returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await actorForAppUser(ctx, args.userId)
    requirePermission(actor, 'hr.attendance_punch:import')
    requirePermission(actor, 'sys.file:read')
    const file = await ctx.db.get(args.fileId)
    if (!file || file.status !== 'ready') throw synieError('not_found', '考勤导入文件不存在')
    const job = await createJob(ctx, {
      kind: 'attendance_import_parse',
      idempotencyKey: `${args.userId}:${args.fileId}:${file.sha256}`,
      fileId: args.fileId, createdById: args.userId, phase: 'download',
    })
    if (job.status === 'succeeded' && job.subjectId) {
      const existing = await parent(ctx, job.subjectId)
      if (existing) return { completed: true, record: hydrateStored(existing) }
    }
    await claimJob(ctx, job._id, args.token, 10 * 60_000)
    return { completed: false, jobId: job._id, file: { objectKey: file.objectKey, size: file.size } }
  },
})

export const stageChunk = internalMutation({
  args: { jobId: v.id('ioJobs'), token: v.string(), chunkNo: v.number(), hash: v.string(), rows: v.array(v.any()) },
  returns: v.object({ inserted: v.number(), matched: v.number(), unmatched: v.number(), unmatchedCounts: v.any() }),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    requireJobLease(job, args.token)
    const witness = await ctx.db.query('ioJobChunks').withIndex('by_job_chunk', (q) =>
      q.eq('jobId', job._id).eq('chunkNo', args.chunkNo),
    ).unique()
    if (witness) {
      if (witness.hash !== args.hash || witness.rowCount !== args.rows.length) throw synieError('conflict', '考勤分块内容发生漂移')
      return { inserted: 0, matched: 0, unmatched: 0, unmatchedCounts: {} }
    }
    let matched = 0
    let unmatched = 0
    const unmatchedCounts: Record<string, number> = {}
    const now = Date.now()
    for (const raw of args.rows) {
      const row = raw as Wire
      const attendanceNo = String(row.attendanceNo)
      const employee = await ctx.db.query('employees').withIndex('by_attendance_no', (q) => q.eq('attendanceNo', attendanceNo)).unique()
      if (employee) matched += 1
      else {
        unmatched += 1
        unmatchedCounts[attendanceNo] = (unmatchedCounts[attendanceNo] ?? 0) + 1
      }
      await ctx.db.insert('attendanceImportRows', {
        jobId: job._id, rowNo: Number(row.rowNo), attendanceNo,
        punchedAt: String(row.punchedAt), employeeId: employee?._id ?? null,
        punchRecordId: null, insertedAt: now, updatedAt: now,
      })
    }
    await ctx.db.insert('ioJobChunks', { jobId: job._id, chunkNo: args.chunkNo, hash: args.hash, rowCount: args.rows.length, insertedAt: now })
    await ctx.db.patch(job._id, {
      phase: 'stage', progressDone: job.progressDone + args.rows.length,
      progressTotal: Math.max(job.progressTotal, job.progressDone + args.rows.length),
      leaseExpiresAt: now + 10 * 60_000, updatedAt: now,
    })
    return { inserted: args.rows.length, matched, unmatched, unmatchedCounts }
  },
})

export const finishParse = internalMutation({
  args: {
    jobId: v.id('ioJobs'), token: v.string(), error: v.optional(v.string()),
    totalRows: v.number(), badRows: v.number(), dupRows: v.number(),
    matchedRows: v.number(), unmatchedRows: v.number(), unmatchedDetail: v.optional(v.string()),
  }, returns: v.any(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    requireJobLease(job, args.token)
    const actor = await actorForAppUser(ctx, job.createdById!)
    const record = await createDomainRecord(ctx, actor, 'hrAttendanceImports', {}, {
      permissionChecked: true,
      trustedDerived: {
        status: args.error ? 'FAILED' : 'PARSED', error: args.error?.slice(0, 500) ?? null,
        totalRows: args.totalRows, badRows: args.badRows, dupRows: args.dupRows,
        matchedRows: args.matchedRows, unmatchedRows: args.unmatchedRows,
        unmatchedDetail: args.unmatchedDetail ?? null,
        importedCount: 0, skippedExistingRows: 0, skippedUnmatchedRows: 0,
        autoCreatedCount: 0, importedAt: null, fileId: job.fileId,
        importedById: null, punchCount: 0,
      },
    })
    await ctx.db.patch(job._id, {
      subjectId: String(record.id), status: 'succeeded', phase: args.error ? 'parse_failed' : 'parsed',
      progressDone: args.matchedRows + args.unmatchedRows, progressTotal: args.matchedRows + args.unmatchedRows,
      leaseToken: null, leaseExpiresAt: null, updatedAt: Date.now(),
    })
    return record
  },
})

async function requireParent(ctx: any, actor: any, importId: string, status?: string) {
  requirePermission(actor, 'hr.attendance_punch:import')
  const row = await parent(ctx, importId)
  if (!row) throw synieError('not_found', '考勤导入批次不存在')
  if (status && row.status !== status) throw synieError('conflict', `仅「${status}」状态可执行该操作`)
  return row
}

export const beginCommit = internalMutation({
  args: { userId: v.id('appUsers'), importId: v.string(), autoCreateEmployees: v.boolean(), token: v.string() }, returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await actorForAppUser(ctx, args.userId)
    const record = await requireParent(ctx, actor, args.importId, 'PARSED')
    if (args.autoCreateEmployees) requirePermission(actor, 'hr.employee:create')
    const parsed = await parseJob(ctx, args.importId)
    if (!parsed) throw synieError('internal', '考勤批次缺少解析任务')
    const total = Number(hydrateStored(record).matchedRows ?? 0) + (args.autoCreateEmployees ? Number(hydrateStored(record).unmatchedRows ?? 0) : 0)
    if (!total) throw synieError('validation', '没有可导入的打卡行')
    const job = await createJob(ctx, {
      kind: 'attendance_import_commit', idempotencyKey: `${args.importId}:${args.autoCreateEmployees}`,
      subjectId: args.importId, createdById: args.userId, phase: 'commit', progressTotal: total,
      parameters: { parseJobId: parsed._id, autoCreateEmployees: args.autoCreateEmployees },
    })
    if (job.status === 'succeeded') return { completed: true, record: hydrateStored(record) }
    await claimJob(ctx, job._id, args.token, 10 * 60_000)
    return { completed: false, jobId: job._id, parseJobId: parsed._id }
  },
})

export const rowsPage = internalQuery({
  args: { jobId: v.id('ioJobs'), paginationOpts: paginationOptsValidator }, returns: v.any(),
  handler: (ctx, args) => ctx.db.query('attendanceImportRows').withIndex('by_job_row', (q) => q.eq('jobId', args.jobId)).paginate(args.paginationOpts),
})

export const resumePlan = internalQuery({
  args: { jobId: v.id('ioJobs'), token: v.string() }, returns: v.any(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    requireJobLease(job, args.token)
    if (job.kind === 'attendance_import_parse') {
      const file = job.fileId ? await ctx.db.get(job.fileId) : null
      if (!file || file.status !== 'ready') throw synieError('not_found', '考勤文件不存在')
      return { kind: job.kind, file: { objectKey: file.objectKey } }
    }
    if (job.kind === 'attendance_import_commit') {
      const parameters = job.parameters as { parseJobId: Id<'ioJobs'> }
      return { kind: job.kind, parseJobId: parameters.parseJobId, userId: job.createdById, importId: job.subjectId }
    }
    throw synieError('internal', '考勤导入任务类型不匹配')
  },
})

async function createImportedEmployee(ctx: any, actor: any, attendanceNo: string): Promise<Id<'employees'>> {
  const existing = await ctx.db.query('employees').withIndex('by_attendance_no', (q: any) => q.eq('attendanceNo', attendanceNo)).unique()
  if (existing) return existing._id
  requirePermission(actor, 'hr.employee:create')
  const code = await nextInMutation(asDomainMutationCtx(ctx), 'hr.employee', {})
  const now = Date.now()
  const id = await ctx.db.insert('employees', {
    code, codeKey: code.toLocaleLowerCase(), name: `考勤机${attendanceNo}`, attendanceNo,
    idNumber: null, householdRegistration: null, phone: null, currentAddress: null,
    dailyWage: null, monthlyAllowance: null, insuranceTypes: [],
    searchText: `${code} 考勤机${attendanceNo} ${attendanceNo}`.toLocaleLowerCase(),
    insertedAt: now, updatedAt: now,
  })
  await writeAudit(asDomainMutationCtx(ctx), actor, {
    resource: 'hrEmployees', recordId: id, recordLabel: `考勤机${attendanceNo}`,
    action: 'create', changes: { code, name: `考勤机${attendanceNo}`, attendanceNo },
  })
  return id
}

export const commitChunk = internalMutation({
  args: { jobId: v.id('ioJobs'), token: v.string(), rowIds: v.array(v.id('attendanceImportRows')) }, returns: v.any(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    requireJobLease(job, args.token)
    const actor = await actorForAppUser(ctx, job.createdById!)
    const parameters = job.parameters as { parseJobId: Id<'ioJobs'>; autoCreateEmployees: boolean }
    let imported = 0; let skippedExisting = 0; let skippedUnmatched = 0; let autoCreated = 0
    const pairs: Array<{ employeeId: string; date: string }> = []
    for (const id of args.rowIds) {
      const row = await ctx.db.get(id)
      if (!row || row.jobId !== parameters.parseJobId || row.punchRecordId) continue
      let employeeId = row.employeeId
      if (!employeeId && parameters.autoCreateEmployees) {
        const before = await ctx.db.query('employees').withIndex('by_attendance_no', (q) => q.eq('attendanceNo', row.attendanceNo)).unique()
        employeeId = before?._id ?? await createImportedEmployee(ctx, actor, row.attendanceNo)
        if (!before) autoCreated += 1
      }
      if (!employeeId) { skippedUnmatched += 1; continue }
      const punchedAt = Date.parse(row.punchedAt)
      const duplicate = await ctx.db.query('attendancePunchFacts').withIndex('by_employee_time', (q) =>
        q.eq('employeeId', employeeId!).eq('punchedAt', punchedAt),
      ).unique()
      if (duplicate) { skippedExisting += 1; continue }
      const date = attendanceLocalDate(punchedAt)
      const factId = await ctx.db.insert('attendancePunchFacts', {
        importId: job.subjectId!, jobId: job._id, attendanceNo: row.attendanceNo,
        punchedAt, date, employeeId, insertedAt: Date.now(),
      })
      await ctx.db.patch(row._id, { employeeId, punchRecordId: String(factId), updatedAt: Date.now() })
      pairs.push({ employeeId: String(employeeId), date })
      imported += 1
    }
    const prior = job.result && typeof job.result === 'object' ? job.result as Wire : {}
    await ctx.db.patch(job._id, {
      progressDone: job.progressDone + imported + skippedExisting + skippedUnmatched,
      result: {
        imported: Number(prior.imported ?? 0) + imported,
        skippedExisting: Number(prior.skippedExisting ?? 0) + skippedExisting,
        skippedUnmatched: Number(prior.skippedUnmatched ?? 0) + skippedUnmatched,
        autoCreated: Number(prior.autoCreated ?? 0) + autoCreated,
      },
      leaseExpiresAt: Date.now() + 10 * 60_000, updatedAt: Date.now(),
    })
    return { imported, skippedExisting, skippedUnmatched, autoCreated, pairs }
  },
})

export const finishCommit = internalMutation({
  args: {
    jobId: v.id('ioJobs'), token: v.string(),
    buildId: v.id('attendanceProjectionBuilds'), targetGeneration: v.number(),
  }, returns: v.any(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    requireJobLease(job, args.token)
    const build = await ctx.db.get(args.buildId)
    const projection = await ctx.db.query('attendanceProjectionState').withIndex('by_key', (q) => q.eq('key', 'singleton')).unique()
    if (!build || build.jobId !== job._id || build.state !== 'verified' ||
        build.targetGeneration !== args.targetGeneration || !projection ||
        projection.activeGeneration !== build.sourceGeneration) {
      throw synieError('conflict', '考勤投影尚未完成对拍或活跃代次已变化')
    }
    const actor = await actorForAppUser(ctx, job.createdById!)
    const result = (job.result ?? {}) as Wire
    const record = await patchDomainStatus(ctx, actor, 'hrAttendanceImports', job.subjectId!, 'IMPORTED', 'import', {
      importedCount: Number(result.imported ?? 0),
      skippedExistingRows: Number(result.skippedExisting ?? 0),
      skippedUnmatchedRows: Number(result.skippedUnmatched ?? 0),
      autoCreatedCount: Number(result.autoCreated ?? 0),
      punchCount: Number(result.imported ?? 0),
      importedAt: new Date().toISOString(), importedById: actor.userId,
    })
    await ctx.db.patch(projection._id, { activeGeneration: build.targetGeneration, updatedAt: Date.now() })
    await ctx.db.patch(build._id, { state: 'activated', updatedAt: Date.now() })
    await ctx.db.patch(job._id, {
      status: 'succeeded', phase: 'committed', progressDone: job.progressTotal,
      leaseToken: null, leaseExpiresAt: null, updatedAt: Date.now(),
    })
    return record
  },
})

async function factVisible(ctx: any, fact: Doc<'attendancePunchFacts'>): Promise<boolean> {
  return (await parent(ctx, fact.importId))?.status === 'IMPORTED'
}

function presentFact(fact: Doc<'attendancePunchFacts'>) {
  return {
    id: fact._id, attendanceNo: fact.attendanceNo,
    punchedAt: new Date(fact.punchedAt).toISOString(), employeeId: fact.employeeId,
    importId: fact.importId, insertedAt: new Date(fact.insertedAt).toISOString(),
  }
}

export const listPunches = authedQuery({
  args: { numItems: v.number(), cursor: v.optional(v.union(v.string(), v.null())), importId: v.optional(v.string()) }, returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'hr.attendance_punch:read')
    const page = args.importId
      ? await ctx.db.query('attendancePunchFacts').withIndex('by_import_time', (q) => q.eq('importId', args.importId!)).order('desc').paginate(paginationOptions(args))
      : await ctx.db.query('attendancePunchFacts').withIndex('by_date').order('desc').paginate(paginationOptions(args))
    const visible = []
    for (const fact of page.page) if (await factVisible(ctx, fact)) visible.push(presentFact(fact))
    return resourcePage({ ...page, page: visible })
  },
})

export const getPunch = authedQuery({
  args: { id: v.id('attendancePunchFacts') }, returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'hr.attendance_punch:read')
    const fact = await ctx.db.get(args.id)
    return fact && await factVisible(ctx, fact) ? presentFact(fact) : null
  },
})

export const beginRemove = internalMutation({
  args: { userId: v.id('appUsers'), importId: v.string() }, returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await actorForAppUser(ctx, args.userId)
    const row = await requireParent(ctx, actor, args.importId)
    if (row.status !== 'PARSED' && row.status !== 'IMPORTED' && row.status !== 'FAILED' && row.status !== 'DELETING') {
      throw synieError('conflict', '考勤批次当前不可删除')
    }
    const parsed = await parseJob(ctx, args.importId)
    if (row.status !== 'DELETING') {
      await patchDomainStatus(ctx, actor, 'hrAttendanceImports', args.importId, 'DELETING', 'remove_import')
    }
    return { parseJobId: parsed?._id ?? null }
  },
})

export const factPage = internalQuery({
  args: { importId: v.string(), paginationOpts: paginationOptsValidator }, returns: v.any(),
  handler: (ctx, args) => ctx.db.query('attendancePunchFacts').withIndex('by_import_time', (q) => q.eq('importId', args.importId)).paginate(args.paginationOpts),
})

export const removeFacts = internalMutation({
  args: { ids: v.array(v.id('attendancePunchFacts')) }, returns: v.null(),
  handler: async (ctx, args) => { for (const id of args.ids) await ctx.db.delete(id); return null },
})

export const finishRemove = internalMutation({
  args: { userId: v.id('appUsers'), importId: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await actorForAppUser(ctx, args.userId)
    await removeDomainRecord(ctx, actor, 'hrAttendanceImports', args.importId, { permissionChecked: true })
    return null
  },
})
