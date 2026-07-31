import { describe, expect, test } from 'bun:test'
import {
  salesReconciliationClient,
  salesReconciliationItemClient,
} from './reconciliations'

interface CapturedRequest {
  url: string
  body?: unknown
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

describe('对账资源 REST Adapter', () => {
  test('列表筛选与条目 decimal 由共享 wire module 编码', async () => {
    const requests: CapturedRequest[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: urlOf(input),
        body:
          typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      return Response.json({ count: 0, results: [], id: 'item-1' })
    }) as typeof fetch

    try {
      await salesReconciliationClient.query({
        limit: 20,
        offset: 40,
        search: '',
        sort: null,
        filter: {
          status: { kind: 'enum', values: ['DRAFT'] },
        },
        fixedFilter: {
          companyId: {
            kind: 'fk',
            values: ['company-1'],
            labels: ['一公司'],
          },
        },
      })
      await salesReconciliationItemClient.create({
        reconciliationId: 'reconciliation-1',
        qty: '',
      })
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(requests).toEqual([
      {
        url: '/api/v1/sales/reconciliations/query',
        body: {
          limit: 20,
          offset: 40,
          filter: {
            status: { kind: 'enum', values: ['DRAFT'] },
            companyId: {
              kind: 'fk',
              values: ['company-1'],
              labels: ['一公司'],
            },
          },
        },
      },
      {
        url: '/api/v1/sales/reconciliation-items',
        body: {
          reconciliationId: 'reconciliation-1',
          qty: null,
        },
      },
    ])
  })
})
