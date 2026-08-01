import { v } from 'convex/values'
import { decimalToScaledInt64, scaledInt64ToDecimal } from '../../lib/decimal'
import { permissionedMutation, permissionedQuery } from '../../lib/auth'
import { asDomainMutationCtx } from '../../lib/mutationContext'
import { synieError, validationError } from '../../lib/errors'
import { changedFields } from '../../platform/audit/model'
import { writeAudit } from '../../platform/audit/write'

function one<T>(row: T | null, label: string): T {
  if (!row) throw synieError('internal', `${label}尚未初始化`)
  return row
}

function ratio(value: string, field: string): bigint {
  try {
    const scaled = decimalToScaledInt64(value.trim(), 6)
    if (scaled < 0n || scaled > 1_000_000n) throw new Error('range')
    return scaled
  } catch {
    throw validationError('设置参数不合法', { [field]: ['须为 0 到 1 的十进制字符串'] })
  }
}

const singletonArgs = {
  numItems: v.number(),
  cursor: v.optional(v.union(v.string(), v.null())),
}

function salesRow(row: any) {
  return {
    id: row._id,
    sampleItemMaxQty: row.sampleItemMaxQty,
    deliveryOvershipRatio: scaledInt64ToDecimal(row.deliveryOvershipRatioScaled, 6),
    spotItemMaxQty: row.spotItemMaxQty,
    receiptOverreceiveRatio: scaledInt64ToDecimal(row.receiptOverreceiveRatioScaled, 6),
    demandOverorderRatio: scaledInt64ToDecimal(row.demandOverorderRatioScaled, 6),
    insertedAt: row.insertedAt,
    updatedAt: row.updatedAt,
  }
}

export const listSales = permissionedQuery('sales.setting:read')({
  args: singletonArgs,
  returns: v.any(),
  handler: async (ctx) => {
    const row = one(await ctx.db.query('salesSettings').withIndex('by_key', (q) => q.eq('key', 'singleton')).unique(), '供应链设置')
    return { results: [salesRow(row)], pageInfo: { continueCursor: null, isDone: true } }
  },
})

export const getSales = permissionedQuery('sales.setting:read')({
  args: { id: v.id('salesSettings') },
  returns: v.any(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id)
    return row ? salesRow(row) : null
  },
})

export const updateSales = permissionedMutation('sales.setting:update')({
  args: {
    id: v.id('salesSettings'),
    sampleItemMaxQty: v.optional(v.number()),
    deliveryOvershipRatio: v.optional(v.string()),
    spotItemMaxQty: v.optional(v.number()),
    receiptOverreceiveRatio: v.optional(v.string()),
    demandOverorderRatio: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const row = one(await ctx.db.get(args.id), '供应链设置')
    const sampleItemMaxQty = args.sampleItemMaxQty ?? row.sampleItemMaxQty
    const spotItemMaxQty = args.spotItemMaxQty ?? row.spotItemMaxQty
    if (!Number.isSafeInteger(sampleItemMaxQty) || sampleItemMaxQty <= 0 || !Number.isSafeInteger(spotItemMaxQty) || spotItemMaxQty <= 0) {
      throw validationError('设置参数不合法', { sampleItemMaxQty: ['数量上限须为正整数'], spotItemMaxQty: ['数量上限须为正整数'] })
    }
    const before = salesRow(row)
    await ctx.db.patch(row._id, {
      sampleItemMaxQty,
      spotItemMaxQty,
      deliveryOvershipRatioScaled: args.deliveryOvershipRatio === undefined ? row.deliveryOvershipRatioScaled : ratio(args.deliveryOvershipRatio, 'deliveryOvershipRatio'),
      receiptOverreceiveRatioScaled: args.receiptOverreceiveRatio === undefined ? row.receiptOverreceiveRatioScaled : ratio(args.receiptOverreceiveRatio, 'receiptOverreceiveRatio'),
      demandOverorderRatioScaled: args.demandOverorderRatio === undefined ? row.demandOverorderRatioScaled : ratio(args.demandOverorderRatio, 'demandOverorderRatio'),
      updatedAt: Date.now(),
    })
    const after = salesRow(one(await ctx.db.get(row._id), '供应链设置'))
    const changes = changedFields(before, after)
    if (Object.keys(changes).length) await writeAudit(asDomainMutationCtx(ctx), ctx.actor, { resource: 'salSettings', recordId: row._id, recordLabel: '供应链设置', action: 'update', changes })
    return after
  },
})

function manufacturingRow(row: any) {
  return { id: row._id, outputOverreceiveRatio: scaledInt64ToDecimal(row.outputOverreceiveRatioScaled, 6), insertedAt: row.insertedAt, updatedAt: row.updatedAt }
}

export const listManufacturing = permissionedQuery('mfg.setting:read')({ args: singletonArgs, returns: v.any(), handler: async (ctx) => {
  const row = one(await ctx.db.query('manufacturingSettings').withIndex('by_key', (q) => q.eq('key', 'singleton')).unique(), '生产设置')
  return { results: [manufacturingRow(row)], pageInfo: { continueCursor: null, isDone: true } }
} })
export const getManufacturing = permissionedQuery('mfg.setting:read')({ args: { id: v.id('manufacturingSettings') }, returns: v.any(), handler: async (ctx, args) => { const row = await ctx.db.get(args.id); return row ? manufacturingRow(row) : null } })
export const updateManufacturing = permissionedMutation('mfg.setting:update')({ args: { id: v.id('manufacturingSettings'), outputOverreceiveRatio: v.optional(v.string()) }, returns: v.any(), handler: async (ctx, args) => {
  const row = one(await ctx.db.get(args.id), '生产设置'); const before = manufacturingRow(row)
  await ctx.db.patch(row._id, { outputOverreceiveRatioScaled: args.outputOverreceiveRatio === undefined ? row.outputOverreceiveRatioScaled : ratio(args.outputOverreceiveRatio, 'outputOverreceiveRatio'), updatedAt: Date.now() })
  const after = manufacturingRow(one(await ctx.db.get(row._id), '生产设置')); const changes = changedFields(before, after)
  if (Object.keys(changes).length) await writeAudit(asDomainMutationCtx(ctx), ctx.actor, { resource: 'mfgSettings', recordId: row._id, recordLabel: '生产设置', action: 'update', changes }); return after
} })

function accountingRow(row: any) { return { id: row._id, insertedAt: row.insertedAt, updatedAt: row.updatedAt } }
export const listAccounting = permissionedQuery('acc.setting:read')({ args: singletonArgs, returns: v.any(), handler: async (ctx) => { const row = one(await ctx.db.query('accountingSettings').withIndex('by_key', (q) => q.eq('key', 'singleton')).unique(), '财务设置'); return { results: [accountingRow(row)], pageInfo: { continueCursor: null, isDone: true } } } })
export const getAccounting = permissionedQuery('acc.setting:read')({ args: { id: v.id('accountingSettings') }, returns: v.any(), handler: async (ctx, args) => { const row = await ctx.db.get(args.id); return row ? accountingRow(row) : null } })
export const updateAccounting = permissionedMutation('acc.setting:update')({ args: { id: v.id('accountingSettings') }, returns: v.any(), handler: async (ctx, args) => {
  const row = one(await ctx.db.get(args.id), '财务设置')
  await ctx.db.patch(row._id, { updatedAt: Date.now() })
  return accountingRow(one(await ctx.db.get(row._id), '财务设置'))
} })

function systemRow(row: any) { return { id: row._id, marketFetchScheduleEnabled: row.marketFetchScheduleEnabled, marketFetchLastIntervalMinutes: row.marketFetchLastIntervalMinutes, marketFetchSettlementEnabled: row.marketFetchSettlementEnabled, marketFetchLastRunAt: row.marketFetchLastRunAt, marketFetchLastSummary: row.marketFetchLastSummary, insertedAt: row.insertedAt, updatedAt: row.updatedAt } }
export const listSystem = permissionedQuery('sys.setting:read')({ args: singletonArgs, returns: v.any(), handler: async (ctx) => { const row = one(await ctx.db.query('systemSettings').withIndex('by_key', (q) => q.eq('key', 'singleton')).unique(), '系统设置'); return { results: [systemRow(row)], pageInfo: { continueCursor: null, isDone: true } } } })
export const getSystem = permissionedQuery('sys.setting:read')({ args: { id: v.id('systemSettings') }, returns: v.any(), handler: async (ctx, args) => { const row = await ctx.db.get(args.id); return row ? systemRow(row) : null } })
export const updateSystem = permissionedMutation('sys.setting:update')({ args: { id: v.id('systemSettings'), marketFetchScheduleEnabled: v.optional(v.boolean()), marketFetchLastIntervalMinutes: v.optional(v.number()), marketFetchSettlementEnabled: v.optional(v.boolean()) }, returns: v.any(), handler: async (ctx, args) => {
  const row = one(await ctx.db.get(args.id), '系统设置'); const interval = args.marketFetchLastIntervalMinutes ?? row.marketFetchLastIntervalMinutes
  if (![30, 60, 120].includes(interval)) throw validationError('系统设置参数不合法', { marketFetchLastIntervalMinutes: ['仅允许 30、60 或 120'] })
  const before = systemRow(row); await ctx.db.patch(row._id, { marketFetchScheduleEnabled: args.marketFetchScheduleEnabled ?? row.marketFetchScheduleEnabled, marketFetchLastIntervalMinutes: interval, marketFetchSettlementEnabled: args.marketFetchSettlementEnabled ?? row.marketFetchSettlementEnabled, updatedAt: Date.now() }); const after = systemRow(one(await ctx.db.get(row._id), '系统设置')); const changes = changedFields(before, after)
  if (Object.keys(changes).length) await writeAudit(asDomainMutationCtx(ctx), ctx.actor, { resource: 'sysSettings', recordId: row._id, recordLabel: '系统设置', action: 'update', changes }); return after
} })
