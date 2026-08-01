import { ConvexQueryClient } from '@convex-dev/react-query'
import { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { getConvexEnvironment } from './lib/convex'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  // 首用户初始化必须能在尚无认证令牌时调用公开的 setup mutation。
  // Convex 函数端仍负责全部身份和权限校验，客户端不能作为安全边界。
  const convexQueryClient = new ConvexQueryClient(getConvexEnvironment().url)

  // getRouter 在 TanStack Start 中按请求调用，禁止把 SSR cache 共享到下一位用户。
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // ERP 数据录入场景:切窗口不应触发全表重取;写操作后由页面显式 invalidate 刷新
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: 1,
        queryKeyHashFn: convexQueryClient.hashFn(),
        queryFn: convexQueryClient.queryFn(),
      },
    },
  })

  convexQueryClient.connect(queryClient)

  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    context: {
      queryClient,
      convexQueryClient,
      convexClient: convexQueryClient.convexClient,
    },
  })

  setupRouterSsrQueryIntegration({ router, queryClient })
  return router
}
