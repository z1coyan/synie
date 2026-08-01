import { describe, expect, test } from 'bun:test'
import type { ResourceTransport } from '~/lib/resources/types'
import { resolveSource } from './remote-query'

const memoryCompanies: ResourceTransport = {
  id: 'memory:basCompanies',
  query: async () => ({ count: 0, results: [] }),
  get: async () => null,
}

describe('Remote source Adapter seam', () => {
  test('标准路径只解析 binding，显式测试 Adapter 才发布给内嵌 DataGrid', () => {
    const standard = resolveSource({ resource: 'basCompanies' })
    expect(standard?.client.id).toBe('rest:basCompanies')
    expect(standard?.explicitClient).toBeUndefined()

    const substituted = resolveSource({
      resource: 'basCompanies',
      client: memoryCompanies,
    })
    expect(substituted?.client).toBe(memoryCompanies)
    expect(substituted?.explicitClient).toBe(memoryCompanies)
  })
})
