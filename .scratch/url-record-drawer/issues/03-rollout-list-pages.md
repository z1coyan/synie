# 03 — 全站列表页记录抽屉迁移

**What to build:** 将各业务列表页上「`useState<{mode,row}|null>` + 开/关抽屉」样板替换为 `useRecordDrawerUrl(resource)`（或共享 Provider 的 `urlSync` 模式）。覆盖所有页面级 `SynieRecordDrawer` / 业务抽屉 Provider；内嵌二级抽屉（`SynieEditableTable` 行编辑、对话框内抽屉）**不得**写 URL。

**Blocked by:** 01, 02

**Status:** resolved

**Parent:** [.scratch/url-record-drawer/spec.md](../spec.md)

## 背景

试点仅 BOM 列表。其余页面（物料、客户、销售订单、工单主抽屉、对账等）仍是本地 state，深链能力未铺开。迁移应机械、可脚本化：grep `setDrawer` / `useState`+`DrawerMode` 找出候选，排除 EditableTable 与 FkPreview。

## 改动面

- 各 `web/app/routes/_app/**/*.tsx` 中页面级抽屉
- 共享 Provider（若有）仿 BOM：`urlSync` 默认 false，列表宿主传 true
- 不得改 server/、packages/、产品文档（除非另开文档票）

## 验收标准

1. 每个迁移页：打开 view/edit/create 后 URL 含正确 `record`/`mode`；关闭清参；刷新保持
2. 与该页 Grid 筛选参数共存（若该页已接 `url-grid-state`）
3. 深链非法 id / 403 有明确 UI（经 rowId + QueryState）
4. `cd web && bunx tsc --noEmit` 零错误；相关单测通过
5. 二级抽屉（EditableTable）URL 无 `record` 变化

## Answer

第二波串行迁完剩余页面级主抽屉后验证（2026-08-02，`wf/frontend-url-rollout`）：

| 检查 | 结果 |
| --- | --- |
| `cd web && bunx tsc --noEmit` | 零错误 |
| `cd web && bun test` | 277 pass / 0 fail |
| `cd web && bun run check` | ok |
| `rg -l useRecordDrawerUrl web/app/routes` | **49** 文件 |
| `rg -l urlSync web/app/routes` | **28** 文件 |
| `rg -l setDrawer web/app/routes` | **0**（旧 `setDrawer` 样板已清空） |

### 已迁移（页面级主抽屉 → URL）

| 路由 / 模块 | resource | 方式 |
| --- | --- | --- |
| `base/units` | basUnits | hook |
| `base/currencies` | basCurrencies | hook |
| `base/accounts` | basAccounts | hook |
| `system/companies` | basCompanies | hook |
| `system/roles` | sysRoles | hook |
| `system/users` | sysUsers | hook |
| `system/storages` | sysStorages | hook |
| `system/print-templates` | sysPrintTemplates | hook |
| `system/numbering` | sysNumberingRules | hook |
| `system/files` | sysFiles | hook |
| `scm/customers` | salCustomers | hook |
| `scm/suppliers` | purSuppliers | hook |
| `scm/materials` | invMaterials | hook（深链 effect 补拉单位转换） |
| `scm/material-categories` | invMaterialCategories | hook |
| `scm/warehouses` | invWarehouses | hook |
| `scm/other-stock/docs`（`-stock-doc`） | invStockDocs | hook |
| `scm/other-stock/counts` | invStockCounts | hook |
| `scm/other-stock/transfers` | invStockTransfers | hook |
| `scm/sales-orders` | salOrders | Provider `urlSync` + 深链 `loadDraft` |
| `scm/purchase` | purOrders | Provider `urlSync` + 深链 load |
| `scm/quotations` | salQuotations | Provider `urlSync` |
| `scm/purchase-quotations` | purQuotations | Provider `urlSync` |
| `scm/sales-deliveries` | salDeliveries | Provider `urlSync` |
| `scm/purchase-receipts` | purReceipts | Provider `urlSync` |
| `scm/outsourced-issues` | purOutsourcedIssues | Provider `urlSync` |
| `scm/outsourced-receipts` | purOutsourcedReceipts | Provider `urlSync` |
| `scm/sales-reconciliations` | salReconciliations | Provider `urlSync` |
| `scm/purchase-reconciliations` | purReconciliations | Provider `urlSync` |
| `mfg/boms` | mfgBoms | Provider `urlSync`（试点） |
| `mfg/operations` | mfgOperations | hook |
| `mfg/process-templates` | mfgProcessTemplates | hook |
| `mfg/work-orders` | mfgWorkOrders | hook（内嵌 BOM Provider **不**传 urlSync） |
| `mfg/demands` | mfgDemands | Provider `urlSync` |
| `mfg/outputs` | mfgOutputs | Provider `urlSync` |
| `finance/bank-accounts` | accBankAccounts | hook |
| `finance/bank-import-templates` | accBankImportTemplates | hook |
| `finance/bank-transactions` | accBankTransactions | hook |
| `finance/entries` | accGlEntries | hook |
| `finance/journals` | accGlJournals | hook |
| `finance/expense-reports` | accExpenseReports | hook |
| `finance/invoices` | accVatInvoices | hook |
| `finance/acceptance/holdings` | accBillHoldings | hook（主抽屉）；发起 tx 二级本地 |
| `finance/acceptance/transactions` | accBillTransactions | hook |
| `hr/employees` | hrEmployees | hook |
| `hr/attendance/corrections` | hrAttendanceCorrections | hook |
| `hr/payroll/loans` | hrEmployeeLoans | hook |
| `hr/payroll/payments` | hrPayrollPayments | hook |
| `hr/payroll/slips` | hrPayrolls | hook |

### 未迁移（有意保留本地态；非本票漏迁）

| 路由 / 组件 | 原因 |
| --- | --- |
| `base/market` | 双资源（价点/品种）独立抽屉，主 search 仅 tab 函数式 merge；抽屉 URL 未接（多 record 键冲突） |
| Provider 内 `localDrawer`（`urlSync=false` 分支） | 嵌套/条目 tab 复用同一 Provider 时不写宿主 URL |
| `work-orders` 内嵌 `BomDrawerProvider`（默认 urlSync false） | 二级 BOM 抽屉不得覆盖工单 `?record=` |
| `finance/acceptance` 发起转让等 `AcceptanceTransactionDrawer` | 二级创建流程，本地 state |
| `finance/-bank-import-drawers`、`finance/-reconcile-drawer` | 导入/对账对话框内嵌抽屉 |
| `hr/attendance/-import-drawers`、`days`、`punches` | 导入/只读查看/重算对话框 |
| `hr/payroll/-payments-section` | 条内嵌套创建抽屉 |
| `scm/stock-entries` | 只读查看抽屉 |
| `system/logs` | 只读审计日志查看 |
| FkPreview | 归 issue 04 |
| 聚合深链验收增强 | 归 issue 05（实现侧已有 `loadDraft` 深链 effect，单独验收不在本票假 resolved） |

### 抽检

1. **materials 深链补单位**：`useEffect` 依赖 `drawer?.recordId/mode`，view/edit 经 `materialUnitClient.query` 拉转换行；create 清空；`unitsLoaded` 门控防回填覆盖。
2. **sales-orders Provider urlSync**：`sales-orders.tsx` 为 `<OrderDrawerProvider urlSync>`；深链 effect 在 `urlSync` 下按 `recordId` `loadDraft`。
3. **work-orders 内嵌 BOM 不写 URL**：`BomDrawerProvider` 无 `urlSync`；主工单 `useRecordDrawerUrl('mfgWorkOrders')`。
4. **market tab 函数式 merge**：`navigate({ search: (prev) => ({ ...prev, tab: k }) })`，注释明确保留网格与抽屉未知键。

`setDrawer` 在 `web/app/routes` 下 **0 命中**；残留本地态使用 `setLocalDrawer` / `setPriceDrawer` 等，均为二级或未迁场景（上表）。
