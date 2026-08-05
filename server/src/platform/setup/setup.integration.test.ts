/**
 * Setup 向导 PG 集成测试。
 * 门控 SYNIE_TEST_DATABASE_URL；会重置 setup 状态并清业务表（与其他包测试串行跑）。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createAccountingServices } from '~/modules/accounting/index.ts'
import { createBaseServices } from '~/modules/base/index.ts'
import { createFinanceServices } from '~/modules/finance/index.ts'
import { isJournalLinkedToBankRecon } from '~/modules/finance/banking-recon.ts'
import { createHrServices } from '~/modules/hr/index.ts'
import { createInventoryServices } from '~/modules/inventory/index.ts'
import { createManufacturingServices } from '~/modules/manufacturing/index.ts'
import { createPartyServices } from '~/modules/party/index.ts'
import { createCompanyAccountDefaultService } from '~/modules/sales/index.ts'
import { createTradingServices } from '~/modules/trading/index.ts'
import { buildTestApp, createPlatformRegistry, testDatabaseUrl, TEST_AUTH_SECRET } from '../../../test/helpers.ts'
import { createTokenManager } from '../auth/token.ts'
import type { Actor } from '../authz/actor.ts'
import { createAuthzEnforcer } from '../authz/enforce.ts'
import { createOwnerRegistry, createFileService } from '../files/index.ts'
import { ApiError } from '../http/errors.ts'
import { buildNumberingCatalog } from '../numbering/catalog.ts'
import { createNumberingService } from '../numbering/service.ts'
import {
  MARKER_BANK_ACCOUNT_NO,
  MARKER_CUSTOMER_CODE,
  seedMaterialCategories,
  seedSampleData,
} from '~/modules/setup/index.ts'
import { createSetupService, SALES_ROLE_MENUS, SALES_ROLE_PERMISSIONS } from './service.ts'
import { testActor } from '~/platform/authz/testing.ts'

const url = testDatabaseUrl()
const run = url ? describe : describe.skip

run('PG 集成（setup 向导）', () => {
  const db = createDb(url!)
  const tokens = createTokenManager({ secret: TEST_AUTH_SECRET, ttlSeconds: 3600 })

  async function prepareEmptySetup(): Promise<void> {
    // 必须在同一连接/事务内持锁：连接池跨连接的 session advisory_lock 会泄漏并卡住 afterAll TRUNCATE。
    await db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('synie-setup-integration'))`.execute(trx)
      await sql`SET LOCAL lock_timeout = '15s'`.execute(trx)
      await sql`SET LOCAL statement_timeout = '60s'`.execute(trx)
      await sql`
        TRUNCATE TABLE
          acc_vat_invoice,
          acc_expense_report_item,
          acc_expense_report,
          hr_payroll_payment,
          hr_payroll,
          acc_gl_journal_line,
          acc_gl_journal,
          acc_bank_transaction,
          acc_bank_reconciliation,
          acc_bank_import_item,
          acc_bank_import,
          acc_bank_account,
          acc_gl_entry,
          pur_reconciliation_item,
          pur_reconciliation,
          pur_outsourced_receipt_item_byproduct,
          pur_outsourced_receipt_item_material,
          pur_outsourced_receipt_item,
          pur_outsourced_receipt,
          pur_outsourced_issue_item,
          pur_outsourced_issue,
          pur_receipt_item,
          pur_receipt,
          pur_order_item_byproduct,
          pur_order_item_material,
          pur_order_item,
          pur_order,
          pur_quotation_tier,
          pur_quotation_item,
          pur_quotation,
          sal_reconciliation_item,
          sal_reconciliation,
          sal_delivery_item,
          sal_delivery,
          sal_order_item,
          sal_order,
          sal_quotation_tier,
          sal_quotation_item,
          sal_quotation,
          inv_stock_count_item,
          inv_stock_count,
          inv_stock_transfer_item,
          inv_stock_transfer,
          inv_stock_doc_item,
          inv_stock_doc,
          inv_stock_entry,
          mfg_output_item,
          mfg_output,
          mfg_work_order,
          mfg_demand_item,
          mfg_demand,
          mfg_bom_route,
          mfg_bom_byproduct,
          mfg_bom_component,
          mfg_bom,
          mfg_process_template_item,
          mfg_process_template,
          mfg_operation,
          inv_material_unit,
          inv_material,
          hr_attendance_correction,
          hr_attendance_day,
          hr_attendance_punch,
          hr_attendance_import,
          hr_employee_loan,
          hr_employees,
          pur_supplier,
          sal_customers,
          sal_company_account_default,
          bas_account,
          inv_warehouse,
          bas_company,
          sys_user,
          sys_role_permission,
          sys_role_menu,
          sys_role,
          inv_material_category,
          bas_unit,
          bas_currency,
          sys_storage
        RESTART IDENTITY CASCADE
      `.execute(trx)
      await sql`UPDATE sys_setting SET setup_completed_at = NULL`.execute(trx)
      await sql`DELETE FROM sys_numbering_counter`.execute(trx)
      await sql`DELETE FROM sys_numbering_rule`.execute(trx)
    })
  }

  // 收尾清空 setup 种子，避免污染共享 synie_test 上的其它 PG 集成包。
  // TRUNCATE 大表 + advisory 锁在机器繁忙时可能超过默认 5s hook 超时。
  afterAll(async () => {
    try {
      await prepareEmptySetup()
    } catch {
      // 收尾失败不阻断 destroy
    }
    await db.destroy()
  }, 120_000)

  test('status 公开 + first-user 并发仅一成功 + 基础 complete', async () => {
    await prepareEmptySetup()
    const setup = createSetupService({ db, tokens, seedMaterialCategories })
    const app = await buildTestApp(db)

    const statusRes = await app.request('/api/v1/setup/status')
    expect(statusRes.status).toBe(200)
    const status = (await statusRes.json()) as { initialized: boolean; hasUsers: boolean }
    expect(status.initialized).toBe(false)
    expect(status.hasUsers).toBe(false)

    const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
    const a = `setup_a_${suffix}`
    const b = `setup_b_${suffix}`
    const results = await Promise.allSettled([
      setup.createFirstUser({ username: a, password: 'secret-a' }),
      setup.createFirstUser({ username: b, password: 'secret-b' }),
    ])
    const successes = results.filter((r) => r.status === 'fulfilled')
    const conflicts = results.filter(
      (r) =>
        r.status === 'rejected' &&
        r.reason instanceof ApiError &&
        r.reason.code === 'conflict',
    )
    expect(successes.length).toBe(1)
    expect(conflicts.length).toBe(1)
    const winner = (
      successes[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof setup.createFirstUser>>>
    ).value
    expect(winner.token.length).toBeGreaterThan(0)

    const flags = await sql<{ super_admin: boolean; all_companies: boolean }>`
      SELECT super_admin, all_companies FROM sys_user WHERE id = ${winner.user.id}::uuid
    `.execute(db)
    expect(flags.rows[0]?.super_admin).toBe(true)
    expect(flags.rows[0]?.all_companies).toBe(true)

    const created = await setup.seedCommonCurrencies()
    expect(created).toBeGreaterThanOrEqual(0)
    expect(created).toBeLessThanOrEqual(setup.commonCurrencyCount)
    expect(await setup.seedCommonCurrencies()).toBe(0)

    const cny = await sql<{ id: string }>`SELECT id FROM bas_currency WHERE iso_code = 'CNY'`.execute(
      db,
    )
    expect(cny.rows[0]).toBeTruthy()
    await setup.activateBaseCurrency(cny.rows[0]!.id)
    const active = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM bas_currency WHERE active
    `.execute(db)
    expect(Number(active.rows[0]?.c)).toBe(1)

    const actor: Actor = testActor({
      userId: winner.user.id,
      username: winner.user.username,
      name: winner.user.name,
      superAdmin: true,
      allCompanies: true,
      permissions: new Set(),
      companyIds: [],
    })
    // 无示例依赖时 seedSampleData=false：仅基础种子 + 完成旗标
    await setup.complete(actor, 'zh-CN', false)

    const lang = await sql<{ preferred_language: string | null }>`
      SELECT preferred_language FROM sys_user WHERE id = ${winner.user.id}::uuid
    `.execute(db)
    expect(lang.rows[0]?.preferred_language).toBe('zh-CN')

    const completed = await sql<{ setup_completed_at: Date | null }>`
      SELECT setup_completed_at FROM sys_setting ORDER BY id LIMIT 1
    `.execute(db)
    expect(completed.rows[0]?.setup_completed_at).toBeTruthy()

    const counts = await sql<{
      storage: string
      rules: string
      categories: string
      units: string
    }>`
      SELECT
        (SELECT count(*)::text FROM sys_storage WHERE name='local') AS storage,
        (SELECT count(*)::text FROM sys_numbering_rule) AS rules,
        (SELECT count(*)::text FROM inv_material_category) AS categories,
        (SELECT count(*)::text FROM bas_unit) AS units
    `.execute(db)
    expect(Number(counts.rows[0]?.storage)).toBeGreaterThanOrEqual(1)
    expect(Number(counts.rows[0]?.rules)).toBeGreaterThanOrEqual(22)
    expect(Number(counts.rows[0]?.categories)).toBeGreaterThanOrEqual(1)
    expect(Number(counts.rows[0]?.units)).toBeGreaterThanOrEqual(1)

    // 内置角色种子：admin 持全域授权旗标 grants_all（无通配授权行）；sales 逐码授权
    const roles = await sql<{
      code: string
      builtin: boolean
      enabled: boolean
      grants_all: boolean
    }>`
      SELECT code, builtin, enabled, grants_all
      FROM sys_role WHERE code IN ('admin', 'sales') ORDER BY code
    `.execute(db)
    expect(roles.rows.map((r) => r.code)).toEqual(['admin', 'sales'])
    expect(roles.rows.every((r) => r.builtin && r.enabled)).toBe(true)
    expect(roles.rows.find((r) => r.code === 'admin')?.grants_all).toBe(true)
    expect(roles.rows.find((r) => r.code === 'sales')?.grants_all).toBe(false)

    const adminPerms = await sql<{ permission: string }>`
      SELECT rp.permission
      FROM sys_role_permission rp JOIN sys_role r ON r.id = rp.role_id
      WHERE r.code = 'admin'
    `.execute(db)
    expect(adminPerms.rows).toEqual([])

    const salesPerms = await sql<{ permission: string; scope: string }>`
      SELECT rp.permission, rp.scope
      FROM sys_role_permission rp JOIN sys_role r ON r.id = rp.role_id
      WHERE r.code = 'sales'
    `.execute(db)
    const salesSet = new Set(salesPerms.rows.map((r) => r.permission))
    expect(salesSet.size).toBe(SALES_ROLE_PERMISSIONS.length)
    // 逐码授权一律 all 范围（三元组授权的范围 UI 见工单 13）
    expect(new Set(salesPerms.rows.map((r) => r.scope))).toEqual(new Set(['all']))
    for (const code of SALES_ROLE_PERMISSIONS) {
      expect(salesSet.has(code)).toBe(true)
    }

    // 内置角色菜单白名单：admin 恒空（不限制）；sales 逐码种子（与菜单目录对齐）
    const adminMenus = await sql<{ menu_code: string }>`
      SELECT rm.menu_code
      FROM sys_role_menu rm JOIN sys_role r ON r.id = rm.role_id
      WHERE r.code = 'admin'
    `.execute(db)
    expect(adminMenus.rows).toEqual([])

    const salesMenus = await sql<{ menu_code: string }>`
      SELECT rm.menu_code
      FROM sys_role_menu rm JOIN sys_role r ON r.id = rm.role_id
      WHERE r.code = 'sales'
    `.execute(db)
    const salesMenuSet = new Set(salesMenus.rows.map((r) => r.menu_code))
    expect(salesMenuSet.size).toBe(SALES_ROLE_MENUS.length)
    for (const code of SALES_ROLE_MENUS) {
      expect(salesMenuSet.has(code)).toBe(true)
    }
  })

  test('HTTP：受保护 setup 端点需超管；公开 first-user 返回 JWT', async () => {
    await prepareEmptySetup()
    const app = await buildTestApp(db)

    const status = await app.request('/api/v1/setup/status')
    expect(status.status).toBe(200)

    const seedNoAuth = await app.request('/api/v1/setup/currencies/seed-common', {
      method: 'POST',
    })
    expect(seedNoAuth.status).toBe(401)

    const first = await app.request('/api/v1/setup/first-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'http-admin',
        name: '管理员',
        password: 'admin123',
      }),
    })
    expect(first.status).toBe(201)
    const body = (await first.json()) as { token: string; user: { username: string } }
    expect(body.token.length).toBeGreaterThan(0)
    expect(body.user.username).toBe('http-admin')

    const headers = {
      authorization: `Bearer ${body.token}`,
      'content-type': 'application/json',
    }
    const seed = await app.request('/api/v1/setup/currencies/seed-common', {
      method: 'POST',
      headers,
    })
    expect(seed.status).toBe(200)
    const seedBody = (await seed.json()) as { created: number }
    expect(seedBody.created).toBeGreaterThanOrEqual(0)
  })

  test(
    '完整路径：公司+科目+示例数据 + C01 幂等 + 登录冒烟',
    async () => {
      await prepareEmptySetup()
      const registry = createPlatformRegistry()
      const numbering = createNumberingService(db, buildNumberingCatalog(registry))
      const base = createBaseServices(db)
      const party = createPartyServices(db, numbering)
      const owners = createOwnerRegistry()
      const files = createFileService({ db, owners, authz: createAuthzEnforcer(registry) })
      const hr = createHrServices(db, files, {
        employees: party.employees,
      })
      const companyAccountDefaults = createCompanyAccountDefaultService(db)
      const inv = createInventoryServices(db, numbering)
      const accounting = createAccountingServices(db, numbering, {
        isJournalLinkedToBankRecon,
      })
      const trading = createTradingServices(db, numbering)
      const finance = createFinanceServices(db, numbering, {
        reconciliations: trading.reconciliations,
        journals: accounting.journals,
        files,
      })
      const manufacturing = createManufacturingServices(db, numbering)

      const sample = {
        db,
        accounts: base.accounts,
        companyAccountDefaults,
        warehouses: inv.warehouses,
        customers: party.customers,
        suppliers: party.suppliers,
        materials: inv.materials,
        materialUnits: inv.materialUnits,
        employees: party.employees,
        trading,
        stockDocs: inv.stockDocs,
        stockTransfers: inv.stockTransfers,
        stockCounts: inv.stockCounts,
        manufacturingMaster: manufacturing.master,
        banking: finance.banking,
        journals: accounting.journals,
        expenses: finance.expenses,
        invoices: finance.invoices,
        hr,
      }
      const setup = createSetupService({
        db,
        tokens,
        seedMaterialCategories,
        seedSampleData: (a, companyId) => seedSampleData(sample, a, companyId),
      })

      const first = await setup.createFirstUser({
        username: 'sample-admin',
        name: '示例管理员',
        password: 'admin123',
      })
      await setup.seedCommonCurrencies()
      const cny = await sql<{ id: string }>`
        SELECT id FROM bas_currency WHERE iso_code = 'CNY'
      `.execute(db)
      await setup.activateBaseCurrency(cny.rows[0]!.id)

      const actor: Actor = testActor({
        userId: first.user.id,
        username: first.user.username,
        name: first.user.name,
        superAdmin: true,
        allCompanies: true,
        permissions: new Set(),
        companyIds: [],
      })
      const company = await base.companies.create(actor, {
        code: 'JT',
        name: '台州京泰电气有限公司',
        shortName: '台州京泰',
        baseCurrencyId: cny.rows[0]!.id,
      })
      await base.accounts.initializeTemplate(actor, company.id, 'small')
      await setup.complete(actor, 'zh-CN', true)

      const c01 = await sql<{ c: string }>`
        SELECT count(*)::text AS c FROM sal_customers WHERE code = ${MARKER_CUSTOMER_CODE}
      `.execute(db)
      expect(Number(c01.rows[0]?.c)).toBe(1)
      const bank = await sql<{ c: string }>`
        SELECT count(*)::text AS c FROM acc_bank_account WHERE account_no = ${MARKER_BANK_ACCOUNT_NO}
      `.execute(db)
      expect(Number(bank.rows[0]?.c)).toBe(1)

      const again = await seedSampleData(sample, actor, company.id)
      expect(again.customers).toBe(0)

      const c01After = await sql<{ c: string }>`
        SELECT count(*)::text AS c FROM sal_customers WHERE code = ${MARKER_CUSTOMER_CODE}
      `.execute(db)
      expect(Number(c01After.rows[0]?.c)).toBe(1)

      const app = await buildTestApp(db)
      const login = await app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'sample-admin', password: 'admin123' }),
      })
      expect(login.status).toBe(200)
      const { token } = (await login.json()) as { token: string }
      const authz = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      }
      async function listCount(path: string): Promise<number> {
        const res = await app.request(path, {
          method: 'POST',
          headers: authz,
          body: JSON.stringify({ limit: 10 }),
        })
        expect(res.status).toBe(200)
        return ((await res.json()) as { count: number }).count
      }
      expect(await listCount('/api/v1/base/customers/query')).toBeGreaterThanOrEqual(1)
      expect(await listCount('/api/v1/base/suppliers/query')).toBeGreaterThanOrEqual(1)
      expect(await listCount('/api/v1/sales/orders/query')).toBeGreaterThanOrEqual(1)
      expect(await listCount('/api/v1/purchase/orders/query')).toBeGreaterThanOrEqual(1)
      expect(await listCount('/api/v1/sales/deliveries/query')).toBeGreaterThanOrEqual(1)
      expect(await listCount('/api/v1/purchase/receipts/query')).toBeGreaterThanOrEqual(1)
      expect(await listCount('/api/v1/inventory/stock-docs/query')).toBeGreaterThanOrEqual(1)
      expect(await listCount('/api/v1/accounting/gl-journals/query')).toBeGreaterThanOrEqual(1)
      expect(await listCount('/api/v1/finance/bank-accounts/query')).toBeGreaterThanOrEqual(1)

      // 已完成初始化后 complete 应 conflict
      const reComplete = await app.request('/api/v1/setup/complete', {
        method: 'POST',
        headers: authz,
        body: JSON.stringify({ preferredLanguage: 'zh-CN', seedSampleData: true }),
      })
      expect(reComplete.status).toBe(409)
    },
    300_000,
  )
})
