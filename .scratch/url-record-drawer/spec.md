# Spec: 记录抽屉 URL 化

**Status:** in-progress
**Feature slug:** `url-record-drawer`
**ADR:** [docs/adr/2026-08-02-url-record-drawer.md](../../docs/adr/2026-08-02-url-record-drawer.md)
**Domain terms:** 记录抽屉、深链、search 参数、ResourceBinding、单条缓存键（见 `CONTEXT.md` 与 web/AGENTS.md）
**Depends on:** ResourceBinding 缓存身份（已交付）、SynieRecordDrawer rowId 自查与 QueryState 三态（已交付）；与 `url-grid-state` / `route-loader-prefetch` 正交共存

---

## Problem Statement

各业务页的记录详情/编辑抽屉几乎一律是组件内 `useState<{ mode, row } | null>` 驱动。结果是：

- **无法深链**：同事要看同一张 BOM/订单，只能口头报编号再自己在列表里搜；
- **无法新标签打开**：复制地址栏只能到列表页，抽屉态丢失；
- **刷新即关**：F5 后抽屉消失，排查与对照现场不友好；
- **前进后退不经过抽屉**：浏览器历史只记路由 path，不记「当前打开哪条记录」。

全局 `FkPreview` 速览同样是状态驱动，属同一类问题，但本轮不纳入实现（见后续工单）。

## Solution

引入可复用 hook `useRecordDrawerUrl`（`web/app/lib/use-record-drawer-url.ts`），把「开/关抽屉 + mode + 记录 id」同步到 URL search：

| search | 语义 |
| --- | --- |
| `?record=<id>&mode=view` | 查看既有记录（`mode` 缺省或非法一律 view） |
| `?record=<id>&mode=edit` | 编辑既有记录 |
| `?record=new` | 新建态（`mode` 参数忽略并在序列化时落掉） |
| 无 `record` | 抽屉关闭，行为与改造前一致 |

约束与边界：

1. **函数式 search 更新**：`prev => ({ ...prev, ...patch })`，保留未知参数（尤其 Grid 筛选），绝不整包替换——与 `url-grid-state` 同页共存。
2. **缓存身份**：深链初始行加载经 `resourceBindingFor(resource).reader.get` + `binding.cache.rowKey(id)`，与 `SynieRecordDrawer` 内部 rowId 自查同键并发去重。
3. **三态 UI**：加载中 / 记录不存在 / 无权限(403) 交给 `SynieRecordDrawer` 已有 QueryState/EmptyState；hook 另暴露 `rowPending`/`rowMissing`/`rowError` 供自绘。
4. **历史语义**：`open` 压栈（后退可关抽屉），`setMode`/`close` 就地 `replace`（不制造噪音）。
5. **试点**：仅 `mfg/boms` 列表启用 `urlSync`；`BomDrawerProvider` 在工单内嵌场景默认关闭 URL 同步。FkPreview 与其余页面全量推广为后续工单。

## User Stories

1. As a 业务用户, I want 打开 BOM 详情后地址栏带上记录 id, so that 我能把链接发给同事直达同一张单
2. As a 业务用户, I want 刷新页面后抽屉仍停在同一记录, so that 对照现场时不怕 F5
3. As a 业务用户, I want 浏览器后退关闭抽屉且保留列表筛选, so that 历史导航符合直觉且不丢 Grid 状态
4. As a 业务用户, I want 深链打开不存在的记录时看到明确「记录不存在」提示, so that 不会对着空白表单猜
5. As a 业务用户, I want 深链打开无权限记录时看到「无权限访问」而不是通用失败, so that 我知道是授权问题
6. As a 业务用户, I want 深链加载中有明确 spinner, so that 知道系统在取数而不是卡死
7. As a 业务用户, I want 新建入口写 `record=new` 且关闭后清参, so that 分享「新建」链与「关抽屉」行为一致
8. As a 开发者, I want 用 `useRecordDrawerUrl(resource)` 替换 useState 样板, so that 各页迁移成本可控
9. As a 开发者, I want search 读写一律函数式并保留未知参数, so that 与 Grid URL 化同页不互相覆盖
10. As a 开发者, I want 单条缓存键走 `resourceBindingFor(resource).cache`, so that 不手写 `rowById` 也不与抽屉内部查询重复
11. As a 开发者, I want 共享抽屉 Provider 可关 URL 同步（工单内嵌 BOM）, so that 内嵌场景不污染宿主页 URL
12. As a 系统, I want 无 `record` 参数时行为与改造前一致, so that 既有书签与菜单入口零回归
