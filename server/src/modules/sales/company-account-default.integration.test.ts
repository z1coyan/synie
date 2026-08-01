/**
 * 工单 02：公司默认过账科目（一公司一行四槽；角色校验；partial upsert）。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { createRegistry } from '~/platform/meta/registry.ts'
import { createAccountService } from '../base/account-service.ts'
import { createCompanyService } from '../base/company-service.ts'
import { createCurrencyService } from '../base/currency-service.ts'
import {
  companyAccountDefaultMeta,
  createCompanyAccountDefaultService,
  registerSalesCompanyAccountDefault,
} from './index.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

function superActor(username = 'cad-test'): Actor {
  return {
    userId: crypto.randomUUID(),
    username,
    name: null,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  }
}

function limitedActor(companyIds: string[], permissions: string[]): Actor {
  return {
    userId: crypto.randomUUID(),
    username: 'cad-limited',
    name: null,
    superAdmin: false,
    allCompanies: false,
    permissions: new Set(permissions),
    companyIds,
  }
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
  const currencies = createCurrencyService(db)
  const companies = createCompanyService(db)
  const accounts = createAccountService(db)
  const defaults = createCompanyAccountDefaultService(db)
  const actor = superActor()
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10)

  let currencyId = ''
  let companyId = ''
  let otherCompanyId = ''
  let deliveryDebitId = ''
  let deliveryCreditId = ''
  let receiptDebitId = ''
  let receiptCreditId = ''
  let wrongRoleId = ''
  let defaultId = ''

  afterAll(async () => {
    if (defaultId) {
      await db
        .deleteFrom('sys_audit_log')
        .where('resource', '=', 'sal_company_account_default')
        .where('record_id', '=', defaultId)
        .execute()
      await db.deleteFrom('sal_company_account_default').where('id', '=', defaultId).execute()
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
    expect(companyAccountDefaultMeta().actions).toEqual([])
  })

  test('空壳 getByCompany + 创建四槽 + 角色校验 + partial upsert', async () => {
    const iso = lettersFrom(`c${suffix}`, 3)
    const cur = await currencies.create(actor, {
      name: `默认过账币-${suffix}`,
      isoCode: iso,
      symbol: '¤',
    })
    currencyId = cur.id

    const company = await companies.create(actor, {
      code: lettersFrom(`a${suffix}`, 2),
      name: `默认过账公司-${suffix}`,
      shortName: `短-${suffix.slice(0, 4)}`,
      baseCurrencyId: cur.id,
    })
    companyId = company.id

    const other = await companies.create(actor, {
      code: lettersFrom(`b${suffix}`, 2),
      name: `他司-${suffix}`,
      shortName: `他-${suffix.slice(0, 4)}`,
      baseCurrencyId: cur.id,
    })
    otherCompanyId = other.id

    const empty = await defaults.getByCompany(actor, companyId)
    expect(empty.id).toBe('')
    expect(empty.companyId).toBe(companyId)
    expect(empty.deliveryDebitAccountId).toBeNull()

    async function leafAccount(
      name: string,
      role: string | null,
      company = companyId,
    ): Promise<string> {
      const acc = await accounts.create(actor, {
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
      defaults.create(actor, {
        companyId,
        deliveryDebitAccountId: wrongRoleId,
      }),
    ).rejects.toMatchObject({ code: 'validation' })

    // 他司科目拒绝
    const foreignAcc = await leafAccount('他司科', null, otherCompanyId)
    await expect(
      defaults.create(actor, {
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

    const created = await defaults.create(actor, {
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
      defaults.create(actor, {
        companyId,
        deliveryDebitAccountId: deliveryDebitId,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })

    // 销售 Tab partial：只改发货两槽，不覆盖入库两槽
    const afterSales = await defaults.update(actor, created.id, {
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
    const afterPurchase = await defaults.update(actor, created.id, {
      deliveryDebitPresent: false,
      deliveryCreditPresent: false,
      receiptDebitPresent: true,
      receiptDebitAccountId: receiptDebitId,
      receiptCreditPresent: true,
      receiptCreditAccountId: receiptCreditId,
    })
    expect(afterPurchase.deliveryDebitAccountId).toBeNull()
    expect(afterPurchase.receiptCreditAccountId).toBe(receiptCreditId)

    const byCompany = await defaults.getByCompany(actor, companyId)
    expect(byCompany.id).toBe(created.id)

    // 权限 fail-closed
    const noPerm = limitedActor([companyId], [])
    await expect(defaults.getByCompany(noPerm, companyId)).rejects.toMatchObject({
      code: 'forbidden',
    })
    const readOnly = limitedActor([companyId], ['sales.setting:read'])
    await expect(
      defaults.create(readOnly, { companyId, deliveryCreditAccountId: deliveryCreditId }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
})
