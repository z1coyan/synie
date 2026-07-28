import { hc } from 'hono/client'
import type { ApiType } from './app.ts'

/**
 * hono/client 工厂：web、e2e 与集成测试共用的类型化客户端。
 * 服务端路由/输入类型经 ApiType 全链路传导——这就是 OpenAPI 的替代物：
 * 契约即代码，改路由不改客户端会直接类型报错。
 */
export function createApiClient(baseUrl: string, options?: { token?: string | (() => string | null) }) {
  return hc<ApiType>(baseUrl, {
    headers: () => {
      const token = typeof options?.token === 'function' ? options.token() : options?.token
      const headers: Record<string, string> = {}
      if (token) headers.Authorization = `Bearer ${token}`
      return headers
    },
  })
}

export type ApiClient = ReturnType<typeof createApiClient>
