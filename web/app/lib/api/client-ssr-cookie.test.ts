/**
 * SSR cookie 转发的并发隔离契约。
 *
 * apiClient 是模块级单例：cookie 必须在每次 fetch 时从当前请求上下文
 * （AsyncLocalStorage）动态取，绝不能实例化时捕获——否则并发 SSR 请求串会话。
 * 本测试用真实 AsyncLocalStorage mock TanStack Start 的请求上下文 API，
 * 两个并发「SSR 请求」各自作用域内发起同一单例 client 的 fetch，
 * 断言各自出站请求携带各自的 cookie。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'

// 模拟 Start 的请求上下文存储；getRequestHeader 与真实实现同样在无上下文时抛错
const requestContext = new AsyncLocalStorage<{ cookie?: string }>()

mock.module('@tanstack/react-start/server', () => ({
  getRequestHeader: (name: string) => {
    const store = requestContext.getStore()
    if (!store) {
      throw new Error('No StartEvent found in AsyncLocalStorage.')
    }
    return name === 'cookie' ? store.cookie : undefined
  },
}))

const originalSsr = process.env.SSR

beforeAll(() => {
  // bun 下 import.meta.env 是 process.env 别名；置 SSR=1 使单例走 SSR 转发分支
  process.env.SSR = '1'
})

afterAll(() => {
  if (originalSsr === undefined) delete process.env.SSR
  else process.env.SSR = originalSsr
})

// client.ts 在 bun（无 window）下构造的就是 SSR 变体单例
import { api } from './client'

function capturingFetch(record: (cookie: string | null) => void): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    // 悬停一拍制造并发窗口：两请求在飞时 headers 已各自定型
    await new Promise((resolve) => setTimeout(resolve, 20))
    record(new Headers(init?.headers).get('cookie'))
    return Response.json({ ok: true })
  }) as typeof fetch
}

describe('SSR cookie 逐请求转发', () => {
  test('两个并发 SSR 请求各自拿到自己的 cookie，不因单例串会话', async () => {
    const seen: Record<string, string | null> = {}

    await Promise.all([
      requestContext.run({ cookie: 'synie.session_token=alice' }, () =>
        api.auth.me.$get(undefined, {
          fetch: capturingFetch((c) => {
            seen.alice = c
          }),
        }),
      ),
      requestContext.run({ cookie: 'synie.session_token=bob' }, () =>
        api.auth.me.$get(undefined, {
          fetch: capturingFetch((c) => {
            seen.bob = c
          }),
        }),
      ),
    ])

    expect(seen.alice).toBe('synie.session_token=alice')
    expect(seen.bob).toBe('synie.session_token=bob')
  })

  test('非请求上下文（构建期等）优雅降级为不带 cookie', async () => {
    let cookie: string | null = 'sentinel'
    await api.auth.me.$get(undefined, {
      fetch: (async (_input: unknown, init?: RequestInit) => {
        cookie = new Headers(init?.headers).get('cookie')
        return Response.json({ ok: true })
      }) as typeof fetch,
    })
    expect(cookie).toBeNull()
  })
})
