import { v } from 'convex/values'
import type { Doc, Id } from '../../_generated/dataModel'
import { permissionedMutation, permissionedQuery } from '../../lib/auth'
import { asDomainMutationCtx } from '../../lib/mutationContext'
import { synieError, validationError } from '../../lib/errors'
import { paginationOptions, requireSearchTerm, resourcePage } from '../../lib/pagination'
import { changedFields } from '../../platform/audit/model'
import { writeAudit } from '../../platform/audit/write'
import { seedDefaultWarehouses } from '../../resources/warehouseSeed'
import { canAccessCompany } from '../../lib/companyScope'

function key(value: string): string { return value.trim().toLocaleLowerCase() }
function present(row: Doc<'companies'>) {
  return {
    id: row._id, code: row.code, name: row.name, shortName: row.shortName,
    parentId: row.parentId, baseCurrencyId: row.baseCurrencyId,
    insertedAt: row.insertedAt, updatedAt: row.updatedAt,
  }
}
function snapshot(row: ReturnType<typeof present>) {
  return { code: row.code, name: row.name, shortName: row.shortName, parentId: row.parentId, baseCurrencyId: row.baseCurrencyId }
}
function text(value: string, field: string, max: number): string {
  const result = value.trim()
  if (!result || [...result].length > max) throw validationError('公司参数不合法', { [field]: [`必填且最多 ${max} 个字符`] })
  return result
}
function requireCompanyAccess(actor: Parameters<typeof canAccessCompany>[0], companyId: string): void {
  if (!canAccessCompany(actor, companyId)) throw synieError('not_found', '公司不存在')
}
async function validateCurrency(ctx: { db: any }, id: Id<'currencies'>) {
  const currency = await ctx.db.get(id)
  if (!currency?.active) throw validationError('公司参数不合法', { baseCurrencyId: ['币种不存在或已停用'] })
}
async function validateParent(ctx: { db: any }, selfId: Id<'companies'> | null, parentId: Id<'companies'> | null) {
  let cursor = parentId
  for (let depth = 0; cursor; depth += 1) {
    if (depth >= 100 || cursor === selfId) throw validationError('公司参数不合法', { parentId: ['上级公司形成循环'] })
    const parent = await ctx.db.get(cursor) as Doc<'companies'> | null
    if (!parent) throw validationError('公司参数不合法', { parentId: ['上级公司不存在'] })
    cursor = parent.parentId
  }
}

export const get = permissionedQuery('base.company:read')({
  args: { id: v.id('companies') }, returns: v.any(),
  handler: async (ctx, args) => { const row = await ctx.db.get(args.id); if (!row) return null; requireCompanyAccess(ctx.actor, row._id); return present(row) },
})
export const list = permissionedQuery('base.company:read')({
  args: { profile: v.union(v.literal('default'), v.literal('search')), numItems: v.number(), cursor: v.optional(v.union(v.string(), v.null())), search: v.optional(v.string()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (!ctx.actor.superAdmin && !ctx.actor.allCompanies) {
      const rows: Doc<'companies'>[] = []
      for (const id of ctx.actor.companyIds) {
        const row = await ctx.db.get(id as Id<'companies'>)
        if (row) rows.push(row)
      }
      rows.sort((a, b) => a.codeKey.localeCompare(b.codeKey))
      const search = args.profile === 'search' ? requireSearchTerm(args.search).toLocaleLowerCase() : null
      const filtered = search ? rows.filter(row => row.searchText.includes(search)) : rows
      const prefix = 'actor-offset:'
      const offset = args.cursor?.startsWith(prefix) ? Number(args.cursor.slice(prefix.length)) : 0
      if (!Number.isSafeInteger(offset) || offset < 0 || args.numItems < 1 || args.numItems > 100) throw synieError('validation', '公司分页参数不合法')
      const page = filtered.slice(offset, offset + args.numItems).map(present)
      const next = offset + page.length
      return { results: page, pageInfo: { continueCursor: next < filtered.length ? `${prefix}${next}` : null, isDone: next >= filtered.length } }
    }
    const options = paginationOptions(args)
    const page = args.profile === 'search'
      ? await ctx.db.query('companies').withSearchIndex('search_text', (q) => q.search('searchText', requireSearchTerm(args.search))).paginate(options)
      : await ctx.db.query('companies').withIndex('by_code_key').paginate(options)
    return resourcePage({ ...page, page: page.page.map(present) })
  },
})
export const create = permissionedMutation('base.company:create')({
  args: { code: v.string(), name: v.string(), shortName: v.string(), parentId: v.optional(v.union(v.id('companies'), v.null())), baseCurrencyId: v.id('currencies') },
  returns: v.any(),
  handler: async (ctx, args) => {
    const code = args.code.trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(code)) throw validationError('公司参数不合法', { code: ['必须为两个英文字母'] })
    const codeKey = key(code)
    if (await ctx.db.query('companies').withIndex('by_code_key', (q) => q.eq('codeKey', codeKey)).unique()) throw synieError('conflict', '公司编号已存在')
    await validateCurrency(ctx, args.baseCurrencyId)
    await validateParent(ctx, null, args.parentId ?? null)
    const now = Date.now()
    const id = await ctx.db.insert('companies', {
      code, codeKey, name: text(args.name, 'name', 128), shortName: text(args.shortName, 'shortName', 32),
      parentId: args.parentId ?? null, baseCurrencyId: args.baseCurrencyId,
      searchText: `${code} ${args.name} ${args.shortName}`.toLocaleLowerCase(), insertedAt: now, updatedAt: now,
    })
    const row = (await ctx.db.get(id))!
    await seedDefaultWarehouses(ctx, ctx.actor, row)
    await writeAudit(asDomainMutationCtx(ctx), ctx.actor, { resource: 'basCompanies', recordId: id, recordLabel: row.name, action: 'create', changes: snapshot(present(row)) })
    return present(row)
  },
})
export const update = permissionedMutation('base.company:update')({
  args: { id: v.id('companies'), name: v.optional(v.string()), shortName: v.optional(v.string()), parentId: v.optional(v.union(v.id('companies'), v.null())), baseCurrencyId: v.optional(v.id('currencies')) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id)
    if (!row) throw synieError('not_found', '公司不存在')
    requireCompanyAccess(ctx.actor, row._id)
    const before = present(row)
    const parentId = args.parentId === undefined ? row.parentId : args.parentId
    const baseCurrencyId = args.baseCurrencyId ?? row.baseCurrencyId
    await validateParent(ctx, row._id, parentId)
    await validateCurrency(ctx, baseCurrencyId)
    const name = args.name === undefined ? row.name : text(args.name, 'name', 128)
    const shortName = args.shortName === undefined ? row.shortName : text(args.shortName, 'shortName', 32)
    await ctx.db.patch(row._id, { name, shortName, parentId, baseCurrencyId, searchText: `${row.code} ${name} ${shortName}`.toLocaleLowerCase(), updatedAt: Date.now() })
    const after = present((await ctx.db.get(row._id))!)
    const changes = changedFields(snapshot(before), snapshot(after))
    if (Object.keys(changes).length) await writeAudit(asDomainMutationCtx(ctx), ctx.actor, { resource: 'basCompanies', recordId: row._id, recordLabel: after.name, action: 'update', changes })
    return after
  },
})
export const remove = permissionedMutation('base.company:delete')({
  args: { id: v.id('companies') }, returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id)
    if (!row) throw synieError('not_found', '公司不存在')
    requireCompanyAccess(ctx.actor, row._id)
    const [child, account, material, warehouse] = await Promise.all([
      ctx.db.query('companies').withIndex('by_parent', (q) => q.eq('parentId', row._id)).first(),
      ctx.db.query('accounts').withIndex('by_company_code_key', (q) => q.eq('companyId', row._id)).first(),
      null,
      ctx.db.query('warehouses').withIndex('by_company_name_key', (q) => q.eq('companyId', row._id)).first(),
    ])
    if (child || account || material || warehouse) throw synieError('conflict', '公司已被业务数据引用,不可删除')
    await ctx.db.delete(row._id)
    await writeAudit(asDomainMutationCtx(ctx), ctx.actor, { resource: 'basCompanies', recordId: row._id, recordLabel: row.name, action: 'destroy', changes: snapshot(present(row)) })
    return null
  },
})
