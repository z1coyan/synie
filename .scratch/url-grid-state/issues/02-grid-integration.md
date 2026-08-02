# 02 — SynieDataGrid 接入 URL 状态

Status: resolved

## 目标

把 `SynieDataGrid` 内 search/filters/page/pageSize/sort 从纯 `useState` 换成 `useUrlGridState`；新增 `urlState` prop。

## 验收

- 页面级默认开启（`urlState` 缺省且无 `pick`）
- `pick` 模式默认关闭 URL 写入
- 显式 `urlState={false|true}` 覆盖默认
- 筛选/排序/分页/搜索变更写 URL；无参时不写冗余键
- 搜索框草稿在 URL 前进后退时与 `q` 对齐

## Answer

- `SynieDataGridProps.urlState?: boolean`；`resolveUrlStateEnabled(urlState, pick)`
- 状态读写统一走 hook；`applyFilter`/`setSearch`/`setSort`/`setPageSize` 内已回第 1 页
- `GridSearch` 增加 `value` 外部变更时对齐草稿，支持浏览器历史恢复
- 与 `defaultFilters`/`defaultSort` 兼容：`f` 缺席用 defaultFilters；有 defaultSort 时用户清排序写 `sort=none`
