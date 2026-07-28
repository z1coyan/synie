/**
 * 打印字段目录「权限前缀头」占位 Meta。
 * 其余业务域工单落地真实 Meta 后可删除对应 stub（registry 按 name 去重 fail-closed）。
 * 仅保证 `/printing/resources` 对齐 Go 60 前缀；字段面随域工单充实。
 */
import type { ResourceMeta } from '../meta/types.ts'
import type { Registry } from '../meta/registry.ts'

interface StubSpec {
  name: string
  prefix: string
  label: string
  table: string
  printHead?: boolean
}

/** Go metaregistry 派生的 60 个打印头前缀对应最小资源（已存在平台资源的前缀不在此列） */
const STUBS: StubSpec[] = [
  { name: 'accBankAccounts', prefix: 'acc.bank_account', label: '银行账户', table: 'acc_bank_account' },
  {
    name: 'accBankImportTemplates',
    prefix: 'acc.bank_import_template',
    label: '银行导入模板',
    table: 'acc_bank_import_template',
  },
  {
    name: 'accBankTransactions',
    prefix: 'acc.bank_transaction',
    label: '银行流水',
    table: 'acc_bank_transaction',
  },
  { name: 'accBills', prefix: 'acc.bill', label: '票据', table: 'acc_bill' },
  { name: 'accBillHoldings', prefix: 'acc.bill_holding', label: '票据持有', table: 'acc_bill_holding' },
  {
    name: 'accBillTransactions',
    prefix: 'acc.bill_transaction',
    label: '票据流转',
    table: 'acc_bill_transaction',
  },
  { name: 'accExpenseReports', prefix: 'acc.expense_report', label: '报销单', table: 'acc_expense_report' },
  { name: 'accGlEntries', prefix: 'acc.gl_entry', label: '总账分录', table: 'acc_gl_entry' },
  { name: 'accGlJournals', prefix: 'acc.gl_journal', label: '会计凭证', table: 'acc_gl_journal', printHead: true },
  { name: 'accVatInvoices', prefix: 'acc.vat_invoice', label: '增值税发票', table: 'acc_vat_invoice' },
  {
    name: 'basMarketPrices',
    prefix: 'base.market_price',
    label: '行情价点',
    table: 'bas_market_price',
  },
  {
    name: 'hrAttendanceCorrections',
    prefix: 'hr.attendance_correction',
    label: '考勤补录',
    table: 'hr_attendance_correction',
  },
  { name: 'hrAttendanceDays', prefix: 'hr.attendance_day', label: '日考勤', table: 'hr_attendance_day' },
  {
    name: 'hrAttendancePunches',
    prefix: 'hr.attendance_punch',
    label: '打卡记录',
    table: 'hr_attendance_punch',
  },
  { name: 'hrEmployeeLoans', prefix: 'hr.employee_loan', label: '员工借款', table: 'hr_employee_loan' },
  { name: 'hrPayrolls', prefix: 'hr.payroll', label: '工资单', table: 'hr_payroll', printHead: true },
  {
    name: 'hrPayrollPayments',
    prefix: 'hr.payroll_payment',
    label: '工资支付',
    table: 'hr_payroll_payment',
  },
  {
    name: 'invMaterialCategories',
    prefix: 'inv.material_category',
    label: '物料分类',
    table: 'inv_material_category',
  },
  { name: 'invStockCounts', prefix: 'inv.stock_count', label: '盘点单', table: 'inv_stock_count', printHead: true },
  { name: 'invStockDocs', prefix: 'inv.stock_doc', label: '出入库单', table: 'inv_stock_doc', printHead: true },
  { name: 'invStockEntries', prefix: 'inv.stock_entry', label: '库存余额', table: 'inv_stock_entry' },
  {
    name: 'invStockTransfers',
    prefix: 'inv.stock_transfer',
    label: '调拨单',
    table: 'inv_stock_transfer',
    printHead: true,
  },
  { name: 'invWarehouses', prefix: 'inv.warehouse', label: '仓库', table: 'inv_warehouse' },
  { name: 'mfgBoms', prefix: 'mfg.bom', label: 'BOM', table: 'mfg_bom' },
  { name: 'mfgDemands', prefix: 'mfg.demand', label: '履约需求', table: 'mfg_demand', printHead: true },
  { name: 'mfgOperations', prefix: 'mfg.operation', label: '工序', table: 'mfg_operation' },
  { name: 'mfgOutputs', prefix: 'mfg.output', label: '生产入库', table: 'mfg_output', printHead: true },
  {
    name: 'mfgRouteTemplates',
    prefix: 'mfg.route_template',
    label: '工艺模板',
    table: 'mfg_route_template',
  },
  { name: 'mfgWorkOrders', prefix: 'mfg.work_order', label: '工单', table: 'mfg_work_order' },
  { name: 'purOrders', prefix: 'purchase.order', label: '采购订单', table: 'pur_order', printHead: true },
  {
    name: 'purOutsourcedIssues',
    prefix: 'purchase.outsourced_issue',
    label: '委外发料',
    table: 'pur_outsourced_issue',
    printHead: true,
  },
  {
    name: 'purOutsourcedReceipts',
    prefix: 'purchase.outsourced_receipt',
    label: '委外入库',
    table: 'pur_outsourced_receipt',
    printHead: true,
  },
  {
    name: 'purQuotations',
    prefix: 'purchase.quotation',
    label: '采购报价',
    table: 'pur_quotation',
    printHead: true,
  },
  { name: 'purReceipts', prefix: 'purchase.receipt', label: '采购入库', table: 'pur_receipt', printHead: true },
  {
    name: 'purReconciliations',
    prefix: 'purchase.reconciliation',
    label: '采购对账',
    table: 'pur_reconciliation',
    printHead: true,
  },
  { name: 'salDeliveries', prefix: 'sales.delivery', label: '销售发货', table: 'sal_delivery', printHead: true },
  {
    name: 'salQuotations',
    prefix: 'sales.quotation',
    label: '销售报价',
    table: 'sal_quotation',
    printHead: true,
  },
  {
    name: 'salReconciliations',
    prefix: 'sales.reconciliation',
    label: '销售对账',
    table: 'sal_reconciliation',
    printHead: true,
  },
]

function stubMeta(spec: StubSpec): ResourceMeta {
  return {
    name: spec.name,
    permissionPrefix: spec.prefix,
    permissionLabel: spec.label,
    table: spec.table,
    printHead: spec.printHead,
    fields: [
      {
        name: 'id',
        apiName: 'id',
        dbColumn: 'id',
        type: 'uuid',
        label: 'id',
        readonly: true,
        sortable: true,
      },
      {
        name: 'name',
        apiName: 'name',
        dbColumn: 'name',
        type: 'string',
        label: '名称',
        filterable: true,
        sortable: true,
      },
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
  }
}

/**
 * 注册尚未存在的打印目录占位资源。
 * 若某 name 已由业务域注册则跳过；若前缀已有资源且无 printHead 冲突则依赖已有候选。
 */
export function registerPrintCatalogStubs(registry: Registry): void {
  for (const spec of STUBS) {
    if (registry.get(spec.name)) continue
    // 前缀已有任一资源时：仅当需要 printHead 且尚无 printHead 才注册
    const existing = registry.list().filter((r) => r.permissionPrefix === spec.prefix)
    if (existing.length > 0) {
      if (spec.printHead && !existing.some((r) => r.printHead) && existing.length > 1) {
        registry.register(stubMeta(spec))
      }
      continue
    }
    registry.register(stubMeta(spec))
  }
}
