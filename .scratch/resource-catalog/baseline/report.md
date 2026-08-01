# Resource Catalog 迁移基线报告

生成时间：2026-07-30T05:58:36.276Z

## 摘要

| 指标 | 数量 |
|------|------|
| 服务端资源 | 97 |
| 字段总数 | 1383 |
| 动作总数 | 307 |
| 声明 Form 的资源 | 62 |
| 前端 ResourceTransport binding | 96 |
| Presentation Extension registry 键 | 21 |
| Remote 默认配置 | 0 |
| 缺 Transport | 1 |
| 多余 Transport | 0 |
| 缺 PE 配置 | 76 |
| 多余 PE 配置 | 0 |
| 已规范化资源 | 97 |
| legacy normalizer 调用 | 0 |
| 未分类 | 0 |
| 未解释缺 Transport | 0 |
| 未解释缺 PE 配置 | 0 |
| 拼写漂移 | 0 |

## 缺口与漂移

### 服务端有、前端 Transport 无

- `sysRolePermissions`

### 未解释缺 Transport（应为 0）

_无_

### 前端 Transport 有、服务端无

_无_

### 服务端有、PE 配置无（basic/none/模块共置 PE 属正常）

- `accBankAccounts`
- `accBankImportItems`
- `accBankImportTemplates`
- `accBankImports`
- `accBankReconciliations`
- `accBankTransactions`
- `accBillHoldings`
- `accBillTransactions`
- `accExpenseReportItems`
- `accExpenseReports`
- `accGlEntries`
- `accGlJournalLines`
- `accGlJournals`
- `accSettings`
- `accVatInvoices`
- `basAccounts`
- `basCompanies`
- `basCurrencies`
- `basMarketInstruments`
- `basMarketPricePoints`
- `basUnits`
- `hrAttendanceCorrections`
- `hrAttendanceDays`
- `hrAttendanceImports`
- `hrAttendancePunches`
- `hrEmployeeLoans`
- `hrEmployees`
- `hrPayrollPayments`
- `invMaterialCategories`
- `invMaterialUnits`
- `invMaterials`
- `invStockCountItems`
- `invStockDocItems`
- `invStockEntries`
- `invStockTransferItems`
- `invWarehouses`
- `mfgBomByproducts`
- `mfgBomComponents`
- `mfgBomRoutes`
- `mfgDemandItems`
- `mfgOperations`
- `mfgOutputItems`
- `mfgProcessTemplateItems`
- `mfgSettings`
- `purOrderItemByproducts`
- `purOrderItemMaterials`
- `purOrderItems`
- `purOutsourcedIssueItems`
- `purOutsourcedReceiptItemByproducts`
- `purOutsourcedReceiptItemMaterials`
- `purOutsourcedReceiptItems`
- `purQuotationItems`
- `purQuotationTiers`
- `purReceiptItems`
- `purReconciliationItems`
- `purSuppliers`
- `salCompanyAccountDefaults`
- `salCustomers`
- `salDeliveryItems`
- `salDeliveryPackBoxes`
- `salDeliveryPackLines`
- `salOrderItems`
- `salQuotationItems`
- `salQuotationTiers`
- `salReconciliationItems`
- `salSettings`
- `scmOrderFlowItems`
- `sysAuditLogs`
- `sysFiles`
- `sysNumberingCounters`
- `sysNumberingRules`
- `sysPrintTemplates`
- `sysRolePermissions`
- `sysSettings`
- `sysStorages`
- `sysUsers`

### 未解释缺 PE 配置（应为 0）

_无_

### PE 配置有、服务端无

_无_

### 已知拼写漂移

_无_

### Remote defaults 资源键（应为空；lookup 归目标资源）

_无_

## 呈现分类统计

```json
{
  "basic": 17,
  "extension": 35,
  "none": 45,
  "reference-only": 0
}
```

## 可扩展统计

```json
{
  "declaredCommands": 53,
  "adapterCommands": 53,
  "adapterResources": [
    "accBankTransactions",
    "accBillTransactions",
    "accExpenseReports",
    "accGlJournals",
    "accVatInvoices",
    "basMarketPricePoints",
    "hrAttendanceDays",
    "invStockCounts",
    "invStockDocs",
    "invStockTransfers",
    "mfgDemands",
    "mfgOutputs",
    "mfgWorkOrders",
    "purOrders",
    "purOutsourcedIssues",
    "purOutsourcedReceipts",
    "purQuotations",
    "purReceipts",
    "purReconciliations",
    "salDeliveries",
    "salOrders",
    "salQuotations",
    "salReconciliations",
    "sysPrintTemplates",
    "sysStorages"
  ],
  "proxyActionHooks": 0,
  "proxyActionSites": [],
  "basicWritableFields": 99,
  "legacyUsages": 0,
  "legacyDrawerFieldFacts": [],
  "legacyPageFieldFacts": [],
  "writeStubs": 0,
  "writeStubPatterns": [],
  "basicCatalogFormResources": 17,
  "basicFormConsumerFiles": [
    "web/app/routes/_app/finance/bank-accounts.tsx",
    "web/app/routes/_app/finance/bank-import-templates.tsx",
    "web/app/routes/_app/system/numbering.tsx",
    "web/app/routes/_app/system/users.tsx",
    "web/app/routes/_app/system/storages.tsx",
    "web/app/routes/_app/system/print-templates.tsx",
    "web/app/routes/_app/system/companies.tsx",
    "web/app/routes/_app/scm/suppliers.tsx",
    "web/app/routes/_app/scm/material-categories.tsx",
    "web/app/routes/_app/hr/attendance/corrections.tsx",
    "web/app/routes/_app/hr/payroll/loans.tsx",
    "web/app/routes/_app/hr/payroll/payments.tsx",
    "web/app/routes/_app/hr/payroll/-payments-section.tsx",
    "web/app/routes/_app/base/currencies.tsx",
    "web/app/routes/_app/base/market.tsx",
    "web/app/routes/_app/base/units.tsx",
    "web/app/routes/_app/mfg/operations.tsx"
  ],
  "basicFormConsumerResources": [
    "accBankAccounts",
    "accBankImportTemplates",
    "basCompanies",
    "basCurrencies",
    "basMarketInstruments",
    "basMarketPricePoints",
    "basUnits",
    "hrAttendanceCorrections",
    "hrEmployeeLoans",
    "hrPayrollPayments",
    "invMaterialCategories",
    "mfgOperations",
    "purSuppliers",
    "sysNumberingRules",
    "sysPrintTemplates",
    "sysStorages",
    "sysUsers"
  ],
  "unconsumedBasicFormResources": [],
  "normalizedResources": 97,
  "formKindCounts": {
    "basic": 17,
    "none": 45,
    "extension": 35
  },
  "presentationCounts": {
    "basic": 17,
    "extension": 35,
    "none": 45,
    "reference-only": 0
  },
  "notes": "实测 gaps：adapterCommands=SEMANTIC_COMMAND_ADAPTERS 覆盖的 catalog 命令数；proxyActionHooks=资源实现中的 new Proxy/action transport；legacyUsages=basic 资源 drawer/页面仍手写 required|edit|placeholder；writeStubs=伪造写方法并抛「不支持」的代码点；unconsumedBasicFormResources=未由 useCatalogBasicForm 消费的 basic 资源"
}
```

## 币种等价基线

见 `currency-meta.superadmin.json`（superadmin 投影的完整 Meta 响应）。

## 资源分类明细

| 资源 | 呈现 | 交互 | Transport | PE 配置 | 备注 |
|------|------|------|--------|--------|------|
| `accBankAccounts` | basic | yes | yes |  |  |
| `accBankImportItems` | none |  | yes |  |  |
| `accBankImports` | none |  | yes |  |  |
| `accBankImportTemplates` | basic | yes | yes |  |  |
| `accBankReconciliations` | none |  | yes |  |  |
| `accBankTransactions` | extension | yes | yes |  | 对账 reconcile 命令 + 导入 |
| `accBillHoldings` | none |  | yes |  | 只读持有投影 |
| `accBills` | extension | yes | yes | yes | 票面影像附件 |
| `accBillTransactions` | extension | yes | yes |  |  |
| `accExpenseReportItems` | none |  | yes |  |  |
| `accExpenseReports` | extension | yes | yes |  |  |
| `accGlEntries` | none |  | yes |  | 只读总账分录 |
| `accGlJournalLines` | none |  | yes |  |  |
| `accGlJournals` | extension | yes | yes |  |  |
| `accSettings` | extension | yes | yes |  | update-only 单行设置卡片；含 OCR 密钥只写交互 |
| `accVatInvoices` | extension | yes | yes |  | OCR Presentation Extension |
| `basAccounts` | extension | yes | yes |  | 汇总科目 effects + role 动态可见 + 公司上下文 parent 筛选 |
| `basCompanies` | basic | yes | yes |  |  |
| `basCurrencies` | basic | yes | yes |  |  |
| `basMarketInstruments` | basic | yes | yes |  |  |
| `basMarketPricePoints` | basic | yes | yes |  | create-only + void 命令；无 update |
| `basUnits` | basic | yes | yes |  |  |
| `hrAttendanceCorrections` | basic | yes | yes |  |  |
| `hrAttendanceDays` | none |  | yes |  | 列表 + collection recalc，无表单 |
| `hrAttendanceImports` | none |  | yes |  |  |
| `hrAttendancePunches` | none |  | yes |  |  |
| `hrEmployeeLoans` | basic | yes | yes |  |  |
| `hrEmployees` | extension | yes | yes |  | 身份证影像 extraContent |
| `hrPayrollPayments` | basic | yes | yes |  | create+delete，无 update |
| `hrPayrolls` | extension | yes | yes | yes |  |
| `invMaterialCategories` | basic | yes | yes |  |  |
| `invMaterials` | extension | yes | yes |  | 单位转换 tab + 客户料 effects + 图纸附件 |
| `invMaterialUnits` | none |  | yes |  | 嵌于物料 PE 子表，无独立抽屉 |
| `invStockCountItems` | none |  | yes |  |  |
| `invStockCounts` | extension | yes | yes | yes |  |
| `invStockDocItems` | none |  | yes |  |  |
| `invStockDocs` | extension | yes | yes | yes |  |
| `invStockEntries` | none |  | yes |  | 只读库存分录 |
| `invStockTransferItems` | none |  | yes |  |  |
| `invStockTransfers` | extension | yes | yes | yes |  |
| `invWarehouses` | extension | yes | yes |  | 协作方多态外键，Basic Form fail-closed |
| `mfgBomByproducts` | none |  | yes |  |  |
| `mfgBomComponents` | none |  | yes |  |  |
| `mfgBomRoutes` | none |  | yes |  |  |
| `mfgBoms` | extension | yes | yes | yes |  |
| `mfgDemandItems` | none |  | yes |  |  |
| `mfgDemands` | extension | yes | yes | yes |  |
| `mfgOperations` | basic | yes | yes |  |  |
| `mfgOutputItems` | none |  | yes |  |  |
| `mfgOutputs` | extension | yes | yes | yes |  |
| `mfgProcessTemplateItems` | none |  | yes |  |  |
| `mfgProcessTemplates` | extension | yes | yes | yes |  |
| `mfgSettings` | extension | yes | yes |  | update-only 单行设置卡片；含百分比显示转换 |
| `mfgWorkOrders` | extension | yes | yes | yes |  |
| `purOrderItemByproducts` | none |  | yes |  |  |
| `purOrderItemMaterials` | none |  | yes |  |  |
| `purOrderItems` | none |  | yes |  |  |
| `purOrders` | extension | yes | yes | yes |  |
| `purOutsourcedIssueItems` | none |  | yes |  |  |
| `purOutsourcedIssues` | extension | yes | yes | yes |  |
| `purOutsourcedReceiptItemByproducts` | none |  | yes |  |  |
| `purOutsourcedReceiptItemMaterials` | none |  | yes |  |  |
| `purOutsourcedReceiptItems` | none |  | yes |  |  |
| `purOutsourcedReceipts` | extension | yes | yes | yes |  |
| `purQuotationItems` | none |  | yes |  |  |
| `purQuotations` | extension | yes | yes | yes |  |
| `purQuotationTiers` | none |  | yes |  |  |
| `purReceiptItems` | none |  | yes |  |  |
| `purReceipts` | extension | yes | yes | yes |  |
| `purReconciliationItems` | none |  | yes |  |  |
| `purReconciliations` | extension | yes | yes | yes |  |
| `purSuppliers` | basic | yes | yes |  |  |
| `salCompanyAccountDefaults` | none |  | yes |  | 公司科目默认只读投影 / 嵌入设置 |
| `salCustomers` | extension | yes | yes |  | 附件面板 Presentation Extension |
| `salDeliveries` | extension | yes | yes | yes | AggregateDraftAdapter + 装箱 |
| `salDeliveryItems` | none |  | yes |  |  |
| `salDeliveryPackBoxes` | none |  | yes |  |  |
| `salDeliveryPackLines` | none |  | yes |  |  |
| `salOrderItems` | none |  | yes |  |  |
| `salOrders` | extension | yes | yes | yes |  |
| `salQuotationItems` | none |  | yes |  |  |
| `salQuotations` | extension | yes | yes | yes |  |
| `salQuotationTiers` | none |  | yes |  |  |
| `salReconciliationItems` | none |  | yes |  |  |
| `salReconciliations` | extension | yes | yes | yes |  |
| `salSettings` | extension | yes | yes |  | update-only 单行设置卡片 |
| `scmOrderFlowItems` | none |  | yes |  | 订单流只读投影 |
| `sysAuditLogs` | none |  | yes |  | 只读审计 |
| `sysFiles` | none | yes | yes |  | 上传创建、只读详情与删除；无普通 create/edit Form |
| `sysNumberingCounters` | none |  | yes |  | 计数器只读投影 |
| `sysNumberingRules` | basic | yes | yes |  |  |
| `sysPrintTemplates` | basic | yes | yes |  |  |
| `sysRolePermissions` | none |  |  |  | catalog-only：嵌于角色 PE，无独立 Client/抽屉 |
| `sysRoles` | extension | yes | yes | yes | builtin 动态隐藏 + 权限矩阵 |
| `sysSettings` | extension | yes | yes |  | update-only 单行设置卡片；含调度运行状态 |
| `sysStorages` | basic | yes | yes |  | setDefault 命令 |
| `sysUsers` | basic | yes | yes |  |  |

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
| `sysPrintTemplates` | `sys.print_template` | 8 | 6 | yes |
| `sysRolePermissions` | `sys.role_permission` | 4 | 3 |  |
| `sysRoles` | `sys.role` | 7 | 8 | yes |
| `sysSettings` | `sys.setting` | 8 | 2 | yes |
| `sysStorages` | `sys.storage` | 15 | 5 | yes |
| `sysUsers` | `sys.user` | 6 | 4 | yes |
