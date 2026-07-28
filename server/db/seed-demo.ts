/**
 * 一键演示库（对齐 mix synie.demo）：
 * admin/admin123 + 公司 JT 台州京泰电气有限公司 + 全业务链示例数据。
 *
 * 用法：
 *   DATABASE_URL=... bun run db:seed:demo
 *
 * 仅允许未完成初始化的库；已初始化则拒绝。
 */
import { createDb } from '../src/db/index.ts'
import { createBaseServices } from '../src/modules/base/index.ts'
import { createAccountingServices } from '../src/modules/accounting/index.ts'
import { createFinanceServices } from '../src/modules/finance/index.ts'
import { createHrServices } from '../src/modules/hr/index.ts'
import { createInventoryServices } from '../src/modules/inventory/index.ts'
import { createManufacturingServices } from '../src/modules/manufacturing/index.ts'
import { createPartyServices } from '../src/modules/party/index.ts'
import { createCompanyAccountDefaultService } from '../src/modules/sales/index.ts'
import { createTradingServices } from '../src/modules/trading/index.ts'
import { createOwnerRegistry, createFileService } from '../src/platform/files/index.ts'
import { createNumberingService } from '../src/platform/numbering/index.ts'
import { createSetupService } from '../src/platform/setup/index.ts'
import { createTokenManager } from '../src/platform/auth/token.ts'
import type { Actor } from '../src/platform/authz/actor.ts'
import { sql } from 'kysely'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('必须设置 DATABASE_URL')
  process.exit(1)
}

const authSecret = process.env.AUTH_SECRET ?? 'demo-seed-auth-secret-32-bytes!!!!'
const db = createDb(databaseUrl)
const tokens = createTokenManager({ secret: authSecret, ttlSeconds: 3600 })
const numbering = createNumberingService(db)
const base = createBaseServices(db)
const party = createPartyServices(db, numbering)
const owners = createOwnerRegistry()
const files = createFileService({ db, owners })
const { hr } = createHrServices(db, files, numbering)
const companyAccountDefaults = createCompanyAccountDefaultService(db)
const inv = createInventoryServices(db, numbering)
const accounting = createAccountingServices(db, numbering)
const trading = createTradingServices(db, numbering)
const finance = createFinanceServices(db, numbering, {
  reconciliations: trading.reconciliations,
  files,
})
const manufacturing = createManufacturingServices(db, numbering)

const setup = createSetupService({
  db,
  tokens,
  sample: {
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
  },
})

try {
  const status = await setup.getStatus()
  if (status.initialized) {
    console.error('系统已完成初始化,拒绝再跑 db:seed:demo（请先清空库后 migrate）')
    process.exit(1)
  }

  console.log(JSON.stringify({ level: 'info', msg: '初始化演示环境…' }))

  const first = await setup.createFirstUser({
    username: 'admin',
    name: '管理员',
    password: 'admin123',
  })
  console.log(JSON.stringify({ level: 'info', msg: '管理员 admin 已创建' }))

  await setup.seedCommonCurrencies()
  const cny = await sql<{ id: string }>`
    SELECT id FROM bas_currency WHERE iso_code = 'CNY'
  `.execute(db)
  if (!cny.rows[0]) {
    throw new Error('预置货币后未找到 CNY')
  }
  await setup.activateBaseCurrency(cny.rows[0].id)

  const actor: Actor = {
    userId: first.user.id,
    username: first.user.username,
    name: first.user.name,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  }

  const company = await base.companies.create(actor, {
    code: 'JT',
    name: '台州京泰电气有限公司',
    shortName: '台州京泰',
    baseCurrencyId: cny.rows[0].id,
  })
  console.log(JSON.stringify({ level: 'info', msg: '公司 JT 台州京泰电气有限公司 已创建' }))

  const accountCount = await base.accounts.initializeTemplate(actor, company.id, 'small')
  console.log(JSON.stringify({ level: 'info', msg: `科目表(小企业) ${accountCount.createdCount} 个` }))

  // 公司 create 已种子默认仓库
  await setup.complete(actor, 'zh-CN', true)

  console.log(
    JSON.stringify({
      level: 'info',
      msg: '完成。登录 admin / admin123，公司 JT，已含全业务链示例数据',
    }),
  )
} catch (err) {
  console.error(err)
  process.exit(1)
} finally {
  await db.destroy()
}
