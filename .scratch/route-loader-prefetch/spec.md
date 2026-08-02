# Spec: 路由 loader 预取基建

**Status:** done（基建 + 单位页试点）；全量推广见 issues
**Feature slug:** `route-loader-prefetch`
**ADR:** [docs/adr/2026-08-02-route-loader-prefetch.md](../../docs/adr/2026-08-02-route-loader-prefetch.md)
**Domain terms:** ResourceBinding、查询缓存身份、ensureQueryData（见 `CONTEXT.md` 与前端深模块 ADR）
**Depends on:** ResourceBinding 缓存身份（已交付）、TanStack Router/Query（已安装）
**Related:** `url-grid-state`、`url-record-drawer`（同日前端 URL 架构三件套，边界见 ADR）

---

## Problem Statement

全站约 150 个业务路由没有 `loader`：`QueryClient` 只在 `__root` 模块级创建，数据全部在
组件挂载后 `useQuery` 发起。结果是：

1. 进入列表页必现 Meta → 列表的**请求瀑布**，首屏长时间 loading；
2. 菜单悬停无法提前取数，点击后才开始拉；
3. 与 TanStack 推荐的「loader + ensureQueryData + intent preload」模型脱节，
   `@tanstack/react-router-ssr-query` 已在依赖树中却未接线。

同时 token 在 localStorage、API 相对路径，SSR 阶段发不了鉴权请求——认证门已用
`typeof window === 'undefined'` 跳过。本轮不摊牌 SSR，只接通**客户端导航预取**。

## Solution

1. **QueryClient 统一入口**（`web/app/lib/query-client.ts`），浏览器单例；
2. **router context** 注入 `queryClient`，`defaultPreload: 'intent'`，Register 类型补全；
3. **`setupRouterSsrQueryIntegration({ wrapQueryClient: false })`** 接线；
   `__root` 保留 `QueryClientProvider`，实例来自 route context；
4. **预取辅助** `ensureDefaultGridPage`：缓存键经 `resourceBindingFor(resource).cache`，
   SSR 跳过鉴权数据；
5. **试点** `base/units`：loader 预取默认首屏，DataGrid `useQuery` 同 key 命中缓存。

## User Stories

1. As a 业务用户, I want 从菜单点进单位管理时列表尽快有数据, so that 不再先看一整屏 loading 再刷出表格
2. As a 业务用户, I want 鼠标悬停菜单项时后台开始拉目标页数据, so that 点击后几乎立刻看见列表
3. As a 前端开发, I want 在路由 loader 里用 ensureQueryData 预取且 queryKey 与 DataGrid 一致, so that 组件无需改数据源即可吃到缓存
4. As a 前端开发, I want QueryClient 只有一个统一入口并进 router context, so that loader 与组件共享同一缓存、不会预取了却挂不上
5. As a 前端开发, I want 列表/单条缓存键只经 resourceBindingFor(resource).cache, so that 不手写 gridRows/rowById、与失效路径一致
6. As a 系统, I want SSR 阶段跳过需鉴权的预取, so that 不破坏现有空壳 SSR 与认证门语义
7. As a 架构维护者, I want 与 url-grid-state / url-record-drawer 边界写进 ADR, so that 三线合并时 search 参数与缓存约定不互相踩踏
8. As a 前端开发, I want 简单主数据页有可复制的 loader 样板与推广工单, so that 全站迁移可分批 AFK 推进

## Out of Scope

- SSR 鉴权、token 上 cookie、服务端代发 API、Query 脱水/注水完整闭环
- 全站 150 路由一次性迁移（仅 units 试点 + 推广工单）
- 改 BootSplash、login/setup、`_app` 认证门
- 改 server/、packages/、产品文档与 CONTEXT.md
- 新增或升级 npm 依赖

## Testing Decisions

- 单测：`defaultGridKeyParts` / `defaultGridQueryKey` 与 DataGrid 默认维度、binding.cache 对齐
- `bunx tsc --noEmit` 零错误
- 不强制 e2e 本轮；试点页人工/后续 e2e 可断言无多余 loading 瀑布
