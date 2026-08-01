import { describe, expect, test } from 'bun:test'
import type { ConvexReactClient } from 'convex/react'
import { createConvexBindingResolver } from './convex-bindings'

function fakeClient() {
  const calls: Array<{ kind: 'query' | 'mutation'; args: unknown }> = []
  const client = {
    async query(_reference: unknown, args: unknown) {
      calls.push({ kind: 'query', args })
      return {
        results: [{ id: 'opaque-convex-id', name: '人民币', isoCode: 'CNY' }],
        pageInfo: { continueCursor: 'opaque-next-cursor', isDone: false },
      }
    },
    async mutation(_reference: unknown, args: unknown) {
      calls.push({ kind: 'mutation', args })
      return 3
    },
  } as unknown as ConvexReactClient
  return { client, calls }
}

describe('Convex ResourceBinding', () => {
  test('resolver 暴露已验收闭包，未知资源 fail-closed', () => {
    const { client } = fakeClient()
    const resolve = createConvexBindingResolver(client)
    expect(resolve('basCurrencies').resource).toBe('basCurrencies')
    expect(resolve('basUnits').resource).toBe('basUnits')
    expect(resolve('invWarehouses').resource).toBe('invWarehouses')
    expect(resolve('basCompanies').resource).toBe('basCompanies')
    expect(resolve('sysUsers').commands).toBeDefined()
    expect(resolve('salSettings').writer).toBeDefined()
    expect(resolve('salOrders').draft).toBeDefined()
    expect(resolve('salOrders').writer?.create).toBeUndefined()
    expect(resolve('salOrders').writer?.update).toBeUndefined()
    expect(resolve('salOrders').writer?.delete).toBeDefined()
    expect(resolve('accBankReconciliations').writer?.delete).toBeDefined()
    expect(() => resolve('unknownResource')).toThrow(/尚未迁移到 Convex/)
  })

  test('reader 原样传递 opaque cursor，且不伪造 totalCount', async () => {
    const { client, calls } = fakeClient()
    const page = await createConvexBindingResolver(client)('basCurrencies').reader.query({
      profile: 'default',
      numItems: 2,
      cursor: 'opaque-current-cursor',
    })
    expect(calls).toEqual([{
      kind: 'query',
      args: {
        profile: 'default',
        numItems: 2,
        cursor: 'opaque-current-cursor',
      },
    }])
    expect(page.pageInfo).toEqual({ continueCursor: 'opaque-next-cursor', isDone: false })
    expect(page).not.toHaveProperty('totalCount')
  })

  test('未声明筛选组合在调用 Convex 前失败', async () => {
    const { client, calls } = fakeClient()
    const reader = createConvexBindingResolver(client)('basCurrencies').reader
    await expect(reader.query({
      profile: 'default',
      numItems: 20,
      sort: { column: 'name', direction: 'ascending' },
    })).rejects.toThrow(/暂不支持/)
    await expect(reader.query({
      profile: 'default',
      numItems: 20,
      search: 'CNY',
      filter: { active: { kind: 'bool', eq: true } },
    })).rejects.toThrow(/搜索 \+ 启用筛选/)
    expect(calls).toEqual([])
  })

  test('领域页面的固定排序、父范围与月份解析为有限 query profile', async () => {
    const { client, calls } = fakeClient()
    const resolve = createConvexBindingResolver(client)
    await resolve('salOrderItems').reader.query({
      profile: 'default',
      numItems: 20,
      cursor: null,
      sort: { column: 'idx', direction: 'descending' },
      fixedFilter: { orderId: { kind: 'fk', values: ['opaque-order'], labels: [] } },
    })
    await resolve('hrPayrolls').reader.query({
      profile: 'default',
      numItems: 20,
      cursor: null,
      fixedFilter: { month: { kind: 'text', op: 'eq', value: '2026-07' } },
    })
    expect(calls.map((call) => call.args)).toEqual([
      {
        resource: 'salOrderItems', numItems: 20, cursor: null,
        queryArgs: {
          parentId: 'opaque-order', sortField: 'idx', sortDirection: 'descending',
        },
      },
      {
        resource: 'hrPayrolls', numItems: 20, cursor: null,
        queryArgs: { month: '2026-07' },
      },
    ])
  })

  test('领域 binding 对未声明 fixedFilter 和排序 fail-closed', async () => {
    const { client, calls } = fakeClient()
    const reader = createConvexBindingResolver(client)('salOrders').reader
    await expect(reader.query({
      profile: 'default', numItems: 20,
      fixedFilter: { partyId: { kind: 'fk', values: ['opaque-party'], labels: [] } },
    })).rejects.toThrow(/暂不支持/)
    await expect(reader.query({
      profile: 'default', numItems: 20,
      sort: { column: 'grossTotal', direction: 'descending' },
    })).rejects.toThrow(/暂不支持/)
    expect(calls).toEqual([])
  })

  test('仓库 collection command 经语义 Adapter 调用 seed mutation', async () => {
    const { client, calls } = fakeClient()
    const commands = createConvexBindingResolver(client)('invWarehouses').commands!
    await expect(commands.execute('seedDefaults', { companyId: 'opaque-company-id' })).resolves.toBe(3)
    expect(calls).toEqual([{
      kind: 'mutation',
      args: { companyId: 'opaque-company-id' },
    }])
  })
})
