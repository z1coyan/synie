import { legacyResourceInventory } from './resourceManifest'

export type TableMigrationDisposition =
  | { targetTable: string }
  | { mergedInto: readonly string[] }
  | { projection: string }
  | { retired: string }

export type TableMigrationEntry = {
  legacyTable: string
  ownerDomain: string
  disposition: TableMigrationDisposition
}

export const legacySqlTables = [
  'acc_bank_account', 'acc_bank_import', 'acc_bank_import_item',
  'acc_bank_import_template', 'acc_bank_reconciliation', 'acc_bank_transaction',
  'acc_bill', 'acc_bill_holding', 'acc_bill_transaction', 'acc_expense_report',
  'acc_expense_report_item', 'acc_gl_entry', 'acc_gl_journal',
  'acc_gl_journal_line', 'acc_setting', 'acc_vat_invoice', 'bas_account',
  'bas_company', 'bas_currency', 'bas_market_instrument', 'bas_market_price_point',
  'bas_unit', 'hr_attendance_correction', 'hr_attendance_day',
  'hr_attendance_import', 'hr_attendance_punch', 'hr_employee_loan',
  'hr_employees', 'hr_payroll', 'hr_payroll_payment', 'inv_material',
  'inv_material_category', 'inv_material_unit', 'inv_stock_count',
  'inv_stock_count_item', 'inv_stock_doc', 'inv_stock_doc_item', 'inv_stock_entry',
  'inv_stock_transfer', 'inv_stock_transfer_item', 'inv_warehouse', 'mfg_bom',
  'mfg_bom_byproduct', 'mfg_bom_component', 'mfg_bom_route', 'mfg_demand',
  'mfg_demand_arrangement', 'mfg_demand_item', 'mfg_operation', 'mfg_output',
  'mfg_output_item', 'mfg_process_template', 'mfg_process_template_item',
  'mfg_setting', 'mfg_work_order', 'mfg_work_order_byproduct',
  'mfg_work_order_component', 'mfg_work_order_route', 'pur_order',
  'pur_order_item', 'pur_order_item_byproduct', 'pur_order_item_material',
  'pur_outsourced_issue', 'pur_outsourced_issue_item', 'pur_outsourced_receipt',
  'pur_outsourced_receipt_item', 'pur_outsourced_receipt_item_byproduct',
  'pur_outsourced_receipt_item_material', 'pur_quotation', 'pur_quotation_item',
  'pur_quotation_tier', 'pur_receipt', 'pur_receipt_item', 'pur_reconciliation',
  'pur_reconciliation_item', 'pur_supplier', 'sal_company_account_default',
  'sal_customers', 'sal_delivery', 'sal_delivery_item', 'sal_delivery_pack_box',
  'sal_delivery_pack_line', 'sal_order', 'sal_order_item', 'sal_quotation',
  'sal_quotation_item', 'sal_quotation_tier', 'sal_reconciliation',
  'sal_reconciliation_item', 'sal_setting', 'sys_attachment', 'sys_audit_log',
  'sys_file', 'sys_numbering_counter', 'sys_numbering_rule', 'sys_print_template',
  'sys_role', 'sys_role_permission', 'sys_setting', 'sys_storage', 'sys_todo',
  'sys_todo_state', 'sys_user', 'sys_user_company', 'sys_user_role',
] as const

const resourceTargetByLegacyTable = new Map(
  legacyResourceInventory.map(([resource, legacyTable]) => [legacyTable, resource]),
)

const dispositionOverrides: Record<string, TableMigrationDisposition> = {
  acc_gl_entry: { targetTable: 'glEntries' },
  bas_currency: { targetTable: 'currencies' },
  bas_unit: { targetTable: 'units' },
  inv_warehouse: { targetTable: 'warehouses' },
  inv_stock_entry: { targetTable: 'stockEntries' },
  mfg_demand_arrangement: { targetTable: 'mfgDemandArrangements' },
  sys_attachment: { targetTable: 'fileAttachments' },
  sys_audit_log: { targetTable: 'auditLogs' },
  sys_numbering_counter: { targetTable: 'numberingCounters' },
  sys_numbering_rule: { targetTable: 'numberingRules' },
  sys_role: { mergedInto: ['iamRoles'] },
  sys_role_permission: { mergedInto: ['iamRolePermissions'] },
  sys_storage: { retired: 'Plan 006 使用单一配置化 S3 provider' },
  sys_todo: { targetTable: 'todos' },
  sys_todo_state: { targetTable: 'todoStates' },
  sys_user: { mergedInto: ['betterAuth.user', 'appUsers'] },
  sys_user_company: { mergedInto: ['iamUserCompanies'] },
  sys_user_role: { mergedInto: ['iamUserRoles'] },
}

export const tableManifest: readonly TableMigrationEntry[] = legacySqlTables.map(
  (legacyTable) => ({
    legacyTable,
    ownerDomain: legacyTable.split('_', 1)[0] || 'unknown',
    disposition:
      dispositionOverrides[legacyTable] ?? {
        targetTable:
          resourceTargetByLegacyTable.get(legacyTable) ??
          legacyTable.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      },
  }),
)
