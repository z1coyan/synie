# 03 — 全站列表页记录抽屉迁移

**What to build:** 将各业务列表页上「`useState<{mode,row}|null>` + 开/关抽屉」样板替换为 `useRecordDrawerUrl(resource)`（或共享 Provider 的 `urlSync` 模式）。覆盖所有页面级 `SynieRecordDrawer` / 业务抽屉 Provider；内嵌二级抽屉（`SynieEditableTable` 行编辑、对话框内抽屉）**不得**写 URL。

**Blocked by:** 01, 02

**Status:** ready-for-agent

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
