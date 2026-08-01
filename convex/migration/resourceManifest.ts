export const migrationStatuses = [
  'legacy',
  'implementing',
  'convex-verified',
  'retired',
] as const

export type MigrationStatus = (typeof migrationStatuses)[number]
export type CompanyScopeKind = 'global' | 'actor-companies'

export type ResourceMigrationEntry = {
  resource: string
  ownerDomain: string
  legacyTable: string
  targetFunctionModule: string
  queryProfiles: readonly string[]
  indexes: readonly string[]
  capabilities: readonly string[]
  permissionPrefix: string
  companyScope: CompanyScopeKind
  decimalFields: readonly string[]
  constraints: readonly string[]
  frontendBinding: boolean
  status: MigrationStatus
  writerAuthority: {
    legacyMode: 'none'
    convexMode: 'convex' | 'none'
  }
  audit: 'convex-formal'
  retirementPlan?: 'retired-by-006'
  transactionClosure: string
  dependsOnClosures: readonly string[]
  portedTests: readonly string[]
  frontendRoutes: readonly string[]
  filePortRequired: boolean
  printBuilderRequired: boolean
}

import { closureDependencies, closureForResource } from './closureManifest'

type InventoryTuple = readonly [
  resource: string,
  legacyTable: string,
  permissionPrefix: string,
  capabilities: readonly string[],
  companyScoped: boolean,
  decimalFields: readonly string[],
]

/**
 * 从 sealed Resource Catalog 在 2026-07-31 生成并由 check:convex-manifest
 * 与生产组合根逐字段对拍。它是迁移总账，不是第二套运行时 Catalog DSL。
 */
export const legacyResourceInventory: readonly InventoryTuple[] = [
  ['accBankAccounts', 'acc_bank_account', 'acc.bank_account', ['read', 'create', 'update', 'delete'], true, []],
  ['accBankImportItems', 'acc_bank_import_item', 'acc.bank_transaction', ['read'], true, ['income', 'expense', 'balance']],
  ['accBankImports', 'acc_bank_import', 'acc.bank_transaction', ['read'], true, []],
  ['accBankImportTemplates', 'acc_bank_import_template', 'acc.bank_import_template', ['read', 'create', 'update', 'delete'], true, []],
  ['accBankReconciliations', 'acc_bank_reconciliation', 'acc.bank_transaction', ['read'], true, ['amount']],
  ['accBankTransactions', 'acc_bank_transaction', 'acc.bank_transaction', ['read', 'create', 'update', 'delete', 'import', 'reconcile'], true, ['income', 'expense', 'balance', 'reconciledAmount', 'unreconciledAmount']],
  ['accBillHoldings', 'acc_bill_holding', 'acc.bill_holding', ['read'], true, ['amount']],
  ['accBills', 'acc_bill', 'acc.bill', ['read', 'update', 'delete'], false, ['faceAmount']],
  ['accBillTransactions', 'acc_bill_transaction', 'acc.bill_transaction', ['read', 'create', 'update', 'delete', 'audit', 'void'], true, ['amount', 'discountRate', 'interest', 'netAmount']],
  ['accExpenseReportItems', 'acc_expense_report_item', 'acc.expense_report', ['read'], true, ['amount']],
  ['accExpenseReports', 'acc_expense_report', 'acc.expense_report', ['read', 'create', 'update', 'delete', 'audit', 'void'], true, []],
  ['accGlEntries', 'acc_gl_entry', 'acc.gl_entry', ['read'], true, ['debit', 'credit']],
  ['accGlJournalLines', 'acc_gl_journal_line', 'acc.gl_journal', ['read'], true, ['debit', 'credit']],
  ['accGlJournals', 'acc_gl_journal', 'acc.gl_journal', ['read', 'create', 'update', 'delete', 'audit', 'cancel'], true, ['debitTotal', 'creditTotal']],
  ['accSettings', 'acc_setting', 'acc.setting', ['read', 'update'], false, []],
  ['accVatInvoices', 'acc_vat_invoice', 'acc.vat_invoice', ['read', 'create', 'update', 'delete', 'audit', 'void', 'reverse'], true, ['netTotal', 'taxTotal', 'grossTotal']],
  ['basAccounts', 'bas_account', 'base.account', ['read', 'create', 'update', 'delete'], true, []],
  ['basCompanies', 'bas_company', 'base.company', ['read', 'create', 'update', 'delete'], false, []],
  ['basCurrencies', 'bas_currency', 'base.currency', ['read', 'create', 'update', 'delete'], false, []],
  ['basMarketInstruments', 'bas_market_instrument', 'base.market_instrument', ['read', 'create', 'update', 'delete'], false, []],
  ['basMarketPricePoints', 'bas_market_price_point', 'base.market_price', ['read', 'create', 'void'], false, ['price']],
  ['basUnits', 'bas_unit', 'base.unit', ['read', 'create', 'update', 'delete'], false, ['ratio']],
  ['hrAttendanceCorrections', 'hr_attendance_correction', 'hr.attendance_correction', ['read', 'create', 'update', 'delete'], false, []],
  ['hrAttendanceDays', 'hr_attendance_day', 'hr.attendance_day', ['read', 'recalc'], false, ['normalHours', 'overtimeHours', 'bonusWorkday']],
  ['hrAttendanceImports', 'hr_attendance_import', 'hr.attendance_punch', ['import'], false, []],
  ['hrAttendancePunches', 'hr_attendance_punch', 'hr.attendance_punch', ['read', 'import'], false, []],
  ['hrEmployeeLoans', 'hr_employee_loan', 'hr.employee_loan', ['read', 'create', 'update', 'delete'], false, ['amount']],
  ['hrEmployees', 'hr_employees', 'hr.employee', ['read', 'create', 'update', 'delete'], false, ['dailyWage', 'monthlyAllowance']],
  ['hrPayrollPayments', 'hr_payroll_payment', 'hr.payroll_payment', ['read', 'create', 'delete'], false, ['amount']],
  ['hrPayrolls', 'hr_payroll', 'hr.payroll', ['read', 'create', 'update', 'delete'], false, ['workdays', 'overtimeHours', 'dailyWage', 'baseAmount', 'allowance', 'bonus', 'fine', 'loanDeduction', 'payable', 'paidTotal']],
  ['invMaterialCategories', 'inv_material_category', 'inv.material_category', ['read', 'create', 'update', 'delete'], false, []],
  ['invMaterials', 'inv_material', 'inv.material', ['read', 'create', 'update', 'delete'], false, []],
  ['invMaterialUnits', 'inv_material_unit', 'inv.material', ['read'], false, ['factor']],
  ['invStockCountItems', 'inv_stock_count_item', 'inv.stock_count', ['read'], true, ['countedQuantity', 'convertedCounted', 'bookQuantity']],
  ['invStockCounts', 'inv_stock_count', 'inv.stock_count', ['read', 'create', 'update', 'delete', 'approve', 'cancel'], true, []],
  ['invStockDocItems', 'inv_stock_doc_item', 'inv.stock_doc', ['read'], true, ['qty', 'baseQty']],
  ['invStockDocs', 'inv_stock_doc', 'inv.stock_doc', ['read', 'create', 'update', 'delete', 'audit', 'void'], true, []],
  ['invStockEntries', 'inv_stock_entry', 'inv.stock_entry', ['read'], true, ['quantity']],
  ['invStockTransferItems', 'inv_stock_transfer_item', 'inv.stock_transfer', ['read'], true, ['qty', 'baseQty', 'receivedQty']],
  ['invStockTransfers', 'inv_stock_transfer', 'inv.stock_transfer', ['read', 'create', 'update', 'delete', 'ship', 'receive'], true, []],
  ['invWarehouses', 'inv_warehouse', 'inv.warehouse', ['read', 'create', 'update', 'delete'], true, []],
  ['mfgBomByproducts', 'mfg_bom_byproduct', 'mfg.bom', ['read'], false, ['quantity']],
  ['mfgBomComponents', 'mfg_bom_component', 'mfg.bom', ['read'], false, ['quantity', 'lossRate']],
  ['mfgBomRoutes', 'mfg_bom_route', 'mfg.bom', ['read'], false, []],
  ['mfgBoms', 'mfg_bom', 'mfg.bom', ['read', 'create', 'update', 'delete'], false, []],
  ['mfgDemandItems', 'mfg_demand_item', 'mfg.demand', ['read'], true, ['qty', 'baseQty', 'orderedQty', 'receivedQty', 'arrangedQty', 'completedQty', 'remainingOrderableQty', 'remainingArrangeableQty']],
  ['mfgDemands', 'mfg_demand', 'mfg.demand', ['read', 'create', 'update', 'delete', 'confirm', 'close', 'void'], true, []],
  ['mfgOperations', 'mfg_operation', 'mfg.operation', ['read', 'create', 'update', 'delete'], false, []],
  ['mfgOutputItems', 'mfg_output_item', 'mfg.output', ['read'], true, ['qty', 'baseQty']],
  ['mfgOutputs', 'mfg_output', 'mfg.output', ['read', 'create', 'update', 'delete', 'audit', 'void'], true, []],
  ['mfgProcessTemplateItems', 'mfg_process_template_item', 'mfg.route_template', ['read'], false, []],
  ['mfgProcessTemplates', 'mfg_process_template', 'mfg.route_template', ['read', 'create', 'update', 'delete'], false, []],
  ['mfgSettings', 'mfg_setting', 'mfg.setting', ['read', 'update'], false, ['outputOverreceiveRatio']],
  ['mfgWorkOrderByproducts', 'mfg_work_order_byproduct', 'mfg.work_order', ['read'], false, ['quantity']],
  ['mfgWorkOrderComponents', 'mfg_work_order_component', 'mfg.work_order', ['read'], false, ['quantity', 'lossRate']],
  ['mfgWorkOrderRoutes', 'mfg_work_order_route', 'mfg.work_order', ['read'], false, []],
  ['mfgWorkOrders', 'mfg_work_order', 'mfg.work_order', ['read', 'create', 'update', 'delete', 'void', 'print', 'export', 'batch_print'], true, ['qty', 'baseQty', 'receivedBaseQty', 'remainingBaseQty']],
  ['purOrderItemByproducts', 'pur_order_item_byproduct', 'purchase.order', ['read'], true, ['quantity']],
  ['purOrderItemMaterials', 'pur_order_item_material', 'purchase.order', ['read'], true, ['quantity', 'issuedQty', 'remainingIssueQty']],
  ['purOrderItems', 'pur_order_item', 'purchase.order', ['read'], true, ['qty', 'baseQty', 'receivedQty', 'price', 'amount', 'basePrice', 'baseAmount', 'taxRate', 'remainingBaseQty']],
  ['purOrders', 'pur_order', 'purchase.order', ['read', 'create', 'update', 'delete', 'audit', 'close', 'void'], true, ['exchangeRate', 'grossTotal', 'baseGrossTotal']],
  ['purOutsourcedIssueItems', 'pur_outsourced_issue_item', 'purchase.outsourced_issue', ['read'], true, ['qty', 'baseQty']],
  ['purOutsourcedIssues', 'pur_outsourced_issue', 'purchase.outsourced_issue', ['read', 'create', 'update', 'delete', 'audit', 'void'], true, []],
  ['purOutsourcedReceiptItemByproducts', 'pur_outsourced_receipt_item_byproduct', 'purchase.outsourced_receipt', ['read'], true, ['qty', 'baseQty']],
  ['purOutsourcedReceiptItemMaterials', 'pur_outsourced_receipt_item_material', 'purchase.outsourced_receipt', ['read'], true, ['qty', 'baseQty']],
  ['purOutsourcedReceiptItems', 'pur_outsourced_receipt_item', 'purchase.outsourced_receipt', ['read'], true, ['qty', 'baseQty', 'orderQty', 'orderBaseQty', 'orderPrice', 'orderAmount', 'orderBasePrice', 'orderBaseAmount', 'orderTaxRate', 'reconciledQty', 'remainingReconcilableQty']],
  ['purOutsourcedReceipts', 'pur_outsourced_receipt', 'purchase.outsourced_receipt', ['read', 'create', 'update', 'delete', 'audit', 'void'], true, []],
  ['purQuotationItems', 'pur_quotation_item', 'purchase.quotation', ['read'], true, ['price', 'taxRate']],
  ['purQuotations', 'pur_quotation', 'purchase.quotation', ['read', 'create', 'update', 'delete', 'audit', 'void'], true, []],
  ['purQuotationTiers', 'pur_quotation_tier', 'purchase.quotation', ['read'], true, ['minQty', 'price']],
  ['purReceiptItems', 'pur_receipt_item', 'purchase.receipt', ['read'], true, ['qty', 'baseQty', 'orderQty', 'orderBaseQty', 'orderPrice', 'orderAmount', 'orderBasePrice', 'orderBaseAmount', 'orderTaxRate', 'reconciledQty', 'remainingReconcilableQty']],
  ['purReceipts', 'pur_receipt', 'purchase.receipt', ['read', 'create', 'update', 'delete', 'audit', 'void'], true, []],
  ['purReconciliationItems', 'pur_reconciliation_item', 'purchase.reconciliation', ['read'], true, ['qty', 'baseQty', 'amount', 'baseAmount']],
  ['purReconciliations', 'pur_reconciliation', 'purchase.reconciliation', ['read', 'create', 'update', 'delete', 'confirm', 'unconfirm', 'audit', 'void'], true, ['grossTotal', 'baseGrossTotal']],
  ['purSuppliers', 'pur_supplier', 'purchase.supplier', ['read', 'create', 'update', 'delete'], false, []],
  ['salCompanyAccountDefaults', 'sal_company_account_default', 'sales.setting', [], true, []],
  ['salCustomers', 'sal_customers', 'sales.customer', ['read', 'create', 'update', 'delete'], false, []],
  ['salDeliveries', 'sal_delivery', 'sales.delivery', ['read', 'create', 'update', 'delete', 'audit', 'void', 'print', 'export', 'batch_print'], true, []],
  ['salDeliveryItems', 'sal_delivery_item', 'sales.delivery', ['read'], true, ['qty', 'baseQty', 'orderQty', 'orderBaseQty', 'orderPrice', 'orderAmount', 'orderBasePrice', 'orderBaseAmount', 'orderTaxRate', 'reconciledQty', 'remainingReconcilableQty']],
  ['salDeliveryPackBoxes', 'sal_delivery_pack_box', 'sales.delivery', ['read'], true, []],
  ['salDeliveryPackLines', 'sal_delivery_pack_line', 'sales.delivery', ['read'], true, ['qty', 'baseQty']],
  ['salOrderItems', 'sal_order_item', 'sales.order', ['read'], true, ['qty', 'baseQty', 'shippedQty', 'price', 'amount', 'basePrice', 'baseAmount', 'taxRate', 'remainingBaseQty']],
  ['salOrders', 'sal_order', 'sales.order', ['read', 'create', 'update', 'delete', 'audit', 'close', 'void', 'print', 'export', 'batch_print'], true, ['exchangeRate', 'grossTotal', 'baseGrossTotal']],
  ['salQuotationItems', 'sal_quotation_item', 'sales.quotation', ['read'], true, ['price', 'taxRate']],
  ['salQuotations', 'sal_quotation', 'sales.quotation', ['read', 'create', 'update', 'delete', 'audit', 'void'], true, []],
  ['salQuotationTiers', 'sal_quotation_tier', 'sales.quotation', ['read'], true, ['minQty', 'price']],
  ['salReconciliationItems', 'sal_reconciliation_item', 'sales.reconciliation', ['read'], true, ['qty', 'baseQty', 'amount', 'baseAmount']],
  ['salReconciliations', 'sal_reconciliation', 'sales.reconciliation', ['read', 'create', 'update', 'delete', 'confirm', 'unconfirm', 'audit', 'void'], true, ['grossTotal', 'baseGrossTotal']],
  ['salSettings', 'sal_setting', 'sales.setting', ['read', 'update'], false, ['deliveryOvershipRatio', 'receiptOverreceiveRatio', 'demandOverorderRatio']],
  ['scmOrderFlowItems', 'scm_order_flow_item', 'scm.order_flow', [], true, ['qty']],
  ['sysAuditLogs', 'sys_audit_log', 'sys.audit_log', ['read'], true, []],
  ['sysFiles', 'sys_file', 'sys.file', ['read', 'create', 'delete'], false, []],
  ['sysNumberingCounters', 'sys_numbering_counter', 'sys.numbering_rule', [], false, []],
  ['sysNumberingRules', 'sys_numbering_rule', 'sys.numbering_rule', ['read', 'create', 'update', 'delete'], false, []],
  ['sysPrintTemplates', 'sys_print_template', 'sys.print_template', ['read', 'create', 'update', 'delete'], false, []],
  ['sysRolePermissions', 'sys_role_permission', 'sys.role_permission', ['read', 'create', 'delete'], false, []],
  ['sysRoles', 'sys_role', 'sys.role', ['read', 'create', 'update', 'delete', 'batch_delete', 'export', 'print', 'batch_print'], false, []],
  ['sysSettings', 'sys_setting', 'sys.setting', ['read', 'update'], false, []],
  ['sysStorages', 'sys_storage', 'sys.storage', ['read', 'create', 'update', 'delete'], false, []],
  ['sysUsers', 'sys_user', 'sys.user', ['read', 'create', 'update', 'delete'], false, []],
] as const

const pilotConfiguration: Record<
  string,
  Pick<ResourceMigrationEntry, 'targetFunctionModule' | 'queryProfiles' | 'indexes'>
> = {
  basCurrencies: {
    targetFunctionModule: 'convex/resources/currencies',
    queryProfiles: ['default', 'lookup', 'search'],
    indexes: [
      'currencies.by_iso_code_key',
      'currencies.by_active_iso_code_key',
      'currencies.search_text',
    ],
  },
  basUnits: {
    targetFunctionModule: 'convex/resources/units',
    queryProfiles: ['default', 'lookup', 'search'],
    indexes: [
      'units.by_name_key',
      'units.by_type_name_key',
      'units.by_symbol_key',
      'units.by_type_base',
      'units.search_text',
    ],
  },
  invMaterialCategories: {
    targetFunctionModule: 'convex/domains/inventory/master',
    queryProfiles: ['default', 'lookup', 'treeChildren', 'search'],
    indexes: [
      'materialCategories.by_code_key',
      'materialCategories.by_is_leaf_code_key',
      'materialCategories.by_active_is_leaf_code_key',
      'materialCategories.by_parent_code_key',
      'materialCategories.search_text',
    ],
  },
  invWarehouses: {
    targetFunctionModule: 'convex/resources/warehouses',
    queryProfiles: ['default', 'lookup', 'treeChildren', 'search'],
    indexes: [
      'warehouses.by_company_name_key',
      'warehouses.by_company_active_is_leaf_name_key',
      'warehouses.by_company_parent_name_key',
      'warehouses.by_parent',
      'warehouses.search_text',
    ],
  },
}

const noFrontendBinding = new Set([
  'mfgWorkOrderByproducts',
  'mfgWorkOrderComponents',
  'mfgWorkOrderRoutes',
  'sysRolePermissions',
])

function ownerDomain(permissionPrefix: string): string {
  return permissionPrefix.split('.', 1)[0] || 'unknown'
}

function targetModuleFor(resource: string, closure: string): string {
  if (resource === 'sysStorages') return 'retired-by-plan-006'
  if (resource === 'basCurrencies') return 'convex/resources/currencies.ts'
  if (resource === 'basUnits') return 'convex/resources/units.ts'
  if (resource === 'invWarehouses') return 'convex/resources/warehouses.ts'
  if (resource === 'basCompanies') return 'convex/domains/base/companies.ts'
  if (resource === 'basAccounts') return 'convex/domains/base/accounts.ts'
  if (resource === 'sysRoles') return 'convex/iam/roles.ts'
  if (resource === 'sysUsers') return 'convex/iam/users.ts'
  if (resource === 'sysNumberingRules' || resource === 'sysNumberingCounters') {
    return 'convex/domains/platform/numbering.ts'
  }
  if (resource.endsWith('Settings')) return 'convex/domains/platform/settings.ts'
  if (resource === 'salCompanyAccountDefaults') {
    return 'convex/domains/platform/companyAccountDefaults.ts'
  }
  const byClosure: Record<string, string> = {
    'application-kernel': 'convex/lib/auth.ts',
    'resource-plane-pilots': 'convex/resources/model.ts',
    'facts-engines': 'convex/engines/shared.ts',
    'platform-master': 'convex/domains/platform/resources.ts',
    'party-master': 'convex/domains/party/parties.ts',
    'inventory-master': 'convex/domains/inventory/master.ts',
    'accounting-documents': 'convex/domains/accounting/documents.ts',
    'inventory-documents': 'convex/domains/inventory/documents.ts',
    'trading-quotations': 'convex/domains/trading/quotations.ts',
    'trading-orders': 'convex/domains/trading/orders.ts',
    'trading-fulfillment': 'convex/domains/trading/fulfillment.ts',
    'trading-reconciliation': 'convex/domains/trading/reconciliation.ts',
    'finance-documents': 'convex/domains/finance/documents.ts',
    manufacturing: 'convex/domains/manufacturing/domain.ts',
    'hr-payroll': 'convex/domains/hr/domain.ts',
    'market-todo-setup': resource.startsWith('basMarket')
      ? 'convex/domains/market/domain.ts'
      : 'convex/domains/todo/domain.ts',
    'files-port': 'convex/files/domain.ts',
    'printing-port': 'convex/platform/printing/templates.ts',
  }
  const target = byClosure[closure]
  if (!target) throw new Error(`资源 ${resource} 缺少 Convex target`)
  return target
}

export const resourceManifest: readonly ResourceMigrationEntry[] =
  legacyResourceInventory.map(
    ([resource, legacyTable, permissionPrefix, capabilities, companyScoped, decimalFields]) => {
      const pilot = pilotConfiguration[resource]
      const retiring = resource === 'sysStorages'
      const transactionClosure = closureForResource(resource)
      return {
        resource,
        ownerDomain: ownerDomain(permissionPrefix),
        legacyTable,
        targetFunctionModule: targetModuleFor(resource, transactionClosure),
        queryProfiles: pilot?.queryProfiles ?? [],
        indexes: pilot?.indexes ?? [],
        capabilities,
        permissionPrefix,
        companyScope: companyScoped ? 'actor-companies' : 'global',
        decimalFields,
        constraints: [`source-table:${legacyTable}`],
        frontendBinding: !retiring && !noFrontendBinding.has(resource),
        status: retiring ? 'retired' : 'convex-verified',
        writerAuthority: {
          legacyMode: 'none',
          convexMode: retiring ? 'none' : 'convex',
        },
        audit: 'convex-formal',
        transactionClosure,
        dependsOnClosures: closureDependencies(transactionClosure),
        portedTests: ['convex/architecture.test.ts', 'convex/migration/manifest.test.ts'],
        frontendRoutes: retiring ? [] : ['web/app/lib/resources/registry.ts'],
        filePortRequired: resource === 'sysFiles' || resource === 'accVatInvoices' || resource === 'hrAttendanceImports',
        printBuilderRequired: capabilities.some((capability) => capability.includes('print')),
        ...(retiring
          ? { retirementPlan: 'retired-by-006' as const }
          : {}),
      }
    },
  )
