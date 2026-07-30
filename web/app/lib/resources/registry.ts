import { accountClient } from './accounts'
import {
  glEntryClient,
  glJournalClient,
  glJournalCommandAdapter,
  glJournalLineClient,
} from './accounting'
import { companyClient } from './companies'
import { customerClient } from './customers'
import { currencyClient } from './currencies'
import { employeeClient } from './employees'
import { fileClient, storageClient, storageCommandAdapter } from './files'
import {
  bankAccountClient,
  bankImportClient,
  bankImportItemClient,
  bankImportTemplateClient,
  bankReconciliationClient,
  bankTransactionClient,
  bankTransactionCommandAdapter,
  billClient,
  billHoldingClient,
  billTransactionClient,
  billTransactionCommandAdapter,
  expenseReportClient,
  expenseReportCommandAdapter,
  expenseReportItemClient,
  vatInvoiceClient,
  vatInvoiceCommandAdapter,
} from './finance-operations'
import {
  purchaseOutsourcedIssueCommandAdapter,
  purchaseOutsourcedIssueClient,
  purchaseOutsourcedIssueItemClient,
  purchaseOutsourcedReceiptCommandAdapter,
  purchaseOutsourcedReceiptClient,
  purchaseOutsourcedReceiptItemByproductClient,
  purchaseOutsourcedReceiptItemClient,
  purchaseOutsourcedReceiptItemMaterialClient,
  purchaseReceiptCommandAdapter,
  purchaseReceiptClient,
  purchaseReceiptItemClient,
  salesDeliveryCommandAdapter,
  salesDeliveryClient,
  salesDeliveryDraftAdapter,
  salesDeliveryItemClient,
  salesDeliveryPackBoxClient,
  salesDeliveryPackLineClient,
} from './fulfillment'
import { roleClient, userClient } from './iam'
import {
  attendanceCorrectionClient,
  attendanceDayClient,
  attendanceDayCommandAdapter,
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
  stockCountCommandAdapter,
  stockCountClient,
  stockCountItemClient,
  stockDocCommandAdapter,
  stockDocClient,
  stockDocItemClient,
  stockEntryClient,
  stockTransferCommandAdapter,
  stockTransferClient,
  stockTransferItemClient,
  warehouseClient,
} from './inventory'
import {
  marketInstrumentClient,
  marketPricePointClient,
  marketPricePointCommandAdapter,
} from './market'
import {
  bomByproductClient,
  bomClient,
  bomComponentClient,
  bomRouteClient,
  demandCommandAdapter,
  demandClient,
  demandItemClient,
  operationClient,
  outputCommandAdapter,
  outputClient,
  outputItemClient,
  processTemplateClient,
  processTemplateItemClient,
  workOrderCommandAdapter,
  workOrderClient,
} from './manufacturing'
import { numberingCounterClient, numberingRuleClient } from './numbering'
import {
  purchaseOrderCommandAdapter,
  purchaseOrderClient,
  purchaseOrderItemByproductClient,
  purchaseOrderItemClient,
  purchaseOrderItemMaterialClient,
  salesOrderCommandAdapter,
  salesOrderClient,
  salesOrderItemClient,
} from './orders'
import { printTemplateClient, printTemplateCommandAdapter } from './printing'
import {
  companyAccountDefaultClient,
  orderFlowItemClient,
  purchaseReconciliationCommandAdapter,
  purchaseReconciliationClient,
  purchaseReconciliationItemClient,
  salesReconciliationCommandAdapter,
  salesReconciliationClient,
  salesReconciliationItemClient,
} from './reconciliations'
import {
  purchaseQuotationCommandAdapter,
  purchaseQuotationClient,
  purchaseQuotationItemClient,
  purchaseQuotationTierClient,
  salesQuotationCommandAdapter,
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
import type { ResourceTransport } from './types'
import {
  bindingFromResourceTransport,
  hasBinding,
  registerBinding,
  replaceBinding,
  resourceBindingFor as bindingFor,
  resourceTransportFromBinding,
  type CommandAdapter,
  type ResourceBinding,
} from './catalog'

const transports: Record<string, ResourceTransport> = {
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
  salDeliveryPackBoxes: salesDeliveryPackBoxClient,
  salDeliveryPackLines: salesDeliveryPackLineClient,
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

/** Catalog 声明的全部语义 CommandAdapter；禁止开放 key Proxy。 */
const SEMANTIC_COMMAND_ADAPTERS: Record<string, CommandAdapter> = {
  accBankTransactions: bankTransactionCommandAdapter,
  accBillTransactions: billTransactionCommandAdapter,
  accExpenseReports: expenseReportCommandAdapter,
  accGlJournals: glJournalCommandAdapter,
  accVatInvoices: vatInvoiceCommandAdapter,
  basMarketPricePoints: marketPricePointCommandAdapter,
  hrAttendanceDays: attendanceDayCommandAdapter,
  invStockCounts: stockCountCommandAdapter,
  invStockDocs: stockDocCommandAdapter,
  invStockTransfers: stockTransferCommandAdapter,
  mfgDemands: demandCommandAdapter,
  mfgOutputs: outputCommandAdapter,
  mfgWorkOrders: workOrderCommandAdapter,
  purOrders: purchaseOrderCommandAdapter,
  purOutsourcedIssues: purchaseOutsourcedIssueCommandAdapter,
  purOutsourcedReceipts: purchaseOutsourcedReceiptCommandAdapter,
  purQuotations: purchaseQuotationCommandAdapter,
  purReceipts: purchaseReceiptCommandAdapter,
  purReconciliations: purchaseReconciliationCommandAdapter,
  salDeliveries: salesDeliveryCommandAdapter,
  salOrders: salesOrderCommandAdapter,
  salQuotations: salesQuotationCommandAdapter,
  salReconciliations: salesReconciliationCommandAdapter,
  sysPrintTemplates: printTemplateCommandAdapter,
  sysStorages: storageCommandAdapter,
}

// 从 transport 一次性生成 ResourceBinding；命令逐资源显式挂载。
for (const [resource, transport] of Object.entries(transports)) {
  const binding = bindingFromResourceTransport(resource, transport)
  const commands = SEMANTIC_COMMAND_ADAPTERS[resource]
  if (commands) {
    registerBinding({ ...binding, commands })
  } else {
    registerBinding(binding)
  }
}

/**
 * 销售发货：聚合草稿 Adapter 是表单写 seam；不为表单暴露 RecordWriter create/update。
 * delete 仍经 writer；Grid 列表读经 reader；权威草稿读/写经 draft。
 */
{
  const base = bindingFromResourceTransport('salDeliveries', salesDeliveryClient, {
    canCreate: false,
    canUpdate: false,
    canDelete: true,
  })
  replaceBinding({
    ...base,
    draft: salesDeliveryDraftAdapter,
    commands: salesDeliveryCommandAdapter,
  })
}

function seedBinding(resource: string): void {
  const transport = transports[resource]
  if (!transport) {
    throw new Error(`资源「${resource}」未注册 ResourceBinding`)
  }
  let binding = bindingFromResourceTransport(
    resource,
    transport,
    resource === 'salDeliveries'
      ? { canCreate: false, canUpdate: false, canDelete: true }
      : undefined,
  )
  const commands = SEMANTIC_COMMAND_ADAPTERS[resource]
  if (commands) binding = { ...binding, commands }
  if (resource === 'salDeliveries') {
    binding = { ...binding, draft: salesDeliveryDraftAdapter }
  }
  if (hasBinding(resource)) replaceBinding(binding)
  else registerBinding(binding)
}

/**
 * 类型安全 ResourceBinding 入口（唯一资源解析）。未知资源显式失败。
 * 若测试 clear 了 binding 表，按传输表防御性补种（仍不接受未知资源名）。
 */
export function resourceBindingFor(resource: string): ResourceBinding {
  if (!hasBinding(resource)) seedBinding(resource)
  return bindingFor(resource)
}

/**
 * 从 binding 派生传输对象（query/get/可选写）。
 * 不含 meta；供仍接受 client prop 的组件过渡使用。
 */
export function resourceTransportFromResourceBinding(resource: string): ResourceTransport {
  return resourceTransportFromBinding(resourceBindingFor(resource))
}

/** 从唯一 binding 派生 query/get + 实际普通写能力。 */
export function resourceTransportFor(resource: string): ResourceTransport {
  return resourceTransportFromResourceBinding(resource)
}

/** 绑定资源键列表 */
export function listResourceBindingKeys(): string[] {
  return Object.keys(transports).sort()
}
