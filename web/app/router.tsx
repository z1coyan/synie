import { createRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { getAppQueryClient } from '~/lib/query-client'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const queryClient = getAppQueryClient()
  const router = createRouter({
    routeTree,
    context: { queryClient },
    // 悬停/触摸意图预加载：触发目标路由 loader（含 ensureQueryData）
    defaultPreload: 'intent',
    // 与 QueryClient 默认 staleTime 对齐，避免 preload 后进页立刻重取
    defaultPreloadStaleTime: 30_000,
    scrollRestoration: true,
  })

  // 接通 SSR/Query 集成钩子；Provider 仍由 __root 挂载，避免双重包裹
  setupRouterSsrQueryIntegration({
    router,
    queryClient,
    wrapQueryClient: false,
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
