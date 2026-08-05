import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { createAccountService } from './account-service.ts'
import { createCompanyService } from './company-service.ts'
import { createCurrencyService } from './currency-service.ts'
import { createUnitService } from './unit-service.ts'
import { testActor } from '~/platform/authz/testing.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

function superActor(username = 'base-test'): Actor {
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

function companyActor(companyIds: string[], username = 'base-scoped'): Actor {
  return testActor({
    userId: crypto.randomUUID(),
    username,
    name: null,
    superAdmin: false,
    allCompanies: false,
    permissions: new Set([
      'base.account:read',
      'base.account:create',
      'base.account:update',
      'base.account:delete',
    ]),
    companyIds,
  })
}

/** 从任意字符串派生 n 位大写英文字母（避免 ISO/公司编码校验失败） */
function lettersFrom(seed: string, n: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let out = ''
  for (let i = 0; i < n; i++) {
    const ch = seed[i % seed.length] ?? 'a'
    const code = ch.charCodeAt(0)
    out += alphabet[code % 26]!
  }
  return out
}

/** 共享库可能被 setup 截断后残留 inactive CNY；确保有启用本币可用 */
async function ensureActiveCny(
  currencies: ReturnType<typeof createCurrencyService>,
  permit: Permit,
  createdCurrencyIds: string[],
) {
  let cny = (
    await currencies.list(permit, {
      limit: 5,
      offset: 0,
      filter: { isoCode: { kind: 'text', op: 'eq', value: 'CNY' } },
    })
  ).results[0]
  if (!cny) {
    cny = await currencies.create(permit, { name: '人民币', isoCode: 'CNY', symbol: '¥' })
    createdCurrencyIds.push(cny.id)
    return cny
  }
  if (!cny.active) {
    cny = await currencies.update(permit, cny.id, { active: true })
  }
  return cny
}

run('PG 集成（base 主数据）', () => {
  const db = createDb(url!)
  const registry = createSealedResourceRegistry()
  const authz = createAuthzEnforcer(registry)
  const currencies = createCurrencyService(db, registry)
  const companies = createCompanyService(db, registry)
  const units = createUnitService(db, registry)
  const accounts = createAccountService(db, registry)
  /** 取一张凭证：superAdmin 的 rowFilter 恒全集；公司边界见 scopedPermit */
  function permitOf(actor: Actor, resource: string, action = 'read'): Permit {
    const decision = authz.decideFor(actor, resource, action)
    if (decision.outcome !== 'permit') throw new Error(`夹具应当 permit：${resource}:${action}`)
    return decision.permit
  }
  const actor = superActor()
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
  const createdCurrencyIds: string[] = []
  const createdCompanyIds: string[] = []
  const createdUnitIds: string[] = []
  const createdAccountIds: string[] = []

  afterAll(async () => {
    for (const id of createdAccountIds) {
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'bas_account').where('record_id', '=', id).execute()
      await db.deleteFrom('bas_account').where('id', '=', id).execute()
    }
    for (const id of createdCompanyIds) {
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'inv_warehouse').where('company_id', '=', id).execute()
      await db.deleteFrom('inv_warehouse').where('company_id', '=', id).execute()
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'bas_company').where('record_id', '=', id).execute()
      await db.deleteFrom('bas_company').where('id', '=', id).execute()
    }
    for (const id of createdCurrencyIds) {
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'bas_currency').where('record_id', '=', id).execute()
      await db.deleteFrom('bas_currency').where('id', '=', id).execute()
    }
    for (const id of createdUnitIds) {
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'bas_unit').where('record_id', '=', id).execute()
      await db.deleteFrom('bas_unit').where('id', '=', id).execute()
    }
    await db.destroy()
  })

  test('货币 CRUD + 本币保护停用', async () => {
    // ISO 4217：恰好三位大写字母（后缀可能含数字，固定字母表映射）
    const isoCode = lettersFrom(suffix, 3)
    const cur = await currencies.create(permitOf(actor, 'basCurrencies', 'create'), {
      name: `测试币-${suffix}`,
      isoCode,
      symbol: '¤',
    })
    createdCurrencyIds.push(cur.id)
    expect(cur.isoCode).toBe(isoCode)
    expect(cur.active).toBe(true)

    const listed = await currencies.list(permitOf(actor, 'basCurrencies', 'read'), { limit: 20, offset: 0, search: isoCode })
    expect(listed.results.some((r) => r.id === cur.id)).toBe(true)

    // 创建公司引用为本币后不可停用
    const companyCode = lettersFrom(suffix + 'co', 2)
    const company = await companies.create(permitOf(actor, 'basCompanies', 'create'), {
      code: companyCode,
      name: `测试公司-${suffix}`,
      shortName: `短-${suffix.slice(0, 4)}`,
      baseCurrencyId: cur.id,
    })
    createdCompanyIds.push(company.id)

    await expect(currencies.update(permitOf(actor, 'basCurrencies', 'update'), cur.id, { active: false })).rejects.toMatchObject({
      code: 'validation',
    })

    // 清理公司后再停用/删除
    const warehouses = await db
      .selectFrom('inv_warehouse')
      .selectAll()
      .where('company_id', '=', company.id)
      .execute()
    expect(warehouses.length).toBe(3)
    expect(warehouses.filter((w) => w.is_leaf).length).toBe(2)
    expect(warehouses.some((w) => w.name.includes('所有仓库'))).toBe(true)
    expect(warehouses.some((w) => w.name.includes('默认仓库'))).toBe(true)
    expect(warehouses.some((w) => w.name.includes('在途'))).toBe(true)

    // 删仓再删公司
    await db.deleteFrom('sys_audit_log').where('resource', '=', 'inv_warehouse').where('company_id', '=', company.id).execute()
    await db.deleteFrom('inv_warehouse').where('company_id', '=', company.id).execute()
    await companies.remove(permitOf(actor, 'basCompanies', 'delete'), company.id)
    createdCompanyIds.splice(createdCompanyIds.indexOf(company.id), 1)

    const disabled = await currencies.update(permitOf(actor, 'basCurrencies', 'update'), cur.id, { active: false })
    expect(disabled.active).toBe(false)

    // 未启用币种不可作本币
    await expect(
      companies.create(permitOf(actor, 'basCompanies', 'create'), {
        code: lettersFrom(`d${suffix}`, 2),
        name: `禁用币公司-${suffix}`,
        shortName: '禁用',
        baseCurrencyId: cur.id,
      }),
    ).rejects.toMatchObject({ code: 'validation' })

    await currencies.remove(permitOf(actor, 'basCurrencies', 'delete'), cur.id)
    createdCurrencyIds.splice(createdCurrencyIds.indexOf(cur.id), 1)
  })

  test('计量单位：基准唯一 + lifecycle', async () => {
    const baseSymbol = `b${suffix}`.slice(0, 16)
    const childSymbol = `u${suffix}`.slice(0, 16)
    // 共享库可能已有 AREA 基准（setup/示例）；先清掉本测类型下的既有基准与孤儿单位
    const existingArea = await units.list(permitOf(actor, 'basUnits', 'read'), { limit: 200, offset: 0 })
    for (const u of existingArea.results.filter((x) => x.unitType === 'AREA')) {
      await units.remove(permitOf(actor, 'basUnits', 'delete'), u.id).catch(() => undefined)
    }

    const base = await units.create(permitOf(actor, 'basUnits', 'create'), {
      unitType: 'AREA',
      isBase: true,
      name: `基准-${suffix}`,
      symbol: baseSymbol,
      ratio: '1',
    })
    createdUnitIds.push(base.id)

    await expect(
      units.create(permitOf(actor, 'basUnits', 'create'), {
        unitType: 'AREA',
        isBase: true,
        name: `重复基准-${suffix}`,
        symbol: `d${suffix}`.slice(0, 16),
        ratio: '1',
      }),
    ).rejects.toMatchObject({ code: 'conflict' })

    const child = await units.create(permitOf(actor, 'basUnits', 'create'), {
      unitType: 'AREA',
      name: `单位-${suffix}`,
      symbol: childSymbol,
      ratio: '0.000001',
    })
    createdUnitIds.push(child.id)
    expect(child.unitType).toBe('AREA')
    expect(child.ratio).toBe('0.000001')

    const listed = await units.list(permitOf(actor, 'basUnits', 'read'), { limit: 10, offset: 0, search: childSymbol })
    expect(listed.count).toBe(1)
    expect(listed.results[0]?.id).toBe(child.id)

    const updated = await units.update(permitOf(actor, 'basUnits', 'update'), child.id, {
      name: `单位已更新-${suffix}`,
      ratio: '0.000002',
    })
    expect(updated.name).toContain('已更新')
    expect(updated.ratio).toBe('0.000002')

    await units.remove(permitOf(actor, 'basUnits', 'delete'), child.id)
    createdUnitIds.splice(createdUnitIds.indexOf(child.id), 1)
    await expect(units.get(permitOf(actor, 'basUnits', 'read'), child.id)).rejects.toMatchObject({ code: 'not_found' })

    await units.remove(permitOf(actor, 'basUnits', 'delete'), base.id)
    createdUnitIds.splice(createdUnitIds.indexOf(base.id), 1)
  })

  test('会计科目：公司隔离/环路/删父冲突/模板', async () => {
    const cny = await ensureActiveCny(currencies, permitOf(actor, 'basCurrencies', 'update'), createdCurrencyIds)

    const companyACode = lettersFrom(`a${suffix}`, 2)
    let companyBCode = lettersFrom(`b${suffix}`, 2)
    if (companyBCode === companyACode) companyBCode = lettersFrom(`c${suffix}`, 2)

    const companyA = await companies.create(permitOf(actor, 'basCompanies', 'create'), {
      code: companyACode,
      name: `科目公司A-${suffix}`,
      shortName: 'A',
      baseCurrencyId: cny.id,
    })
    createdCompanyIds.push(companyA.id)
    const companyB = await companies.create(permitOf(actor, 'basCompanies', 'create'), {
      code: companyBCode,
      name: `科目公司B-${suffix}`,
      shortName: 'B',
      baseCurrencyId: cny.id,
    })
    createdCompanyIds.push(companyB.id)

    const scoped = companyActor([companyA.id])
    const outsider = companyActor([companyB.id])

    const root = await accounts.create(permitOf(scoped, 'basAccounts', 'create'), {
      code: `R${suffix}`,
      name: `根-${suffix}`,
      direction: 'DEBIT',
      isGroup: true,
      companyId: companyA.id,
    })
    createdAccountIds.push(root.id)

    const child = await accounts.create(permitOf(scoped, 'basAccounts', 'create'), {
      code: `C${suffix}`,
      name: `子-${suffix}`,
      direction: 'DEBIT',
      isGroup: true,
      parentId: root.id,
      companyId: companyA.id,
    })
    createdAccountIds.push(child.id)

    const leaf = await accounts.create(permitOf(scoped, 'basAccounts', 'create'), {
      code: `D${suffix}`,
      name: `叶-${suffix}`,
      direction: 'DEBIT',
      parentId: child.id,
      companyId: companyA.id,
    })
    createdAccountIds.push(leaf.id)

    const listed = await accounts.list(permitOf(scoped, 'basAccounts', 'read'), { limit: 20, offset: 0, search: suffix })
    expect(listed.count).toBe(3)
    for (const item of listed.results) {
      expect(item.companyId).toBe(companyA.id)
    }

    await expect(accounts.get(permitOf(outsider, 'basAccounts', 'read'), root.id)).rejects.toMatchObject({ code: 'not_found' })

    await expect(
      accounts.update(permitOf(scoped, 'basAccounts', 'update'), root.id, {
        parentId: leaf.id,
        parentIdPresent: true,
      }),
    ).rejects.toMatchObject({ code: 'validation' })

    await expect(accounts.remove(permitOf(scoped, 'basAccounts', 'delete'), root.id)).rejects.toMatchObject({ code: 'conflict' })

    const updated = await accounts.update(permitOf(scoped, 'basAccounts', 'update'), leaf.id, {
      name: `叶已更新-${suffix}`,
      active: false,
    })
    expect(updated.name).toContain('已更新')
    expect(updated.active).toBe(false)

    await accounts.remove(permitOf(scoped, 'basAccounts', 'delete'), leaf.id)
    createdAccountIds.splice(createdAccountIds.indexOf(leaf.id), 1)
    await accounts.remove(permitOf(scoped, 'basAccounts', 'delete'), child.id)
    createdAccountIds.splice(createdAccountIds.indexOf(child.id), 1)
    await accounts.remove(permitOf(scoped, 'basAccounts', 'delete'), root.id)
    createdAccountIds.splice(createdAccountIds.indexOf(root.id), 1)

    // 模板初始化
    const tmpl = await accounts.initializeTemplate(permitOf(scoped, 'basAccounts', 'create'), companyA.id, 'SMALL')
    expect(tmpl.createdCount).toBeGreaterThan(10)
    const afterTemplate = await accounts.list(permitOf(scoped, 'basAccounts', 'read'), { limit: 200, offset: 0 })
    expect(afterTemplate.count).toBe(tmpl.createdCount)
    for (const item of afterTemplate.results) {
      createdAccountIds.push(item.id)
    }

    await expect(accounts.initializeTemplate(permitOf(scoped, 'basAccounts', 'create'), companyA.id, 'SMALL')).rejects.toMatchObject({
      code: 'conflict',
    })

    // 清理科目
    // 先叶子后根：按 hasChildren 反复删
    let remaining = true
    while (remaining) {
      const page = await accounts.list(permitOf(superActor(), 'basAccounts', 'read'), {
        limit: 200,
        offset: 0,
        filter: { companyId: { kind: 'fk', values: [companyA.id], labels: [] } },
      })
      const leaves = page.results.filter((a) => !a.hasChildren)
      if (leaves.length === 0) {
        remaining = false
        break
      }
      for (const leafAcc of leaves) {
        await accounts.remove(permitOf(superActor(), 'basAccounts', 'delete'), leafAcc.id)
        const idx = createdAccountIds.indexOf(leafAcc.id)
        if (idx >= 0) createdAccountIds.splice(idx, 1)
      }
    }

    // 清理公司仓库
    for (const cid of [companyA.id, companyB.id]) {
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'inv_warehouse').where('company_id', '=', cid).execute()
      await db.deleteFrom('inv_warehouse').where('company_id', '=', cid).execute()
      await companies.remove(permitOf(actor, 'basCompanies', 'delete'), cid)
      const idx = createdCompanyIds.indexOf(cid)
      if (idx >= 0) createdCompanyIds.splice(idx, 1)
    }
  })

  test('公司上级环路拒绝', async () => {
    const cny = await ensureActiveCny(currencies, permitOf(actor, 'basCurrencies', 'update'), createdCurrencyIds)
    const parentCode = lettersFrom(`p${suffix}`, 2)
    let childCode = lettersFrom(`k${suffix}`, 2)
    if (childCode === parentCode) childCode = lettersFrom(`m${suffix}`, 2)
    const parent = await companies.create(permitOf(actor, 'basCompanies', 'create'), {
      code: parentCode,
      name: `环父-${suffix}`,
      shortName: '父',
      baseCurrencyId: cny.id,
    })
    createdCompanyIds.push(parent.id)
    const child = await companies.create(permitOf(actor, 'basCompanies', 'create'), {
      code: childCode,
      name: `环子-${suffix}`,
      shortName: '子',
      parentId: parent.id,
      baseCurrencyId: cny.id,
    })
    createdCompanyIds.push(child.id)

    await expect(
      companies.update(permitOf(actor, 'basCompanies', 'update'), parent.id, {
        parentId: child.id,
        parentIdPresent: true,
      }),
    ).rejects.toBeInstanceOf(ApiError)

    for (const id of [child.id, parent.id]) {
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'inv_warehouse').where('company_id', '=', id).execute()
      await db.deleteFrom('inv_warehouse').where('company_id', '=', id).execute()
      await companies.remove(permitOf(actor, 'basCompanies', 'delete'), id)
      const idx = createdCompanyIds.indexOf(id)
      if (idx >= 0) createdCompanyIds.splice(idx, 1)
    }
  })
})
