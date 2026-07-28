import { buildApp } from './app.ts'
import { createDb } from './db/index.ts'
import { loadEnv } from './env.ts'
import { createBaseServices, registerBaseResources } from './modules/base/index.ts'
import {
  createMarketInstrumentService,
  registerMarketResources,
} from './modules/base/market/index.ts'
import { createIamService, registerIamResources } from './modules/iam/index.ts'
import { createPartyServices, registerPartyResources } from './modules/party/index.ts'
import {
  createCompanyAccountDefaultService,
  registerSalesCompanyAccountDefault,
} from './modules/sales/index.ts'
import {
  createInventoryServices,
  registerInventoryResources,
} from './modules/inventory/index.ts'
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
registerSalesCompanyAccountDefault(registry)
registerInventoryResources(registry)

const settings = createSettingsService(db)
const numbering = createNumberingService(db)
const owners = createOwnerRegistry()
const files = createFileService({ db, owners })
const storages = createStorageService({ db })
const audit = createAuditService(db)
const base = createBaseServices(db)
const marketInstruments = createMarketInstrumentService(db)
const iam = createIamService(db, registry)
const party = createPartyServices(db, numbering)
const companyAccountDefaults = createCompanyAccountDefaultService(db)
const inv = createInventoryServices(db, numbering)

const app = buildApp({
  db,
  auth,
  registry,
  settings,
  numbering,
  files,
  storages,
  audit,
  currencies: base.currencies,
  companies: base.companies,
  units: base.units,
  accounts: base.accounts,
  marketInstruments,
  iam,
  customers: party.customers,
  suppliers: party.suppliers,
  employees: party.employees,
  companyAccountDefaults,
  invCategories: inv.categories,
  invMaterials: inv.materials,
  invMaterialUnits: inv.materialUnits,
  invWarehouses: inv.warehouses,
  invStockDocs: inv.stockDocs,
  invStockTransfers: inv.stockTransfers,
  invStockCounts: inv.stockCounts,
  invStockEntries: inv.stockEntries,
})

const server = Bun.serve({
  port: env.port,
  hostname: env.host,
  fetch: app.fetch,
})

console.log(JSON.stringify({ level: 'info', msg: 'synie server listening', port: server.port }))

process.on('SIGTERM', async () => {
  server.stop()
  await db.destroy()
  process.exit(0)
})
