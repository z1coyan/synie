# 01 — 编解码与 useUrlGridState

Status: resolved

## 目标

实现网格状态与 URL search 的编解码，以及 `SynieDataGrid` 内可切换的状态 hook。

## 验收

- `~/lib/url-grid-state.ts`：parse/encode/merge；默认值省略；FilterState 各 kind 往返；坏输入 fail-soft
- `use-url-grid-state.ts`：enabled 时 URL 为源，disabled 时本地 useState；函数式 search 更新
- 单测覆盖编解码与 merge 保留未知键

## Answer

- 实现文件：
  - `web/app/lib/url-grid-state.ts` + `url-grid-state.test.ts`
  - `web/app/components/synie-data-grid/use-url-grid-state.ts`
- 键约定：`q`/`page`/`ps`/`sort`/`f`；`sort` 升序 `col`、降序 `-col`、显式无排序 `none`；`f` 为 FilterState JSON（与 wire 同构，含 labels）
- `mergeGridUrlSearch` 只动网格键，保留 `record`/`mode`/其它
- `bun test app/lib/url-grid-state.test.ts` 通过
