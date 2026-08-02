# 01 — QueryClient 统一入口与 router context

**What to build:** 把 QueryClient 创建从 `__root.tsx` 模块级抽到 `web/app/lib/query-client.ts`；
`getRouter()` 注入 `context.queryClient`、开启 `defaultPreload: 'intent'` 与匹配的
`defaultPreloadStaleTime`；补全 `Register` 类型；接线
`setupRouterSsrQueryIntegration({ wrapQueryClient: false })`；根路由改为
`createRootRouteWithContext`，Provider 实例取自 route context。不改 BootSplash /
认证门语义。

**Blocked by:** None

**Status:** resolved

**Parent:** [.scratch/route-loader-prefetch/spec.md](../spec.md)

- [x] `web/app/lib/query-client.ts`：create/get + `AppRouterContext`
- [x] `web/app/router.tsx`：context、intent 预加载、Register、ssr-query 集成
- [x] `web/app/routes/__root.tsx`：WithContext + Provider 同源实例
- [x] tsc 通过

## Answer

- 浏览器端 `getAppQueryClient()` 单例，保证 loader 预取与组件 `useQuery` 共享缓存；
  SSR 每次新建（本轮 loader 跳过鉴权数据）。
- `defaultPreload: 'intent'` + `defaultPreloadStaleTime: 30_000` 与 Query 默认
  staleTime 对齐。
- `wrapQueryClient: false` 避免与 `__root` Provider 双重包裹。
- 验证：`cd web && bunx tsc --noEmit`；相关单测见 02。
