# 04 — 依赖 URL / 复杂列表的 loader 预取

**What to build:** 对带 `defaultFilters` / `defaultSort` / `fixedFilter` / `extraFields` /
树形 / 多 Grid 的页面，以及 **url-grid-state 落地后** search 驱动筛选分页的页面，
编写与真实首屏 key 对齐的 loader 预取（可读 URL search，不写 URL）。

**Blocked by:** 01, 02；与 `url-grid-state` 合并后收益最大（可读同一套 search 约定）

**Status:** ready-for-agent

**Parent:** [.scratch/route-loader-prefetch/spec.md](../spec.md)

## 背景

`ensureDefaultGridPage` 只覆盖 DataGrid **默认** state。若页面或 URL 导致首屏
page/filters/sort 非默认，默认预取会写错 key，进页仍 miss 再取——白费请求。

## 改动面

- 扩展 `route-prefetch.ts`（或页面内联）：接受与 DataGrid 相同的 key 维度
  （已有 `DefaultGridPrefetchOptions`），从 `loader` 的 `deps`/search 填入。
- 若 url-grid-state 已合并：loader 用 `validateSearch` 或松散 search 解析出
  page/filters/sort/search，再 `ensureDefaultGridPage(qc, resource, parts)`。
- 多资源页（如 market）对每个首屏可见 Grid 分别预取。
- 与 url-record-drawer 共存时：若 search 含 `record=`，可额外
  `ensureQueryData({ queryKey: binding.cache.rowKey(id), ... })`，非本票强制。
- search 只读；更新 URL 仍归 Grid/Drawer 线，且必须函数式保留未知参数。

## 验收标准

- [ ] 每个迁移页 loader 预取的 key 与该页首屏 DataGrid useQuery key 逐字段一致
  （可用单测或临时 log 对比）
- [ ] 非默认 URL 进入时命中缓存；无「预取了 A、组件读 B」
- [ ] 不手写缓存键；不改 server
- [ ] `bunx tsc --noEmit` 通过
