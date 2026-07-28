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
  registerManufacturingResources,
} from './modules/manufacturing/index.ts'
import { createPartyServices, registerPartyResources } from './modules/party/index.ts'
import {
  createCompanyAccountDefaultService,
  registerSalesCompanyAccountDefault,
} from './modules/sales/index.ts'
import { createTradingServices, registerTradingResources } from './modules/trading/index.ts'
import { createScmServices, registerScmResources } from './modules/scm/index.ts'
import {
  createFinanceServices,
  registerFinanceResources,
} from './modules/finance/index.ts'
import { createTodoService } from './platform/todo/index.ts'
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
  registerPrintingFileOwners,
  registerPrintingResources,
} from './platform/printing/index.ts'
import { createSettingsService, registerSettingResources } from './platform/settings/index.ts'

const env = loadEnv()
const db = createDb(env.databaseUrl)

const auth = await createAuthService({
  store: createAuthStore(db),
  tokens: createTokenManager({ secret: env.authSecret, ttlSeconds: env.tokenTtlSeconds }),
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
// 打印目录 stub 在业务域之后：已有真实 Meta 则跳过
registerPrintingResources(registry)

const settings = createSettingsService(db)
const numbering = createNumberingService(db)
const owners = createOwnerRegistry()
registerPrintingFileOwners(owners)
const files = createFileService({ db, owners })
const storages = createStorageService({ db })
const audit = createAuditService(db)
const printing = createPrintingService({
  db,
  files,
  catalog: buildPrintingCatalog(registry),
})
const base = createBaseServices(db)
const market = createMarketService(db, { settings })
const iam = createIamService(db, registry)
const party = createPartyServices(db, numbering)
const { hr } = createHrServices(db, files, numbering)
const companyAccountDefaults = createCompanyAccountDefaultService(db)
const inv = createInventoryServices(db, numbering)
const accounting = createAccountingServices(db, numbering)
const trading = createTradingServices(db, numbering)
const finance = createFinanceServices(db, numbering, {
  reconciliations: trading.reconciliations,
  files,
})
const todos = createTodoService(db)
const scm = createScmServices(db)
const manufacturing = createManufacturingServices(db, numbering)

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
  todos,
  manufacturing,
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
