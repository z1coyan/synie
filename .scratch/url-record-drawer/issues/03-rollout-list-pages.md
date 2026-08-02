# 03 — 全站列表页记录抽屉迁移

**What to build:** 将各业务列表页上「`useState<{mode,row}|null>` + 开/关抽屉」样板替换为 `useRecordDrawerUrl(resource)`（或共享 Provider 的 `urlSync` 模式）。覆盖所有页面级 `SynieRecordDrawer` / 业务抽屉 Provider；内嵌二级抽屉（`SynieEditableTable` 行编辑、对话框内抽屉）**不得**写 URL。

**Blocked by:** 01, 02

**Status:** partial

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

本轮已迁移（`useRecordDrawerUrl` + `rowId` 自查，不再本地 `useState` 抽屉态）：

| 路由 | resource |
| --- | --- |
| `mfg/boms`（试点，既有） | mfgBoms（Provider `urlSync`） |
| `base/units` | basUnits |
| `base/currencies` | basCurrencies |
| `system/companies` | basCompanies |
| `system/roles` | sysRoles |
| `scm/customers` | salCustomers |
| `scm/suppliers` | purSuppliers |
| `mfg/operations` | mfgOperations |
| `finance/bank-accounts` | accBankAccounts |
| `finance/bank-import-templates` | accBankImportTemplates |
| `hr/employees` | hrEmployees |

**未迁移**（仍本地 state；含异步开抽屉副作用 / 聚合 Provider / 复杂多抽屉，归后续批次）：

- `scm/materials`（单位转换异步 + 暂存附件）
- `system/users`（角色/公司关联预拉）
- `system/storages`、`print-templates`、`numbering`、`files`
- `scm/material-categories`、`warehouses`、`accounts`（树）
- `base/market`（双资源抽屉）
- 全部单据聚合页（销售/采购订单/发货/入库/对账/工单/需求/凭证/发票等 `-*-drawer` Provider）
- FkPreview（issue 04）、聚合深链（issue 05）

约定：二级 EditableTable 抽屉、对话框内嵌抽屉本轮均未接 URL（正确）。

验证：`rg -l useRecordDrawerUrl web/app/routes` 12 文件；`tsc` / `bun test` / `check` 全过。
