# 04 — 内嵌网格显式关闭 URL 状态

Status: ready-for-agent

## 背景

页面级网格默认 `urlState` 开启；内嵌网格写同一 search 会污染宿主列表（甚至抢掉筛选）。`pick` 模式已在组件内默认关闭，但下列**非 pick** 内嵌点仍会写 URL，必须逐一加 `urlState={false}`。

## 改动面（本分支文件范围外，须单独提交）

1. `web/app/routes/_app/finance/-bank-import-drawers.tsx`
   - 导入历史 Sheet 内 `accBankImports` 网格
   - 导入详情 `extraContent` 内 `accBankImportItems` 网格
2. `web/app/routes/_app/finance/-reconcile-drawer.tsx`
   - 流水对账列表 `accBankReconciliations` 网格（`hideSearch`，非 pick）
   - （pick 选择凭证网格已由 `pick` 默认关闭，建议仍显式 `urlState={false}` 求稳）
3. `web/app/components/synie-remote-select/RemoteDialogSelect.tsx`
   - 虽已 `pick="single"` 默认关闭，建议显式 `urlState={false}` 作为契约文档

可选扫尾：全库 `rg '<SynieDataGrid'` 再确认无遗漏内嵌（抽屉 `-*.tsx`、Modal、Sheet）。

## 验收标准

- 上述调用点均带 `urlState={false}`
- 打开银行流水「导入历史」并搜索时，宿主 `accBankTransactions` 列表 URL（若有）不被改写
- `pick` 弹窗内翻页/搜索不出现 `q`/`page`/`f` 写入地址栏
- `cd web && bunx tsc --noEmit` 与 `bun run check` 通过
