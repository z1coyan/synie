import type { Kysely } from 'kysely'
import { buildApp, type AppDeps, type ApiType } from '~/app.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  createAccountingServices,
  registerAccountingResources,
} from '~/modules/accounting/index.ts'
import { createBaseServices, registerBaseResources } from '~/modules/base/index.ts'
import {
  createMarketService,
  registerMarketResources,
  type MarketService,
} from '~/modules/base/market/index.ts'
import { createIamService, registerIamResources } from '~/modules/iam/index.ts'
import { createHrServices, registerHrResources } from '~/modules/hr/index.ts'
import {
  createPartyServices,
  registerPartyResources,
  registerPartyTodoSources,
} from '~/modules/party/index.ts'
import {
  createCompanyAccountDefaultService,
  registerSalesCompanyAccountDefault,
} from '~/modules/sales/index.ts'
import {
  createInventoryServices,
  registerInventoryResources,
} from '~/modules/inventory/index.ts'
import {
  createSalesSettingService,
  createTradingServices,
  registerSalesOrderDocBuilder,
  registerTradingResources,
} from '~/modules/trading/index.ts'
import { createScmServices, registerScmResources } from '~/modules/scm/index.ts'
import {
  createManufacturingServices,
  createManufacturingSettingService,
  registerManufacturingResources,
} from '~/modules/manufacturing/index.ts'
import {
  createAccountingSettingService,
  createFinanceServices,
  registerFinanceFileOwners,
  registerFinanceResources,
  registerFinanceTodoSources,
} from '~/modules/finance/index.ts'
import { isJournalLinkedToBankRecon } from '~/modules/finance/banking-recon.ts'
import { createTodoService, createTodoSourceRegistry } from '~/platform/todo/index.ts'
import { createRateLimiter } from '~/platform/auth/limiter.ts'
import { createAuthService, type AuthService } from '~/platform/auth/service.ts'
import { createAuthStore } from '~/platform/auth/store.ts'
import { createTokenManager } from '~/platform/auth/token.ts'
import { createAuditService, registerAuditResources, type AuditService } from '~/platform/audit/index.ts'
import {
  createFileService,
  createOwnerRegistry,
  createStorageService,
  registerFileResources,
  type FileService,
  type OwnerRegistry,
  type StorageService,
} from '~/platform/files/index.ts'
import { createRegistry, type Registry } from '~/platform/meta/registry.ts'
import {
  createNumberingService,
  registerNumberingResources,
  type NumberingService,
} from '~/platform/numbering/index.ts'
import {
  createSettingsService,
  registerSettingResources,
  type SettingsService,
} from '~/platform/settings/index.ts'
import {
  buildPrintingCatalog,
  createPrintingService,
  createSofficeConverter,
  registerPrintingFileOwners,
  registerPrintingResources,
  type PrintingService,
} from '~/platform/printing/index.ts'
import { createSetupService } from '~/platform/setup/index.ts'
import { seedSampleData } from '~/modules/setup/index.ts'

/** 集成测试用固定密钥（≥32 字节）；仅测试进程内使用 */
export const TEST_AUTH_SECRET = 'integration-test-secret-32-bytes!!'

/** 读门控变量；未设置返回 undefined（调用方 describe.skip） */
export function testDatabaseUrl(): string | undefined {
  return process.env.SYNIE_TEST_DATABASE_URL
}

/** 与 index.ts 同构的测试 AuthService（固定 secret / 1h TTL / 进程内限流） */
export async function createTestAuth(db: Kysely<Database>): Promise<AuthService> {
  return createAuthService({
    store: createAuthStore(db),
    tokens: createTokenManager({ secret: TEST_AUTH_SECRET, ttlSeconds: 3600 }),
    limiter: createRateLimiter(),
  })
}

/** 创建并注册平台 + 工单 02 业务 Meta 的 Registry */
export function createPlatformRegistry(): Registry {
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
  return registry
}

export interface PlatformServices {
  settings: SettingsService
  numbering: NumberingService
  files: FileService
  storages: StorageService
  audit: AuditService
  owners: OwnerRegistry
}

/** 与 index.ts 同构的平台服务（owners 默认为空注册表，可被调用方继续 register） */
export function createPlatformServices(db: Kysely<Database>): PlatformServices {
  const owners = createOwnerRegistry()
  registerPrintingFileOwners(owners)
  registerFinanceFileOwners(owners)
  return {
    settings: createSettingsService(db, {
      sales: createSalesSettingService(db),
      manufacturing: createManufacturingSettingService(db),
      accounting: createAccountingSettingService(db),
    }),
    numbering: createNumberingService(db),
    files: createFileService({ db, owners }),
    storages: createStorageService({ db }),
    audit: createAuditService(db),
    owners,
  }
}

export interface TestAppOptions {
  auth?: AuthService
  registry?: Registry
  deps?: Partial<Omit<AppDeps, 'db' | 'auth' | 'registry'>>
  platform?: Partial<PlatformServices>
}

/** 装配可 request() 的测试应用（不 listen） */
export async function buildTestApp(
  db: Kysely<Database>,
  options: TestAppOptions = {},
): Promise<ApiType> {
  const auth = options.auth ?? (await createTestAuth(db))
  const registry = options.registry ?? createPlatformRegistry()
  const platform = createPlatformServices(db)
  const merged = { ...platform, ...options.platform, ...options.deps }
  const numbering = merged.numbering
  const settings = merged.settings
  const base = createBaseServices(db)
  const market: MarketService =
    (merged.market as MarketService | undefined) ??
    (merged.marketInstruments as MarketService | undefined) ??
    createMarketService(db, { settings })
  const iam = createIamService(db, registry)
  const party = createPartyServices(db, numbering)
  const hr = createHrServices(db, merged.files, {
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
    files: merged.files,
  })
  const todoSources = createTodoSourceRegistry()
  registerFinanceTodoSources(todoSources)
  registerPartyTodoSources(todoSources)
  const todos = createTodoService(db, todoSources)
  const scm = createScmServices(db)
  const manufacturing = createManufacturingServices(db, numbering)
  const printing =
    merged.printing ??
    (() => {
      const svc = createPrintingService({
        db,
        files: merged.files,
        catalog: buildPrintingCatalog(registry),
        converter: createSofficeConverter(),
      })
      registerSalesOrderDocBuilder(svc, db)
      return svc
    })()
  const accountsSvc = merged.accounts ?? base.accounts
  const customersSvc = merged.customers ?? party.customers
  const suppliersSvc = merged.suppliers ?? party.suppliers
  const employeesSvc = merged.employees ?? party.employees
  const hrSvc = merged.hr ?? hr
  const companyAccountDefaultsSvc = merged.companyAccountDefaults ?? companyAccountDefaults
  const invCategories = merged.invCategories ?? inv.categories
  const invMaterials = merged.invMaterials ?? inv.materials
  const invMaterialUnits = merged.invMaterialUnits ?? inv.materialUnits
  const invWarehouses = merged.invWarehouses ?? inv.warehouses
  const invStockDocs = merged.invStockDocs ?? inv.stockDocs
  const invStockTransfers = merged.invStockTransfers ?? inv.stockTransfers
  const invStockCounts = merged.invStockCounts ?? inv.stockCounts
  const invStockEntries = merged.invStockEntries ?? inv.stockEntries
  const journals = merged.journals ?? accounting.journals
  const entries = merged.entries ?? accounting.entries
  const tradingSvc = (merged as { trading?: typeof trading }).trading ?? trading
  const scmSvc = (merged as { scm?: typeof scm }).scm ?? scm
  const invoices = (merged as { invoices?: typeof finance.invoices }).invoices ?? finance.invoices
  const banking = (merged as { banking?: typeof finance.banking }).banking ?? finance.banking
  const expenses = (merged as { expenses?: typeof finance.expenses }).expenses ?? finance.expenses
  const bills = (merged as { bills?: typeof finance.bills }).bills ?? finance.bills
  const todosSvc = (merged as { todos?: typeof todos }).todos ?? todos
  const manufacturingSvc = merged.manufacturing ?? manufacturing
  const setup =
    (merged as { setup?: ReturnType<typeof createSetupService> }).setup ??
    createSetupService({
      db,
      tokens: createTokenManager({ secret: TEST_AUTH_SECRET, ttlSeconds: 3600 }),
      seedSampleData: (actor, companyId) =>
        seedSampleData(
          {
            db,
            accounts: accountsSvc,
            companyAccountDefaults: companyAccountDefaultsSvc,
            warehouses: invWarehouses,
            customers: customersSvc,
            suppliers: suppliersSvc,
            materials: invMaterials,
            materialUnits: invMaterialUnits,
            employees: employeesSvc,
            trading: tradingSvc,
            stockDocs: invStockDocs,
            stockTransfers: invStockTransfers,
            stockCounts: invStockCounts,
            manufacturingMaster: manufacturingSvc.master,
            banking,
            journals,
            expenses,
            invoices,
            hr: hrSvc,
          },
          actor,
          companyId,
        ),
    })

  return buildApp({
    db,
    auth,
    registry,
    settings,
    numbering,
    files: merged.files,
    storages: merged.storages,
    audit: merged.audit,
    printing,
    currencies: merged.currencies ?? base.currencies,
    companies: merged.companies ?? base.companies,
    units: merged.units ?? base.units,
    accounts: accountsSvc,
    market,
    iam: merged.iam ?? iam,
    customers: customersSvc,
    suppliers: suppliersSvc,
    employees: employeesSvc,
    hr: hrSvc,
    companyAccountDefaults: companyAccountDefaultsSvc,
    invCategories,
    invMaterials,
    invMaterialUnits,
    invWarehouses,
    invStockDocs,
    invStockTransfers,
    invStockCounts,
    invStockEntries,
    journals,
    entries,
    trading: tradingSvc,
    scm: scmSvc,
    invoices,
    banking,
    expenses,
    bills,
    todos: todosSvc,
    manufacturing: manufacturingSvc,
    setup,
  })
}
