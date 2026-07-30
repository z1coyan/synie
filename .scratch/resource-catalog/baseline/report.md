# Resource Catalog 迁移基线报告

生成时间：2026-07-30T03:35:28.116Z

## 摘要

| 指标 | 数量 |
|------|------|
| 服务端资源 | 97 |
| 字段总数 | 1383 |
| 动作总数 | 305 |
| 声明 Form 的资源 | 36 |
| 前端 ResourceClient | 96 |
| 抽屉 registry 键 | 84 |
| Remote 默认配置 | 4 |
| 缺 Client | 1 |
| 多余 Client | 0 |
| 缺 Drawer | 14 |
| 多余 Drawer | 1 |

## 缺口与漂移

### 服务端有、前端 Client 无

- `sysRolePermissions`

### 前端 Client 有、服务端无

_无_

### 服务端有、Drawer 无（含仅列表/只读投影属正常）

- `accSettings`
- `hrAttendanceCorrections`
- `hrAttendanceDays`
- `invMaterialCategories`
- `mfgSettings`
- `purOrderItemByproducts`
- `purOrderItemMaterials`
- `salCompanyAccountDefaults`
- `salDeliveryPackBoxes`
- `salDeliveryPackLines`
- `salSettings`
- `scmOrderFlowItems`
- `sysRolePermissions`
- `sysSettings`

### Drawer 有、服务端无

- `mfgSetting`

### 已知拼写漂移

- **drawer-typo**: server=`mfgSettings` frontend=`mfgSetting` — drawer registry 使用历史拼写 mfgSetting；服务端与 ResourceClient 为 mfgSettings

### Remote defaults 资源键

- `basUnits`
- `hrEmployees`
- `invMaterialCategories`
- `invMaterials`

## 可扩展统计（后续工单）

```json
{
  "declaredCommands": 0,
  "adapterCommands": 0,
  "basicWritableFields": 0,
  "legacyUsages": 0,
  "writeStubs": 0,
  "notes": "declaredCommands/adapterCommands/basicWritableFields/legacyUsages/writeStubs 在工单 05+ 填入真实计数"
}
```

## 币种等价基线

见 `currency-meta.superadmin.json`（superadmin 投影的完整 Meta 响应）。

## 资源明细（名称 / 字段 / 动作 / Form）

| 资源 | 前缀 | 字段 | 动作 | Form |
|------|------|------|------|------|
| `accBankAccounts` | `acc.bank_account` | 13 | 4 |  |
| `accBankImportItems` | `acc.bank_transaction` | 16 | 1 |  |
| `accBankImports` | `acc.bank_transaction` | 14 | 1 |  |
| `accBankImportTemplates` | `acc.bank_import_template` | 21 | 4 |  |
| `accBankReconciliations` | `acc.bank_transaction` | 7 | 1 |  |
| `accBankTransactions` | `acc.bank_transaction` | 16 | 6 |  |
| `accBillHoldings` | `acc.bill_holding` | 13 | 1 |  |
| `accBills` | `acc.bill` | 23 | 3 |  |
| `accBillTransactions` | `acc.bill_transaction` | 28 | 6 |  |
| `accExpenseReportItems` | `acc.expense_report` | 12 | 1 |  |
| `accExpenseReports` | `acc.expense_report` | 14 | 6 |  |
| `accGlEntries` | `acc.gl_entry` | 18 | 1 |  |
| `accGlJournalLines` | `acc.gl_journal` | 13 | 1 |  |
| `accGlJournals` | `acc.gl_journal` | 14 | 6 |  |
| `accSettings` | `acc.setting` | 4 | 2 | yes |
| `accVatInvoices` | `acc.vat_invoice` | 40 | 7 |  |
| `basAccounts` | `base.account` | 13 | 4 | yes |
| `basCompanies` | `base.company` | 6 | 4 | yes |
| `basCurrencies` | `base.currency` | 7 | 4 | yes |
| `basMarketInstruments` | `base.market_instrument` | 14 | 4 | yes |
| `basMarketPricePoints` | `base.market_price` | 12 | 3 | yes |
| `basUnits` | `base.unit` | 8 | 4 | yes |
| `hrAttendanceCorrections` | `hr.attendance_correction` | 8 | 4 |  |
| `hrAttendanceDays` | `hr.attendance_day` | 13 | 2 |  |
| `hrAttendanceImports` | `hr.attendance_punch` | 20 | 1 |  |
| `hrAttendancePunches` | `hr.attendance_punch` | 6 | 2 |  |
| `hrEmployeeLoans` | `hr.employee_loan` | 10 | 4 |  |
| `hrEmployees` | `hr.employee` | 13 | 4 | yes |
| `hrPayrollPayments` | `hr.payroll_payment` | 11 | 3 |  |
| `hrPayrolls` | `hr.payroll` | 19 | 4 |  |
| `invMaterialCategories` | `inv.material_category` | 9 | 4 | yes |
| `invMaterials` | `inv.material` | 12 | 4 | yes |
| `invMaterialUnits` | `inv.material` | 6 | 1 | yes |
| `invStockCountItems` | `inv.stock_count` | 15 | 1 |  |
| `invStockCounts` | `inv.stock_count` | 14 | 6 |  |
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
| `mfgDemands` | `mfg.demand` | 9 | 7 |  |
| `mfgOperations` | `mfg.operation` | 6 | 4 | yes |
| `mfgOutputItems` | `mfg.output` | 17 | 1 |  |
| `mfgOutputs` | `mfg.output` | 12 | 6 |  |
| `mfgProcessTemplateItems` | `mfg.route_template` | 8 | 1 | yes |
| `mfgProcessTemplates` | `mfg.route_template` | 6 | 4 | yes |
| `mfgSettings` | `mfg.setting` | 4 | 2 | yes |
| `mfgWorkOrders` | `mfg.work_order` | 20 | 5 |  |
| `purOrderItemByproducts` | `purchase.order` | 9 | 1 |  |
| `purOrderItemMaterials` | `purchase.order` | 16 | 1 |  |
| `purOrderItems` | `purchase.order` | 33 | 1 |  |
| `purOrders` | `purchase.order` | 20 | 7 |  |
| `purOutsourcedIssueItems` | `purchase.outsourced_issue` | 24 | 1 |  |
| `purOutsourcedIssues` | `purchase.outsourced_issue` | 15 | 6 |  |
| `purOutsourcedReceiptItemByproducts` | `purchase.outsourced_receipt` | 19 | 1 |  |
| `purOutsourcedReceiptItemMaterials` | `purchase.outsourced_receipt` | 19 | 1 |  |
| `purOutsourcedReceiptItems` | `purchase.outsourced_receipt` | 35 | 1 |  |
| `purOutsourcedReceipts` | `purchase.outsourced_receipt` | 18 | 6 |  |
| `purQuotationItems` | `purchase.quotation` | 25 | 1 |  |
| `purQuotations` | `purchase.quotation` | 16 | 6 |  |
| `purQuotationTiers` | `purchase.quotation` | 7 | 1 |  |
| `purReceiptItems` | `purchase.receipt` | 35 | 1 |  |
| `purReceipts` | `purchase.receipt` | 17 | 6 |  |
| `purReconciliationItems` | `purchase.reconciliation` | 20 | 1 |  |
| `purReconciliations` | `purchase.reconciliation` | 16 | 8 |  |
| `purSuppliers` | `purchase.supplier` | 6 | 4 | yes |
| `salCompanyAccountDefaults` | `sales.setting` | 8 | 0 | yes |
| `salCustomers` | `sales.customer` | 6 | 4 | yes |
| `salDeliveries` | `sales.delivery` | 17 | 9 |  |
| `salDeliveryItems` | `sales.delivery` | 35 | 1 |  |
| `salDeliveryPackBoxes` | `sales.delivery` | 6 | 1 |  |
| `salDeliveryPackLines` | `sales.delivery` | 17 | 1 |  |
| `salOrderItems` | `sales.order` | 29 | 1 |  |
| `salOrders` | `sales.order` | 19 | 10 |  |
| `salQuotationItems` | `sales.quotation` | 25 | 1 |  |
| `salQuotations` | `sales.quotation` | 16 | 6 |  |
| `salQuotationTiers` | `sales.quotation` | 7 | 1 |  |
| `salReconciliationItems` | `sales.reconciliation` | 19 | 1 |  |
| `salReconciliations` | `sales.reconciliation` | 16 | 8 |  |
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
