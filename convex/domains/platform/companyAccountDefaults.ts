import { v } from 'convex/values'
import type { Doc, Id } from '../../_generated/dataModel'
import type { QueryCtx } from '../../_generated/server'
import type { Actor } from '../../lib/actor'
import type { DomainMutationCtx } from '../../lib/mutationContext'
import { permissionedMutation, permissionedQuery } from '../../lib/auth'
import { canAccessCompany } from '../../lib/companyScope'
import { asDomainMutationCtx } from '../../lib/mutationContext'
import { synieError, validationError } from '../../lib/errors'
import { paginationOptions, resourcePage } from '../../lib/pagination'
import { changedFields } from '../../platform/audit/model'
import { writeAudit } from '../../platform/audit/write'

function requireCompany(actor: Parameters<typeof canAccessCompany>[0], companyId: string) { if (!canAccessCompany(actor, companyId)) throw synieError('forbidden', '无权访问该公司') }
function present(row: Doc<'companyAccountDefaults'>) { return { id: row._id, companyId: row.companyId, deliveryDebitAccountId: row.deliveryDebitAccountId, deliveryCreditAccountId: row.deliveryCreditAccountId, receiptDebitAccountId: row.receiptDebitAccountId, receiptCreditAccountId: row.receiptCreditAccountId, insertedAt: row.insertedAt, updatedAt: row.updatedAt } }
async function validateAccounts(ctx: { db: any }, companyId: Id<'companies'>, values: Array<Id<'accounts'> | null>) {
  for (const id of values) { if (!id) continue; const account = await ctx.db.get(id) as Doc<'accounts'> | null; if (!account || account.companyId !== companyId || account.isGroup || !account.active) throw validationError('默认科目参数不合法', { accountId: ['科目须为同公司启用的明细科目'] }) }
}

export async function paginateCompanyAccountDefaults(
  db: QueryCtx['db'],
  actor: Actor,
  args: { numItems: number; cursor?: string | null; companyId?: Id<'companies'> },
) {
  const options = paginationOptions(args)
  if (args.companyId) {
    requireCompany(actor, args.companyId)
    const row = await db.query('companyAccountDefaults')
      .withIndex('by_company', q => q.eq('companyId', args.companyId!))
      .unique()
    return resourcePage({ page: row ? [present(row)] : [], continueCursor: '', isDone: true })
  }
  const companies = actor.superAdmin || actor.allCompanies ? null : new Set(actor.companyIds)
  const page = await db.query('companyAccountDefaults').withIndex('by_company').paginate(options)
  return resourcePage({
    ...page,
    page: page.page
      .filter(row => !companies || companies.has(String(row.companyId)))
      .map(present),
  })
}

export const list = permissionedQuery('sales.setting:read')({ args: { numItems: v.number(), cursor: v.optional(v.union(v.string(), v.null())), companyId: v.optional(v.id('companies')) }, returns: v.any(), handler: (ctx, args) =>
  paginateCompanyAccountDefaults(ctx.db, ctx.actor, args)
})
export const get = permissionedQuery('sales.setting:read')({ args: { id: v.id('companyAccountDefaults') }, returns: v.any(), handler: async (ctx, args) => { const row = await ctx.db.get(args.id); if (!row) return null; requireCompany(ctx.actor, row.companyId); return present(row) } })
export const byCompany = permissionedQuery('sales.setting:read')({ args: { companyId: v.id('companies') }, returns: v.any(), handler: async (ctx, args) => { requireCompany(ctx.actor, args.companyId); const row = await ctx.db.query('companyAccountDefaults').withIndex('by_company', q => q.eq('companyId', args.companyId)).unique(); return row ? present(row) : null } })
type DefaultsInput = { companyId: Id<'companies'>; deliveryDebitAccountId?: Id<'accounts'> | null; deliveryCreditAccountId?: Id<'accounts'> | null; receiptDebitAccountId?: Id<'accounts'> | null; receiptCreditAccountId?: Id<'accounts'> | null }

export async function createCompanyAccountDefaultsInMutation(ctx: DomainMutationCtx, actor: Actor, args: DefaultsInput) {
  requireCompany(actor, args.companyId); if (!(await ctx.db.get(args.companyId))) throw validationError('默认科目参数不合法', { companyId: ['公司不存在'] }); if (await ctx.db.query('companyAccountDefaults').withIndex('by_company', q => q.eq('companyId', args.companyId)).unique()) throw synieError('conflict', '该公司已有默认科目配置')
  const values = [args.deliveryDebitAccountId ?? null, args.deliveryCreditAccountId ?? null, args.receiptDebitAccountId ?? null, args.receiptCreditAccountId ?? null]; await validateAccounts(ctx, args.companyId, values); const now = Date.now(); const id = await ctx.db.insert('companyAccountDefaults', { companyId: args.companyId, deliveryDebitAccountId: values[0], deliveryCreditAccountId: values[1], receiptDebitAccountId: values[2], receiptCreditAccountId: values[3], insertedAt: now, updatedAt: now }); const row = (await ctx.db.get(id))!; await writeAudit(ctx, actor, { resource: 'salCompanyAccountDefaults', recordId: id, recordLabel: '公司默认科目', companyId: args.companyId, action: 'create', changes: present(row) }); return present(row)
}

export const create = permissionedMutation('sales.setting:update')({ args: { companyId: v.id('companies'), deliveryDebitAccountId: v.optional(v.union(v.id('accounts'), v.null())), deliveryCreditAccountId: v.optional(v.union(v.id('accounts'), v.null())), receiptDebitAccountId: v.optional(v.union(v.id('accounts'), v.null())), receiptCreditAccountId: v.optional(v.union(v.id('accounts'), v.null())) }, returns: v.any(), handler: (ctx, args) => createCompanyAccountDefaultsInMutation(asDomainMutationCtx(ctx), ctx.actor, args) })
export const update = permissionedMutation('sales.setting:update')({ args: { id: v.id('companyAccountDefaults'), deliveryDebitAccountId: v.optional(v.union(v.id('accounts'), v.null())), deliveryCreditAccountId: v.optional(v.union(v.id('accounts'), v.null())), receiptDebitAccountId: v.optional(v.union(v.id('accounts'), v.null())), receiptCreditAccountId: v.optional(v.union(v.id('accounts'), v.null())) }, returns: v.any(), handler: async (ctx, args) => {
  const row = await ctx.db.get(args.id); if (!row) throw synieError('not_found', '默认科目配置不存在'); requireCompany(ctx.actor, row.companyId); const next = { deliveryDebitAccountId: args.deliveryDebitAccountId === undefined ? row.deliveryDebitAccountId : args.deliveryDebitAccountId, deliveryCreditAccountId: args.deliveryCreditAccountId === undefined ? row.deliveryCreditAccountId : args.deliveryCreditAccountId, receiptDebitAccountId: args.receiptDebitAccountId === undefined ? row.receiptDebitAccountId : args.receiptDebitAccountId, receiptCreditAccountId: args.receiptCreditAccountId === undefined ? row.receiptCreditAccountId : args.receiptCreditAccountId }; await validateAccounts(ctx, row.companyId, Object.values(next)); const before = present(row); await ctx.db.patch(row._id, { ...next, updatedAt: Date.now() }); const after = present((await ctx.db.get(row._id))!); const changes = changedFields(before, after); if (Object.keys(changes).length) await writeAudit(asDomainMutationCtx(ctx), ctx.actor, { resource: 'salCompanyAccountDefaults', recordId: row._id, recordLabel: '公司默认科目', companyId: row.companyId, action: 'update', changes }); return after
} })
