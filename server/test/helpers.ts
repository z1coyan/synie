import type { Kysely } from 'kysely'
import { buildApp, type AppDeps, type ApiType } from '~/app.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  createAccountingServices,
  registerAccountingResources,
} from '~/modules/accounting/index.ts'
import { createBaseServices, registerBaseResources } from '~/modules/base/index.ts'
import {
  createMarketInstrumentService,
  registerMarketResources,
} from '~/modules/base/market/index.ts'
import { createIamService, registerIamResources } from '~/modules/iam/index.ts'
import { createPartyServices, registerPartyResources } from '~/modules/party/index.ts'
import {
  createCompanyAccountDefaultService,
  registerSalesCompanyAccountDefault,
} from '~/modules/sales/index.ts'
import {
  createInventoryServices,
  registerInventoryResources,
} from '~/modules/inventory/index.ts'
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
  registerSalesCompanyAccountDefault(registry)
  registerInventoryResources(registry)
  registerAccountingResources(registry)
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
  return {
    settings: createSettingsService(db),
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
  const base = createBaseServices(db)
  const marketInstruments = createMarketInstrumentService(db)
  const iam = createIamService(db, registry)
  const party = createPartyServices(db, numbering)
  const companyAccountDefaults = createCompanyAccountDefaultService(db)
  const inv = createInventoryServices(db, numbering)
  const accounting = createAccountingServices(db, numbering)
  return buildApp({
    db,
    auth,
    registry,
    settings: merged.settings,
    numbering,
    files: merged.files,
    storages: merged.storages,
    audit: merged.audit,
    currencies: merged.currencies ?? base.currencies,
    companies: merged.companies ?? base.companies,
    units: merged.units ?? base.units,
    accounts: merged.accounts ?? base.accounts,
    marketInstruments: merged.marketInstruments ?? marketInstruments,
    iam: merged.iam ?? iam,
    customers: merged.customers ?? party.customers,
    suppliers: merged.suppliers ?? party.suppliers,
    employees: merged.employees ?? party.employees,
    companyAccountDefaults: merged.companyAccountDefaults ?? companyAccountDefaults,
    invCategories: merged.invCategories ?? inv.categories,
    invMaterials: merged.invMaterials ?? inv.materials,
    invMaterialUnits: merged.invMaterialUnits ?? inv.materialUnits,
    invWarehouses: merged.invWarehouses ?? inv.warehouses,
    invStockDocs: merged.invStockDocs ?? inv.stockDocs,
    invStockTransfers: merged.invStockTransfers ?? inv.stockTransfers,
    invStockCounts: merged.invStockCounts ?? inv.stockCounts,
    invStockEntries: merged.invStockEntries ?? inv.stockEntries,
    journals: merged.journals ?? accounting.journals,
    entries: merged.entries ?? accounting.entries,
  })
}
