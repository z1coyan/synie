/**
 * 服务装配组合根：生产入口（index.ts）与测试基座（test/helpers.ts）共用，
 * 全量服务图只允许在这里装配一份。
 * 依赖顺序固定：平台横切 → base/market/iam/party → 库存/会计/交易链 → 财务
 * → 待办/SCM/制造 → setup（setup 的种子闭包必须看到 overrides 之后的服务集）。
 */
import type { Kysely } from 'kysely'
import type { AppDeps } from './app.ts'
import type { DB as Database } from './db/types.ts'
import { createAccountingServices } from './modules/accounting/index.ts'
import { createBaseServices } from './modules/base/index.ts'
import { createMarketService } from './modules/base/market/index.ts'
import { createHrServices } from './modules/hr/index.ts'
import { createDepartmentService, createIamService } from './modules/iam/index.ts'
import { createInventoryServices } from './modules/inventory/index.ts'
import {
  createManufacturingServices,
  createManufacturingSettingService,
  registerWorkOrderDocBuilder,
} from './modules/manufacturing/index.ts'
import { createPartyServices, registerPartyTodoSources } from './modules/party/index.ts'
import { createCompanyAccountDefaultService } from './modules/sales/index.ts'
import { createScmServices } from './modules/scm/index.ts'
import {
  createSalesSettingService,
  createTradingServices,
  registerSalesOrderDocBuilder,
} from './modules/trading/index.ts'
import {
  createAccountingSettingService,
  createFinanceServices,
  registerFinanceTodoSources,
} from './modules/finance/index.ts'
import { isJournalLinkedToBankRecon } from './modules/finance/banking-recon.ts'
import { seedMaterialCategories, seedSampleData } from './modules/setup/index.ts'
import type { TokenManager } from './platform/auth/token.ts'
import { createAuditService } from './platform/audit/index.ts'
import {
  buildOwnerRegistryFromMeta,
  createFileService,
  createStorageService,
} from './platform/files/index.ts'
import type { Registry } from './platform/meta/registry.ts'
import { buildNumberingCatalog, createNumberingService } from './platform/numbering/index.ts'
import {
  buildPrintingCatalog,
  createPrintingService,
  createSofficeConverter,
} from './platform/printing/index.ts'
import type { PDFConverter } from './platform/printing/pdf.ts'
import { createSettingsService } from './platform/settings/index.ts'
import { createSetupService, type SetupService } from './platform/setup/index.ts'
import {
  assertTodoSourcesConsistent,
  createTodoService,
  createTodoSourceRegistry,
} from './platform/todo/index.ts'

export interface CreateServicesOptions {
  registry: Registry
  tokens: TokenManager
  /** PDF 转换器；缺省走 soffice 默认配置 */
  converter?: PDFConverter
  /** 测试用：按服务整体替换装配结果；构造期依赖（如 finance 的构造参数）不回溯 */
  overrides?: Partial<Services>
}

/** 除 setup 外的完整装配图（setup 依赖其余服务，见 createServices） */
function assembleDomain(
  db: Kysely<Database>,
  opts: CreateServicesOptions,
) {
  const settings = createSettingsService(db, {
    sales: createSalesSettingService(db),
    manufacturing: createManufacturingSettingService(db),
    accounting: createAccountingSettingService(db),
  })
  const numbering = createNumberingService(db, buildNumberingCatalog(opts.registry))
  // 附件宿主从 Meta Registry 派生（meta.attachments 即声明即注册，启动期 fail-closed）
  const owners = buildOwnerRegistryFromMeta(opts.registry.list())
  const files = createFileService({ db, owners })
  const storages = createStorageService({ db })
  const audit = createAuditService(db)
  const printing = createPrintingService({
    db,
    files,
    catalog: buildPrintingCatalog(opts.registry),
    converter: opts.converter ?? createSofficeConverter(),
  })
  // 业务域 DocBuilder 显式装配（platform 不内置业务表查询）
  registerSalesOrderDocBuilder(printing, db)
  registerWorkOrderDocBuilder(printing, db)
  const base = createBaseServices(db)
  const market = createMarketService(db, { settings })
  const iam = createIamService(db, opts.registry)
  const departments = createDepartmentService(db, opts.registry)
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
  // 启动期 fail-closed：meta.todoSource 声明与注册互为镜像，draftLink/party 表列必须存在
  assertTodoSourcesConsistent(opts.registry.list(), todoSources)
  const todos = createTodoService(db, todoSources)
  const scm = createScmServices(db)
  const manufacturing = createManufacturingServices(db, numbering)
  return {
    settings,
    numbering,
    files,
    storages,
    audit,
    owners,
    printing,
    base,
    market,
    iam,
    departments,
    party,
    hr,
    companyAccountDefaults,
    inv,
    accounting,
    trading,
    finance,
    todos,
    scm,
    manufacturing,
  }
}

/** 完整服务装配图 */
export interface Services extends ReturnType<typeof assembleDomain> {
  setup: SetupService
}

/** 装配全部平台 + 领域服务；overrides 应用之后再构造 setup */
export function createServices(db: Kysely<Database>, opts: CreateServicesOptions): Services {
  const merged = { ...assembleDomain(db, opts), ...opts.overrides }
  // setup 必须在 overrides 之后构造：seedSampleData 闭包要看到替换后的服务集
  const setup =
    opts.overrides?.setup ??
    createSetupService({
      db,
      tokens: opts.tokens,
      seedMaterialCategories,
      seedSampleData: (actor, companyId) =>
        seedSampleData(
          {
            db,
            accounts: merged.base.accounts,
            companyAccountDefaults: merged.companyAccountDefaults,
            warehouses: merged.inv.warehouses,
            customers: merged.party.customers,
            suppliers: merged.party.suppliers,
            materials: merged.inv.materials,
            materialUnits: merged.inv.materialUnits,
            employees: merged.party.employees,
            trading: merged.trading,
            stockDocs: merged.inv.stockDocs,
            stockTransfers: merged.inv.stockTransfers,
            stockCounts: merged.inv.stockCounts,
            manufacturingMaster: merged.manufacturing.master,
            banking: merged.finance.banking,
            journals: merged.accounting.journals,
            expenses: merged.finance.expenses,
            invoices: merged.finance.invoices,
            hr: merged.hr,
          },
          actor,
          companyId,
        ),
    })
  return { ...merged, setup }
}

/** 服务图 → AppDeps 机械摊平（db/auth/betterAuth/logtoEnabled/registry/authz 由调用方补） */
export function toAppDeps(
  services: Services,
): Omit<AppDeps, 'db' | 'auth' | 'betterAuth' | 'logtoEnabled' | 'registry' | 'authz'> {
  const { base, party, inv, accounting, finance } = services
  return {
    settings: services.settings,
    numbering: services.numbering,
    files: services.files,
    storages: services.storages,
    audit: services.audit,
    printing: services.printing,
    currencies: base.currencies,
    companies: base.companies,
    units: base.units,
    accounts: base.accounts,
    market: services.market,
    iam: services.iam,
    departments: services.departments,
    customers: party.customers,
    suppliers: party.suppliers,
    employees: party.employees,
    partyAddresses: party.addresses,
    hr: services.hr,
    companyAccountDefaults: services.companyAccountDefaults,
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
    trading: services.trading,
    scm: services.scm,
    invoices: finance.invoices,
    banking: finance.banking,
    expenses: finance.expenses,
    bills: finance.bills,
    todos: services.todos,
    manufacturing: services.manufacturing,
    setup: services.setup,
  }
}
