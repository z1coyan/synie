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
import {
  bindingFromResourceClient,
  hasBinding,
  registerBinding,
  replaceBinding,
  resourceBindingFor as bindingFor,
  resourceClientFromBinding,
  type CommandAdapter,
  type ResourceBinding,
} from './catalog'

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

/** 只读资源：不挂 create/update/delete（expand 期从 binding 生成 client 时省略 stub） */
const READ_ONLY_RESOURCES = new Set([
  'sysAuditLogs',
  'accGlEntries',
  'invStockEntries',
  'scmOrderFlowItems',
  'accBillHoldings',
])

/** 已迁移语义 CommandAdapter：覆盖自动生成的 proxy commands */
const SEMANTIC_COMMAND_ADAPTERS: Record<string, CommandAdapter> = {
  sysStorages: storageCommandAdapter,
  hrAttendanceDays: attendanceDayCommandAdapter,
  accBankTransactions: bankTransactionCommandAdapter,
}

// 从现有 ResourceClient 一次性生成 ResourceBinding（第二事实源不再可编辑；以 clients 为运输实现）
for (const [resource, client] of Object.entries(clients)) {
  const readOnly = READ_ONLY_RESOURCES.has(resource)
  const binding = bindingFromResourceClient(resource, client, {
    canCreate: !readOnly,
    canUpdate: !readOnly,
    canDelete: !readOnly,
  })
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
  const base = bindingFromResourceClient('salDeliveries', salesDeliveryClient, {
    canCreate: false,
    canUpdate: false,
    canDelete: true,
  })
  replaceBinding({
    ...base,
    draft: salesDeliveryDraftAdapter,
  })
}

/**
 * 共享资源组件的唯一默认解析入口。
 * expand 期仍返回 legacy ResourceClient 实现，保证 Grid/Drawer 行为不变；
 * 写能力边界由 binding 约束（resourceBindingFor）。
 */
export function resourceClientFor(resource: string): ResourceClient {
  const client = clients[resource]
  if (!client) {
    throw new Error(`资源「${resource}」未注册 REST ResourceClient`)
  }
  return client
}

/**
 * 类型安全 ResourceBinding 入口。未知资源显式失败。
 * Grid / Drawer / 外键预览迁移后均应经本函数取能力。
 */
export function resourceBindingFor(resource: string): ResourceBinding {
  if (!hasBinding(resource) && clients[resource]) {
    // 理论上 module 加载时已注册；防御性补齐
    const readOnly = READ_ONLY_RESOURCES.has(resource)
    registerBinding(
      bindingFromResourceClient(resource, clients[resource]!, {
        canCreate: !readOnly,
        canUpdate: !readOnly,
        canDelete: !readOnly,
      }),
    )
  }
  return bindingFor(resource)
}

/** 将 binding 适配为 ResourceClient（迁移中的页面可选用） */
export function resourceClientFromResourceBinding(resource: string): ResourceClient {
  return resourceClientFromBinding(resourceBindingFor(resource))
}
