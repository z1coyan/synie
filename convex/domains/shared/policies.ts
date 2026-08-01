import generatedDocuments from '../../catalog/generatedDocuments.json'

export type ClosureStore =
  | 'accountingDocuments'
  | 'inventoryDocuments'
  | 'tradingDocuments'
  | 'financeDocuments'
  | 'manufacturingDocuments'
  | 'hrDocuments'
  | 'marketTodoRecords'

export type CatalogField = {
  name: string
  label: string
  kind: string
  scalarType?: string
  decimalScale?: number
  targetResource?: string | null
  discriminator?: string
  variants?: Array<{ value: string; resource: string }>
  options?: Array<{ value: string; label: string }>
  searchable?: boolean
  input: {
    create: 'required' | 'optional' | 'allowed' | 'forbidden'
    update: 'required' | 'optional' | 'allowed' | 'forbidden'
    clearable?: boolean
  }
}

export type CatalogDocument = {
  name: string
  label: string
  permissionPrefix: string
  capabilities: string[]
  fields: CatalogField[]
  lookup: { labelField: string; searchFields: string[] }
  commands: Array<{ key: string; requiredCapability: string }>
  queryProfiles: Array<{
    key: string
    equalityFields: string[]
    companyScopeField?: string
    acceptsSearch?: boolean
  }>
}

const documents = generatedDocuments as Record<string, CatalogDocument>

const formalResources = new Set([
  'basCurrencies', 'basCompanies', 'basUnits', 'basAccounts',
  'sysUsers', 'sysRoles', 'sysRolePermissions', 'sysAuditLogs',
  'sysNumberingRules', 'sysNumberingCounters',
  'salCustomers', 'purSuppliers', 'hrEmployees',
  'salCompanyAccountDefaults', 'invMaterialCategories', 'invMaterials',
  'invMaterialUnits', 'invWarehouses', 'salSettings', 'mfgSettings',
  'accSettings', 'sysSettings',
])

export const retiredOrDeferredResources = new Set([
  'sysStorages', 'sysFiles', 'sysPrintTemplates',
])

/** Runtime storage routing is sealed in source; Catalog input can never choose a table. */
export function storeForResource(resource: string): ClosureStore | null {
  if (formalResources.has(resource) || retiredOrDeferredResources.has(resource)) return null
  if (resource.startsWith('accGl')) return 'accountingDocuments'
  if (resource.startsWith('invStock')) return 'inventoryDocuments'
  if (
    resource.startsWith('sal') || resource.startsWith('pur') ||
    resource.startsWith('scmOrderFlow')
  ) return 'tradingDocuments'
  if (resource.startsWith('acc')) return 'financeDocuments'
  if (resource.startsWith('mfg')) return 'manufacturingDocuments'
  if (resource.startsWith('hr')) return 'hrDocuments'
  if (resource.startsWith('basMarket') || resource.startsWith('sysTodo')) {
    return 'marketTodoRecords'
  }
  return null
}

export function catalogDocument(resource: string): CatalogDocument {
  const document = documents[resource]
  if (!document) throw new Error(`Catalog 未声明资源 ${resource}`)
  return document
}

export function domainRecordResources(): string[] {
  return Object.keys(documents).filter((resource) => storeForResource(resource) !== null).sort()
}

export const AGGREGATE_HEADS = new Set([
  'accGlJournals',
  'invStockDocs', 'invStockTransfers', 'invStockCounts',
  'purOrders', 'purQuotations', 'purReceipts',
  'salDeliveries', 'salOrders', 'salQuotations',
  'purOutsourcedIssues', 'purOutsourcedReceipts',
  'salReconciliations', 'purReconciliations',
  'accExpenseReports',
  'mfgProcessTemplates', 'mfgBoms', 'mfgDemands', 'mfgWorkOrders', 'mfgOutputs',
])

export const AGGREGATE_CHILDREN: Readonly<Record<string, readonly string[]>> = Object.freeze({
  accGlJournals: ['accGlJournalLines'],
  invStockDocs: ['invStockDocItems'],
  invStockTransfers: ['invStockTransferItems'],
  invStockCounts: ['invStockCountItems'],
  purOrders: ['purOrderItems', 'purOrderItemMaterials', 'purOrderItemByproducts'],
  purQuotations: ['purQuotationItems', 'purQuotationTiers'],
  purReceipts: ['purReceiptItems'],
  purOutsourcedIssues: ['purOutsourcedIssueItems'],
  purOutsourcedReceipts: ['purOutsourcedReceiptItems', 'purOutsourcedReceiptItemMaterials', 'purOutsourcedReceiptItemByproducts'],
  purReconciliations: ['purReconciliationItems'],
  salDeliveries: ['salDeliveryItems', 'salDeliveryPackBoxes', 'salDeliveryPackLines'],
  salOrders: ['salOrderItems'],
  salQuotations: ['salQuotationItems', 'salQuotationTiers'],
  salReconciliations: ['salReconciliationItems'],
  accExpenseReports: ['accExpenseReportItems'],
  mfgProcessTemplates: ['mfgProcessTemplateItems'],
  mfgBoms: ['mfgBomComponents', 'mfgBomRoutes', 'mfgBomByproducts'],
  mfgDemands: ['mfgDemandItems'],
  mfgWorkOrders: ['mfgWorkOrderComponents', 'mfgWorkOrderRoutes', 'mfgWorkOrderByproducts'],
  mfgOutputs: ['mfgOutputItems'],
})

/** Parent fields are explicit because they are part of each aggregate/query contract. */
export const PARENT_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  invStockDocItems: 'stockDocId',
  invStockTransferItems: 'stockTransferId',
  invStockCountItems: 'countId',
  accGlJournalLines: 'journalId',
  salQuotationItems: 'quotationId',
  salQuotationTiers: 'itemId',
  salOrderItems: 'orderId',
  salDeliveryItems: 'deliveryId',
  salDeliveryPackBoxes: 'deliveryId',
  salDeliveryPackLines: 'packBoxId',
  salReconciliationItems: 'reconciliationId',
  purQuotationItems: 'quotationId',
  purQuotationTiers: 'itemId',
  purOrderItems: 'orderId',
  purOrderItemMaterials: 'orderItemId',
  purOrderItemByproducts: 'orderItemId',
  purReceiptItems: 'receiptId',
  purReconciliationItems: 'reconciliationId',
  purOutsourcedIssueItems: 'issueId',
  purOutsourcedReceiptItems: 'receiptId',
  purOutsourcedReceiptItemMaterials: 'receiptItemId',
  purOutsourcedReceiptItemByproducts: 'receiptItemId',
  accBankImportItems: 'importId',
  accBankReconciliations: 'bankTransactionId',
  accExpenseReportItems: 'reportId',
  accBillTransactions: 'billId',
  accBillHoldings: 'billId',
  mfgProcessTemplateItems: 'templateId',
  mfgBomComponents: 'bomId',
  mfgBomRoutes: 'bomId',
  mfgBomByproducts: 'bomId',
  mfgDemandItems: 'demandId',
  mfgWorkOrderComponents: 'workOrderId',
  mfgWorkOrderRoutes: 'workOrderId',
  mfgWorkOrderByproducts: 'workOrderId',
  mfgOutputItems: 'outputId',
  hrPayrollPayments: 'payrollId',
})

/** Strong unique keys preserved by explicit per-resource claims. */
export const UNIQUE_GROUPS: Readonly<Record<string, readonly (readonly string[])[]>> = Object.freeze({
  basMarketInstruments: [['code']],
  hrAttendanceCorrections: [['employeeId', 'date']],
  hrAttendanceDays: [['employeeId', 'date']],
  hrPayrolls: [['employeeId', 'month']],
  invStockDocs: [['companyId', 'docNo']],
  invStockTransfers: [['companyId', 'docNo']],
  invStockCounts: [['companyId', 'docNo']],
  accGlJournals: [['companyId', 'voucherNo']],
  salQuotations: [['companyId', 'quotationNo']],
  salOrders: [['companyId', 'orderNo']],
  salDeliveries: [['companyId', 'deliveryNo']],
  salReconciliations: [['companyId', 'reconciliationNo']],
  purQuotations: [['companyId', 'quotationNo']],
  purOrders: [['companyId', 'orderNo']],
  purReceipts: [['companyId', 'receiptNo']],
  purReconciliations: [['companyId', 'reconciliationNo']],
  purOutsourcedIssues: [['companyId', 'issueNo']],
  purOutsourcedReceipts: [['companyId', 'receiptNo']],
  accVatInvoices: [['companyId', 'docNo']],
  accBankAccounts: [['companyId', 'accountNo']],
  accBankImportTemplates: [['companyId', 'name']],
  accExpenseReports: [['companyId', 'docNo']],
  accBills: [['billNo']],
  accBillTransactions: [['companyId', 'docNo']],
  mfgOperations: [['code']],
  mfgProcessTemplates: [['code']],
  mfgBoms: [['code']],
  mfgDemands: [['companyId', 'demandNo']],
  mfgWorkOrders: [['companyId', 'workOrderNo']],
  mfgOutputs: [['companyId', 'outputNo']],
})

export const NUMBER_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  mfgOperations: 'code', mfgProcessTemplates: 'code', mfgBoms: 'code',
  invStockDocs: 'docNo', invStockTransfers: 'docNo', invStockCounts: 'docNo',
  accGlJournals: 'voucherNo', salQuotations: 'quotationNo', salOrders: 'orderNo',
  salDeliveries: 'deliveryNo', salReconciliations: 'reconciliationNo',
  purQuotations: 'quotationNo', purOrders: 'orderNo', purReceipts: 'receiptNo',
  purReconciliations: 'reconciliationNo', purOutsourcedIssues: 'issueNo',
  purOutsourcedReceipts: 'receiptNo', accVatInvoices: 'docNo',
  accExpenseReports: 'docNo', accBillTransactions: 'docNo',
  mfgDemands: 'demandNo', mfgWorkOrders: 'workOrderNo', mfgOutputs: 'outputNo',
})

export const INITIAL_STATUS: Readonly<Record<string, string>> = Object.freeze({
  hrAttendanceImports: 'PARSED', hrAttendanceDays: 'MISSING', hrPayrolls: 'PENDING',
  invStockDocs: 'DRAFT', invStockTransfers: 'DRAFT', invStockCounts: 'DRAFT',
  accGlJournals: 'DRAFT', salQuotations: 'DRAFT', salOrders: 'DRAFT',
  salDeliveries: 'DRAFT', salReconciliations: 'DRAFT', purQuotations: 'DRAFT',
  purOrders: 'DRAFT', purReceipts: 'DRAFT', purReconciliations: 'DRAFT',
  purOutsourcedIssues: 'DRAFT', purOutsourcedReceipts: 'DRAFT', accVatInvoices: 'DRAFT',
  accBankImports: 'PARSED', accExpenseReports: 'DRAFT', accBillTransactions: 'DRAFT',
  scmOrderFlowItems: 'DRAFT', mfgBoms: 'DRAFT', mfgDemands: 'DRAFT',
  mfgDemandItems: 'PENDING', mfgWorkOrders: 'IN_PROGRESS', mfgOutputs: 'DRAFT',
})

export function resourceHasCompanyScope(resource: string): boolean {
  return catalogDocument(resource).queryProfiles.some((profile) => Boolean(profile.companyScopeField)) ||
    catalogDocument(resource).fields.some((field) => field.name === 'companyId')
}

/** Same scale rule as the frozen SQL numeric manifest, expressed on wire camelCase fields. */
export function decimalScaleForField(field: CatalogField): 2 | 4 | 6 {
  if (field.decimalScale === 2 || field.decimalScale === 4 || field.decimalScale === 6) return field.decimalScale
  if (/(?:^|[A-Z])price$/i.test(field.name)) return 4
  if (/(?:amount|balance|income|expense|debit|credit|interest|allowance|bonus|fine|payable|wage|total)$/i.test(field.name)) return 2
  return 6
}
