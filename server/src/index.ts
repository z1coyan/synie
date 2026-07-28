import { createMarketScheduler } from './jobs/index.ts'
import { buildApp } from './app.ts'
import { createDb } from './db/index.ts'
import { loadEnv } from './env.ts'
import {
  createAccountingServices,
  registerAccountingResources,
} from './modules/accounting/index.ts'
import { createBaseServices, registerBaseResources } from './modules/base/index.ts'
import { createMarketService, registerMarketResources } from './modules/base/market/index.ts'
import { createHrServices, registerHrResources } from './modules/hr/index.ts'
import { createIamService, registerIamResources } from './modules/iam/index.ts'
import {
  createInventoryServices,
  registerInventoryResources,
} from './modules/inventory/index.ts'
import {
  createManufacturingServices,
  createManufacturingSettingService,
  registerManufacturingResources,
} from './modules/manufacturing/index.ts'
import {
  createPartyServices,
  registerPartyResources,
  registerPartyTodoSources,
} from './modules/party/index.ts'
import {
  createCompanyAccountDefaultService,
  registerSalesCompanyAccountDefault,
} from './modules/sales/index.ts'
import {
  createSalesSettingService,
  createTradingServices,
  registerSalesOrderDocBuilder,
  registerTradingResources,
} from './modules/trading/index.ts'
import { createScmServices, registerScmResources } from './modules/scm/index.ts'
import {
  createAccountingSettingService,
  createFinanceServices,
  registerFinanceFileOwners,
  registerFinanceResources,
  registerFinanceTodoSources,
} from './modules/finance/index.ts'
import { isJournalLinkedToBankRecon } from './modules/finance/banking-recon.ts'
import { createTodoService, createTodoSourceRegistry } from './platform/todo/index.ts'
import { createRateLimiter } from './platform/auth/limiter.ts'
import { createAuthService } from './platform/auth/service.ts'
import { createAuthStore } from './platform/auth/store.ts'
import { createTokenManager } from './platform/auth/token.ts'
import { createAuditService, registerAuditResources } from './platform/audit/index.ts'
import {
  createFileService,
  createOwnerRegistry,
  createStorageService,
  registerFileResources,
} from './platform/files/index.ts'
import { createRegistry } from './platform/meta/registry.ts'
import { createNumberingService, registerNumberingResources } from './platform/numbering/index.ts'
import {
  buildPrintingCatalog,
  createPrintingService,
  createSofficeConverter,
  registerPrintingFileOwners,
  registerPrintingResources,
} from './platform/printing/index.ts'
import { createSettingsService, registerSettingResources } from './platform/settings/index.ts'
import { createSetupService } from './platform/setup/index.ts'
import { seedSampleData } from './modules/setup/index.ts'

const env = loadEnv()
const db = createDb(env.databaseUrl)

const tokens = createTokenManager({ secret: env.authSecret, ttlSeconds: env.tokenTtlSeconds })
const auth = await createAuthService({
  store: createAuthStore(db),
  tokens,
  limiter: createRateLimiter(),
})

const registry = createRegistry()
registerSettingResources(registry)
registerNumberingResources(registry)
registerFileResources(registry)
registerAuditResources(registry)
registerBaseResources(registry)
registerMarketResources(registry)
registerIamResources(registry)
registerPartyResources(registry)
registerHrResources(registry)
registerSalesCompanyAccountDefault(registry)
registerInventoryResources(registry)
registerAccountingResources(registry)
registerTradingResources(registry)
registerFinanceResources(registry)
registerScmResources(registry)
registerManufacturingResources(registry)
// 打印模板 Meta 在业务域之后（字段目录自 Registry fail-closed 派生）
registerPrintingResources(registry)

const settings = createSettingsService(db, {
  sales: createSalesSettingService(db),
  manufacturing: createManufacturingSettingService(db),
  accounting: createAccountingSettingService(db),
})
const numbering = createNumberingService(db)
const owners = createOwnerRegistry()
registerPrintingFileOwners(owners)
registerFinanceFileOwners(owners)
const files = createFileService({ db, owners })
const storages = createStorageService({ db })
const audit = createAuditService(db)
const printing = createPrintingService({
  db,
  files,
  catalog: buildPrintingCatalog(registry),
  converter: createSofficeConverter({
    path: env.sofficePath,
    timeoutMs: env.sofficeTimeoutMs,
    maxConcurrency: env.sofficeMaxConcurrency,
  }),
})
// 业务域 DocBuilder 显式装配（platform 不内置业务表查询）
registerSalesOrderDocBuilder(printing, db)
const base = createBaseServices(db)
const market = createMarketService(db, { settings })
const iam = createIamService(db, registry)
const party = createPartyServices(db, numbering)
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
const todoSources = createTodoSourceRegistry()
registerFinanceTodoSources(todoSources)
registerPartyTodoSources(todoSources)
const todos = createTodoService(db, todoSources)
const scm = createScmServices(db)
const manufacturing = createManufacturingServices(db, numbering)

const setup = createSetupService({
  db,
  tokens,
  seedSampleData: (actor, companyId) =>
    seedSampleData(
      {
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
      actor,
      companyId,
    ),
})

const app = buildApp({
  db,
  auth,
  registry,
  settings,
  numbering,
  files,
  storages,
  audit,
  printing,
  currencies: base.currencies,
  companies: base.companies,
  units: base.units,
  accounts: base.accounts,
  market,
  iam,
  customers: party.customers,
  suppliers: party.suppliers,
  employees: party.employees,
  hr,
  companyAccountDefaults,
  invCategories: inv.categories,
  invMaterials: inv.materials,
  invMaterialUnits: inv.materialUnits,
  invWarehouses: inv.warehouses,
  invStockDocs: inv.stockDocs,
  invStockTransfers: inv.stockTransfers,
  invStockCounts: inv.stockCounts,
  invStockEntries: inv.stockEntries,
  journals: accounting.journals,
  entries: accounting.entries,
  trading,
  scm,
  invoices: finance.invoices,
  banking: finance.banking,
  expenses: finance.expenses,
  bills: finance.bills,
  todos,
  manufacturing,
  setup,
})

const marketScheduler = createMarketScheduler({ settings, market })
marketScheduler.start()

const server = Bun.serve({
  port: env.port,
  hostname: env.host,
  fetch: app.fetch,
})

console.log(JSON.stringify({ level: 'info', msg: 'synie server listening', port: server.port }))

async function shutdown() {
  marketScheduler.stop()
  server.stop()
  await db.destroy()
  process.exit(0)
}

process.on('SIGTERM', () => {
  void shutdown()
})
process.on('SIGINT', () => {
  void shutdown()
})
