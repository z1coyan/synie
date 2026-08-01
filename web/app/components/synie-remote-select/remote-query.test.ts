import { describe, expect, test } from 'bun:test'
import type { ResourceTransport } from '~/lib/resources/types'
import { buildRemoteOptionsQuery, resolveSource } from './remote-query'

const memoryCompanies: ResourceTransport = {
  id: 'memory:basCompanies',
  query: async () => ({ count: 0, results: [] }),
  get: async () => null,
}

describe('Remote source Adapter seam', () => {
  test('标准路径只解析 binding，显式测试 Adapter 才发布给内嵌 DataGrid', () => {
    const standard = resolveSource({ resource: 'basCompanies' })
    expect(standard?.client.id).toBe('convex-unbound:basCompanies')
    expect(standard?.explicitClient).toBeUndefined()

    const substituted = resolveSource({
      resource: 'basCompanies',
      client: memoryCompanies,
    })
    expect(substituted?.client).toBe(memoryCompanies)
    expect(substituted?.explicitClient).toBe(memoryCompanies)
  })

  test('科目 RemoteSelect 按真实复合索引的 codeKey 契约请求 code 升序', () => {
    const source = resolveSource({ resource: 'basAccounts' })
    expect(source?.labelField).toBe('name')
    expect(source?.sortField).toBe('code')
    expect(source?.searchFields).toEqual(['code', 'name'])
  })

  test('仅将显式/Catalog 排序发给 lookup，搜索由 search profile 决定顺序', () => {
    const implicit = resolveSource({
      resource: 'basCompanies',
      client: memoryCompanies,
    })!
    const account = resolveSource({ resource: 'basAccounts' })!
    const explicit = resolveSource({
      resource: 'accBillHoldings',
      client: memoryCompanies,
      sortField: 'dueDate',
    })!

    expect(buildRemoteOptionsQuery(implicit, '', null)).not.toHaveProperty('sort')
    expect(buildRemoteOptionsQuery(account, '', null).sort).toEqual({
      column: 'code',
      direction: 'ascending',
    })
    expect(buildRemoteOptionsQuery(explicit, '', null).sort).toEqual({
      column: 'dueDate',
      direction: 'ascending',
    })
    expect(buildRemoteOptionsQuery(account, ' 应收 ', 'next')).toMatchObject({
      profile: 'search',
      search: '应收',
      cursor: 'next',
    })
    expect(buildRemoteOptionsQuery(account, ' 应收 ', 'next')).not.toHaveProperty('sort')
  })

  test('pageSize 只接受 1..100 的整数，并原样传入资源查询', () => {
    for (const pageSize of [0, 101, 1.5]) {
      expect(() => resolveSource({
        resource: 'basCompanies',
        client: memoryCompanies,
        pageSize,
      })).toThrow(/pageSize 必须是 1\.\.100 的整数/)
    }

    const source = resolveSource({
      resource: 'basCompanies',
      client: memoryCompanies,
      pageSize: 100,
    })!
    expect(buildRemoteOptionsQuery(source, '', null).numItems).toBe(100)
  })
})
