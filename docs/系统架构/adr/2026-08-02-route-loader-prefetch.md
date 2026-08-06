# ADR：路由 loader 预取与 QueryClient 进 router context

2026-08-02，状态：已实施（基建 + 单位页试点）。本 ADR 与同日
[`2026-08-02-url-grid-state.md`](./2026-08-02-url-grid-state.md)、
[`2026-08-02-url-record-drawer.md`](./2026-08-02-url-record-drawer.md)
共同构成前端 URL/导航架构三件套；三者边界正交，合并时不得互相吞并 search 参数或缓存键约定。

## 背景

约 150 个业务路由零 `loader`：数据全部在组件内 `useQuery` 发起，首屏必然出现
Meta → 列表的请求瀑布，菜单悬停也无法提前取数。`QueryClient` 曾在
`routes/__root.tsx` 模块级创建，router 对其无感；`@tanstack/react-router-ssr-query`
已随 Start 出现在依赖树中但从未接线。

token 存 localStorage、API 走相对路径，SSR 阶段既读不到凭证也发不出同源请求——
`_app.tsx` 的 `beforeLoad` 已有 `typeof window === 'undefined' return` 先例。
本轮**不**解决 SSR 鉴权与脱水，只把客户端导航预取能力接通。

## 决策

### 1. QueryClient 统一入口 + 进 router context

- 新建 `web/app/lib/query-client.ts`：`createAppQueryClient` / `getAppQueryClient`
  （浏览器单例、SSR 每次新建）与 `AppRouterContext` 类型。
- `router.tsx`：`createRouter({ context: { queryClient }, defaultPreload: 'intent',
  defaultPreloadStaleTime: 30_000 })`，并 `declare module` 补全 `Register`。
- 调用 `setupRouterSsrQueryIntegration({ wrapQueryClient: false })` 接通集成钩子；
  **不**让它再包一层 Provider——`__root.tsx` 继续挂 `QueryClientProvider`，
  实例取自 `Route.useRouteContext().queryClient`，与 router 同源。
- 根路由改 `createRootRouteWithContext<AppRouterContext>()`，loader 经
  `context.queryClient` 类型安全访问。

### 2. loader 用 ensureQueryData；缓存键只经 ResourceBinding.cache

- 预取列表/单条时，queryKey 一律 `resourceBindingFor(resource).cache.gridKey(...)`
  / `rowKey(...)`，禁止手写 `['gridRows', ...]` / `['rowById', ...]`。
- 辅助模块 `web/app/lib/route-prefetch.ts` 提供 `ensureDefaultGridPage`，
  默认维度与 `SynieDataGrid` 初始 state（page=1、pageSize=20、空筛选/搜索等）对齐，
  保证 loader 与组件 `useQuery` 命中同一 key。
- **SSR 跳过鉴权数据**：`ensureDefaultGridPage` 在 `typeof window === 'undefined'`
  时直接返回；SSR HTML 仍为空壳。SSR 鉴权、cookie/token 传递与脱水是**明确的后续工作**，
  不在本轮范围。

### 3. 导航 intent 预加载

`defaultPreload: 'intent'` 使 `<Link>` 悬停/触摸触发目标路由 loader，从而在点击前
完成 `ensureQueryData`。`defaultPreloadStaleTime` 与 Query 默认 `staleTime`（30s）
对齐，避免进页立刻二次请求。

### 4. 试点与推广边界

- 本轮仅迁移 `web/app/routes/_app/base/units.tsx`：loader 预取 Meta + 默认首屏列表；
  组件内 `useQuery`（经 DataGrid）保持不变。
- 其余页面推广见原 `.scratch/route-loader-prefetch/issues/` 后续工单（已删除）。
- **不改** BootSplash、login/setup、`_app` 认证门语义。

## 与另两个 slug 的边界与兼容

| 能力 | 负责 | 不负责 |
|------|------|--------|
| **route-loader-prefetch**（本 ADR） | QueryClient 生命周期、router context、loader `ensureQueryData`、intent 预加载 | URL search 读写、抽屉深链 |
| **url-grid-state** | DataGrid 的 search/filters/page/sort 同步到 URL | 数据预取；不得手写缓存键 |
| **url-record-drawer** | 记录抽屉 `record`/`mode` 参数与深链 | 列表预取；FkPreview URL 另立项 |

兼容约定：

1. **search 参数共存**：Grid 线与 Drawer 线读写 search 一律函数式更新并保留未知键
   （`old => ({ ...old, ...patch })`），绝不全量替换。loader 预取若依赖 URL 状态
   （筛选/分页/record id），只**读取**对应参数，不写 URL。
2. **缓存键唯一来源**：三线凡触及列表/单条缓存，一律 `resourceBindingFor(resource).cache`。
3. **推广顺序建议**：无 URL 状态依赖的简单主数据页可先挂默认 `ensureDefaultGridPage`；
   依赖筛选/分页 URL 的页面应在 url-grid-state 落地后，让 loader 按 search 构造
   与 DataGrid 相同的 key parts 再预取；抽屉深链的单条预取用 `cache.rowKey(id)`。
4. **合并冲突**：`router.tsx` / `__root.tsx` 仅本线改动；Grid/Drawer 线改组件与
   各自试点路由。三线不应争抢同一路由文件的同一关注点。

## 备选方案

- **继续组件内 useQuery only**（拒）：无法消灭首屏瀑布，也无法利用 intent 预加载。
- **loader 返回 data、组件不用 Query**（拒）：与全站 React Query 缓存/失效模型分叉，
  写后 invalidate 与预取无法共享。
- **setupRouterSsrQueryIntegration 接管 Provider**（拒本轮）：会与「保留 __root
  Provider、BootSplash 不动」冲突；`wrapQueryClient: false` 已接通钩子，
  未来 SSR 脱水可再评估是否改由集成包装。
- **本轮做全站 SSR 鉴权**（拒）：token 在 localStorage 的取舍需独立设计
  （cookie / 服务端 session / Start server functions），范围远超预取基建。

## 后果

- 新页面/迁移页的标准模式：`loader` 调 `ensureDefaultGridPage`（或按 search/params
  定制 key）→ 组件继续 `useQuery` / DataGrid。
- intent 预加载会增加悬停时的 API 流量；`staleTime` 与 preload stale 控制重复请求。
- SSR 仍为空壳：首屏 HTML 无业务数据，SEO/无 JS 首屏不在目标内；客户端 hydrate 后
  经 loader（或组件）取数。后续若上 SSR 鉴权，须同步改 `ensureDefaultGridPage` 的
  window 守卫与 token 传递。
- 与 url-grid-state 合并后，默认预取在「URL 已有非默认筛选」时可能与首屏 key 不一致
  ——属预期，对应推广工单要求 loader 读 search 对齐。
