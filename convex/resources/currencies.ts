import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import { permissionedMutation, permissionedQuery } from '../lib/auth'
import { synieError, validationError } from '../lib/errors'
import { paginationOptions, rejectSearch, requireSearchTerm, resourcePage } from '../lib/pagination'
import { normalizeCurrency } from './model'
import { asDomainMutationCtx } from '../lib/mutationContext'
import { changedFields } from '../platform/audit/model'
import { writeAudit } from '../platform/audit/write'

const currency = v.object({
  id: v.id('currencies'),
  name: v.string(),
  isoCode: v.string(),
  symbol: v.union(v.string(), v.null()),
  active: v.boolean(),
  insertedAt: v.number(),
  updatedAt: v.number(),
})

const page = v.object({
  results: v.array(currency),
  pageInfo: v.object({ continueCursor: v.union(v.string(), v.null()), isDone: v.boolean() }),
})

function present(row: Doc<'currencies'>) {
  return {
    id: row._id,
    name: row.name,
    isoCode: row.isoCode,
    symbol: row.symbol,
    active: row.active,
    insertedAt: row.insertedAt,
    updatedAt: row.updatedAt,
  }
}

function snapshot(row: ReturnType<typeof present>) {
  return { name: row.name, isoCode: row.isoCode, symbol: row.symbol, active: row.active }
}

export const get = permissionedQuery('base.currency:read')({
  args: { id: v.id('currencies') },
  returns: v.union(currency, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id)
    return row ? present(row) : null
  },
})

export const list = permissionedQuery('base.currency:read')({
  args: {
    profile: v.union(v.literal('default'), v.literal('lookup'), v.literal('search')),
    numItems: v.number(),
    cursor: v.optional(v.union(v.string(), v.null())),
    search: v.optional(v.string()),
    args: v.optional(v.object({ active: v.optional(v.boolean()) })),
  },
  returns: page,
  handler: async (ctx, args) => {
    const options = paginationOptions(args)
    if (args.profile === 'search') {
      if (args.args?.active !== undefined) {
        throw synieError('validation', 'search profile 不接受 active 参数')
      }
      const term = requireSearchTerm(args.search)
      const result = await ctx.db
        .query('currencies')
        .withSearchIndex('search_text', (query) => query.search('searchText', term))
        .paginate(options)
      return resourcePage({ ...result, page: result.page.map(present) })
    }

    rejectSearch(args.search)
    if (args.profile === 'lookup') {
      if (args.args?.active === undefined) {
        throw synieError('validation', 'lookup profile 需要 active 参数')
      }
      const result = await ctx.db
        .query('currencies')
        .withIndex('by_active_iso_code_key', (query) => query.eq('active', args.args!.active!))
        .order('asc')
        .paginate(options)
      return resourcePage({ ...result, page: result.page.map(present) })
    }
    if (args.args?.active !== undefined) {
      throw synieError('validation', 'default profile 不接受参数')
    }
    const result = await ctx.db
      .query('currencies')
      .withIndex('by_iso_code_key')
      .order('asc')
      .paginate(options)
    return resourcePage({ ...result, page: result.page.map(present) })
  },
})

export const create = permissionedMutation('base.currency:create')({
  args: {
    name: v.string(),
    isoCode: v.string(),
    symbol: v.optional(v.union(v.string(), v.null())),
    active: v.optional(v.boolean()),
  },
  returns: currency,
  handler: async (ctx, args) => {
    const normalized = normalizeCurrency(args)
    const existing = await ctx.db
      .query('currencies')
      .withIndex('by_iso_code_key', (query) => query.eq('isoCodeKey', normalized.isoCodeKey))
      .unique()
    if (existing) throw synieError('conflict', 'ISO 编码已存在')
    const now = Date.now()
    const id = await ctx.db.insert('currencies', {
      ...normalized,
      active: args.active ?? true,
      insertedAt: now,
      updatedAt: now,
    })
    const row = present((await ctx.db.get(id))!)
    await writeAudit(asDomainMutationCtx(ctx), ctx.actor, {
      resource: 'basCurrencies', recordId: id, recordLabel: row.name, action: 'create', changes: snapshot(row),
    })
    return row
  },
})

export const update = permissionedMutation('base.currency:update')({
  args: {
    id: v.id('currencies'),
    name: v.optional(v.string()),
    symbol: v.optional(v.union(v.string(), v.null())),
    active: v.optional(v.boolean()),
  },
  returns: currency,
  handler: async (ctx, args) => {
    const beforeDoc = await ctx.db.get(args.id)
    if (!beforeDoc) throw synieError('not_found', '货币不存在')
    const normalized = normalizeCurrency({
      name: args.name ?? beforeDoc.name,
      isoCode: beforeDoc.isoCode,
      symbol: args.symbol === undefined ? beforeDoc.symbol : args.symbol,
    })
    const active = args.active ?? beforeDoc.active
    if (beforeDoc.active && !active) {
      const company = await ctx.db
        .query('pilotCompanies')
        .withIndex('by_base_currency', (query) => query.eq('baseCurrencyId', beforeDoc._id))
        .first()
      if (company) {
        throw validationError('币种参数不合法', { active: ['已被公司引用为本币,不可停用'] })
      }
    }
    const before = present(beforeDoc)
    await ctx.db.patch(beforeDoc._id, { ...normalized, active, updatedAt: Date.now() })
    const after = present((await ctx.db.get(beforeDoc._id))!)
    const changes = changedFields(snapshot(before), snapshot(after))
    if (Object.keys(changes).length > 0) {
      await writeAudit(asDomainMutationCtx(ctx), ctx.actor, {
        resource: 'basCurrencies', recordId: beforeDoc._id, recordLabel: after.name, action: 'update', changes,
      })
    }
    return after
  },
})

export const remove = permissionedMutation('base.currency:delete')({
  args: { id: v.id('currencies') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id)
    if (!row) throw synieError('not_found', '货币不存在')
    const [company, account, witness] = await Promise.all([
      ctx.db.query('pilotCompanies').withIndex('by_base_currency', (q) => q.eq('baseCurrencyId', row._id)).first(),
      ctx.db.query('pilotAccounts').withIndex('by_currency', (q) => q.eq('currencyId', row._id)).first(),
      ctx.db.query('pilotResourceReferences').withIndex('by_target', (q) => q.eq('targetResource', 'basCurrencies').eq('targetId', row._id)).first(),
    ])
    if (company || account || witness) throw synieError('conflict', '货币已被业务数据引用,不可删除')
    const item = present(row)
    await ctx.db.delete(row._id)
    await writeAudit(asDomainMutationCtx(ctx), ctx.actor, {
      resource: 'basCurrencies', recordId: row._id, recordLabel: item.name, action: 'destroy', changes: snapshot(item),
    })
    return null
  },
})
