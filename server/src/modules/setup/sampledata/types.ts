import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import type { AuthzEnforcer } from '~/platform/authz/enforce.ts'
import type { JournalService } from '~/modules/accounting/journal-service.ts'
import type { AccountService } from '~/modules/base/account-service.ts'
import type { BankingService } from '~/modules/finance/banking-service.ts'
import type { BankAccountService } from '~/modules/finance/banking-accounts.ts'
import type { ExpenseService } from '~/modules/finance/expense-service.ts'
import type { VatInvoiceService } from '~/modules/finance/invoice-service.ts'
import type { HrServices } from '~/modules/hr/index.ts'
import type {
  MaterialService,
  MaterialUnitService,
  StockCountService,
  StockDocService,
  StockTransferService,
  WarehouseService,
} from '~/modules/inventory/index.ts'
import type { MasterService } from '~/modules/manufacturing/master-service.ts'
import type {
  CustomerService,
  EmployeeService,
  SupplierService,
} from '~/modules/party/party-service.ts'
import type { CompanyAccountDefaultService } from '~/modules/sales/company-account-default.ts'
import type { TradingServices } from '~/modules/trading/index.ts'

/** 示例种子所需领域服务（各服务自开事务） */
export interface SampleDataDeps {
  db: Kysely<Database>
  /** 已迁 Permit 的服务按种子 actor 现取凭证（种子不绕过判定） */
  authz: AuthzEnforcer
  accounts: AccountService
  companyAccountDefaults: CompanyAccountDefaultService
  warehouses: WarehouseService
  customers: CustomerService
  suppliers: SupplierService
  materials: MaterialService
  materialUnits: MaterialUnitService
  employees: EmployeeService
  trading: TradingServices
  stockDocs: StockDocService
  stockTransfers: StockTransferService
  stockCounts: StockCountService
  manufacturingMaster: MasterService
  banking: BankingService
  bankAccounts: BankAccountService
  journals: JournalService
  expenses: ExpenseService
  invoices: VatInvoiceService
  hr: HrServices
}

/** 示例数据摘要 wire 形状：唯一事实源在 platform/setup/service.ts（modules→platform 方向合法） */
export type { SampleSummary } from '~/platform/setup/service.ts'

export interface PurchaseResult {
  quotations: string[]
  orders: string[]
  receipts: string[]
  reconciliations: string[]
  confirmedReconciliation: string
  confirmedBaseGrossTotal: string
  quotationItems: Record<string, Record<string, string>>
  orderItems: Record<string, Record<number, string>>
  receiptItems: Record<string, Record<number, string>>
}

export interface SalesResult {
  quotations: string[]
  orders: string[]
  deliveries: string[]
  reconciliations: string[]
  confirmedReconciliation: string
  confirmedBaseGrossTotal: string
  quotationItems: Record<string, Record<string, string>>
  orderItems: Record<string, Record<number, string>>
  deliveryItems: Record<string, Record<number, string>>
}

export interface MfgResult {
  operations: string[]
  processTemplates: string[]
  boms: string[]
  opsByName: Record<string, string>
}

export interface OutsourcedResult {
  boms: string[]
  orders: string[]
  issues: string[]
  receipts: string[]
  reconciliations: string[]
}

export interface FinanceResult {
  bankTransactions: number
  glJournals: number
  payrolls: number
  vatInvoices: number
}

export interface ReconLine {
  sourceItemId: string
  qty: number
  kind: 'delivery' | 'receipt' | 'outsourced'
}
