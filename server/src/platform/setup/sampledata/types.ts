import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import type { JournalService } from '~/modules/accounting/journal-service.ts'
import type { AccountService } from '~/modules/base/account-service.ts'
import type { BankingService } from '~/modules/finance/banking-service.ts'
import type { ExpenseService } from '~/modules/finance/expense-service.ts'
import type { VatInvoiceService } from '~/modules/finance/invoice-service.ts'
import type { HrService } from '~/modules/hr/index.ts'
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
  journals: JournalService
  expenses: ExpenseService
  invoices: VatInvoiceService
  hr: HrService
}

export interface SampleSummary {
  customers: number
  suppliers: number
  materials: number
  employees: number
  salesQuotations: number
  purchaseQuotations: number
  salesOrders: number
  purchaseOrders: number
  salesDeliveries: number
  purchaseReceipts: number
  salesReconciliations: number
  purchaseReconciliations: number
  stockDocs: number
  stockTransfers: number
  stockCounts: number
  operations: number
  processTemplates: number
  boms: number
  bankAccounts: number
  bankTransactions: number
  glJournals: number
  expenseReports: number
  payrolls: number
  vatInvoices: number
  outsourcedOrders: number
  outsourcedIssues: number
  outsourcedReceipts: number
}

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
