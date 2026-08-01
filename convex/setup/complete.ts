import { v } from 'convex/values'
import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import type { DataModel } from '../_generated/dataModel'
import type { Actor } from '../lib/actor'
import { authedMutation, authedQuery } from '../lib/auth'
import { asDomainMutationCtx } from '../lib/mutationContext'
import { synieError, validationError } from '../lib/errors'
import { createCompanyInMutation } from '../domains/base/companies'
import { initializeAccountTemplateInMutation } from '../domains/base/accounts'
import { seedSettings } from '../domains/platform/settingsSeed'
import { seedDefaultNumberingRules } from '../platform/numbering/defaults'
import {
  activateSetupCurrency,
  seedBuiltinRoles,
  seedMaterialCategories,
  seedSetupUnits,
} from './seeds'

function requireLanguage(value: string): 'zh-CN' | 'en-US' {
  if (value !== 'zh-CN' && value !== 'en-US') {
    throw validationError('完成初始化参数不合法', {
      preferredLanguage: ['仅支持 zh-CN 或 en-US'],
    })
  }
  return value
}

type SetupReadCtx = Pick<GenericQueryCtx<DataModel>, 'db'> & { actor: Actor }
type SetupMutationCtx = GenericMutationCtx<DataModel> & { actor: Actor }

async function requireOwner(ctx: SetupReadCtx) {
  const state = await ctx.db.query('setupState').withIndex('by_key', (query) =>
    query.eq('key', 'singleton'),
  ).unique()
  if (!state) throw synieError('conflict', '请先创建首个管理员')
  if (state.firstAdminUserId !== ctx.actor.userId) {
    throw synieError('forbidden', '只有首位超级管理员可完成初始化')
  }
  return state
}

export const options = authedQuery({
  args: {},
  returns: v.object({
    currencies: v.array(v.object({
      id: v.id('currencies'),
      name: v.string(),
      isoCode: v.string(),
      symbol: v.union(v.string(), v.null()),
    })),
    accountTemplates: v.array(v.object({ code: v.string(), name: v.string() })),
    resumeSample: v.boolean(),
    existingCompanyName: v.union(v.string(), v.null()),
  }),
  handler: async (ctx) => {
    const currencies = await ctx.db.query('currencies').withIndex('by_iso_code_key').collect()
    const state = await requireOwner(ctx)
    const company = state.firstCompanyId ? await ctx.db.get(state.firstCompanyId) : null
    return {
      currencies: currencies.map((row) => ({
        id: row._id,
        name: row.name,
        isoCode: row.isoCode,
        symbol: row.symbol,
      })),
      accountTemplates: [
        { code: 'CAS', name: '企业会计准则' },
        { code: 'SMALL', name: '小企业会计准则' },
        { code: 'INTL', name: '国际通用精简' },
      ],
      resumeSample: state.sampleRequested === true && state.completedAt === undefined,
      existingCompanyName: company?.name ?? null,
    }
  },
})

export const complete = authedMutation({
  args: {
    company: v.object({
      code: v.string(),
      name: v.string(),
      shortName: v.string(),
      baseCurrencyId: v.id('currencies'),
      accountTemplate: v.union(v.literal('CAS'), v.literal('SMALL'), v.literal('INTL')),
    }),
    preferredLanguage: v.string(),
    seedSampleData: v.boolean(),
  },
  returns: v.object({
    companyId: v.id('companies'),
    accounts: v.number(),
    units: v.number(),
    categories: v.number(),
    rolePermissions: v.number(),
    sampleRequired: v.boolean(),
  }),
  handler: async (rawCtx, args) => {
    const setupCtx: SetupMutationCtx = rawCtx
    const state = await requireOwner(setupCtx)
    if (state.completedAt !== undefined) throw synieError('conflict', '系统已完成初始化')
    if (state.firstCompanyId) throw synieError('conflict', '业务底座已建立，请继续生成示例数据')
    const language = requireLanguage(args.preferredLanguage)
    if (await rawCtx.db.query('companies').first()) {
      throw synieError('conflict', '初始化完成前已存在公司，请根据恢复记录排查')
    }

    const ctx = asDomainMutationCtx(rawCtx)
    await activateSetupCurrency(ctx, args.company.baseCurrencyId)
    const company = await createCompanyInMutation(ctx, rawCtx.actor, {
      code: args.company.code,
      name: args.company.name,
      shortName: args.company.shortName,
      baseCurrencyId: args.company.baseCurrencyId,
    })
    const accountResult = await initializeAccountTemplateInMutation(ctx, rawCtx.actor, {
      companyId: company.id,
      template: args.company.accountTemplate,
    })
    const units = await seedSetupUnits(ctx)
    const categories = await seedMaterialCategories(ctx)
    const rolePermissions = await seedBuiltinRoles(ctx)
    await seedSettings(ctx)
    await seedDefaultNumberingRules(ctx)
    const now = Date.now()
    await rawCtx.db.patch(rawCtx.actor.userId, { preferredLanguage: language, updatedAt: now })
    await rawCtx.db.patch(state._id, {
      firstCompanyId: company.id,
      sampleRequested: args.seedSampleData,
      ...(args.seedSampleData
        ? { sampleStage: 'master', sampleData: { companyId: company.id } }
        : { completedAt: now }),
    })
    return {
      companyId: company.id,
      accounts: accountResult.createdCount,
      units,
      categories,
      rolePermissions,
      sampleRequired: args.seedSampleData,
    }
  },
})
