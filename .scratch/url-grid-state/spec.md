# Spec: 数据网格状态入 URL

**Status:** in-progress
**Feature slug:** `url-grid-state`
**ADR:** [docs/adr/2026-08-02-url-grid-state.md](../../docs/adr/2026-08-02-url-grid-state.md)
**Depends on:** 无（与 `url-record-drawer` / `route-loader-prefetch` 边界正交，见 ADR）

---

## Problem Statement

`SynieDataGrid` 的搜索词、列筛选、分页与排序全部收在组件内部 `useState`。刷新即丢、筛选视图无法用链接分享、浏览器前进/后退不经过这些状态。全站约 150 个路由里仅 `finance/entries` 与 `base/market` 使用 `validateSearch`，其余页面零 search 契约；若要求每个列表路由手写 `validateSearch` 才能同步状态，迁移成本不可接受。

## Solution

在 `SynieDataGrid` 内部（`useUrlGridState` + `~/lib/url-grid-state`）把页面级网格的查询状态同步到 URL search params：

- 键：`q` / `page` / `ps` / `sort` / `f`（FilterState JSON，与 wire 同构，含 fk labels）
- 读：`useSearch({ strict: false })`，路由无需 `validateSearch`
- 写：函数式 `navigate({ search: old => merge(...) })`，只补丁网格键，保留 `record`/`mode`/其它未知参数
- 默认：页面网格开启；`pick` 选择器关闭；内嵌用法显式 `urlState={false}`
- 无参访问与改前默认行为一致（page=1、ps=20、无搜索/筛选、排序取 `defaultSort`）

试点：`scm/materials` 验证真实页面；其余页面默认即生效，边缘场景与内嵌点位扫尾见工单。

## User Stories

1. As a 业务用户, I want 在物料列表搜「轴承」并筛选启用状态后复制地址栏, so that 同事打开同一链接看到同一结果集
2. As a 业务用户, I want 刷新列表页后仍停留在第 3 页且筛选未丢, so that 不会重新找记录
3. As a 业务用户, I want 浏览器后退回到上一次筛选/分页, so that 排查数据时能逐步回退
4. As a 业务用户, I want 无参数打开列表与改前一样（默认排序、第 1 页、无筛选）, so that 书签与菜单入口行为不变
5. As a 开发者, I want 页面路由零改动即可获得 URL 同步, so that 不必为 100+ 列表写 validateSearch
6. As a 开发者, I want 内嵌网格（远程选择弹窗、对账抽屉内表）不写 URL, so that 不会污染宿主页的查询状态
7. As a 开发者, I want 网格 URL 键与记录抽屉的 record/mode 共存, so that 两条工作线可同页并行
8. As a 业务用户, I want URL 恢复的外键筛选在 Chips 上显示可读标签且可改可清, so that 分享链接与手工筛选体验一致
