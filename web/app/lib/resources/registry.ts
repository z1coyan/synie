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

/**
 * 写能力边界：与服务端 actions 对齐。
 * 不在集合中的资源默认 full CRUD；下列显式省略不支持的写方法（无 stub）。
 */
type WriteCaps = { create: boolean; update: boolean; delete: boolean }

const WRITE_CAPS: Record<string, WriteCaps> = {
  // 只读投影
  sysAuditLogs: { create: false, update: false, delete: false },
  accGlEntries: { create: false, update: false, delete: false },
  invStockEntries: { create: false, update: false, delete: false },
  scmOrderFlowItems: { create: false, update: false, delete: false },
  accBillHoldings: { create: false, update: false, delete: false },
  accBankImportItems: { create: false, update: false, delete: false },
  accBankImports: { create: false, update: false, delete: false },
  accBankReconciliations: { create: false, update: false, delete: false },
  accExpenseReportItems: { create: false, update: false, delete: false },
  accGlJournalLines: { create: false, update: false, delete: false },
  hrAttendanceDays: { create: false, update: false, delete: false },
  hrAttendanceImports: { create: false, update: false, delete: false },
  hrAttendancePunches: { create: false, update: false, delete: false },
  invMaterialUnits: { create: false, update: false, delete: false },
  invStockCountItems: { create: false, update: false, delete: false },
  invStockDocItems: { create: false, update: false, delete: false },
  invStockTransferItems: { create: false, update: false, delete: false },
  mfgBomByproducts: { create: false, update: false, delete: false },
  mfgBomComponents: { create: false, update: false, delete: false },
  mfgBomRoutes: { create: false, update: false, delete: false },
  mfgDemandItems: { create: false, update: false, delete: false },
  mfgOutputItems: { create: false, update: false, delete: false },
  mfgProcessTemplateItems: { create: false, update: false, delete: false },
  purOrderItemByproducts: { create: false, update: false, delete: false },
  purOrderItemMaterials: { create: false, update: false, delete: false },
  purOrderItems: { create: false, update: false, delete: false },
  purOutsourcedIssueItems: { create: false, update: false, delete: false },
  purOutsourcedReceiptItemByproducts: { create: false, update: false, delete: false },
  purOutsourcedReceiptItemMaterials: { create: false, update: false, delete: false },
  purOutsourcedReceiptItems: { create: false, update: false, delete: false },
  purQuotationItems: { create: false, update: false, delete: false },
  purQuotationTiers: { create: false, update: false, delete: false },
  purReceiptItems: { create: false, update: false, delete: false },
  purReconciliationItems: { create: false, update: false, delete: false },
  salCompanyAccountDefaults: { create: false, update: false, delete: false },
  salDeliveryItems: { create: false, update: false, delete: false },
  salDeliveryPackBoxes: { create: false, update: false, delete: false },
  salDeliveryPackLines: { create: false, update: false, delete: false },
  salOrderItems: { create: false, update: false, delete: false },
  salQuotationItems: { create: false, update: false, delete: false },
  salQuotationTiers: { create: false, update: false, delete: false },
  salReconciliationItems: { create: false, update: false, delete: false },
  sysNumberingCounters: { create: false, update: false, delete: false },
  // update-only 设置
  accSettings: { create: false, update: true, delete: false },
  mfgSettings: { create: false, update: true, delete: false },
  salSettings: { create: false, update: true, delete: false },
  sysSettings: { create: false, update: true, delete: false },
  // 部分写
  accBills: { create: false, update: true, delete: true },
  basMarketPricePoints: { create: true, update: false, delete: false },
  hrPayrollPayments: { create: true, update: false, delete: true },
  sysFiles: { create: true, update: false, delete: true },
  // 销售发货：表单写经 AggregateDraftAdapter，不暴露 create/update
  salDeliveries: { create: false, update: false, delete: true },
}

function writeCapsFor(resource: string): WriteCaps {
  return WRITE_CAPS[resource] ?? { create: true, update: true, delete: true }
}

/** 已迁移语义 CommandAdapter：覆盖自动生成的 proxy commands */
const SEMANTIC_COMMAND_ADAPTERS: Record<string, CommandAdapter> = {
  sysStorages: storageCommandAdapter,
  hrAttendanceDays: attendanceDayCommandAdapter,
  accBankTransactions: bankTransactionCommandAdapter,
}

// 从现有 ResourceClient 一次性生成 ResourceBinding（第二事实源不再可编辑；以 clients 为运输实现）
for (const [resource, client] of Object.entries(clients)) {
  const caps = writeCapsFor(resource)
  const binding = bindingFromResourceClient(resource, client, {
    canCreate: caps.create,
    canUpdate: caps.update,
    canDelete: caps.delete,
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
  const caps = writeCapsFor('salDeliveries')
  const base = bindingFromResourceClient('salDeliveries', salesDeliveryClient, {
    canCreate: caps.create,
    canUpdate: caps.update,
    canDelete: caps.delete,
  })
  replaceBinding({
    ...base,
    draft: salesDeliveryDraftAdapter,
  })
}

function seedBinding(resource: string): void {
  const client = clients[resource]
  if (!client) {
    throw new Error(`资源「${resource}」未注册 ResourceBinding`)
  }
  const caps = writeCapsFor(resource)
  let binding = bindingFromResourceClient(resource, client, {
    canCreate: caps.create,
    canUpdate: caps.update,
    canDelete: caps.delete,
  })
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
export function resourceClientFromResourceBinding(resource: string): ResourceClient {
  return resourceClientFromBinding(resourceBindingFor(resource))
}

/** @deprecated 使用 resourceBindingFor / resourceClientFromResourceBinding */
export function resourceClientFor(resource: string): ResourceClient {
  return resourceClientFromResourceBinding(resource)
}

/** 已绑定资源键（基线/契约用） */
export function listResourceClientKeys(): string[] {
  return Object.keys(clients).sort()
}

/** 绑定资源键列表 */
export function listResourceBindingKeys(): string[] {
  return Object.keys(clients).sort()
}
