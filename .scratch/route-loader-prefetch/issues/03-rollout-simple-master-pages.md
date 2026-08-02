# 03 — 简单主数据页全量挂默认 loader 预取

**What to build:** 将 `ensureDefaultGridPage(queryClient, resource)` 推广到**无默认
筛选/排序/树形/extraFields** 的简单主数据列表页（与 units 同构：页面只挂
`SynieDataGrid` + `SynieRecordDrawer`，资源为标准 ResourceBinding）。

**Blocked by:** 01, 02

**Status:** ready-for-agent

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

- [ ] 列入清单的每一页都有 loader 预取，resource 与 DataGrid 一致
- [ ] 无手写 `gridRows` / `rowById` key
- [ ] `cd web && bunx tsc --noEmit` 零错误
- [ ] 至少抽 1 个页面人工或既有 e2e 冒烟：悬停菜单后进入，网络面板可见预取、
      首屏不出现「Meta 完成前列表 enabled=false 的空等」可感瀑布（允许仍有短 loading）
