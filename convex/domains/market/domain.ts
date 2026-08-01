import {
  Decimal,
  decideMarketSchedule,
  emptyMarketScheduleState,
  type MarketScheduleState,
} from '@synie/shared'
import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import { v } from 'convex/values'
import type { DataModel } from '../../_generated/dataModel'
import { internalMutation, internalQuery } from '../../_generated/server'
import { authedMutation, authedQuery } from '../../lib/auth'
import { actorForAppUser, type Actor } from '../../lib/actor'
import { synieError, validationError } from '../../lib/errors'
import { requirePermission } from '../../lib/permissions'
import { claimJob, createJob, requireJobLease } from '../../jobs/domain'
import {
  createDomainRecord,
  getDomainRecord,
  hydrateStored,
  listDomainRecords,
  removeDomainRecord,
  updateDomainRecord,
} from '../shared/records'

type QueryCtx = GenericQueryCtx<DataModel>
type MutationCtx = GenericMutationCtx<DataModel>
type Ctx = QueryCtx | MutationCtx
type Wire = Record<string, unknown>
type PriceKind = 'SETTLEMENT' | 'AVERAGE' | 'LAST'
type PriceSource = 'MANUAL' | 'FETCH'

const RESOURCES = new Set(['basMarketInstruments', 'basMarketPricePoints'])
const PRICE_KINDS = new Set<PriceKind>(['SETTLEMENT', 'AVERAGE', 'LAST'])
const SOURCES = new Set<PriceSource>(['MANUAL', 'FETCH'])

function resource(value: string): 'basMarketInstruments' | 'basMarketPricePoints' {
  if (!RESOURCES.has(value)) throw synieError('validation', `资源 ${value} 不属于行情闭包`)
  return value as 'basMarketInstruments' | 'basMarketPricePoints'
}

function object(value: unknown): Wire {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw synieError('validation', '参数必须是对象')
  }
  return value as Wire
}

function requiredText(value: unknown, field: string, maximum: number): string {
  const text = String(value ?? '').trim()
  if (!text || [...text].length > maximum) {
    throw validationError('行情品种参数不合法', { [field]: [`不能为空且最多 ${maximum} 个字符`] })
  }
  return text
}

function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const text = String(value).trim()
  if ([...text].length > maximum) {
    throw validationError('行情参数不合法', { [field]: [`不能超过 ${maximum} 个字符`] })
  }
  return text
}

function priceKind(value: unknown, field = 'priceKind'): PriceKind {
  const normalized = String(value ?? '').trim().toUpperCase() as PriceKind
  if (!PRICE_KINDS.has(normalized)) {
    throw validationError('行情价点参数不合法', { [field]: ['仅支持 SETTLEMENT/AVERAGE/LAST'] })
  }
  return normalized
}

function source(value: unknown): PriceSource {
  const normalized = String(value ?? 'MANUAL').trim().toUpperCase() as PriceSource
  if (!SOURCES.has(normalized)) {
    throw validationError('行情价点参数不合法', { source: ['仅支持 MANUAL/FETCH'] })
  }
  return normalized
}

function instant(value: unknown, field: string): number {
  const result = typeof value === 'number' ? value : Date.parse(String(value ?? ''))
  if (!Number.isFinite(result)) {
    throw validationError('行情价点参数不合法', { [field]: ['必须是有效时间'] })
  }
  return result
}

function decimal(value: unknown): string {
  if (typeof value !== 'string') {
    throw validationError('价格格式不合法', { price: ['必须是十进制字符串'] })
  }
  let result: Decimal
  try { result = new Decimal(value.trim()) } catch {
    throw validationError('价格格式不合法', { price: ['必须是十进制字符串'] })
  }
  if (!result.isFinite() || result.lte(0)) {
    throw validationError('价格必须大于 0', { price: ['必须大于 0'] })
  }
  return result.toString()
}

function iso(value: unknown): string {
  return new Date(instant(value, 'observedAt')).toISOString()
}

async function closureRow(ctx: Ctx, resourceName: string, id: string): Promise<Wire> {
  const normalized = ctx.db.normalizeId('marketTodoRecords', id)
  const row = normalized ? await ctx.db.get(normalized) : null
  if (!row || row.resource !== resourceName) throw synieError('not_found', '行情记录不存在')
  return hydrateStored(row)
}

async function replaceInstrumentIndex(ctx: MutationCtx, row: Wire | null, recordId: string): Promise<void> {
  const previous = await ctx.db.query('marketInstrumentIndex').withIndex('by_record', (q) =>
    q.eq('recordId', recordId),
  ).unique()
  if (previous) await ctx.db.delete(previous._id)
  if (!row) return
  await ctx.db.insert('marketInstrumentIndex', {
    recordId,
    code: String(row.code),
    active: Boolean(row.active),
    fetchEnabled: Boolean(row.fetchEnabled),
    defaultPriceKind: priceKind(row.defaultPriceKind, 'defaultPriceKind'),
    currencyId: String(row.currencyId),
    unitId: String(row.unitId),
  })
}

async function replacePriceIndex(ctx: MutationCtx, row: Wire, recordId: string, active: boolean): Promise<void> {
  const observedAt = instant(row.observedAt, 'observedAt')
  const kind = priceKind(row.priceKind)
  const pointSource = source(row.source)
  const previous = await ctx.db.query('marketPriceIndex').withIndex('by_record', (q) =>
    q.eq('recordId', recordId),
  ).unique()
  if (previous) await ctx.db.delete(previous._id)
  if (active) {
    const duplicate = await ctx.db.query('marketPriceIndex').withIndex('by_active_unique', (q) =>
      q.eq('active', true)
        .eq('instrumentId', String(row.instrumentId))
        .eq('observedAt', observedAt)
        .eq('priceKind', kind)
        .eq('source', pointSource),
    ).unique()
    if (duplicate && duplicate.recordId !== recordId) throw synieError('conflict', '同一行情价点已存在')
  }
  await ctx.db.insert('marketPriceIndex', {
    recordId,
    instrumentId: String(row.instrumentId),
    observedAt,
    priceKind: kind,
    source: pointSource,
    active,
  })
}

function normalizeInstrumentCreate(input: Wire): Wire {
  const sourceType = String(input.sourceType ?? '').trim().toUpperCase()
  if (!['EXCHANGE', 'SPOT_INDEX', 'OTHER'].includes(sourceType)) {
    throw validationError('行情品种参数不合法', { sourceType: ['仅支持 EXCHANGE/SPOT_INDEX/OTHER'] })
  }
  return {
    code: requiredText(input.code, 'code', 32),
    name: requiredText(input.name, 'name', 64),
    sourceType,
    defaultPriceKind: priceKind(input.defaultPriceKind, 'defaultPriceKind'),
    active: input.active === undefined ? true : input.active,
    fetchEnabled: input.fetchEnabled === undefined ? false : input.fetchEnabled,
    externalLastCode: optionalText(input.externalLastCode, 'externalLastCode', 32),
    externalProductGroup: optionalText(input.externalProductGroup, 'externalProductGroup', 16),
    note: optionalText(input.note, 'note', 255),
    currencyId: input.currencyId,
    unitId: input.unitId,
  }
}

function normalizeInstrumentUpdate(input: Wire): Wire {
  const result: Wire = {}
  if ('name' in input) result.name = requiredText(input.name, 'name', 64)
  if ('defaultPriceKind' in input) result.defaultPriceKind = priceKind(input.defaultPriceKind, 'defaultPriceKind')
  if ('active' in input) result.active = input.active
  if ('fetchEnabled' in input) result.fetchEnabled = input.fetchEnabled
  if ('externalLastCode' in input) result.externalLastCode = optionalText(input.externalLastCode, 'externalLastCode', 32)
  if ('externalProductGroup' in input) result.externalProductGroup = optionalText(input.externalProductGroup, 'externalProductGroup', 16)
  if ('note' in input) result.note = optionalText(input.note, 'note', 255)
  return result
}

export const get = authedQuery({
  args: { resource: v.string(), id: v.string() }, returns: v.any(),
  handler: (ctx, args) => getDomainRecord(ctx, ctx.actor, resource(args.resource), args.id),
})

export const list = authedQuery({
  args: {
    resource: v.string(), numItems: v.number(), cursor: v.optional(v.union(v.string(), v.null())),
    search: v.optional(v.string()), queryArgs: v.optional(v.any()),
  },
  returns: v.any(),
  handler: (ctx, args) => listDomainRecords(ctx, ctx.actor, resource(args.resource), {
    numItems: args.numItems, cursor: args.cursor, search: args.search, args: args.queryArgs,
  }),
})

export const create = authedMutation({
  args: { resource: v.string(), input: v.any() }, returns: v.any(),
  handler: async (ctx, args) => {
    const name = resource(args.resource)
    if (name === 'basMarketInstruments') {
      const result = await createDomainRecord(ctx, ctx.actor, name, normalizeInstrumentCreate(object(args.input)))
      await replaceInstrumentIndex(ctx, result, String(result.id))
      return result
    }
    const input = object(args.input)
    const instrument = await closureRow(ctx, 'basMarketInstruments', String(input.instrumentId ?? ''))
    const result = await createDomainRecord(ctx, ctx.actor, name, {
      instrumentId: instrument.id,
      observedAt: iso(input.observedAt),
      price: decimal(input.price),
      priceKind: input.priceKind == null || String(input.priceKind).trim() === ''
        ? priceKind(instrument.defaultPriceKind)
        : priceKind(input.priceKind),
      source: source(input.source),
      note: optionalText(input.note, 'note', 255),
    }, {
      trustedDerived: {
        currencyId: instrument.currencyId,
        unitId: instrument.unitId,
        isVoided: false,
      },
    })
    await replacePriceIndex(ctx, result, String(result.id), true)
    return result
  },
})

export const update = authedMutation({
  args: { resource: v.string(), id: v.string(), input: v.any() }, returns: v.any(),
  handler: async (ctx, args) => {
    const name = resource(args.resource)
    if (name !== 'basMarketInstruments') throw synieError('validation', '行情价点不支持普通修改')
    const result = await updateDomainRecord(ctx, ctx.actor, name, args.id, normalizeInstrumentUpdate(object(args.input)))
    await replaceInstrumentIndex(ctx, result, args.id)
    return result
  },
})

export const remove = authedMutation({
  args: { resource: v.string(), id: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    const name = resource(args.resource)
    if (name !== 'basMarketInstruments') throw synieError('validation', '行情价点不支持删除')
    const point = await ctx.db.query('marketPriceIndex').withIndex('by_instrument', (q) =>
      q.eq('instrumentId', args.id),
    ).first()
    if (point) throw synieError('conflict', '品种下已有行情价点,请停用而非删除')
    await removeDomainRecord(ctx, ctx.actor, name, args.id)
    await replaceInstrumentIndex(ctx, null, args.id)
    return null
  },
})

/** Called by the shared command state machine in the same mutation. */
export async function voidPriceIndex(ctx: MutationCtx, id: string): Promise<void> {
  const row = await closureRow(ctx, 'basMarketPricePoints', id)
  if (row.isVoided === true) throw synieError('validation', '价点已作废')
  await replacePriceIndex(ctx, row, id, false)
}

function canRead(actor: Actor): void {
  requirePermission(actor, 'base.market_price:read')
}

async function instrumentView(ctx: Ctx, index: {
  recordId: string; currencyId: string; unitId: string; defaultPriceKind: PriceKind
}) {
  const row = await closureRow(ctx, 'basMarketInstruments', index.recordId)
  const currencyId = ctx.db.normalizeId('currencies', index.currencyId)
  const unitId = ctx.db.normalizeId('units', index.unitId)
  const [currency, unit] = await Promise.all([
    currencyId ? ctx.db.get(currencyId) : null,
    unitId ? ctx.db.get(unitId) : null,
  ])
  return {
    id: index.recordId,
    instrumentId: index.recordId,
    code: String(row.code),
    name: String(row.name),
    currencyId: index.currencyId,
    unitId: index.unitId,
    currencyCode: currency?.isoCode ?? null,
    unitName: unit?.name ?? null,
    defaultPriceKind: index.defaultPriceKind,
  }
}

export const chartInstruments = authedQuery({
  args: {}, returns: v.any(),
  handler: async (ctx) => {
    canRead(ctx.actor)
    const indexes = await ctx.db.query('marketInstrumentIndex').withIndex('by_active_code', (q) =>
      q.eq('active', true),
    ).collect()
    return Promise.all(indexes.map((row) => instrumentView(ctx, row)))
  },
})

export const takeQuote = authedQuery({
  args: { instrumentId: v.string(), at: v.union(v.string(), v.number()), priceKind: v.optional(v.union(v.string(), v.null())) },
  returns: v.any(),
  handler: async (ctx, args) => {
    canRead(ctx.actor)
    const instrument = await ctx.db.query('marketInstrumentIndex').withIndex('by_record', (q) =>
      q.eq('recordId', args.instrumentId),
    ).unique()
    if (!instrument) throw synieError('not_found', '行情品种不存在')
    const kind = args.priceKind == null || args.priceKind.trim() === ''
      ? instrument.defaultPriceKind
      : priceKind(args.priceKind)
    const at = instant(args.at, 'at')
    const index = await ctx.db.query('marketPriceIndex').withIndex('by_instrument_kind_active_time', (q) =>
      q.eq('instrumentId', args.instrumentId).eq('priceKind', kind).eq('active', true).lte('observedAt', at),
    ).order('desc').first()
    if (!index) throw synieError('not_found', '无有效行情价点')
    return closureRow(ctx, 'basMarketPricePoints', index.recordId)
  },
})

export const priceSeries = authedQuery({
  args: { instrumentIds: v.array(v.string()), priceKind: v.string(), from: v.union(v.string(), v.number()), to: v.union(v.string(), v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    canRead(ctx.actor)
    const ids = [...new Set(args.instrumentIds.filter(Boolean))]
    if (ids.length > 6) throw validationError('最多同时对比 6 个品种', { instrumentIds: ['最多同时对比 6 个品种'] })
    const kind = priceKind(args.priceKind)
    const from = instant(args.from, 'from')
    const to = instant(args.to, 'to')
    if (from > to) throw validationError('结束时间不能早于开始时间', { to: ['结束时间不能早于开始时间'] })
    const output = { priceKind: kind.toLowerCase(), from: new Date(from).toISOString(), to: new Date(to).toISOString(), series: [] as Wire[] }
    if (!ids.length) return output
    const indexes = []
    for (const id of ids) {
      const row = await ctx.db.query('marketInstrumentIndex').withIndex('by_record', (q) => q.eq('recordId', id)).unique()
      if (!row) throw validationError('部分行情品种不存在', { instrumentIds: ['部分行情品种不存在'] })
      indexes.push(row)
    }
    const first = indexes[0]!
    if (indexes.some((row) => row.currencyId !== first.currencyId || row.unitId !== first.unitId)) {
      throw validationError('勾选品种必须同一币种与计量单位,无法同图对比', { instrumentIds: ['勾选品种必须同一币种与计量单位'] })
    }
    for (const index of indexes) {
      const view = await instrumentView(ctx, index)
      const rows = await ctx.db.query('marketPriceIndex').withIndex('by_instrument_kind_active_time', (q) =>
        q.eq('instrumentId', index.recordId).eq('priceKind', kind).eq('active', true)
          .gte('observedAt', from).lte('observedAt', to),
      ).order('asc').collect()
      const points = []
      for (const row of rows) {
        const point = await closureRow(ctx, 'basMarketPricePoints', row.recordId)
        points.push({ observedAt: new Date(row.observedAt).toISOString(), price: String(point.price) })
      }
      output.series.push({ ...view, points })
    }
    return output
  },
})

type RefreshMode = 'manual' | 'last' | 'settlement'

function refreshMode(value: unknown): RefreshMode {
  if (value === 'manual' || value === 'last' || value === 'settlement') return value
  throw synieError('internal', '行情任务模式不合法')
}

function minute(value: number): number {
  return Math.floor(value / 60_000) * 60_000
}

function scheduleState(row: {
  lastLastDate: string | null; lastLastSlot: number | null
  lastSettlementDate: string | null; lastSettlementSlot: number | null
} | null): MarketScheduleState {
  return {
    lasts: row?.lastLastDate !== null && row?.lastLastDate !== undefined && row.lastLastSlot !== null
      ? { date: row.lastLastDate, slot: row.lastLastSlot }
      : null,
    settlement: row?.lastSettlementDate !== null && row?.lastSettlementDate !== undefined && row.lastSettlementSlot !== null
      ? { date: row.lastSettlementDate, slot: row.lastSettlementSlot }
      : null,
  }
}

async function fetchable(ctx: Ctx, instrumentId: string | null) {
  if (instrumentId) {
    const row = await ctx.db.query('marketInstrumentIndex').withIndex('by_record', (q) =>
      q.eq('recordId', instrumentId),
    ).unique()
    return row?.active && row.fetchEnabled ? [row] : []
  }
  return ctx.db.query('marketInstrumentIndex').withIndex('by_active_code', (q) =>
    q.eq('active', true),
  ).filter((q) => q.eq(q.field('fetchEnabled'), true)).collect()
}

export const startManualRefresh = internalMutation({
  args: {
    userId: v.id('appUsers'), instrumentId: v.optional(v.union(v.string(), v.null())),
    requestedAt: v.number(), token: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await actorForAppUser(ctx, args.userId)
    requirePermission(actor, 'base.market_price:create')
    const selected = args.instrumentId?.trim() || null
    if (selected && !(await fetchable(ctx, selected)).length) {
      throw validationError('行情刷新参数不合法', { instrumentId: ['品种不存在、已停用或未启用拉取'] })
    }
    const observedAt = minute(args.requestedAt)
    const job = await createJob(ctx, {
      kind: 'market_refresh',
      idempotencyKey: `${args.userId}:manual:${selected ?? 'all'}:${observedAt}`,
      subjectId: selected,
      createdById: args.userId,
      phase: 'fetch',
      parameters: { mode: 'manual', instrumentId: selected, requestedAt: args.requestedAt },
    })
    if (job.status === 'succeeded') return { completed: true, result: job.result ?? { count: 0, items: [] } }
    const claimed = await claimJob(ctx, job._id, args.token, 5 * 60_000)
    if (claimed.status === 'dead_letter') throw synieError('conflict', '行情刷新任务已进入死信，请检查配置')
    return { completed: false, jobId: claimed._id, token: args.token }
  },
})

/** One serialized mutation persists schedule slots before returning runnable job ids. */
export const scheduleTick = internalMutation({
  args: { now: v.number(), token: v.string() }, returns: v.any(),
  handler: async (ctx, args) => {
    const settings = await ctx.db.query('systemSettings').withIndex('by_key', (q) => q.eq('key', 'singleton')).unique()
    const setup = await ctx.db.query('setupState').withIndex('by_key', (q) => q.eq('key', 'singleton')).unique()
    if (!settings || !setup) return { jobs: [], skipped: 'not_initialized' }
    let state = await ctx.db.query('marketSchedulerState').withIndex('by_key', (q) => q.eq('key', 'singleton')).unique()
    if (state?.leaseToken && (state.leaseExpiresAt ?? 0) > args.now) return { jobs: [], skipped: 'leased' }
    if (!state) {
      const id = await ctx.db.insert('marketSchedulerState', {
        key: 'singleton', lastLastDate: null, lastLastSlot: null,
        lastSettlementDate: null, lastSettlementSlot: null,
        leaseToken: args.token, leaseExpiresAt: args.now + 55_000,
        lastTickAt: null, updatedAt: args.now,
      })
      state = (await ctx.db.get(id))!
    } else {
      await ctx.db.patch(state._id, { leaseToken: args.token, leaseExpiresAt: args.now + 55_000, updatedAt: args.now })
    }
    const decision = decideMarketSchedule({
      scheduleEnabled: settings.marketFetchScheduleEnabled,
      lastIntervalMinutes: settings.marketFetchLastIntervalMinutes,
      settlementEnabled: settings.marketFetchSettlementEnabled,
    }, new Date(args.now), scheduleState(state))
    const jobs: string[] = []
    const enqueue = async (mode: 'last' | 'settlement', date: string, slot: number) => {
      const job = await createJob(ctx, {
        kind: 'market_refresh', idempotencyKey: `schedule:${mode}:${date}:${slot}`,
        createdById: setup.firstAdminUserId, phase: 'fetch',
        parameters: { mode, instrumentId: null, requestedAt: args.now, scheduleDate: date, scheduleSlot: slot },
      })
      if (job.status === 'queued' || job.status === 'failed' ||
          (job.status === 'running' && (job.leaseExpiresAt ?? 0) <= args.now)) jobs.push(String(job._id))
    }
    if (decision.runLasts && decision.next.lasts) await enqueue('last', decision.next.lasts.date, decision.next.lasts.slot)
    if (decision.runSettlements && decision.next.settlement) await enqueue('settlement', decision.next.settlement.date, decision.next.settlement.slot)
    await ctx.db.patch(state._id, {
      lastLastDate: decision.next.lasts?.date ?? null,
      lastLastSlot: decision.next.lasts?.slot ?? null,
      lastSettlementDate: decision.next.settlement?.date ?? null,
      lastSettlementSlot: decision.next.settlement?.slot ?? null,
      leaseToken: null, leaseExpiresAt: null, lastTickAt: args.now, updatedAt: args.now,
    })
    return { jobs, skipped: null }
  },
})

export const refreshPlan = internalQuery({
  args: { jobId: v.id('ioJobs'), token: v.string() }, returns: v.any(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    requireJobLease(job, args.token)
    if (job.kind !== 'market_refresh' || !job.createdById) throw synieError('internal', '行情任务不完整')
    const parameters = object(job.parameters)
    const mode = refreshMode(parameters.mode)
    const requestedAt = Number(parameters.requestedAt)
    if (!Number.isFinite(requestedAt)) throw synieError('internal', '行情任务时间不合法')
    const instrumentId = typeof parameters.instrumentId === 'string' && parameters.instrumentId ? parameters.instrumentId : null
    const indexes = await fetchable(ctx, instrumentId)
    const settings = await ctx.db.query('systemSettings').withIndex('by_key', (q) => q.eq('key', 'singleton')).unique()
    const instruments = []
    for (const index of indexes) {
      const row = await closureRow(ctx, 'basMarketInstruments', index.recordId)
      instruments.push({
        id: index.recordId, code: String(row.code), name: String(row.name),
        externalLastCode: typeof row.externalLastCode === 'string' ? row.externalLastCode : null,
        externalProductGroup: typeof row.externalProductGroup === 'string' ? row.externalProductGroup : null,
      })
    }
    return {
      mode, requestedAt, instruments,
      settlementEnabled: settings?.marketFetchSettlementEnabled ?? false,
    }
  },
})

export const ingestFetchedPoint = internalMutation({
  args: {
    jobId: v.id('ioJobs'), token: v.string(), instrumentId: v.string(),
    observedAt: v.number(), price: v.string(), priceKind: v.string(), note: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    requireJobLease(job, args.token)
    if (job.kind !== 'market_refresh' || !job.createdById) throw synieError('internal', '行情任务不完整')
    const actor = await actorForAppUser(ctx, job.createdById)
    const instrument = await ctx.db.query('marketInstrumentIndex').withIndex('by_record', (q) =>
      q.eq('recordId', args.instrumentId),
    ).unique()
    if (!instrument?.active || !instrument.fetchEnabled) return { status: 'skipped', message: '品种已停用或关闭拉取', pricePointId: null }
    const kind = priceKind(args.priceKind)
    const existing = await ctx.db.query('marketPriceIndex').withIndex('by_instrument_kind_active_time', (q) =>
      q.eq('instrumentId', args.instrumentId).eq('priceKind', kind).eq('active', true).eq('observedAt', args.observedAt),
    ).first()
    if (existing) return { status: 'skipped', message: kind === 'LAST' ? '本分钟已有行情价' : '当日结算价已存在', pricePointId: existing.recordId }
    const wire = await closureRow(ctx, 'basMarketInstruments', args.instrumentId)
    const result = await createDomainRecord(ctx, actor, 'basMarketPricePoints', {
      instrumentId: args.instrumentId, observedAt: new Date(args.observedAt).toISOString(),
      price: decimal(args.price), priceKind: kind, source: 'FETCH', note: args.note.slice(0, 255),
    }, {
      permissionChecked: true,
      trustedDerived: { currencyId: wire.currencyId, unitId: wire.unitId, isVoided: false },
    })
    await replacePriceIndex(ctx, result, String(result.id), true)
    await ctx.db.patch(job._id, {
      progressDone: job.progressDone + 1,
      leaseExpiresAt: Date.now() + 5 * 60_000,
      updatedAt: Date.now(),
    })
    return { status: 'ok', message: '', pricePointId: result.id }
  },
})

export const finishRefresh = internalMutation({
  args: { jobId: v.id('ioJobs'), token: v.string(), items: v.array(v.any()), summary: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    requireJobLease(job, args.token)
    const result = { count: args.items.length, items: args.items }
    await ctx.db.patch(job._id, {
      status: 'succeeded', phase: 'completed', progressDone: args.items.length,
      progressTotal: args.items.length, leaseToken: null, leaseExpiresAt: null,
      errorCode: null, errorMessage: null, result, updatedAt: Date.now(),
    })
    const settings = await ctx.db.query('systemSettings').withIndex('by_key', (q) => q.eq('key', 'singleton')).unique()
    if (settings) await ctx.db.patch(settings._id, {
      marketFetchLastRunAt: Date.now(), marketFetchLastSummary: args.summary.slice(0, 500), updatedAt: Date.now(),
    })
    return result
  },
})
