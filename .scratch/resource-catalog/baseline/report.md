# Resource Catalog 迁移基线报告

生成时间：2026-07-30T05:21:05.647Z

## 摘要

| 指标 | 数量 |
|------|------|
| 服务端资源 | 97 |
| 字段总数 | 1383 |
| 动作总数 | 305 |
| 声明 Form 的资源 | 62 |
| 前端 ResourceClient | 96 |
| 抽屉 registry 键 | 84 |
| Remote 默认配置 | 0 |
| 缺 Client | 1 |
| 多余 Client | 0 |
| 缺 Drawer | 13 |
| 多余 Drawer | 0 |
| typed 资源 | 97 |
| legacy 资源 | 0 |
| legacy normalizer 调用 | 0 |
| 未分类 | 0 |
| 未解释缺 Client | 0 |
| 未解释缺 Drawer | 0 |
| 拼写漂移 | 0 |

## 缺口与漂移

### 服务端有、前端 Client 无

- `sysRolePermissions`

### 未解释缺 Client（应为 0）

_无_

### 前端 Client 有、服务端无

_无_

### 服务端有、Drawer 无（含仅列表/只读投影属正常）

- `accSettings`
- `hrAttendanceCorrections`
- `hrAttendanceDays`
- `invMaterialCategories`
- `purOrderItemByproducts`
- `purOrderItemMaterials`
- `salCompanyAccountDefaults`
- `salDeliveryPackBoxes`
- `salDeliveryPackLines`
- `salSettings`
- `scmOrderFlowItems`
- `sysRolePermissions`
- `sysSettings`

### 未解释缺 Drawer（应为 0）

_无_

### Drawer 有、服务端无

_无_

### 已知拼写漂移

_无_

### Remote defaults 资源键（应为空；lookup 归目标资源）

_无_

## 呈现分类统计

```json
{
  "basic": 22,
  "extension": 31,
  "none": 44,
  "reference-only": 0
}
```

## 可扩展统计

```json
{
  "declaredCommands": 51,
  "adapterCommands": 3,
  "adapterResources": [
    "sysStorages",
    "hrAttendanceDays",
    "accBankTransactions"
  ],
  "proxyActionHooks": 17,
  "basicWritableFields": 98,
  "legacyUsages": 17,
  "legacyDrawerFieldFacts": [],
  "legacyPageFieldFacts": [
    "web/app/routes/_app/finance/acceptance/-transaction-drawer.tsx",
    "web/app/routes/_app/finance/-bank-import-drawers.tsx",
    "web/app/routes/_app/finance/invoices.tsx",
    "web/app/routes/_app/finance/bank-transactions.tsx",
    "web/app/routes/_app/finance/bank-import-templates.tsx",
    "web/app/routes/_app/finance/journals.tsx",
    "web/app/routes/_app/system/numbering.tsx",
    "web/app/routes/_app/system/storages.tsx",
    "web/app/routes/_app/system/print-templates.tsx",
    "web/app/routes/_app/scm/warehouses.tsx",
    "web/app/routes/_app/scm/sales-orders/-order-drawer.tsx",
    "web/app/routes/_app/scm/materials.tsx",
    "web/app/routes/_app/scm/purchase/-order-drawer.tsx",
    "web/app/routes/_app/hr/attendance/corrections.tsx",
    "web/app/routes/_app/hr/payroll/loans.tsx",
    "web/app/routes/_app/hr/payroll/slips.tsx",
    "web/app/routes/_app/hr/payroll/-payments-section.tsx"
  ],
  "writeStubs": 14,
  "writeStubPatterns": [
    "binding-registry:1",
    "system-ops:2",
    "hr-operations.ts:2",
    "finance-operations.ts:2",
    "inventory.ts:3",
    "system-ops.ts:2",
    "accounting.ts:1",
    "fulfillment.ts:1"
  ],
  "basicCatalogFormResources": 18,
  "basicFormConsumerFiles": [
    "web/app/routes/_app/finance/bank-accounts.tsx",
    "web/app/routes/_app/system/users.tsx",
    "web/app/routes/_app/system/companies.tsx",
    "web/app/routes/_app/scm/suppliers.tsx",
    "web/app/routes/_app/scm/material-categories.tsx",
    "web/app/routes/_app/base/currencies.tsx",
    "web/app/routes/_app/base/market.tsx",
    "web/app/routes/_app/base/units.tsx",
    "web/app/routes/_app/mfg/operations.tsx"
  ],
  "typedResources": 97,
  "formKindCounts": {
    "basic": 18,
    "none": 48,
    "extension": 31
  },
  "presentationCounts": {
    "basic": 22,
    "extension": 31,
    "none": 44,
    "reference-only": 0
  },
  "notes": "实测 gaps：adapterCommands=SEMANTIC_COMMAND_ADAPTERS 覆盖的 catalog 命令数；legacyUsages=basic 资源 drawer/页面仍手写 required|edit|placeholder；writeStubs=抛「不支持 create/update/delete」的代码点"
}
```

## 币种等价基线

见 `currency-meta.superadmin.json`（superadmin 投影的完整 Meta 响应）。

## 资源分类明细

| 资源 | 呈现 | 交互 | Client | Drawer | 备注 |
|------|------|------|--------|--------|------|
| `accBankAccounts` | basic | yes | yes | yes |  |
| `accBankImportItems` | none |  | yes | yes |  |
| `accBankImports` | none |  | yes | yes |  |
| `accBankImportTemplates` | basic | yes | yes | yes |  |
| `accBankReconciliations` | none |  | yes | yes |  |
| `accBankTransactions` | extension | yes | yes | yes | 对账 reconcile 命令 + 导入 |
| `accBillHoldings` | none |  | yes | yes | 只读持有投影 |
| `accBills` | extension | yes | yes | yes | 票面影像附件 |
| `accBillTransactions` | extension | yes | yes | yes |  |
| `accExpenseReportItems` | none |  | yes | yes |  |
| `accExpenseReports` | extension | yes | yes | yes |  |
| `accGlEntries` | none |  | yes | yes | 只读总账分录 |
| `accGlJournalLines` | none |  | yes | yes |  |
| `accGlJournals` | extension | yes | yes | yes |  |
| `accSettings` | basic | yes | yes |  | update-only |
| `accVatInvoices` | extension | yes | yes | yes | OCR Presentation Extension |
| `basAccounts` | extension | yes | yes | yes | 汇总科目 effects + role 动态可见 + 公司上下文 parent 筛选 |
| `basCompanies` | basic | yes | yes | yes |  |
| `basCurrencies` | basic | yes | yes | yes |  |
| `basMarketInstruments` | basic | yes | yes | yes |  |
| `basMarketPricePoints` | basic | yes | yes | yes | create-only + void 命令；无 update |
| `basUnits` | basic | yes | yes | yes |  |
| `hrAttendanceCorrections` | basic | yes | yes |  |  |
| `hrAttendanceDays` | none |  | yes |  | 列表 + collection recalc，无表单 |
| `hrAttendanceImports` | none |  | yes | yes |  |
| `hrAttendancePunches` | none |  | yes | yes |  |
| `hrEmployeeLoans` | basic | yes | yes | yes |  |
| `hrEmployees` | extension | yes | yes | yes | 身份证影像 extraContent |
| `hrPayrollPayments` | basic | yes | yes | yes | create+delete，无 update |
| `hrPayrolls` | extension | yes | yes | yes |  |
| `invMaterialCategories` | basic | yes | yes |  |  |
| `invMaterials` | extension | yes | yes | yes | 单位转换 tab + 客户料 effects + 图纸附件 |
| `invMaterialUnits` | none |  | yes | yes | 嵌于物料 PE 子表，无独立抽屉 |
| `invStockCountItems` | none |  | yes | yes |  |
| `invStockCounts` | extension | yes | yes | yes |  |
| `invStockDocItems` | none |  | yes | yes |  |
| `invStockDocs` | extension | yes | yes | yes |  |
| `invStockEntries` | none |  | yes | yes | 只读库存分录 |
| `invStockTransferItems` | none |  | yes | yes |  |
| `invStockTransfers` | extension | yes | yes | yes |  |
| `invWarehouses` | extension | yes | yes | yes | 协作方多态外键，Basic Form fail-closed |
| `mfgBomByproducts` | none |  | yes | yes |  |
| `mfgBomComponents` | none |  | yes | yes |  |
| `mfgBomRoutes` | none |  | yes | yes |  |
| `mfgBoms` | extension | yes | yes | yes |  |
| `mfgDemandItems` | none |  | yes | yes |  |
| `mfgDemands` | extension | yes | yes | yes |  |
| `mfgOperations` | basic | yes | yes | yes |  |
| `mfgOutputItems` | none |  | yes | yes |  |
| `mfgOutputs` | extension | yes | yes | yes |  |
| `mfgProcessTemplateItems` | none |  | yes | yes |  |
| `mfgProcessTemplates` | extension | yes | yes | yes |  |
| `mfgSettings` | basic | yes | yes | yes | update-only 设置；前端历史拼写 mfgSetting 已删除 |
| `mfgWorkOrders` | extension | yes | yes | yes |  |
| `purOrderItemByproducts` | none |  | yes |  |  |
| `purOrderItemMaterials` | none |  | yes |  |  |
| `purOrderItems` | none |  | yes | yes |  |
| `purOrders` | extension | yes | yes | yes |  |
| `purOutsourcedIssueItems` | none |  | yes | yes |  |
| `purOutsourcedIssues` | extension | yes | yes | yes |  |
| `purOutsourcedReceiptItemByproducts` | none |  | yes | yes |  |
| `purOutsourcedReceiptItemMaterials` | none |  | yes | yes |  |
| `purOutsourcedReceiptItems` | none |  | yes | yes |  |
| `purOutsourcedReceipts` | extension | yes | yes | yes |  |
| `purQuotationItems` | none |  | yes | yes |  |
| `purQuotations` | extension | yes | yes | yes |  |
| `purQuotationTiers` | none |  | yes | yes |  |
| `purReceiptItems` | none |  | yes | yes |  |
| `purReceipts` | extension | yes | yes | yes |  |
| `purReconciliationItems` | none |  | yes | yes |  |
| `purReconciliations` | extension | yes | yes | yes |  |
| `purSuppliers` | basic | yes | yes | yes |  |
| `salCompanyAccountDefaults` | none |  | yes |  | 公司科目默认只读投影 / 嵌入设置 |
| `salCustomers` | extension | yes | yes | yes | 附件面板 Presentation Extension |
| `salDeliveries` | extension | yes | yes | yes | AggregateDraftAdapter + 装箱 |
| `salDeliveryItems` | none |  | yes | yes |  |
| `salDeliveryPackBoxes` | none |  | yes |  |  |
| `salDeliveryPackLines` | none |  | yes |  |  |
| `salOrderItems` | none |  | yes | yes |  |
| `salOrders` | extension | yes | yes | yes |  |
| `salQuotationItems` | none |  | yes | yes |  |
| `salQuotations` | extension | yes | yes | yes |  |
| `salQuotationTiers` | none |  | yes | yes |  |
| `salReconciliationItems` | none |  | yes | yes |  |
| `salReconciliations` | extension | yes | yes | yes |  |
| `salSettings` | basic | yes | yes |  | update-only |
| `scmOrderFlowItems` | none |  | yes |  | 订单流只读投影 |
| `sysAuditLogs` | none |  | yes | yes | 只读审计 |
| `sysFiles` | basic | yes | yes | yes | create+delete，无 update |
| `sysNumberingCounters` | none |  | yes | yes | 计数器只读投影 |
| `sysNumberingRules` | basic | yes | yes | yes |  |
| `sysPrintTemplates` | basic | yes | yes | yes |  |
| `sysRolePermissions` | none |  |  |  | catalog-only：嵌于角色 PE，无独立 Client/抽屉 |
| `sysRoles` | extension | yes | yes | yes | builtin 动态隐藏 + 权限矩阵 |
| `sysSettings` | basic | yes | yes |  | update-only |
| `sysStorages` | basic | yes | yes | yes | setDefault 命令 |
| `sysUsers` | basic | yes | yes | yes |  |

## 资源明细（名称 / 字段 / 动作 / Form）

| 资源 | 前缀 | 字段 | 动作 | Form |
|------|------|------|------|------|
| `accBankAccounts` | `acc.bank_account` | 13 | 4 | yes |
| `accBankImportItems` | `acc.bank_transaction` | 16 | 1 |  |
| `accBankImports` | `acc.bank_transaction` | 14 | 1 |  |
| `accBankImportTemplates` | `acc.bank_import_template` | 21 | 4 | yes |
| `accBankReconciliations` | `acc.bank_transaction` | 7 | 1 |  |
| `accBankTransactions` | `acc.bank_transaction` | 16 | 6 | yes |
| `accBillHoldings` | `acc.bill_holding` | 13 | 1 |  |
| `accBills` | `acc.bill` | 23 | 3 | yes |
| `accBillTransactions` | `acc.bill_transaction` | 28 | 6 | yes |
| `accExpenseReportItems` | `acc.expense_report` | 12 | 1 |  |
| `accExpenseReports` | `acc.expense_report` | 14 | 6 | yes |
| `accGlEntries` | `acc.gl_entry` | 18 | 1 |  |
| `accGlJournalLines` | `acc.gl_journal` | 13 | 1 |  |
| `accGlJournals` | `acc.gl_journal` | 14 | 6 | yes |
| `accSettings` | `acc.setting` | 4 | 2 | yes |
| `accVatInvoices` | `acc.vat_invoice` | 40 | 7 | yes |
| `basAccounts` | `base.account` | 13 | 4 | yes |
| `basCompanies` | `base.company` | 6 | 4 | yes |
| `basCurrencies` | `base.currency` | 7 | 4 | yes |
| `basMarketInstruments` | `base.market_instrument` | 14 | 4 | yes |
| `basMarketPricePoints` | `base.market_price` | 12 | 3 | yes |
| `basUnits` | `base.unit` | 8 | 4 | yes |
| `hrAttendanceCorrections` | `hr.attendance_correction` | 8 | 4 | yes |
| `hrAttendanceDays` | `hr.attendance_day` | 13 | 2 |  |
| `hrAttendanceImports` | `hr.attendance_punch` | 20 | 1 |  |
| `hrAttendancePunches` | `hr.attendance_punch` | 6 | 2 |  |
| `hrEmployeeLoans` | `hr.employee_loan` | 10 | 4 | yes |
| `hrEmployees` | `hr.employee` | 13 | 4 | yes |
| `hrPayrollPayments` | `hr.payroll_payment` | 11 | 3 | yes |
| `hrPayrolls` | `hr.payroll` | 19 | 4 | yes |
| `invMaterialCategories` | `inv.material_category` | 9 | 4 | yes |
| `invMaterials` | `inv.material` | 12 | 4 | yes |
| `invMaterialUnits` | `inv.material` | 6 | 1 | yes |
| `invStockCountItems` | `inv.stock_count` | 15 | 1 |  |
| `invStockCounts` | `inv.stock_count` | 14 | 6 | yes |
| `invStockDocItems` | `inv.stock_doc` | 15 | 1 | yes |
| `invStockDocs` | `inv.stock_doc` | 14 | 6 | yes |
| `invStockEntries` | `inv.stock_entry` | 14 | 1 |  |
| `invStockTransferItems` | `inv.stock_transfer` | 16 | 1 | yes |
| `invStockTransfers` | `inv.stock_transfer` | 17 | 6 | yes |
| `invWarehouses` | `inv.warehouse` | 14 | 4 | yes |
| `mfgBomByproducts` | `mfg.bom` | 8 | 1 | yes |
| `mfgBomComponents` | `mfg.bom` | 9 | 1 | yes |
| `mfgBomRoutes` | `mfg.bom` | 8 | 1 | yes |
| `mfgBoms` | `mfg.bom` | 7 | 4 | yes |
| `mfgDemandItems` | `mfg.demand` | 23 | 1 |  |
| `mfgDemands` | `mfg.demand` | 9 | 7 | yes |
| `mfgOperations` | `mfg.operation` | 6 | 4 | yes |
| `mfgOutputItems` | `mfg.output` | 17 | 1 |  |
| `mfgOutputs` | `mfg.output` | 12 | 6 | yes |
| `mfgProcessTemplateItems` | `mfg.route_template` | 8 | 1 | yes |
| `mfgProcessTemplates` | `mfg.route_template` | 6 | 4 | yes |
| `mfgSettings` | `mfg.setting` | 4 | 2 | yes |
| `mfgWorkOrders` | `mfg.work_order` | 20 | 5 | yes |
| `purOrderItemByproducts` | `purchase.order` | 9 | 1 |  |
| `purOrderItemMaterials` | `purchase.order` | 16 | 1 |  |
| `purOrderItems` | `purchase.order` | 33 | 1 |  |
| `purOrders` | `purchase.order` | 20 | 7 | yes |
| `purOutsourcedIssueItems` | `purchase.outsourced_issue` | 24 | 1 |  |
| `purOutsourcedIssues` | `purchase.outsourced_issue` | 15 | 6 | yes |
| `purOutsourcedReceiptItemByproducts` | `purchase.outsourced_receipt` | 19 | 1 |  |
| `purOutsourcedReceiptItemMaterials` | `purchase.outsourced_receipt` | 19 | 1 |  |
| `purOutsourcedReceiptItems` | `purchase.outsourced_receipt` | 35 | 1 |  |
| `purOutsourcedReceipts` | `purchase.outsourced_receipt` | 18 | 6 | yes |
| `purQuotationItems` | `purchase.quotation` | 25 | 1 |  |
| `purQuotations` | `purchase.quotation` | 16 | 6 | yes |
| `purQuotationTiers` | `purchase.quotation` | 7 | 1 |  |
| `purReceiptItems` | `purchase.receipt` | 35 | 1 |  |
| `purReceipts` | `purchase.receipt` | 17 | 6 | yes |
| `purReconciliationItems` | `purchase.reconciliation` | 20 | 1 |  |
| `purReconciliations` | `purchase.reconciliation` | 16 | 8 | yes |
| `purSuppliers` | `purchase.supplier` | 6 | 4 | yes |
| `salCompanyAccountDefaults` | `sales.setting` | 8 | 0 | yes |
| `salCustomers` | `sales.customer` | 6 | 4 | yes |
| `salDeliveries` | `sales.delivery` | 17 | 9 | yes |
| `salDeliveryItems` | `sales.delivery` | 35 | 1 |  |
| `salDeliveryPackBoxes` | `sales.delivery` | 6 | 1 |  |
| `salDeliveryPackLines` | `sales.delivery` | 17 | 1 |  |
| `salOrderItems` | `sales.order` | 29 | 1 |  |
| `salOrders` | `sales.order` | 19 | 10 | yes |
| `salQuotationItems` | `sales.quotation` | 25 | 1 |  |
| `salQuotations` | `sales.quotation` | 16 | 6 | yes |
| `salQuotationTiers` | `sales.quotation` | 7 | 1 |  |
| `salReconciliationItems` | `sales.reconciliation` | 19 | 1 |  |
| `salReconciliations` | `sales.reconciliation` | 16 | 8 | yes |
| `salSettings` | `sales.setting` | 8 | 2 | yes |
| `scmOrderFlowItems` | `scm.order_flow` | 14 | 0 |  |
| `sysAuditLogs` | `sys.audit_log` | 11 | 1 |  |
| `sysFiles` | `sys.file` | 9 | 3 | yes |
| `sysNumberingCounters` | `sys.numbering_rule` | 6 | 0 | yes |
| `sysNumberingRules` | `sys.numbering_rule` | 8 | 4 | yes |
| `sysPrintTemplates` | `sys.print_template` | 8 | 4 | yes |
| `sysRolePermissions` | `sys.role_permission` | 4 | 3 |  |
| `sysRoles` | `sys.role` | 7 | 8 | yes |
| `sysSettings` | `sys.setting` | 8 | 2 | yes |
| `sysStorages` | `sys.storage` | 15 | 5 | yes |
| `sysUsers` | `sys.user` | 6 | 4 | yes |
