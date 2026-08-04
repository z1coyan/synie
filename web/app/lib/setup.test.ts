import { describe, expect, test } from 'bun:test'
import {
  activateSetupBaseCurrency,
  completeSetup,
  createSetupFirstUser,
  fetchSetupStatus,
  seedSetupCommonCurrencies,
} from './setup'

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

describe('Setup REST facade', () => {
  test('初始化五个动作保留结构化输入与示例数据选择', async () => {
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

      if (url.endsWith('/status')) {
        return Response.json({ initialized: false, hasUsers: false, logtoEnabled: false })
      }
      if (url.endsWith('/first-user')) {
        return Response.json({
          token: 'token',
          expiresAt: '2099-01-01T00:00:00Z',
          user: { id: 'user-1', username: 'admin', name: null },
        })
      }
      if (url.endsWith('/seed-common')) {
        return Response.json({ created: 3 })
      }
      return Response.json({ success: true })
    }) as typeof fetch

    try {
      await expect(fetchSetupStatus()).resolves.toEqual({
        initialized: false,
        hasUsers: false,
        logtoEnabled: false,
      })
      await expect(
        createSetupFirstUser({ username: 'admin', password: 'secret' }),
      ).resolves.toMatchObject({ token: 'token' })
      await expect(seedSetupCommonCurrencies()).resolves.toEqual({ created: 3 })
      await expect(activateSetupBaseCurrency('currency-cny')).resolves.toEqual({
        success: true,
      })
      await expect(completeSetup('zh-CN', true)).resolves.toEqual({
        success: true,
      })
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(requests).toEqual([
      {
        url: '/api/v1/setup/status',
        method: 'GET',
        body: undefined,
      },
      {
        url: '/api/v1/setup/first-user',
        method: 'POST',
        body: { username: 'admin', password: 'secret' },
      },
      {
        url: '/api/v1/setup/currencies/seed-common',
        method: 'POST',
        body: undefined,
      },
      {
        url: '/api/v1/setup/currencies/activate-base',
        method: 'POST',
        body: { currencyId: 'currency-cny' },
      },
      {
        url: '/api/v1/setup/complete',
        method: 'POST',
        body: { preferredLanguage: 'zh-CN', seedSampleData: true },
      },
    ])
  })
})
