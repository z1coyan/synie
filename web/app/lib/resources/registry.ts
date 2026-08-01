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
import { purchaseReceiptDraftAdapter } from './purchase-receipt-draft'
import {
  purchaseQuotationDraftAdapter,
  salesQuotationDraftAdapter,
} from './quotation-draft'
import {
  purchaseOrderDraftAdapter,
  salesOrderDraftAdapter,
} from './order-draft'
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
  bomCommandAdapter,
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
  registerBinding,
  replaceBinding,
  resourceTransportFromBinding,
  type CommandAdapter,
  type AggregateDraftAdapter,
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
  mfgBoms: bomCommandAdapter,
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

const DRAFT_ADAPTERS = {
  purOrders: purchaseOrderDraftAdapter,
  purQuotations: purchaseQuotationDraftAdapter,
  purReceipts: purchaseReceiptDraftAdapter,
  salDeliveries: salesDeliveryDraftAdapter,
  salOrders: salesOrderDraftAdapter,
  salQuotations: salesQuotationDraftAdapter,
} satisfies Record<string, AggregateDraftAdapter<unknown, unknown>>

type AggregateDraftResource = keyof typeof DRAFT_ADAPTERS

/**
 * 聚合头资源不通过普通 RecordWriter 暴露 create/update。
 * 删除草稿仍是单记录命令，继续保留 writer.delete。
 */
const AGGREGATE_WRITER_OPTIONS: Record<
  AggregateDraftResource,
  { canCreate: false; canUpdate: false; canDelete: true }
> = {
  purOrders: { canCreate: false, canUpdate: false, canDelete: true },
  purQuotations: { canCreate: false, canUpdate: false, canDelete: true },
  purReceipts: { canCreate: false, canUpdate: false, canDelete: true },
  salDeliveries: { canCreate: false, canUpdate: false, canDelete: true },
  salOrders: { canCreate: false, canUpdate: false, canDelete: true },
  salQuotations: { canCreate: false, canUpdate: false, canDelete: true },
}

function draftAdapterFor(resource: string): AggregateDraftAdapter | undefined {
  return DRAFT_ADAPTERS[resource as AggregateDraftResource] as
    | AggregateDraftAdapter
    | undefined
}

function aggregateWriterOptions(resource: string) {
  return AGGREGATE_WRITER_OPTIONS[resource as AggregateDraftResource]
}

// 从 transport 一次性生成规范 ResourceBinding；命令与 Aggregate Draft 逐资源显式挂载。
const productionBindings = new Map<string, ResourceBinding>()
for (const [resource, transport] of Object.entries(transports)) {
  const binding = bindingFromResourceTransport(
    resource,
    transport,
    aggregateWriterOptions(resource),
  )
  const commands = SEMANTIC_COMMAND_ADAPTERS[resource]
  const draft = draftAdapterFor(resource)
  const productionBinding = {
    ...binding,
    ...(commands ? { commands } : {}),
    ...(draft ? { draft } : {}),
  }
  productionBindings.set(resource, productionBinding)
  registerBinding(productionBinding)
}

/**
 * 类型安全 ResourceBinding 入口（唯一资源解析）。未知资源显式失败。
 * 生产入口始终恢复模块装配时创建的规范 binding；测试/本地自定义 binding 应通过
 * 显式 Adapter seam 或注入 resolver 使用，不能污染同名生产资源。
 */
export function resourceBindingFor(resource: string): ResourceBinding {
  const binding = productionBindings.get(resource)
  if (!binding) {
    throw new Error(`资源「${resource}」未注册 ResourceBinding`)
  }
  replaceBinding(binding)
  return binding
}

/** 已注册 Aggregate Draft 的类型恢复入口；未知或漏挂能力显式失败。 */
export function aggregateDraftFor<K extends AggregateDraftResource>(
  resource: K,
): (typeof DRAFT_ADAPTERS)[K] {
  const draft = resourceBindingFor(resource).draft
  if (!draft) {
    throw new Error(`资源「${resource}」未注册 Aggregate Draft Adapter`)
  }
  return draft as (typeof DRAFT_ADAPTERS)[K]
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
