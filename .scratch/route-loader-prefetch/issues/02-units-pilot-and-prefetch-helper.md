# 02 — 预取辅助 + 单位页试点

**What to build:** 新增 `web/app/lib/route-prefetch.ts`（`ensureDefaultGridPage` /
key 维度辅助），默认 page/filters 与 `SynieDataGrid` 初始 state 对齐，缓存键经
`resourceBindingFor(resource).cache`；SSR 下直接 no-op。试点
`web/app/routes/_app/base/units.tsx` 的 loader 调用预取，组件侧 DataGrid 保持
原 useQuery 路径。

**Blocked by:** 01

**Status:** resolved

**Parent:** [.scratch/route-loader-prefetch/spec.md](../spec.md)

- [x] `ensureDefaultGridPage` 并行预取 gridMeta + 默认首屏列表
- [x] 缓存键不手写 gridRows，走 binding.cache.gridKey
- [x] units 路由 loader 接线
- [x] 单测 key 对齐；tsc 通过

## Answer

- 默认 key 维度：`treeActive=false, page=1, pageSize=20, search='', sort=null,
  filters={}, fixedFilter=null, extraFields=''`，与 DataGrid 组件内 useState 一致。
- units loader：`loader: ({ context: { queryClient } }) => ensureDefaultGridPage(queryClient, 'basUnits')`。
- 验证：`bun test app/lib/route-prefetch.test.ts` 4 pass；`bunx tsc --noEmit` 零错误。
