import { paginationOptsValidator, type GenericMutationCtx } from 'convex/server'
import { Decimal } from '@synie/shared'
import { v } from 'convex/values'
import { action, internalMutation, internalQuery } from '../../_generated/server'
import { internal } from '../../_generated/api'
import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import { authComponent } from '../../auth'
import { actorForAppUser, type Actor } from '../../lib/actor'
import { decimalToScaledInt64, scaledInt64ToDecimal } from '../../lib/decimal'
import { synieError } from '../../lib/errors'
import { requirePermission } from '../../lib/permissions'
import { authedQuery } from '../../lib/auth'
import { paginationOptions, requireSearchTerm, resourcePage } from '../../lib/pagination'
import { hydrateStored } from '../shared/records'
import { requireJobLease } from '../../jobs/domain'
import { computeAttendanceDay } from './attendanceRules'

const indexedResource = v.union(
  v.literal('hrAttendancePunches'),
  v.literal('hrAttendanceCorrections'),
  v.literal('hrAttendanceDays'),
)

export const actorPayload = internalQuery({
  args: { authUserId: v.string() }, returns: v.any(),
  handler: async (ctx, args) => {
    const user = await ctx.db.query('appUsers').withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId)).unique()
    if (!user?.enabled) throw synieError('unauthorized', '登录状态已失效,请重新登录')
    const [roleLinks, companyLinks] = await Promise.all([
      ctx.db.query('iamUserRoles').withIndex('by_user', (q) => q.eq('userId', user._id)).collect(),
      ctx.db.query('iamUserCompanies').withIndex('by_user', (q) => q.eq('userId', user._id)).collect(),
    ])
    const permissions: string[] = []
    for (const link of roleLinks) {
      const role = await ctx.db.get(link.roleId)
      if (!role?.enabled) continue
      const rows = await ctx.db.query('iamRolePermissions').withIndex('by_role', (q) => q.eq('roleId', role._id)).collect()
      permissions.push(...rows.map((row) => row.permission))
    }
    return { userId: user._id, superAdmin: user.superAdmin, permissions, companyIds: companyLinks.map((link) => link.companyId) }
  },
})

export const pairPage = internalQuery({
  args: { resource: indexedResource, dateFrom: v.string(), dateTo: v.string(), paginationOpts: paginationOptsValidator },
  returns: v.any(),
  handler: (ctx, args) => ctx.db.query('hrAttendanceIndex').withIndex('by_resource_date', (q) =>
    q.eq('resource', args.resource).gte('date', args.dateFrom).lte('date', args.dateTo),
  ).paginate(args.paginationOpts),
})

export const punchFactPage = internalQuery({
  args: { dateFrom: v.string(), dateTo: v.string(), paginationOpts: paginationOptsValidator },
  returns: v.any(),
  handler: async (ctx, args) => {
    const page = await ctx.db.query('attendancePunchFacts').withIndex('by_date', (q) =>
      q.gte('date', args.dateFrom).lte('date', args.dateTo),
    ).paginate(args.paginationOpts)
    const visible = []
    for (const fact of page.page) {
      const parentId = ctx.db.normalizeId('hrDocuments', fact.importId)
      const parent = parentId ? await ctx.db.get(parentId) : null
      if (parent?.resource === 'hrAttendanceImports' && parent.status === 'IMPORTED') visible.push(fact)
    }
    return { ...page, page: visible }
  },
})

async function indexedRows(ctx: GenericMutationCtx<DataModel>, resource: 'hrAttendancePunches' | 'hrAttendanceCorrections', employeeId: string, date: string, includeImportId?: string) {
  const indexes = await ctx.db.query('hrAttendanceIndex').withIndex('by_resource_employee_date', (q) =>
    q.eq('resource', resource).eq('employeeId', employeeId).eq('date', date),
  ).collect()
  const rows: Record<string, unknown>[] = []
  for (const index of indexes) {
    const id = ctx.db.normalizeId('hrDocuments', index.recordId)
    const row = id ? await ctx.db.get(id) : null
    if (row?.resource === resource) rows.push(hydrateStored(row))
  }
  if (resource === 'hrAttendancePunches') {
    const employeeKey = ctx.db.normalizeId('employees', employeeId)
    if (employeeKey) {
      const facts = await ctx.db.query('attendancePunchFacts').withIndex('by_employee_date', (q) =>
        q.eq('employeeId', employeeKey).eq('date', date),
      ).collect()
      for (const fact of facts) {
        const parentId = ctx.db.normalizeId('hrDocuments', fact.importId)
        const parent = parentId ? await ctx.db.get(parentId) : null
        if (parent?.resource === 'hrAttendanceImports' && (parent.status === 'IMPORTED' || fact.importId === includeImportId)) {
          rows.push({ punchedAt: new Date(fact.punchedAt).toISOString() })
        }
      }
    }
  }
  return rows
}

function punchTime(value: unknown): string {
  const instant = typeof value === 'number' ? value : Date.parse(String(value))
  if (!Number.isFinite(instant)) throw synieError('internal', '打卡时间损坏')
  return new Date(instant + 8 * 60 * 60 * 1_000).toISOString().slice(11, 19)
}

function projectedDay(row: Doc<'attendanceDayProjections'>) {
  return {
    id: row._id, employeeId: row.employeeId, date: row.date,
    morningIn: row.morningIn, morningOut: row.morningOut,
    afternoonIn: row.afternoonIn, afternoonOut: row.afternoonOut,
    normalHours: scaledInt64ToDecimal(row.normalHoursScaled, 6),
    overtimeHours: scaledInt64ToDecimal(row.overtimeHoursScaled, 6),
    bonusWorkday: scaledInt64ToDecimal(row.bonusWorkdayScaled, 6),
    status: row.status,
    insertedAt: new Date(row.insertedAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  }
}

async function activeGeneration(ctx: { db: any }): Promise<number> {
  return (await ctx.db.query('attendanceProjectionState').withIndex('by_key', (q: any) => q.eq('key', 'singleton')).unique())?.activeGeneration ?? 0
}

async function ensureProjectionState(ctx: GenericMutationCtx<DataModel>) {
  const existing = await ctx.db.query('attendanceProjectionState').withIndex('by_key', (q) => q.eq('key', 'singleton')).unique()
  if (existing) return existing
  const id = await ctx.db.insert('attendanceProjectionState', { key: 'singleton', activeGeneration: 0, updatedAt: Date.now() })
  return (await ctx.db.get(id))!
}

export async function getProjectedAttendanceDay(ctx: any, actor: Actor, id: string) {
  requirePermission(actor, 'hr.attendance_day:read')
  const normalized = ctx.db.normalizeId('attendanceDayProjections', id)
  const row = normalized ? await ctx.db.get(normalized) : null
  return row && row.generation === await activeGeneration(ctx) ? projectedDay(row) : null
}

export async function listProjectedAttendanceDays(ctx: any, actor: Actor, input: {
  numItems: number; cursor?: string | null; search?: string; args?: Record<string, unknown>
}) {
  requirePermission(actor, 'hr.attendance_day:read')
  const generation = await activeGeneration(ctx)
  const options = paginationOptions(input)
  if (input.search !== undefined) {
    const page = await ctx.db.query('attendanceDayProjections').withSearchIndex('search_text', (q: any) =>
      q.search('searchText', requireSearchTerm(input.search)).eq('generation', generation),
    ).paginate(options)
    return resourcePage({ ...page, page: page.page.map(projectedDay) })
  }
  const direction = input.args?.sortDirection === 'descending' ? 'desc' : 'asc'
  const page = await ctx.db.query('attendanceDayProjections').withIndex('by_generation_date', (q: any) =>
    q.eq('generation', generation),
  ).order(direction).paginate(options)
  return resourcePage({ ...page, page: page.page.map(projectedDay) })
}

async function calculateProjection(
  ctx: GenericMutationCtx<DataModel>, employeeId: string, date: string, includeImportId?: string,
) {
  const [punches, corrections] = await Promise.all([
    indexedRows(ctx, 'hrAttendancePunches', employeeId, date, includeImportId),
    indexedRows(ctx, 'hrAttendanceCorrections', employeeId, date),
  ])
  const values = [
    ...punches.map((row) => punchTime(row.punchedAt)),
    ...corrections.flatMap((row) => Array.isArray(row.times) ? row.times.map(String) : [String(row.times)]),
  ]
  return values.length ? computeAttendanceDay(values) : null
}

async function replaceProjectedDay(
  ctx: GenericMutationCtx<DataModel>, generation: number,
  pair: { employeeId: string; date: string }, includeImportId?: string,
) {
  const employeeId = ctx.db.normalizeId('employees', pair.employeeId)
  if (!employeeId) throw synieError('not_found', '考勤员工不存在')
  const existing = await ctx.db.query('attendanceDayProjections').withIndex('by_generation_employee_date', (q) =>
    q.eq('generation', generation).eq('employeeId', employeeId).eq('date', pair.date),
  ).unique()
  const computed = await calculateProjection(ctx, pair.employeeId, pair.date, includeImportId)
  if (!computed) {
    if (existing) await ctx.db.delete(existing._id)
    return false
  }
  const now = Date.now()
  const patch = {
    morningIn: computed.morningIn, morningOut: computed.morningOut,
    afternoonIn: computed.afternoonIn, afternoonOut: computed.afternoonOut,
    normalHoursScaled: decimalToScaledInt64(computed.normalHours, 6),
    overtimeHoursScaled: decimalToScaledInt64(computed.overtimeHours, 6),
    bonusWorkdayScaled: decimalToScaledInt64(computed.bonusWorkday, 6),
    status: (computed.status === 'MISSING' ? 'MISSING' : 'OK') as 'MISSING' | 'OK',
    searchText: [computed.morningIn, computed.morningOut, computed.afternoonIn, computed.afternoonOut].filter(Boolean).join(' '),
    updatedAt: now,
  }
  if (existing) await ctx.db.patch(existing._id, patch)
  else await ctx.db.insert('attendanceDayProjections', {
    generation, employeeId, date: pair.date, ...patch, insertedAt: now,
  })
  return true
}

export const recalcBatch = internalMutation({
  args: { userId: v.id('appUsers'), pairs: v.array(v.object({ employeeId: v.string(), date: v.string() })) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const actor = await actorForAppUser(ctx, args.userId)
    requirePermission(actor, 'hr.attendance_day:recalc')
    const building = await ctx.db.query('attendanceProjectionBuilds').withIndex('by_state', (q) =>
      q.eq('state', 'building'),
    ).first()
    if (building) throw synieError('conflict', '考勤导入正在切换投影，请稍后重算')
    const state = await ensureProjectionState(ctx)
    for (const pair of args.pairs) {
      await replaceProjectedDay(ctx, state.activeGeneration, pair)
    }
    return args.pairs.length
  },
})

export const projectionPairPage = internalQuery({
  args: { dateFrom: v.string(), dateTo: v.string(), paginationOpts: paginationOptsValidator }, returns: v.any(),
  handler: async (ctx, args) => {
    const generation = await activeGeneration(ctx)
    return ctx.db.query('attendanceDayProjections').withIndex('by_generation_date', (q) =>
      q.eq('generation', generation).gte('date', args.dateFrom).lte('date', args.dateTo),
    ).paginate(args.paginationOpts)
  },
})

export const startProjectionBuild = internalMutation({
  args: { jobId: v.id('ioJobs'), token: v.string() }, returns: v.any(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    requireJobLease(job, args.token)
    if (job.kind !== 'attendance_import_commit') throw synieError('internal', '考勤投影任务类型不匹配')
    const existing = await ctx.db.query('attendanceProjectionBuilds').withIndex('by_job', (q) => q.eq('jobId', args.jobId)).unique()
    if (existing) return existing
    const other = await ctx.db.query('attendanceProjectionBuilds').withIndex('by_state', (q) => q.eq('state', 'building')).first()
    if (other) throw synieError('conflict', '另一批考勤投影正在构建')
    const state = await ensureProjectionState(ctx)
    const now = Date.now()
    const id = await ctx.db.insert('attendanceProjectionBuilds', {
      jobId: job._id, sourceGeneration: state.activeGeneration,
      targetGeneration: state.activeGeneration + 1, state: 'building',
      copiedRows: 0, rebuiltPairs: 0, targetRows: 0,
      insertedAt: now, updatedAt: now,
    })
    return (await ctx.db.get(id))!
  },
})

export const projectionGenerationPage = internalQuery({
  args: { generation: v.number(), paginationOpts: paginationOptsValidator }, returns: v.any(),
  handler: (ctx, args) => ctx.db.query('attendanceDayProjections').withIndex('by_generation_date', (q) =>
    q.eq('generation', args.generation),
  ).paginate(args.paginationOpts),
})

export const copyProjectionChunk = internalMutation({
  args: { jobId: v.id('ioJobs'), token: v.string(), buildId: v.id('attendanceProjectionBuilds'), rows: v.array(v.any()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId); requireJobLease(job, args.token)
    const build = await ctx.db.get(args.buildId)
    if (!build || build.jobId !== job._id || build.state !== 'building') throw synieError('conflict', '考勤投影构建状态已变化')
    let copied = 0
    for (const raw of args.rows) {
      const row = raw as Record<string, unknown>
      const employeeId = ctx.db.normalizeId('employees', String(row.employeeId ?? ''))
      if (!employeeId) throw synieError('internal', '考勤投影员工损坏')
      const date = String(row.date)
      const duplicate = await ctx.db.query('attendanceDayProjections').withIndex('by_generation_employee_date', (q) =>
        q.eq('generation', build.targetGeneration).eq('employeeId', employeeId).eq('date', date),
      ).unique()
      if (duplicate) continue
      await ctx.db.insert('attendanceDayProjections', {
        generation: build.targetGeneration, employeeId, date,
        morningIn: typeof row.morningIn === 'string' ? row.morningIn : null,
        morningOut: typeof row.morningOut === 'string' ? row.morningOut : null,
        afternoonIn: typeof row.afternoonIn === 'string' ? row.afternoonIn : null,
        afternoonOut: typeof row.afternoonOut === 'string' ? row.afternoonOut : null,
        normalHoursScaled: BigInt(String(row.normalHoursScaled)),
        overtimeHoursScaled: BigInt(String(row.overtimeHoursScaled)),
        bonusWorkdayScaled: BigInt(String(row.bonusWorkdayScaled)),
        status: row.status === 'MISSING' ? 'MISSING' : 'OK',
        searchText: String(row.searchText ?? ''),
        insertedAt: Number(row.insertedAt), updatedAt: Number(row.updatedAt),
      })
      copied += 1
    }
    await ctx.db.patch(build._id, { copiedRows: build.copiedRows + copied, updatedAt: Date.now() })
    await ctx.db.patch(job._id, { leaseExpiresAt: Date.now() + 10 * 60_000, updatedAt: Date.now() })
    return copied
  },
})

export const rebuildProjectionChunk = internalMutation({
  args: {
    jobId: v.id('ioJobs'), token: v.string(), buildId: v.id('attendanceProjectionBuilds'),
    importId: v.string(), pairs: v.array(v.object({ employeeId: v.string(), date: v.string() })),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId); requireJobLease(job, args.token)
    const build = await ctx.db.get(args.buildId)
    if (!build || build.jobId !== job._id || build.state !== 'building') throw synieError('conflict', '考勤投影构建状态已变化')
    let rebuilt = 0
    for (const pair of args.pairs) {
      const employeeId = ctx.db.normalizeId('employees', pair.employeeId)
      if (!employeeId) throw synieError('not_found', '考勤员工不存在')
      const witness = await ctx.db.query('attendanceProjectionBuildPairs').withIndex('by_build_pair', (q) =>
        q.eq('buildId', build._id).eq('employeeId', employeeId).eq('date', pair.date),
      ).unique()
      if (witness) continue
      await replaceProjectedDay(ctx, build.targetGeneration, pair, args.importId)
      await ctx.db.insert('attendanceProjectionBuildPairs', { buildId: build._id, employeeId, date: pair.date, insertedAt: Date.now() })
      rebuilt += 1
    }
    await ctx.db.patch(build._id, { rebuiltPairs: build.rebuiltPairs + rebuilt, updatedAt: Date.now() })
    await ctx.db.patch(job._id, { phase: 'projection', leaseExpiresAt: Date.now() + 10 * 60_000, updatedAt: Date.now() })
    return rebuilt
  },
})

export const verifyProjectionBuild = internalMutation({
  args: {
    jobId: v.id('ioJobs'), token: v.string(), buildId: v.id('attendanceProjectionBuilds'),
    copiedRows: v.number(), rebuiltPairs: v.number(), targetRows: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId); requireJobLease(job, args.token)
    const build = await ctx.db.get(args.buildId)
    if (!build || build.jobId !== job._id || build.state !== 'building') throw synieError('conflict', '考勤投影构建状态已变化')
    if (build.copiedRows !== args.copiedRows || build.rebuiltPairs !== args.rebuiltPairs ||
        args.targetRows < 0 || args.targetRows > args.copiedRows + args.rebuiltPairs) {
      throw synieError('conflict', '考勤投影分块对拍失败')
    }
    await ctx.db.patch(build._id, { state: 'verified', targetRows: args.targetRows, updatedAt: Date.now() })
    return { targetGeneration: build.targetGeneration, targetRows: args.targetRows }
  },
})

export const recalcRange = action({
  args: { dateFrom: v.string(), dateTo: v.string() }, returns: v.number(),
  handler: async (ctx, args) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(args.dateTo)) throw synieError('validation', '重算日期格式不合法')
    const from = Date.parse(`${args.dateFrom}T00:00:00Z`); const to = Date.parse(`${args.dateTo}T00:00:00Z`)
    if (to < from || (to - from) / 86_400_000 > 366) throw synieError('validation', '重算区间结束日不得早于开始日且不能超过一年')
    const authUser = await authComponent.safeGetAuthUser(ctx)
    if (!authUser) throw synieError('unauthorized', '登录状态已失效,请重新登录')
    const payload = await ctx.runQuery(internal.domains.hr.attendance.actorPayload, { authUserId: authUser._id })
    requirePermission({ superAdmin: payload.superAdmin, permissions: new Set<string>(payload.permissions) }, 'hr.attendance_day:recalc')
    const pairs = new Map<string, { employeeId: string; date: string }>()
    for (const resource of ['hrAttendancePunches', 'hrAttendanceCorrections'] as const) {
      let cursor: string | null = null
      do {
        const page: {
          page: Array<{ employeeId: string; date: string }>
          isDone: boolean
          continueCursor: string
        } = await ctx.runQuery(internal.domains.hr.attendance.pairPage, {
          resource, dateFrom: args.dateFrom, dateTo: args.dateTo,
          paginationOpts: { numItems: 500, cursor },
        })
        for (const row of page.page) pairs.set(`${row.employeeId}\0${row.date}`, { employeeId: row.employeeId, date: row.date })
        cursor = page.isDone ? null : page.continueCursor
      } while (cursor)
    }
    let projectionCursor: string | null = null
    do {
      const page: {
        page: Array<{ employeeId: string; date: string }>
        isDone: boolean
        continueCursor: string
      } = await ctx.runQuery(internal.domains.hr.attendance.projectionPairPage, {
        dateFrom: args.dateFrom, dateTo: args.dateTo,
        paginationOpts: { numItems: 500, cursor: projectionCursor },
      })
      for (const row of page.page) pairs.set(`${row.employeeId}\0${row.date}`, { employeeId: row.employeeId, date: row.date })
      projectionCursor = page.isDone ? null : page.continueCursor
    } while (projectionCursor)
    let factCursor: string | null = null
    do {
      const page: {
        page: Array<{ employeeId: string; date: string }>
        isDone: boolean
        continueCursor: string
      } = await ctx.runQuery(internal.domains.hr.attendance.punchFactPage, {
        dateFrom: args.dateFrom, dateTo: args.dateTo,
        paginationOpts: { numItems: 500, cursor: factCursor },
      })
      for (const row of page.page) pairs.set(`${row.employeeId}\0${row.date}`, { employeeId: row.employeeId, date: row.date })
      factCursor = page.isDone ? null : page.continueCursor
    } while (factCursor)
    const ordered = [...pairs.values()].sort((a, b) => a.employeeId.localeCompare(b.employeeId) || a.date.localeCompare(b.date))
    for (let index = 0; index < ordered.length; index += 25) {
      await ctx.runMutation(internal.domains.hr.attendance.recalcBatch, { userId: payload.userId as Id<'appUsers'>, pairs: ordered.slice(index, index + 25) })
    }
    return ordered.length
  },
})

export const monthSummary = authedQuery({
  args: { month: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'hr.attendance_day:read')
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(args.month)) throw synieError('validation', '月份格式应为 YYYY-MM')
    const start = `${args.month}-01`
    const nextDate = new Date(`${start}T00:00:00Z`)
    nextDate.setUTCMonth(nextDate.getUTCMonth() + 1)
    const end = nextDate.toISOString().slice(0, 10)
    const generation = await activeGeneration(ctx)
    const rows = await ctx.db.query('attendanceDayProjections').withIndex('by_generation_date', (q) =>
      q.eq('generation', generation).gte('date', start).lt('date', end),
    ).collect()
    const totals = new Map<string, {
      days: number
      missingDays: number
      normalHours: Decimal
      overtimeHours: Decimal
      bonusWorkdays: Decimal
    }>()
    for (const row of rows) {
      const total = totals.get(String(row.employeeId)) ?? {
        days: 0,
        missingDays: 0,
        normalHours: new Decimal(0),
        overtimeHours: new Decimal(0),
        bonusWorkdays: new Decimal(0),
      }
      total.days += 1
      if (row.status === 'MISSING') total.missingDays += 1
      total.normalHours = total.normalHours.add(scaledInt64ToDecimal(row.normalHoursScaled, 6))
      total.overtimeHours = total.overtimeHours.add(scaledInt64ToDecimal(row.overtimeHoursScaled, 6))
      total.bonusWorkdays = total.bonusWorkdays.add(scaledInt64ToDecimal(row.bonusWorkdayScaled, 6))
      totals.set(String(row.employeeId), total)
    }
    const result = []
    for (const [employeeId, total] of totals) {
      const employeeKey = ctx.db.normalizeId('employees', employeeId)
      const employee = employeeKey ? await ctx.db.get(employeeKey) : null
      result.push({
        employeeId,
        employeeCode: employee?.code ?? null,
        employeeName: employee?.name ?? null,
        days: total.days,
        missingDays: total.missingDays,
        normalHours: total.normalHours.toString(),
        overtimeHours: total.overtimeHours.toString(),
        bonusWorkdays: total.bonusWorkdays.toString(),
        workdays: total.normalHours.div(8).add(total.bonusWorkdays).toString(),
      })
    }
    return result.sort((left, right) => String(left.employeeCode ?? '').localeCompare(String(right.employeeCode ?? '')) || String(left.employeeName ?? '').localeCompare(String(right.employeeName ?? '')))
  },
})
