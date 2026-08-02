/**
 * 应用级 QueryClient 统一入口。
 *
 * router context 与 `__root` 的 QueryClientProvider 必须共享同一实例，
 * 否则 loader 的 ensureQueryData 与组件 useQuery 会各用各的缓存。
 *
 * 浏览器端单例；SSR 每次新建（本轮鉴权数据在 loader 内跳过，不依赖 SSR 脱水）。
 */
import { QueryClient } from '@tanstack/react-query'

const defaultOptions = {
  queries: {
    // ERP 数据录入场景:切窗口不应触发全表重取;写操作后由页面显式 invalidate 刷新
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
  },
} as const

/** 新建 QueryClient（测试或显式需要独立实例时用） */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions })
}

let browserClient: QueryClient | undefined

/**
 * 取得应用 QueryClient。
 * - 浏览器：进程内单例，router 与 Provider 共用
 * - SSR：每次新建，避免跨请求串缓存
 */
export function getAppQueryClient(): QueryClient {
  if (typeof window === 'undefined') {
    return createAppQueryClient()
  }
  if (!browserClient) {
    browserClient = createAppQueryClient()
  }
  return browserClient
}

/** 路由 context 形状；loader 经 context.queryClient 预取 */
export type AppRouterContext = {
  queryClient: QueryClient
}
