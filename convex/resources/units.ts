import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import { permissionedMutation, permissionedQuery } from '../lib/auth'
import { scaledInt64ToDecimal } from '../lib/decimal'
import { synieError } from '../lib/errors'
import { paginationOptions, rejectSearch, requireSearchTerm, resourcePage } from '../lib/pagination'
import { UNIT_TYPES, normalizeUnit, type UnitType } from './model'
import { asDomainMutationCtx } from '../lib/mutationContext'
import { changedFields } from '../platform/audit/model'
import { writeAudit } from '../platform/audit/write'

const unitType = v.union(
  v.literal('LENGTH'), v.literal('AREA'), v.literal('WEIGHT'), v.literal('QUANTITY'),
)
const unit = v.object({
  id: v.id('units'),
  unitType,
  isBase: v.boolean(),
  name: v.string(),
  symbol: v.string(),
  ratio: v.string(),
  insertedAt: v.number(),
  updatedAt: v.number(),
})
const page = v.object({
  results: v.array(unit),
  pageInfo: v.object({ continueCursor: v.union(v.string(), v.null()), isDone: v.boolean() }),
})

function present(row: Doc<'units'>) {
  return {
    id: row._id,
    unitType: row.unitType,
    isBase: row.isBase,
    name: row.name,
    symbol: row.symbol,
    ratio: scaledInt64ToDecimal(row.ratioScaled, 6),
    insertedAt: row.insertedAt,
    updatedAt: row.updatedAt,
  }
}

function snapshot(row: ReturnType<typeof present>) {
  return {
    unitType: row.unitType, isBase: row.isBase, name: row.name, symbol: row.symbol, ratio: row.ratio,
  }
}

function requireUnitType(value: UnitType | undefined): UnitType {
  if (!value || !UNIT_TYPES.includes(value)) throw synieError('validation', 'lookup profile 需要合法 unitType')
  return value
}

export const get = permissionedQuery('base.unit:read')({
  args: { id: v.id('units') },
  returns: v.union(unit, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id)
    return row ? present(row) : null
  },
})

export const list = permissionedQuery('base.unit:read')({
  args: {
    profile: v.union(v.literal('default'), v.literal('lookup'), v.literal('search')),
    numItems: v.number(),
    cursor: v.optional(v.union(v.string(), v.null())),
    search: v.optional(v.string()),
    args: v.optional(v.object({ unitType: v.optional(unitType) })),
  },
  returns: page,
  handler: async (ctx, args) => {
    const options = paginationOptions(args)
    if (args.profile === 'search') {
      if (args.args?.unitType !== undefined) throw synieError('validation', 'search profile 不接受参数')
      const result = await ctx.db
        .query('units')
        .withSearchIndex('search_text', (query) => query.search('searchText', requireSearchTerm(args.search)))
        .paginate(options)
      return resourcePage({ ...result, page: result.page.map(present) })
    }
    rejectSearch(args.search)
    if (args.profile === 'lookup') {
      const requestedType = requireUnitType(args.args?.unitType)
      const result = await ctx.db
        .query('units')
        .withIndex('by_type_name_key', (query) => query.eq('unitType', requestedType))
        .order('asc')
        .paginate(options)
      return resourcePage({ ...result, page: result.page.map(present) })
    }
    if (args.args?.unitType !== undefined) throw synieError('validation', 'default profile 不接受参数')
    const result = await ctx.db.query('units').withIndex('by_name_key').order('asc').paginate(options)
    return resourcePage({ ...result, page: result.page.map(present) })
  },
})

export const create = permissionedMutation('base.unit:create')({
  args: {
    unitType,
    isBase: v.optional(v.boolean()),
    name: v.string(),
    symbol: v.string(),
    ratio: v.string(),
  },
  returns: unit,
  handler: async (ctx, args) => {
    const normalized = normalizeUnit({ ...args, isBase: args.isBase ?? false })
    const symbol = await ctx.db
      .query('units')
      .withIndex('by_symbol_key', (query) => query.eq('symbolKey', normalized.symbolKey))
      .unique()
    if (symbol) throw synieError('conflict', '单位符号已存在')
    if (normalized.isBase) {
      const base = await ctx.db
        .query('units')
        .withIndex('by_type_base', (query) => query.eq('unitType', normalized.unitType).eq('isBase', true))
        .unique()
      if (base) throw synieError('conflict', '该类型已存在基准单位')
    }
    const now = Date.now()
    const id = await ctx.db.insert('units', { ...normalized, insertedAt: now, updatedAt: now })
    const row = present((await ctx.db.get(id))!)
    await writeAudit(asDomainMutationCtx(ctx), ctx.actor, {
      resource: 'basUnits', recordId: id, recordLabel: row.name, action: 'create', changes: snapshot(row),
    })
    return row
  },
})

export const update = permissionedMutation('base.unit:update')({
  args: {
    id: v.id('units'),
    unitType: v.optional(unitType),
    isBase: v.optional(v.boolean()),
    name: v.optional(v.string()),
    symbol: v.optional(v.string()),
    ratio: v.optional(v.string()),
  },
  returns: unit,
  handler: async (ctx, args) => {
    const beforeDoc = await ctx.db.get(args.id)
    if (!beforeDoc) throw synieError('not_found', '计量单位不存在')
    const normalized = normalizeUnit({
      unitType: args.unitType ?? beforeDoc.unitType,
      isBase: args.isBase ?? beforeDoc.isBase,
      name: args.name ?? beforeDoc.name,
      symbol: args.symbol ?? beforeDoc.symbol,
      ratio: args.ratio ?? scaledInt64ToDecimal(beforeDoc.ratioScaled, 6),
    })
    const sameSymbol = await ctx.db
      .query('units')
      .withIndex('by_symbol_key', (query) => query.eq('symbolKey', normalized.symbolKey))
      .unique()
    if (sameSymbol && sameSymbol._id !== beforeDoc._id) throw synieError('conflict', '单位符号已存在')
    if (normalized.isBase) {
      const base = await ctx.db
        .query('units')
        .withIndex('by_type_base', (query) => query.eq('unitType', normalized.unitType).eq('isBase', true))
        .unique()
      if (base && base._id !== beforeDoc._id) throw synieError('conflict', '该类型已存在基准单位')
    }
    const before = present(beforeDoc)
    await ctx.db.patch(beforeDoc._id, { ...normalized, updatedAt: Date.now() })
    const after = present((await ctx.db.get(beforeDoc._id))!)
    const changes = changedFields(snapshot(before), snapshot(after))
    if (Object.keys(changes).length > 0) {
      await writeAudit(asDomainMutationCtx(ctx), ctx.actor, {
        resource: 'basUnits', recordId: beforeDoc._id, recordLabel: after.name, action: 'update', changes,
      })
    }
    return after
  },
})

export const remove = permissionedMutation('base.unit:delete')({
  args: { id: v.id('units') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id)
    if (!row) throw synieError('not_found', '计量单位不存在')
    const witness = await ctx.db
      .query('pilotResourceReferences')
      .withIndex('by_target', (query) => query.eq('targetResource', 'basUnits').eq('targetId', row._id))
      .first()
    if (witness) throw synieError('conflict', '计量单位已被业务数据引用,不可删除')
    const item = present(row)
    await ctx.db.delete(row._id)
    await writeAudit(asDomainMutationCtx(ctx), ctx.actor, {
      resource: 'basUnits', recordId: row._id, recordLabel: item.name, action: 'destroy', changes: snapshot(item),
    })
    return null
  },
})
