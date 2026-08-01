import { describe, expect, test } from 'bun:test'
import {
  dismissTodo,
  fetchTodos,
  fetchUnreadCount,
  markTodoRead,
} from './system-ops'

interface CapturedRequest {
  url: string
  method: string
  body?: unknown
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

describe('Todo REST facade', () => {
  test('列表、未读、已读与忽略穿过公开 facade', async () => {
    const requests: CapturedRequest[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const url = urlOf(input)
      requests.push({
        url,
        method:
          init?.method ?? (input instanceof Request ? input.method : 'GET'),
        body:
          typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      })

      if (url.endsWith('/query')) {
        return Response.json({ count: 0, results: [] })
      }
      if (url.endsWith('/unread-count')) {
        return Response.json({ count: 2 })
      }
      return Response.json({})
    }) as typeof fetch

    try {
      await expect(
        fetchTodos('active', { limit: 10, offset: 20 }),
      ).resolves.toEqual({ count: 0, results: [] })
      await expect(fetchUnreadCount()).resolves.toBe(2)
      await expect(markTodoRead('todo-1')).resolves.toBeUndefined()
      await expect(dismissTodo('todo-1')).resolves.toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(requests).toEqual([
      {
        url: '/api/v1/todos/query',
        method: 'POST',
        body: {
          tab: 'active',
          includeDismissed: false,
          limit: 10,
          offset: 20,
        },
      },
      {
        url: '/api/v1/todos/unread-count',
        method: 'GET',
        body: undefined,
      },
      {
        url: '/api/v1/todos/todo-1/read',
        method: 'POST',
        body: undefined,
      },
      {
        url: '/api/v1/todos/todo-1/dismiss',
        method: 'POST',
        body: undefined,
      },
    ])
  })

  test('无读取权限时 facade 返回空列表与零未读', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      Response.json(
        {
          error: {
            code: 'forbidden',
            message: '无权限',
          },
        },
        { status: 403 },
      )) as unknown as typeof fetch

    try {
      await expect(fetchTodos('active')).resolves.toEqual({
        count: 0,
        results: [],
      })
      await expect(fetchUnreadCount()).resolves.toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
