import { createServerFn } from '@tanstack/react-start'

/** SSR 与客户端导航共用的 server function；token 不进入浏览器 storage。 */
export const getConvexAuthToken = createServerFn({ method: 'GET' }).handler(
  async () => {
    const { getConvexAuthRuntime } = await import('./auth-runtime.server')
    return (await getConvexAuthRuntime().getToken()) ?? null
  },
)
