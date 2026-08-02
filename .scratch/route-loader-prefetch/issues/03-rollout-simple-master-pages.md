# 03 — 简单主数据页全量挂默认 loader 预取

**What to build:** 将 `ensureDefaultGridPage(queryClient, resource)` 推广到**无默认
筛选/排序/树形/extraFields** 的简单主数据列表页（与 units 同构：页面只挂
`SynieDataGrid` + `SynieRecordDrawer`，资源为标准 ResourceBinding）。

**Blocked by:** 01, 02

**Status:** partial

**Parent:** [.scratch/route-loader-prefetch/spec.md](../spec.md)

## 背景

基建与 units 试点已落地。其余同构页仍是组件挂载后才请求，intent 预加载对它们无效。

## 改动面

- 目标路由：`web/app/routes/_app/base/`、`system/`、以及其它「仅 resource + 默认
  DataGrid」的页面（实施前用 grep `createFileRoute` + `SynieDataGrid` 列出，排除
  market、accounts 树形、带 fixedFilter/defaultSort/extraFields 的页面——那些归 04）。
- 每页：import `ensureDefaultGridPage`，在 `createFileRoute` 增加
  `loader: ({ context: { queryClient } }) => ensureDefaultGridPage(queryClient, RESOURCE)`。
- **禁止**手写 queryKey；RESOURCE 字符串与页面 DataGrid 的 `resource` prop 必须一致。
- 不改组件、不改 server、不改产品文档。

## 验收标准

- [x] 列入清单的每一页都有 loader 预取，resource 与 DataGrid 一致（本轮清单见 Answer）
- [x] 无手写 `gridRows` / `rowById` key
- [x] `cd web && bunx tsc --noEmit` 零错误
- [ ] 至少抽 1 个页面人工或既有 e2e 冒烟：悬停菜单后进入，网络面板可见预取、
      首屏不出现「Meta 完成前列表 enabled=false 的空等」可感瀑布（允许仍有短 loading）

## Answer

本轮已挂 `ensureDefaultGridPage` loader 的简单主数据页（`rg -l ensureDefaultGridPage web/app/routes` → **18** 文件）：

| 路由 | RESOURCE |
| --- | --- |
| `base/units`（试点） | basUnits |
| `base/currencies` | basCurrencies |
| `system/companies` | basCompanies |
| `system/roles` | sysRoles |
| `system/users` | sysUsers |
| `system/storages` | sysStorages |
| `system/print-templates` | sysPrintTemplates |
| `system/numbering` | sysNumberingRules |
| `scm/customers` | salCustomers |
| `scm/suppliers` | purSuppliers |
| `mfg/operations` | mfgOperations |
| `mfg/process-templates` | mfgProcessTemplates |
| `finance/bank-accounts` | accBankAccounts |
| `finance/bank-import-templates` | accBankImportTemplates |
| `finance/journals` | accGlJournals |
| `finance/expense-reports` | accExpenseReports |
| `finance/invoices` | accVatInvoices |
| `hr/employees` | hrEmployees |

**未挂**（归 04 或非「默认首屏」同构）：market（tab/双网格）、accounts/warehouses/material-categories（树+fixedFilter）、materials（extraFields/join）、单据列表（defaultSort/筛选）、files 等带额外逻辑页；以及复杂/URL 驱动筛选页。

验证（2026-08-02）：`tsc` / `bun test`（277）/ `check` 全过；无手写 gridRows。**人工悬停预取冒烟仍未在浏览器执行** → 保持 **partial**（勿标 resolved）。
