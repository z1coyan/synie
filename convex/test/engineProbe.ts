import { v } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import { mutation, query } from '../_generated/server'
import type { MutationCtx } from '../_generated/server'
import type { Actor } from '../lib/actor'
import { asDomainMutationCtx } from '../lib/mutationContext'
import { synieError } from '../lib/errors'
import { activeGenerationInQuery } from '../engines/generation'
import { cancelInventoryInMutation, postInventoryInMutation } from '../engines/inventory/engine'
import { inventoryAsOf, readCurrent, applyInventoryDelta } from '../engines/inventory/projections'
import { cancelGlInMutation, postGlInMutation, reverseGlInMutation } from '../engines/gl/engine'
import { postDocumentInMutation } from '../engines/posting/orchestrator'
import {
  activateVerifiedGeneration,
  applyInventoryRebuildChunk,
  startProjectionRebuild,
} from '../engines/reconciliation/rebuild'
import { createNumberingRuleInMutation, nextInMutation } from '../platform/numbering/service'

declare const process: { env: Record<string, string | undefined> }

function equalSecret(candidate: string, expected: string): boolean {
  const left = new TextEncoder().encode(candidate)
  const right = new TextEncoder().encode(expected)
  const length = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return difference === 0
}

function requireSecret(candidate: string): void {
  const expected = process.env.SYNIE_ENGINE_SPIKE_SECRET
  if (!expected || !equalSecret(candidate, expected)) throw synieError('forbidden', '事实引擎测试入口不可用')
}

async function ensureActor(ctx: MutationCtx): Promise<Actor> {
  let user = await ctx.db.query('appUsers').withIndex('by_username_key', (q) => q.eq('usernameKey', 'engine-probe')).unique()
  if (!user) {
    const id = await ctx.db.insert('appUsers', {
      authUserId: `engine-probe-${crypto.randomUUID()}`,
      usernameKey: 'engine-probe',
      username: 'engine-probe',
      name: '事实引擎验收',
      enabled: true,
      superAdmin: true,
      allCompanies: true,
    })
    user = (await ctx.db.get(id))!
  }
  return {
    userId: user._id,
    username: user.username,
    name: user.name,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  }
}

const fixture = v.object({
  actorUserId: v.id('appUsers'),
  companyId: v.id('companies'),
  otherCompanyId: v.id('companies'),
  warehouseId: v.id('warehouses'),
  secondWarehouseId: v.id('warehouses'),
  allowNegativeWarehouseId: v.id('warehouses'),
  materialId: v.id('materials'),
  secondMaterialId: v.id('materials'),
  debitAccountId: v.id('accounts'),
  creditAccountId: v.id('accounts'),
  partyAccountId: v.id('accounts'),
})

async function insertWarehouse(ctx: MutationCtx, companyId: string, name: string, allowNegative: boolean) {
  return ctx.db.insert('warehouses', {
    name,
    nameKey: name.toLowerCase(),
    isLeaf: true,
    active: true,
    isOutsourced: false,
    partyType: null,
    partyId: null,
    allowNegative,
    companyId,
    parentId: null,
    accountId: null,
    searchText: name.toLowerCase(),
    insertedAt: Date.now(),
    updatedAt: Date.now(),
  })
}

async function insertAccount(ctx: MutationCtx, companyId: string, code: string, role: string | null = null) {
  return ctx.db.insert('accounts', {
    companyId: companyId as Id<'companies'>,
    code,
    codeKey: code.toLowerCase(),
    name: `科目 ${code}`,
    direction: 'DEBIT',
    isGroup: false,
    active: true,
    role,
    parentId: null,
    currencyId: null,
    searchText: `${code} 科目 ${code}`.toLowerCase(),
    insertedAt: Date.now(),
    updatedAt: Date.now(),
  })
}

export const prepare = mutation({
  args: { spikeSecret: v.string(), marker: v.string() },
  returns: fixture,
  handler: async (ctx, args) => {
    requireSecret(args.spikeSecret)
    const actor = await ensureActor(ctx)
    const code = `E${args.marker.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}`.toUpperCase()
    const currencyId = await ctx.db.insert('currencies', {
      name: `${code} 币种`, nameKey: `${code} 币种`.toLowerCase(), isoCode: 'TST', isoCodeKey: `tst-${args.marker}`,
      symbol: null, active: true, searchText: `${code} 币种 tst`.toLowerCase(), insertedAt: Date.now(), updatedAt: Date.now(),
    })
    const companyId = await ctx.db.insert('companies', {
      code, codeKey: code.toLowerCase(), name: `${code} 公司`, shortName: code, parentId: null,
      baseCurrencyId: currencyId, searchText: `${code} 公司`.toLowerCase(), insertedAt: Date.now(), updatedAt: Date.now(),
    })
    const otherCode = `${code}X`
    const otherCompanyId = await ctx.db.insert('companies', {
      code: otherCode, codeKey: otherCode.toLowerCase(), name: `${otherCode} 公司`, shortName: otherCode, parentId: null,
      baseCurrencyId: currencyId, searchText: `${otherCode} 公司`.toLowerCase(), insertedAt: Date.now(), updatedAt: Date.now(),
    })
    const [warehouseId, secondWarehouseId, allowNegativeWarehouseId] = await Promise.all([
      insertWarehouse(ctx, companyId, `${code} 主仓`, false),
      insertWarehouse(ctx, companyId, `${code} 次仓`, false),
      insertWarehouse(ctx, companyId, `${code} 负库存仓`, true),
    ])
    const unitId = await ctx.db.insert('units', {
      unitType: 'QUANTITY', isBase: true, name: `${code} 件`, nameKey: `${code} 件`.toLowerCase(),
      symbol: `pc-${args.marker}`, symbolKey: `pc-${args.marker}`.toLowerCase(), ratioScaled: 1_000_000n,
      searchText: `${code} 件 pc`.toLowerCase(), insertedAt: Date.now(), updatedAt: Date.now(),
    })
    const categoryId = await ctx.db.insert('materialCategories', {
      code: `C-${args.marker}`, codeKey: `c-${args.marker}`.toLowerCase(), name: `${code} 分类`,
      isLeaf: true, active: true, parentId: null, searchText: `${code} 分类`.toLowerCase(),
      insertedAt: Date.now(), updatedAt: Date.now(),
    })
    const [materialId, secondMaterialId] = await Promise.all([
      ctx.db.insert('materials', {
        code: 'M1', codeKey: `m1-${args.marker}`, name: '物料 1', spec: null, customerPartNo: null,
        isCustomerMaterial: false, active: true, categoryId, defaultUnitId: unitId,
        customerId: null, searchText: 'm1 物料 1', insertedAt: Date.now(), updatedAt: Date.now(),
      }),
      ctx.db.insert('materials', {
        code: 'M2', codeKey: `m2-${args.marker}`, name: '物料 2', spec: null, customerPartNo: null,
        isCustomerMaterial: false, active: true, categoryId, defaultUnitId: unitId,
        customerId: null, searchText: 'm2 物料 2', insertedAt: Date.now(), updatedAt: Date.now(),
      }),
    ])
    const [debitAccountId, creditAccountId, partyAccountId] = await Promise.all([
      insertAccount(ctx, companyId, '1405'),
      insertAccount(ctx, companyId, '1001'),
      insertAccount(ctx, companyId, '1122', 'receivable'),
    ])
    await createNumberingRuleInMutation(asDomainMutationCtx(ctx), {
      resource: 'engine.document',
      name: '事实引擎验收规则',
      perCompany: true,
      segments: [
        { kind: 'text', value: 'EN' },
        { kind: 'field', field: 'posting_date', format: 'YYYYMM' },
        { kind: 'sequence', padding: 4 },
      ],
    })
    return {
      actorUserId: actor.userId,
      companyId,
      otherCompanyId,
      warehouseId,
      secondWarehouseId,
      allowNegativeWarehouseId,
      materialId,
      secondMaterialId,
      debitAccountId,
      creditAccountId,
      partyAccountId,
    }
  },
})

export const takeNumber = mutation({
  args: { spikeSecret: v.string(), companyId: v.id('companies'), marker: v.string(), failAfterNumber: v.boolean() },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireSecret(args.spikeSecret)
    const number = await nextInMutation(asDomainMutationCtx(ctx), 'engine.document', {
      company_id: args.companyId,
      posting_date: '2026-07-31',
    })
    if (args.failAfterNumber) throw synieError('validation', '取号后业务校验故障注入')
    await ctx.db.insert('enginePostingHeads', {
      companyId: args.companyId,
      voucherType: 'engine.number',
      voucherId: args.marker,
      voucherNo: number,
      state: 'draft',
      auditedBy: null,
      auditedAt: null,
    })
    return number
  },
})

export const inventoryPost = mutation({
  args: {
    spikeSecret: v.string(),
    voucherId: v.string(),
    companyId: v.id('companies'),
    warehouseId: v.id('warehouses'),
    materialId: v.id('materials'),
    quantity: v.string(),
    direction: v.union(v.literal('in'), v.literal('out')),
    postingDate: v.optional(v.string()),
  },
  returns: v.number(),
  handler: (ctx, args) => {
    requireSecret(args.spikeSecret)
    return postInventoryInMutation(asDomainMutationCtx(ctx), {
      type: 'inv.stock_doc', id: args.voucherId, no: args.voucherId, companyId: args.companyId,
      postingDate: args.postingDate ?? '2026-07-31',
    }, [{ warehouseId: args.warehouseId, materialId: args.materialId, quantity: args.quantity, direction: args.direction }])
  },
})

export const inventoryCancel = mutation({
  args: { spikeSecret: v.string(), voucherId: v.string() },
  returns: v.number(),
  handler: (ctx, args) => {
    requireSecret(args.spikeSecret)
    return cancelInventoryInMutation(asDomainMutationCtx(ctx), 'inv.stock_doc', args.voucherId)
  },
})

export const glPost = mutation({
  args: {
    spikeSecret: v.string(), voucherId: v.string(), companyId: v.id('companies'),
    debitAccountId: v.id('accounts'), creditAccountId: v.id('accounts'), amount: v.string(),
    partyType: v.optional(v.string()), partyId: v.optional(v.string()),
  },
  returns: v.number(),
  handler: (ctx, args) => {
    requireSecret(args.spikeSecret)
    return postGlInMutation(asDomainMutationCtx(ctx), {
      type: 'gl.voucher', id: args.voucherId, no: args.voucherId, companyId: args.companyId, postingDate: '2026-07-31',
    }, [
      { accountId: args.debitAccountId, debit: args.amount, partyType: args.partyType, partyId: args.partyId },
      { accountId: args.creditAccountId, credit: args.amount },
    ])
  },
})

export const glReverse = mutation({
  args: { spikeSecret: v.string(), voucherId: v.string() },
  returns: v.number(),
  handler: (ctx, args) => {
    requireSecret(args.spikeSecret)
    return reverseGlInMutation(asDomainMutationCtx(ctx), 'gl.voucher', args.voucherId)
  },
})

export const glCancel = mutation({
  args: { spikeSecret: v.string(), voucherId: v.string() },
  returns: v.number(),
  handler: (ctx, args) => {
    requireSecret(args.spikeSecret)
    return cancelGlInMutation(asDomainMutationCtx(ctx), 'gl.voucher', args.voucherId)
  },
})

const fault = v.union(
  v.literal('after_validate'),
  v.literal('after_controlled_projection'),
  v.literal('after_inventory'),
  v.literal('after_gl'),
  v.literal('after_head'),
  v.literal('after_audit'),
)

export const postWithFault = mutation({
  args: {
    spikeSecret: v.string(), marker: v.string(), actorUserId: v.id('appUsers'), companyId: v.id('companies'),
    warehouseId: v.id('warehouses'), materialId: v.id('materials'), debitAccountId: v.id('accounts'),
    creditAccountId: v.id('accounts'), faultAfter: v.optional(fault),
  },
  returns: v.id('enginePostingHeads'),
  handler: async (ctx, args) => {
    requireSecret(args.spikeSecret)
    const actorRow = await ctx.db.get(args.actorUserId)
    if (!actorRow) throw synieError('not_found', '测试 Actor 不存在')
    const actor: Actor = {
      userId: actorRow._id, username: actorRow.username, name: actorRow.name, superAdmin: true,
      allCompanies: true, permissions: new Set(), companyIds: [],
    }
    const headId = await ctx.db.insert('enginePostingHeads', {
      companyId: args.companyId, voucherType: 'engine.posting', voucherId: args.marker, voucherNo: args.marker,
      state: 'draft', auditedBy: null, auditedAt: null,
    })
    const domainCtx = asDomainMutationCtx(ctx)
    await postDocumentInMutation(domainCtx, {
      actor,
      stock: {
        voucher: { type: 'engine.posting', id: args.marker, no: args.marker, companyId: args.companyId, postingDate: '2026-07-31' },
        lines: [{ warehouseId: args.warehouseId, materialId: args.materialId, quantity: '1', direction: 'in' }],
      },
      gl: {
        voucher: { type: 'engine.posting', id: args.marker, no: args.marker, companyId: args.companyId, postingDate: '2026-07-31' },
        lines: [{ accountId: args.debitAccountId, debit: '1' }, { accountId: args.creditAccountId, credit: '1' }],
      },
      validate: async () => {},
      applyControlledProjections: async () => {},
      updateHead: async (innerCtx) => innerCtx.db.patch(headId, { state: 'audited', auditedBy: actor.userId, auditedAt: Date.now() }),
      audit: {
        resource: 'engine.posting', recordId: headId, recordLabel: args.marker, companyId: args.companyId,
        action: 'audit', changes: { state: 'audited', nested: { password: 'must-not-leak', capabilityToken: 'must-not-leak' } },
      },
      faultAfter: args.faultAfter,
    })
    return headId
  },
})

export const inspectPosting = query({
  args: { spikeSecret: v.string(), marker: v.string() },
  returns: v.object({ heads: v.number(), stock: v.number(), gl: v.number(), audits: v.number(), secretLeak: v.boolean() }),
  handler: async (ctx, args) => {
    requireSecret(args.spikeSecret)
    const [heads, stock, gl, audits] = await Promise.all([
      ctx.db.query('enginePostingHeads').withIndex('by_voucher', (q) => q.eq('voucherType', 'engine.posting').eq('voucherId', args.marker)).take(10),
      ctx.db.query('stockEntries').withIndex('by_voucher', (q) => q.eq('voucherType', 'engine.posting').eq('voucherId', args.marker)).take(10),
      ctx.db.query('glEntries').withIndex('by_voucher', (q) => q.eq('voucherType', 'engine.posting').eq('voucherId', args.marker)).take(10),
      ctx.db.query('auditLogs').withIndex('by_resource_record', (q) => q.eq('resource', 'engine.posting')).take(100),
    ])
    const owned = audits.filter((row) => row.recordLabel === args.marker)
    return {
      heads: heads.length,
      stock: stock.length,
      gl: gl.length,
      audits: owned.length,
      secretLeak: JSON.stringify(owned.map((row) => row.changes)).includes('must-not-leak'),
    }
  },
})

export const inspectInventory = query({
  args: { spikeSecret: v.string(), companyId: v.id('companies'), warehouseId: v.id('warehouses'), materialId: v.id('materials'), asOf: v.optional(v.string()) },
  returns: v.object({ generation: v.number(), current: v.int64(), factSum: v.int64(), mismatch: v.boolean(), asOf: v.int64(), scannedBuckets: v.number() }),
  handler: async (ctx, args) => {
    requireSecret(args.spikeSecret)
    const generation = await activeGenerationInQuery(ctx, 'inventory')
    const current = await ctx.db.query('inventoryCurrentBalances').withIndex('by_key', (q) =>
      q.eq('generation', generation).eq('companyId', args.companyId).eq('warehouseId', args.warehouseId).eq('materialId', args.materialId),
    ).unique()
    const facts = await ctx.db.query('stockEntries').withIndex('by_company_warehouse_material_date', (q) =>
      q.eq('companyId', args.companyId).eq('warehouseId', args.warehouseId).eq('materialId', args.materialId),
    ).take(20_000)
    const factSum = facts.reduce((sum, fact) => fact.cancelled ? sum : sum + fact.signedBaseQty, 0n)
    const asOf = await inventoryAsOf(ctx, generation, {
      companyId: args.companyId, warehouseId: args.warehouseId, materialId: args.materialId,
    }, args.asOf ?? '2026-07-31')
    return { generation, current: current?.baseQty ?? 0n, factSum, mismatch: (current?.baseQty ?? 0n) !== factSum, asOf: asOf.baseQty, scannedBuckets: asOf.scannedBuckets }
  },
})

export const inspectGl = query({
  args: { spikeSecret: v.string(), voucherId: v.string(), companyId: v.id('companies'), accountId: v.id('accounts') },
  returns: v.object({ liveFacts: v.number(), allFacts: v.number(), debit: v.int64(), credit: v.int64() }),
  handler: async (ctx, args) => {
    requireSecret(args.spikeSecret)
    const generation = await activeGenerationInQuery(ctx, 'gl')
    const facts = await ctx.db.query('glEntries').withIndex('by_voucher', (q) => q.eq('voucherType', 'gl.voucher').eq('voucherId', args.voucherId)).take(100)
    const daily = await ctx.db.query('glAccountDaily').withIndex('by_key_date', (q) =>
      q.eq('generation', generation).eq('companyId', args.companyId).eq('accountId', args.accountId).eq('postingDate', '2026-07-31'),
    ).unique()
    return { liveFacts: facts.filter((fact) => !fact.cancelled).length, allFacts: facts.length, debit: daily?.debit ?? 0n, credit: daily?.credit ?? 0n }
  },
})

export const corruptInventory = mutation({
  args: { spikeSecret: v.string(), companyId: v.id('companies'), warehouseId: v.id('warehouses'), materialId: v.id('materials') },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireSecret(args.spikeSecret)
    const generation = (await ctx.db.query('projectionGenerations').withIndex('by_projection', (q) => q.eq('projection', 'inventory')).unique())?.activeGeneration ?? 1
    const current = await readCurrent(asDomainMutationCtx(ctx), generation, args)
    if (!current) throw synieError('not_found', '库存 current projection 不存在')
    await ctx.db.patch(current._id, { baseQty: current.baseQty + 1n })
    return null
  },
})

export const rebuildInventoryForSmoke = mutation({
  args: { spikeSecret: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    requireSecret(args.spikeSecret)
    const domainCtx = asDomainMutationCtx(ctx)
    const facts = await ctx.db.query('stockEntries').take(20_000)
    const session = await startProjectionRebuild(domainCtx, 'inventory')
    await applyInventoryRebuildChunk(domainCtx, session._id, 'all-smoke-facts', facts)
    return activateVerifiedGeneration(domainCtx, session._id, 1, facts.length)
  },
})

export const seedHistoryChunk = mutation({
  args: {
    spikeSecret: v.string(), companyId: v.id('companies'), warehouseId: v.id('warehouses'), materialId: v.id('materials'), dates: v.array(v.string()), marker: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    requireSecret(args.spikeSecret)
    if (args.dates.length > 120) throw synieError('validation', '历史桶 chunk 过大')
    const domainCtx = asDomainMutationCtx(ctx)
    const generation = (await ctx.db.query('projectionGenerations').withIndex('by_projection', (q) => q.eq('projection', 'inventory')).unique())?.activeGeneration ?? 1
    for (const [sequence, postingDate] of args.dates.entries()) {
      await ctx.db.insert('stockEntries', {
        voucherType: 'engine.history', voucherId: `${args.marker}-${sequence}`, voucherNo: args.marker,
        companyId: args.companyId, warehouseId: args.warehouseId, materialId: args.materialId,
        postingDate, signedBaseQty: 1n, sequence, cancelled: false, cancelledAt: null, createdAt: Date.now(),
      })
      await applyInventoryDelta(domainCtx, generation, {
        companyId: args.companyId,
        warehouseId: args.warehouseId,
        materialId: args.materialId,
      }, postingDate, 1n)
    }
    return args.dates.length
  },
})
