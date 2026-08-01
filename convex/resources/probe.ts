import { v } from 'convex/values'
import { mutation, query } from '../_generated/server'
import type { MutationCtx } from '../_generated/server'
import type { Actor } from '../lib/actor'
import { synieError } from '../lib/errors'
import { normalizedKey } from './model'
import { seedDefaultWarehouses } from './warehouseSeed'

declare const process: { env: Record<string, string | undefined> }

function equalSecret(candidate: string, expected: string): boolean {
  const left = new TextEncoder().encode(candidate)
  const right = new TextEncoder().encode(expected)
  const length = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

function requireProbeSecret(candidate: string): void {
  const expected = process.env.SYNIE_RESOURCE_SPIKE_SECRET
  if (!expected || !equalSecret(candidate, expected)) {
    throw synieError('forbidden', '资源迁移测试入口不可用')
  }
}

async function actorForUsername(ctx: MutationCtx, username: string): Promise<Actor> {
  const appUser = await ctx.db
    .query('appUsers')
    .withIndex('by_username_key', (index) => index.eq('usernameKey', normalizedKey(username)))
    .unique()
  if (!appUser) throw synieError('not_found', '测试用户不存在')
  return {
    userId: appUser._id,
    username: appUser.username,
    name: appUser.name,
    superAdmin: appUser.superAdmin,
    allCompanies: appUser.allCompanies,
    permissions: new Set(),
    companyIds: [],
  }
}

export const prepare = mutation({
  args: { spikeSecret: v.string(), adminUsername: v.string(), companyCode: v.string() },
  returns: v.object({
    companyId: v.id('pilotCompanies'),
    accountId: v.id('pilotAccounts'),
    supplierId: v.id('pilotSuppliers'),
  }),
  handler: async (ctx, args) => {
    requireProbeSecret(args.spikeSecret)
    const actor = await actorForUsername(ctx, args.adminUsername)
    const code = args.companyCode.trim().toUpperCase()
    if (!/^[A-Z0-9]{2,12}$/.test(code)) throw synieError('validation', '测试公司编号不合法')
    const codeKey = normalizedKey(code)
    let company = await ctx.db
      .query('pilotCompanies')
      .withIndex('by_code_key', (index) => index.eq('codeKey', codeKey))
      .unique()
    if (!company) {
      const id = await ctx.db.insert('pilotCompanies', {
        code,
        codeKey,
        name: `${code} 测试公司`,
        baseCurrencyId: null,
      })
      company = (await ctx.db.get(id))!
    }
    let account = await ctx.db
      .query('pilotAccounts')
      .withIndex('by_company_code', (index) => index.eq('companyId', company!._id).eq('code', '1405'))
      .unique()
    if (!account) {
      const id = await ctx.db.insert('pilotAccounts', {
        companyId: company._id,
        code: '1405',
        name: '库存商品',
        isGroup: false,
        active: true,
        role: null,
        currencyId: null,
      })
      account = (await ctx.db.get(id))!
    }
    const supplierKey = normalizedKey(`${code} 测试供应商`)
    let supplier = await ctx.db
      .query('pilotSuppliers')
      .withIndex('by_name_key', (index) => index.eq('nameKey', supplierKey))
      .unique()
    if (!supplier) {
      const id = await ctx.db.insert('pilotSuppliers', {
        name: `${code} 测试供应商`,
        nameKey: supplierKey,
        enabled: true,
      })
      supplier = (await ctx.db.get(id))!
    }
    const assignment = await ctx.db
      .query('iamUserCompanies')
      .withIndex('by_user_company', (index) => index.eq('userId', actor.userId).eq('companyId', company!._id))
      .unique()
    if (!assignment) await ctx.db.insert('iamUserCompanies', { userId: actor.userId, companyId: company._id })
    return { companyId: company._id, accountId: account._id, supplierId: supplier._id }
  },
})

export const seedWithFault = mutation({
  args: {
    spikeSecret: v.string(),
    adminUsername: v.string(),
    companyId: v.id('pilotCompanies'),
    fault: v.union(v.literal('after_root'), v.literal('after_first_leaf')),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireProbeSecret(args.spikeSecret)
    const [actor, company] = await Promise.all([
      actorForUsername(ctx, args.adminUsername),
      ctx.db.get(args.companyId),
    ])
    if (!company) throw synieError('not_found', '测试公司不存在')
    await seedDefaultWarehouses(ctx, actor, company, args.fault)
    return null
  },
})

export const inspectCompany = query({
  args: { spikeSecret: v.string(), companyId: v.id('pilotCompanies') },
  returns: v.object({ warehouseCount: v.number(), auditCount: v.number() }),
  handler: async (ctx, args) => {
    requireProbeSecret(args.spikeSecret)
    const warehouses = await ctx.db
      .query('warehouses')
      .withIndex('by_company_name_key', (index) => index.eq('companyId', args.companyId))
      .take(10)
    let auditCount = 0
    for (const row of warehouses) {
      auditCount += (
        await ctx.db
          .query('auditLogs')
          .withIndex('by_resource_record', (index) =>
            index.eq('resource', 'invWarehouses').eq('recordId', row._id),
          )
          .take(10)
      ).length
    }
    return { warehouseCount: warehouses.length, auditCount }
  },
})

export const addReference = mutation({
  args: {
    spikeSecret: v.string(),
    targetResource: v.union(v.literal('basCurrencies'), v.literal('basUnits'), v.literal('invWarehouses')),
    targetId: v.string(),
    sourceLabel: v.string(),
  },
  returns: v.id('pilotResourceReferences'),
  handler: async (ctx, args) => {
    requireProbeSecret(args.spikeSecret)
    return ctx.db.insert('pilotResourceReferences', {
      targetResource: args.targetResource,
      targetId: args.targetId,
      sourceLabel: args.sourceLabel.trim() || 'probe',
    })
  },
})
