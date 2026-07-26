import { accountClient } from './accounts'
import {
  glEntryClient,
  glJournalClient,
  glJournalLineClient,
} from './accounting'
import { companyClient } from './companies'
import { customerClient } from './customers'
import { currencyClient } from './currencies'
import { employeeClient } from './employees'
import { fileClient, storageClient } from './files'
import {
  bankAccountClient,
  bankImportClient,
  bankImportItemClient,
  bankImportTemplateClient,
  bankReconciliationClient,
  bankTransactionClient,
  billClient,
  billHoldingClient,
  billTransactionClient,
  expenseReportClient,
  expenseReportItemClient,
  vatInvoiceClient,
} from './finance-operations'
import {
  purchaseOutsourcedIssueClient,
  purchaseOutsourcedIssueItemClient,
  purchaseOutsourcedReceiptClient,
  purchaseOutsourcedReceiptItemByproductClient,
  purchaseOutsourcedReceiptItemClient,
  purchaseOutsourcedReceiptItemMaterialClient,
  purchaseReceiptClient,
  purchaseReceiptItemClient,
  salesDeliveryClient,
  salesDeliveryItemClient,
} from './fulfillment'
import { roleClient, userClient } from './iam'
import {
  attendanceCorrectionClient,
  attendanceDayClient,
  attendanceImportClient,
  attendancePunchClient,
  employeeLoanClient,
  payrollClient,
  payrollPaymentClient,
} from './hr-operations'
import {
  materialCategoryClient,
  materialClient,
  materialUnitClient,
  stockCountClient,
  stockCountItemClient,
  stockDocClient,
  stockDocItemClient,
  stockEntryClient,
  stockTransferClient,
  stockTransferItemClient,
  warehouseClient,
} from './inventory'
import { marketInstrumentClient, marketPricePointClient } from './market'
import {
  bomByproductClient,
  bomClient,
  bomComponentClient,
  bomRouteClient,
  demandClient,
  demandItemClient,
  operationClient,
  outputClient,
  outputItemClient,
  processTemplateClient,
  processTemplateItemClient,
  workOrderClient,
} from './manufacturing'
import { numberingCounterClient, numberingRuleClient } from './numbering'
import {
  purchaseOrderClient,
  purchaseOrderItemByproductClient,
  purchaseOrderItemClient,
  purchaseOrderItemMaterialClient,
  salesOrderClient,
  salesOrderItemClient,
} from './orders'
import { printTemplateClient } from './printing'
import {
  companyAccountDefaultClient,
  orderFlowItemClient,
  purchaseReconciliationClient,
  purchaseReconciliationItemClient,
  salesReconciliationClient,
  salesReconciliationItemClient,
} from './reconciliations'
import {
  purchaseQuotationClient,
  purchaseQuotationItemClient,
  purchaseQuotationTierClient,
  salesQuotationClient,
  salesQuotationItemClient,
  salesQuotationTierClient,
} from './quotations'
import { supplierClient } from './suppliers'
import {
  accountingSettingClient,
  manufacturingSettingClient,
  salesSettingClient,
  systemSettingClient,
} from './settings'
import { auditLogClient } from './system-ops'
import { unitClient } from './units'
import type { ResourceClient } from './types'

const clients: Record<string, ResourceClient> = {
  accGlEntries: glEntryClient,
  accGlJournals: glJournalClient,
  accGlJournalLines: glJournalLineClient,
  accBankAccounts: bankAccountClient,
  accBankTransactions: bankTransactionClient,
  accBankImportTemplates: bankImportTemplateClient,
  accBankImports: bankImportClient,
  accBankImportItems: bankImportItemClient,
  accBankReconciliations: bankReconciliationClient,
  accVatInvoices: vatInvoiceClient,
  accExpenseReports: expenseReportClient,
  accExpenseReportItems: expenseReportItemClient,
  accBills: billClient,
  accBillTransactions: billTransactionClient,
  accBillHoldings: billHoldingClient,
  basAccounts: accountClient,
  basCompanies: companyClient,
  basCurrencies: currencyClient,
  basMarketInstruments: marketInstrumentClient,
  basMarketPricePoints: marketPricePointClient,
  basUnits: unitClient,
  invMaterialCategories: materialCategoryClient,
  invMaterials: materialClient,
  invMaterialUnits: materialUnitClient,
  invWarehouses: warehouseClient,
  invStockEntries: stockEntryClient,
  invStockDocs: stockDocClient,
  invStockDocItems: stockDocItemClient,
  invStockTransfers: stockTransferClient,
  invStockTransferItems: stockTransferItemClient,
  invStockCounts: stockCountClient,
  invStockCountItems: stockCountItemClient,
  mfgOperations: operationClient,
  mfgProcessTemplates: processTemplateClient,
  mfgProcessTemplateItems: processTemplateItemClient,
  mfgBoms: bomClient,
  mfgBomComponents: bomComponentClient,
  mfgBomRoutes: bomRouteClient,
  mfgBomByproducts: bomByproductClient,
  mfgDemands: demandClient,
  mfgDemandItems: demandItemClient,
  mfgWorkOrders: workOrderClient,
  mfgOutputs: outputClient,
  mfgOutputItems: outputItemClient,
  hrEmployees: employeeClient,
  hrAttendancePunches: attendancePunchClient,
  hrAttendanceImports: attendanceImportClient,
  hrAttendanceDays: attendanceDayClient,
  hrAttendanceCorrections: attendanceCorrectionClient,
  hrPayrolls: payrollClient,
  hrPayrollPayments: payrollPaymentClient,
  hrEmployeeLoans: employeeLoanClient,
  purSuppliers: supplierClient,
  purOrders: purchaseOrderClient,
  purOrderItems: purchaseOrderItemClient,
  purOrderItemMaterials: purchaseOrderItemMaterialClient,
  purOrderItemByproducts: purchaseOrderItemByproductClient,
  purOutsourcedIssues: purchaseOutsourcedIssueClient,
  purOutsourcedIssueItems: purchaseOutsourcedIssueItemClient,
  purOutsourcedReceipts: purchaseOutsourcedReceiptClient,
  purOutsourcedReceiptItems: purchaseOutsourcedReceiptItemClient,
  purOutsourcedReceiptItemMaterials:
    purchaseOutsourcedReceiptItemMaterialClient,
  purOutsourcedReceiptItemByproducts:
    purchaseOutsourcedReceiptItemByproductClient,
  purReceipts: purchaseReceiptClient,
  purReceiptItems: purchaseReceiptItemClient,
  purReconciliations: purchaseReconciliationClient,
  purReconciliationItems: purchaseReconciliationItemClient,
  purQuotations: purchaseQuotationClient,
  purQuotationItems: purchaseQuotationItemClient,
  purQuotationTiers: purchaseQuotationTierClient,
  salCustomers: customerClient,
  salOrders: salesOrderClient,
  salOrderItems: salesOrderItemClient,
  salDeliveries: salesDeliveryClient,
  salDeliveryItems: salesDeliveryItemClient,
  salReconciliations: salesReconciliationClient,
  salReconciliationItems: salesReconciliationItemClient,
  salCompanyAccountDefaults: companyAccountDefaultClient,
  salQuotations: salesQuotationClient,
  salQuotationItems: salesQuotationItemClient,
  salQuotationTiers: salesQuotationTierClient,
  sysFiles: fileClient,
  sysNumberingCounters: numberingCounterClient,
  sysNumberingRules: numberingRuleClient,
  sysPrintTemplates: printTemplateClient,
  accSettings: accountingSettingClient,
  mfgSettings: manufacturingSettingClient,
  salSettings: salesSettingClient,
  sysSettings: systemSettingClient,
  sysAuditLogs: auditLogClient,
  sysRoles: roleClient,
  sysStorages: storageClient,
  sysUsers: userClient,
  scmOrderFlowItems: orderFlowItemClient,
}

/**
 * 共享资源组件的唯一默认解析入口。
 * 调用方未显式传 client 时必须命中 registry；禁止静默回退到其他传输层。
 */
export function resourceClientFor(resource: string): ResourceClient {
  const client = clients[resource]
  if (!client) {
    throw new Error(`资源「${resource}」未注册 REST ResourceClient`)
  }
  return client
}
