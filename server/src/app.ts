import { Hono, type MiddlewareHandler } from 'hono'
import { requestId } from 'hono/request-id'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DB as Database } from './db/types.ts'
import { accountingRoutes } from './modules/accounting/index.ts'
import type { EntryService } from './modules/accounting/entry-service.ts'
import type { JournalService } from './modules/accounting/journal-service.ts'
import { baseRoutes } from './modules/base/index.ts'
import type { AccountService } from './modules/base/account-service.ts'
import type { CompanyService } from './modules/base/company-service.ts'
import type { CurrencyService } from './modules/base/currency-service.ts'
import type { UnitService } from './modules/base/unit-service.ts'
import {
  marketInstrumentRoutes,
  marketPricePointRoutes,
} from './modules/base/market/index.ts'
import type { MarketService } from './modules/base/market/index.ts'
import {
  attendanceCorrectionRoutes,
  attendanceDayRoutes,
  attendanceImportRoutes,
  attendancePunchRoutes,
  employeeLoanRoutes,
  payrollPaymentRoutes,
  payrollRoutes,
  type HrServices,
} from './modules/hr/index.ts'
import { iamDepartmentRoutes, iamRoleRoutes, iamUserRoutes } from './modules/iam/index.ts'
import type { DepartmentService } from './modules/iam/index.ts'
import type { IamService } from './modules/iam/service.ts'
import {
  customerRoutes,
  employeeRoutes,
  partyAddressRoutes,
  supplierRoutes,
} from './modules/party/index.ts'
import type { PartyAddressService } from './modules/party/address-service.ts'
import type {
  CustomerService,
  EmployeeService,
  SupplierService,
} from './modules/party/party-service.ts'
import { companyAccountDefaultRoutes } from './modules/sales/index.ts'
import type { CompanyAccountDefaultService } from './modules/sales/company-account-default.ts'
import { inventoryMasterRoutes, inventoryRoutes } from './modules/inventory/index.ts'
import type {
  MaterialCategoryService,
  MaterialService,
  MaterialUnitService,
  WarehouseService,
  StockDocService,
  StockTransferService,
  StockCountService,
  StockEntryService,
} from './modules/inventory/index.ts'
import { tradingRouteMounts, type TradingServices } from './modules/trading/index.ts'
import { scmRouteMounts, type ScmServices } from './modules/scm/index.ts'
import { manufacturingRoutes, type ManufacturingServices } from './modules/manufacturing/index.ts'
import {
  vatInvoiceRoutes,
  bankAccountRoutes,
  bankTransactionRoutes,
  bankImportTemplateRoutes,
  bankImportRoutes,
  bankImportItemRoutes,
  bankReconciliationRoutes,
  expenseReportRoutes,
  expenseReportItemRoutes,
  billRoutes,
  billTransactionRoutes,
  billHoldingRoutes,
  type VatInvoiceService,
  type BankingService,
  type ExpenseService,
  type BillService,
} from './modules/finance/index.ts'
import type { SynieBetterAuth } from './platform/auth/better-auth.ts'
import { authRoutes } from './platform/auth/routes.ts'
import type { AuthService } from './platform/auth/service.ts'
import type { AppEnv } from './platform/http/context.ts'
import { notFound, onError } from './platform/http/errors.ts'
import { logJson, serializeError } from './platform/http/log.ts'
import { metaRoutes } from './platform/meta/routes.ts'
import type { Registry } from './platform/meta/registry.ts'
import { auditRoutes } from './platform/audit/routes.ts'
import type { AuditService } from './platform/audit/service.ts'
import { fileRoutes, storageRoutes } from './platform/files/routes.ts'
import type { FileService } from './platform/files/service.ts'
import type { StorageService } from './platform/files/storage-service.ts'
import { numberingRoutes } from './platform/numbering/routes.ts'
import type { NumberingService } from './platform/numbering/service.ts'
import { settingsRoutes } from './platform/settings/routes.ts'
import type { SettingsService } from './platform/settings/service.ts'
import { printingRoutes, systemPrintingRoutes } from './platform/printing/routes.ts'
import type { PrintingService } from './platform/printing/service.ts'
import { todoRoutes, type TodoService } from './platform/todo/index.ts'
import type { AuthzEnforcer } from './platform/authz/enforce.ts'
import { setupRoutes, type SetupService } from './platform/setup/index.ts'

/**
 * 应用依赖。平台 + base/iam/party + 库存 + 会计 + 交易链。
 * 路由必须链式 .route() + zValidator，保 ApiType 类型链。
 */
export interface AppDeps {
  db: Kysely<Database>
  auth: AuthService
  /** better-auth 实例（cookie 会话通道；/auth/* 具体路由之外的兜底 handler） */
  betterAuth: SynieBetterAuth
  /** Logto OIDC 是否启用（env 三件套齐备）；透出到 setup status 供登录页判断 */
  logtoEnabled: boolean
  registry: Registry
  /** 授权执行面（guard / decideFor / targetOf）；由 registry 派生 */
  authz: AuthzEnforcer
  settings: SettingsService
  numbering: NumberingService
  files: FileService
  storages: StorageService
  audit: AuditService
  printing: PrintingService
  currencies: CurrencyService
  companies: CompanyService
  units: UnitService
  accounts: AccountService
  market: MarketService
  iam: IamService
  /** 部门（组织树主数据）；新授权体系首个 guard/Permit 消费者 */
  departments: DepartmentService
  customers: CustomerService
  suppliers: SupplierService
  employees: EmployeeService
  partyAddresses: PartyAddressService
  hr: HrServices
  companyAccountDefaults: CompanyAccountDefaultService
  // 工单 04 库存
  invCategories: MaterialCategoryService
  invMaterials: MaterialService
  invMaterialUnits: MaterialUnitService
  invWarehouses: WarehouseService
  invStockDocs: StockDocService
  invStockTransfers: StockTransferService
  invStockCounts: StockCountService
  invStockEntries: StockEntryService
  // 工单 05 会计
  journals: JournalService
  entries: EntryService
  // 工单 06/07/08 交易链 + 对账
  trading: TradingServices
  // 工单 08 订单流只读投影
  scm: ScmServices
  // 工单 09 发票 + 待办
  invoices: VatInvoiceService
  // 工单 12 银行/票据/报销
  banking: BankingService
  expenses: ExpenseService
  bills: BillService
  todos: TodoService
  // 工单 11 制造
  manufacturing: ManufacturingServices
  // 工单 16 初始化向导
  setup: SetupService
}

/**
 * 访问日志：请求结束后落盘。
 * - 5xx 用 error 级别（即使 handler 直接 return 500 未 throw，也能在日志里定位）
 * - finally 保证 next() 异常路径也会尽量写出一行（若 onError 已写 response）
 */
const accessLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = performance.now()
  try {
    await next()
  } finally {
    const status = c.res?.status ?? 0
    const entry = {
      requestId: c.get('requestId'),
      method: c.req.method,
      path: c.req.path,
      status,
      ms: Math.round(performance.now() - start),
    }
    if (status >= 500) {
      logJson('error', 'http_request', entry)
    } else {
      logJson('info', 'http_request', entry)
    }
  }
}

export function buildApp(deps: AppDeps) {
  const app = new Hono<AppEnv>()
    .basePath('/api/v1')
    .use('*', requestId())
    .use('*', accessLog)
    .get('/healthz', async (c) => {
      try {
        await sql`select 1`.execute(deps.db)
        return c.json({ status: 'ok' })
      } catch (err) {
        logJson('error', 'healthz_db_failed', {
          requestId: c.get('requestId'),
          error: serializeError(err),
        })
        return c.json({ error: { code: 'internal', message: '数据库不可用' } }, 503)
      }
    })
    .route(
      '/setup',
      setupRoutes({ auth: deps.auth, setup: deps.setup, logtoEnabled: deps.logtoEnabled }),
    )
    // 具体路由（/auth/login、/auth/me，旧契约）先注册先匹配；其余 /auth/* 兜底给 better-auth
    .route('/auth', authRoutes(deps.auth))
    .on(['GET', 'POST'], '/auth/*', (c) => deps.betterAuth.handler(c.req.raw))
    .route('/meta', metaRoutes(deps.registry, deps.auth))
    .route('/settings', settingsRoutes({ auth: deps.auth, settings: deps.settings }))
    .route('/system/numbering', numberingRoutes({ auth: deps.auth, numbering: deps.numbering }))
    .route('/files', fileRoutes({ auth: deps.auth, authz: deps.authz, files: deps.files }))
    .route(
      '/system/storages',
      storageRoutes({ auth: deps.auth, authz: deps.authz, storages: deps.storages }),
    )
    .route('/system/audit-logs', auditRoutes({ auth: deps.auth, audit: deps.audit }))
    .route(
      '/system/printing',
      systemPrintingRoutes({ auth: deps.auth, printing: deps.printing }),
    )
    .route('/printing', printingRoutes({ auth: deps.auth, printing: deps.printing }))
    .route(
      '/base',
      baseRoutes({
        auth: deps.auth,
        currencies: deps.currencies,
        companies: deps.companies,
        units: deps.units,
        accounts: deps.accounts,
      }),
    )
    .route(
      '/base/market-instruments',
      marketInstrumentRoutes({
        auth: deps.auth,
        market: deps.market,
      }),
    )
    .route(
      '/base/market-price-points',
      marketPricePointRoutes({
        auth: deps.auth,
        market: deps.market,
      }),
    )
    .route('/system/users', iamUserRoutes({ auth: deps.auth, iam: deps.iam }))
    .route(
      '/system/departments',
      iamDepartmentRoutes({ auth: deps.auth, authz: deps.authz, departments: deps.departments }),
    )
    .route('/system/roles', iamRoleRoutes({ auth: deps.auth, iam: deps.iam }))
    .route('/base/customers', customerRoutes({ auth: deps.auth, customers: deps.customers }))
    .route('/base/suppliers', supplierRoutes({ auth: deps.auth, suppliers: deps.suppliers }))
    .route(
      '/base/party-addresses',
      partyAddressRoutes({ auth: deps.auth, addresses: deps.partyAddresses }),
    )
    .route('/hr/employees', employeeRoutes({ auth: deps.auth, employees: deps.employees }))
    .route(
      '/hr/attendance-punches',
      attendancePunchRoutes({ auth: deps.auth, attendance: deps.hr.attendance }),
    )
    .route(
      '/hr/attendance-imports',
      attendanceImportRoutes({ auth: deps.auth, attendance: deps.hr.attendance }),
    )
    .route(
      '/hr/attendance-days',
      attendanceDayRoutes({ auth: deps.auth, attendance: deps.hr.attendance }),
    )
    .route(
      '/hr/attendance-corrections',
      attendanceCorrectionRoutes({ auth: deps.auth, attendance: deps.hr.attendance }),
    )
    .route('/hr/payrolls', payrollRoutes({ auth: deps.auth, payroll: deps.hr.payroll }))
    .route(
      '/hr/payroll-payments',
      payrollPaymentRoutes({ auth: deps.auth, payroll: deps.hr.payroll }),
    )
    .route(
      '/hr/employee-loans',
      employeeLoanRoutes({ auth: deps.auth, payroll: deps.hr.payroll }),
    )
    .route(
      '/sales/company-account-defaults',
      companyAccountDefaultRoutes({
        auth: deps.auth,
        defaults: deps.companyAccountDefaults,
      }),
    )
    .route(
      '/base',
      inventoryMasterRoutes({
        auth: deps.auth,
        categories: deps.invCategories,
        materials: deps.invMaterials,
        materialUnits: deps.invMaterialUnits,
        warehouses: deps.invWarehouses,
      }),
    )
    .route(
      '/inventory',
      inventoryRoutes({
        auth: deps.auth,
        stockDocs: deps.invStockDocs,
        stockTransfers: deps.invStockTransfers,
        stockCounts: deps.invStockCounts,
        stockEntries: deps.invStockEntries,
      }),
    )
    .route(
      '/accounting',
      accountingRoutes({
        auth: deps.auth,
        journals: deps.journals,
        entries: deps.entries,
      }),
    )
    .route(
      '/finance/vat-invoices',
      vatInvoiceRoutes({ auth: deps.auth, invoices: deps.invoices }),
    )
    .route(
      '/finance/bank-accounts',
      bankAccountRoutes({ auth: deps.auth, banking: deps.banking }),
    )
    .route(
      '/finance/bank-transactions',
      bankTransactionRoutes({ auth: deps.auth, banking: deps.banking }),
    )
    .route(
      '/finance/bank-import-templates',
      bankImportTemplateRoutes({ auth: deps.auth, banking: deps.banking }),
    )
    .route(
      '/finance/bank-imports',
      bankImportRoutes({ auth: deps.auth, banking: deps.banking }),
    )
    .route(
      '/finance/bank-import-items',
      bankImportItemRoutes({ auth: deps.auth, banking: deps.banking }),
    )
    .route(
      '/finance/bank-reconciliations',
      bankReconciliationRoutes({ auth: deps.auth, banking: deps.banking }),
    )
    .route(
      '/finance/expense-reports',
      expenseReportRoutes({ auth: deps.auth, expenses: deps.expenses }),
    )
    .route(
      '/finance/expense-report-items',
      expenseReportItemRoutes({ auth: deps.auth, expenses: deps.expenses }),
    )
    .route('/finance/bills', billRoutes({ auth: deps.auth, bills: deps.bills }))
    .route(
      '/finance/bill-transactions',
      billTransactionRoutes({ auth: deps.auth, bills: deps.bills }),
    )
    .route(
      '/finance/bill-holdings',
      billHoldingRoutes({ auth: deps.auth, bills: deps.bills }),
    )
    .route('/todos', todoRoutes({ auth: deps.auth, todos: deps.todos }))
    .route(
      '/manufacturing',
      manufacturingRoutes({
        auth: deps.auth,
        authz: deps.authz,
        master: deps.manufacturing.master,
        demands: deps.manufacturing.demands,
        workOrders: deps.manufacturing.workOrders,
        outputs: deps.manufacturing.outputs,
        moldDesigns: deps.manufacturing.moldDesigns,
      }),
    )

  const t = tradingRouteMounts({ auth: deps.auth, trading: deps.trading })
  const s = scmRouteMounts({ auth: deps.auth, scm: deps.scm })
  const app2 = app
    .route('/sales/quotations', t.salesQuotations)
    .route('/sales/quotation-items', t.salesQuotationItems)
    .route('/sales/quotation-tiers', t.salesQuotationTiers)
    .route('/purchase/quotations', t.purchaseQuotations)
    .route('/purchase/quotation-items', t.purchaseQuotationItems)
    .route('/purchase/quotation-tiers', t.purchaseQuotationTiers)
    .route('/sales/orders', t.salesOrders)
    .route('/sales/order-items', t.salesOrderItems)
    .route('/purchase/orders', t.purchaseOrders)
    .route('/purchase/order-items', t.purchaseOrderItems)
    .route('/purchase/order-item-materials', t.purchaseOrderItemMaterials)
    .route('/purchase/order-item-byproducts', t.purchaseOrderItemByproducts)
    .route('/purchase/order-demand-lines', t.purchaseOrderDemandLines)
    .route('/purchase/order-bom', t.purchaseOrderBom)
    .route('/sales/deliveries', t.salesDeliveries)
    .route('/sales/delivery-items', t.salesDeliveryItems)
    .route('/sales/delivery-pack-boxes', t.salesDeliveryPackBoxes)
    .route('/sales/delivery-pack-lines', t.salesDeliveryPackLines)
    .route('/purchase/receipts', t.purchaseReceipts)
    .route('/purchase/receipt-items', t.purchaseReceiptItems)
    .route('/purchase/outsourced-issues', t.outsourcedIssues)
    .route('/purchase/outsourced-issue-items', t.outsourcedIssueItems)
    .route('/purchase/outsourced-receipts', t.outsourcedReceipts)
    .route('/purchase/outsourced-receipt-items', t.outsourcedReceiptItems)
    .route('/purchase/outsourced-receipt-item-materials', t.outsourcedReceiptItemMaterials)
    .route('/purchase/outsourced-receipt-item-byproducts', t.outsourcedReceiptItemByproducts)
    .route('/sales/reconciliations', t.salesReconciliations)
    .route('/sales/reconciliation-items', t.salesReconciliationItems)
    .route('/purchase/reconciliations', t.purchaseReconciliations)
    .route('/purchase/reconciliation-items', t.purchaseReconciliationItems)
    .route('/base/order-flow-items', s.orderFlowItems)

  app2.onError(onError)
  app2.notFound(notFound)
  return app2
}

export type ApiType = ReturnType<typeof buildApp>
