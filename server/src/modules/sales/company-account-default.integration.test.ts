/**
 * 工单 02：公司默认过账科目（一公司一行四槽；角色校验；partial upsert）。
 * 工单 10：授权改为 guard + Permit——403 只由 HTTP guard 产生，行不可达一律 not_found / 空结果。
 */
import { testActor } from '~/platform/authz/testing.ts'
import { afterAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createDb } from '~/db/index.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { onError } from '~/platform/http/errors.ts'
import { createRegistry } from '~/platform/meta/registry.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { createAccountService } from '../base/account-service.ts'
import { createCompanyService } from '../base/company-service.ts'
import { createCurrencyService } from '../base/currency-service.ts'
import {
  companyAccountDefaultMeta,
  companyAccountDefaultRoutes,
  createCompanyAccountDefaultService,
  DEFAULT_RESOURCE,
  registerSalesCompanyAccountDefault,
} from './index.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

function superActor(username = 'cad-test'): Actor {
  return testActor({
    userId: crypto.randomUUID(),
    username,
    name: null,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })
}

function limitedActor(companyIds: string[], permissions: string[]): Actor {
  return testActor({
    userId: crypto.randomUUID(),
    username: 'cad-limited',
    name: null,
    superAdmin: false,
    allCompanies: false,
    permissions: new Set(permissions),
    companyIds,
  })
}

function lettersFrom(seed: string, n: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let out = ''
  for (let i = 0; i < n; i++) {
    const ch = seed[i % seed.length] ?? 'a'
    out += alphabet[ch.charCodeAt(0) % 26]!
  }
  return out
}

run('PG 集成（公司默认过账科目）', () => {
  const db = createDb(url!)
  const sealed = createSealedResourceRegistry()
  const baseAuthz = createAuthzEnforcer(sealed)
  const currencies = createCurrencyService(db, sealed)
  const companies = createCompanyService(db, sealed)
  const accounts = createAccountService(db, sealed)
  const defaults = createCompanyAccountDefaultService(db, sealed)
  const actor = superActor()
  /** base 夹具的凭证（superAdmin → rowFilter 全集） */
  function basePermit(resource: string, action: string): Permit {
    const decision = baseAuthz.decideFor(actor, resource, action)
    if (decision.outcome !== 'permit') throw new Error(`夹具应当 permit：${resource}:${action}`)
    return decision.permit
  }
  /** 本资源凭证：actor 可变，凭证每次现取 */
  function permitFor(who: Actor, action: string): Permit {
    const decision = baseAuthz.decideFor(who, DEFAULT_RESOURCE, action)
    if (decision.outcome !== 'permit') {
      throw new Error(`应当 permit：${DEFAULT_RESOURCE}:${action}`)
    }
    return decision.permit
  }
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10)

  /** HTTP seam：403 必须由 guard（码级判定）产生，不由服务层 */
  let httpActor: Actor = actor
  const auth = {
    authenticate: async () => httpActor,
    authenticateRequest: async () => httpActor,
  } as unknown as AuthService
  const http = new Hono<AppEnv>().route(
    '/api/v1/sales/company-account-defaults',
    companyAccountDefaultRoutes({ auth, authz: baseAuthz, defaults }),
  )
  http.onError(onError)
  const call = (path: string, init?: RequestInit) =>
    http.request(`/api/v1/sales/company-account-defaults${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })

  let currencyId = ''
  let companyId = ''
  let otherCompanyId = ''
  let deliveryDebitId = ''
  let deliveryCreditId = ''
  let receiptDebitId = ''
  let receiptCreditId = ''
  let wrongRoleId = ''
  let defaultId = ''
  let otherDefaultId = ''

  afterAll(async () => {
    for (const id of [defaultId, otherDefaultId].filter(Boolean)) {
      await db
        .deleteFrom('sys_audit_log')
        .where('resource', '=', 'sal_company_account_default')
        .where('record_id', '=', id)
        .execute()
      await db.deleteFrom('sal_company_account_default').where('id', '=', id).execute()
    }
    for (const id of [
      deliveryDebitId,
      deliveryCreditId,
      receiptDebitId,
      receiptCreditId,
      wrongRoleId,
    ].filter(Boolean)) {
      await db
        .deleteFrom('sys_audit_log')
        .where('resource', '=', 'bas_account')
        .where('record_id', '=', id)
        .execute()
      await db.deleteFrom('bas_account').where('id', '=', id).execute()
    }
    for (const id of [companyId, otherCompanyId].filter(Boolean)) {
      await db
        .deleteFrom('sys_audit_log')
        .where('resource', '=', 'inv_warehouse')
        .where('company_id', '=', id)
        .execute()
      await db.deleteFrom('inv_warehouse').where('company_id', '=', id).execute()
      await db
        .deleteFrom('sys_audit_log')
        .where('resource', '=', 'bas_company')
        .where('record_id', '=', id)
        .execute()
      await db.deleteFrom('bas_company').where('id', '=', id).execute()
    }
    if (currencyId) {
      await db
        .deleteFrom('sys_audit_log')
        .where('resource', '=', 'bas_currency')
        .where('record_id', '=', currencyId)
        .execute()
      await db.deleteFrom('bas_currency').where('id', '=', currencyId).execute()
    }
    await db.destroy()
  })

  test('Meta 可注册', () => {
    const registry = createRegistry()
    registerSalesCompanyAccountDefault(registry)
    const meta = registry.get('salCompanyAccountDefaults')
    expect(meta?.permissionPrefix).toBe('sales.setting')
    expect(meta?.table).toBe('sal_company_account_default')
    // 动作事实源归 meta：read/update 与共享前缀 salSettings 同码，不新增权限点
    expect(companyAccountDefaultMeta().actions.map((a) => a.key)).toEqual(['read', 'update'])
    expect(sealed.permissionCatalog().find((g) => g.prefix === 'sales.setting')?.actions).toEqual([
      'read',
      'update',
    ])
  })

  test('空壳 getByCompany + 创建四槽 + 角色校验 + partial upsert', async () => {
    const iso = lettersFrom(`c${suffix}`, 3)
    const cur = await currencies.create(basePermit('basCurrencies', 'create'), {
      name: `默认过账币-${suffix}`,
      isoCode: iso,
      symbol: '¤',
    })
    currencyId = cur.id

    const company = await companies.create(basePermit('basCompanies', 'create'), {
      code: lettersFrom(`a${suffix}`, 2),
      name: `默认过账公司-${suffix}`,
      shortName: `短-${suffix.slice(0, 4)}`,
      baseCurrencyId: cur.id,
    })
    companyId = company.id

    const other = await companies.create(basePermit('basCompanies', 'create'), {
      code: lettersFrom(`b${suffix}`, 2),
      name: `他司-${suffix}`,
      shortName: `他-${suffix.slice(0, 4)}`,
      baseCurrencyId: cur.id,
    })
    otherCompanyId = other.id

    const empty = await defaults.getByCompany(permitFor(actor, 'read'), companyId)
    expect(empty.id).toBe('')
    expect(empty.companyId).toBe(companyId)
    expect(empty.deliveryDebitAccountId).toBeNull()

    async function leafAccount(
      name: string,
      role: string | null,
      company = companyId,
    ): Promise<string> {
      const acc = await accounts.create(basePermit('basAccounts', 'create'), {
        companyId: company,
        code: `${lettersFrom(name + suffix, 4)}${Math.floor(Math.random() * 90 + 10)}`,
        name: `${name}-${suffix}`,
        direction: 'DEBIT',
        isGroup: false,
        active: true,
        role,
      })
      return acc.id
    }

    deliveryDebitId = await leafAccount('发货借', 'UNBILLED_RECEIVABLE')
    deliveryCreditId = await leafAccount('发货贷', null)
    receiptDebitId = await leafAccount('入库借', null)
    receiptCreditId = await leafAccount('入库贷', 'UNBILLED_PAYABLE')
    wrongRoleId = await leafAccount('错误角色', 'RECEIVABLE')

    // 发货借必须 unbilled_receivable
    await expect(
      defaults.create(permitFor(actor, 'update'), {
        companyId,
        deliveryDebitAccountId: wrongRoleId,
      }),
    ).rejects.toMatchObject({ code: 'validation' })

    // 他司科目拒绝
    const foreignAcc = await leafAccount('他司科', null, otherCompanyId)
    await expect(
      defaults.create(permitFor(actor, 'update'), {
        companyId,
        deliveryCreditAccountId: foreignAcc,
      }),
    ).rejects.toMatchObject({ code: 'validation' })
    await db
      .deleteFrom('sys_audit_log')
      .where('resource', '=', 'bas_account')
      .where('record_id', '=', foreignAcc)
      .execute()
    await db.deleteFrom('bas_account').where('id', '=', foreignAcc).execute()

    const created = await defaults.create(permitFor(actor, 'update'), {
      companyId,
      deliveryDebitAccountId: deliveryDebitId,
      deliveryCreditAccountId: deliveryCreditId,
      receiptDebitAccountId: receiptDebitId,
      receiptCreditAccountId: receiptCreditId,
    })
    defaultId = created.id
    expect(created.deliveryDebitAccountId).toBe(deliveryDebitId)
    expect(created.receiptCreditAccountId).toBe(receiptCreditId)

    // 重复创建 conflict
    await expect(
      defaults.create(permitFor(actor, 'update'), {
        companyId,
        deliveryDebitAccountId: deliveryDebitId,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })

    // 销售 Tab partial：只改发货两槽，不覆盖入库两槽
    const afterSales = await defaults.update(permitFor(actor, 'update'), created.id, {
      deliveryDebitPresent: true,
      deliveryDebitAccountId: null,
      deliveryCreditPresent: true,
      deliveryCreditAccountId: deliveryCreditId,
      receiptDebitPresent: false,
      receiptCreditPresent: false,
    })
    expect(afterSales.deliveryDebitAccountId).toBeNull()
    expect(afterSales.deliveryCreditAccountId).toBe(deliveryCreditId)
    expect(afterSales.receiptDebitAccountId).toBe(receiptDebitId)
    expect(afterSales.receiptCreditAccountId).toBe(receiptCreditId)

    // 采购 Tab partial：只改入库两槽
    const afterPurchase = await defaults.update(permitFor(actor, 'update'), created.id, {
      deliveryDebitPresent: false,
      deliveryCreditPresent: false,
      receiptDebitPresent: true,
      receiptDebitAccountId: receiptDebitId,
      receiptCreditPresent: true,
      receiptCreditAccountId: receiptCreditId,
    })
    expect(afterPurchase.deliveryDebitAccountId).toBeNull()
    expect(afterPurchase.receiptCreditAccountId).toBe(receiptCreditId)

    const byCompany = await defaults.getByCompany(permitFor(actor, 'read'), companyId)
    expect(byCompany.id).toBe(created.id)

    // 他司也建一行：跨公司可见性的对照组
    const otherCreated = await defaults.create(permitFor(actor, 'update'), {
      companyId: otherCompanyId,
    })
    otherDefaultId = otherCreated.id
  })

  test('公司域 actor：别名回归（本司行可见）+ 跨公司单条 404 + 他司空结果', async () => {
    const scoped = limitedActor([companyId], ['sales.setting:read'])
    const read = () => permitFor(scoped, 'read')

    // 别名回归：本公司的行必须在结果里（别名写错会静默算成空集）
    const listed = await defaults.list(read(), { limit: 50, offset: 0 })
    expect(listed.results.map((r) => r.id)).toContain(defaultId)
    expect(listed.results.map((r) => r.companyId)).not.toContain(otherCompanyId)

    // 单条：本司命中、他司 404（不泄露存在性）
    expect((await defaults.get(read(), defaultId)).id).toBe(defaultId)
    await expect(defaults.get(read(), otherDefaultId)).rejects.toMatchObject({
      code: 'not_found',
    })

    // 单公司读端点：他司落空壳（空结果，不是 forbidden）
    const foreign = await defaults.getByCompany(read(), otherCompanyId)
    expect(foreign.id).toBe('')
    expect(foreign.companyId).toBe(otherCompanyId)

    // 写侧：码满足但他司行不可达 → 404
    const writer = limitedActor([companyId], ['sales.setting:read', 'sales.setting:update'])
    const write = () => permitFor(writer, 'update')
    await expect(
      defaults.update(write(), otherDefaultId, {
        receiptDebitPresent: true,
        receiptDebitAccountId: null,
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      defaults.create(write(), { companyId: otherCompanyId }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  test('HTTP guard：缺码 403；只读码不能写；创建沿用 update 码', async () => {
    httpActor = limitedActor([companyId], [])
    const denied = await call(`/by-company/${companyId}`)
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: { code: 'forbidden' } })

    const deniedList = await call('/query', {
      method: 'POST',
      body: JSON.stringify({ limit: 20, offset: 0 }),
    })
    expect(deniedList.status).toBe(403)

    httpActor = limitedActor([companyId], ['sales.setting:read'])
    const readOk = await call(`/${defaultId}`)
    expect(readOk.status).toBe(200)
    // 集合根无尾斜杠（尾斜杠会落全局 notFound 假 404）
    const writeDenied = await call('', {
      method: 'POST',
      body: JSON.stringify({ companyId: otherCompanyId }),
    })
    expect(writeDenied.status).toBe(403)

    // 有 update 码但公司不在边界内：404（码满足，行不可达）
    httpActor = limitedActor([companyId], ['sales.setting:read', 'sales.setting:update'])
    const foreignCreate = await call('', {
      method: 'POST',
      body: JSON.stringify({ companyId: otherCompanyId }),
    })
    expect(foreignCreate.status).toBe(404)
    httpActor = actor
  })
})
