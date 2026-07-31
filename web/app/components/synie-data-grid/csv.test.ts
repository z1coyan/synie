import { describe, expect, test } from 'bun:test'
import type { ResourceReader } from '~/lib/resources/catalog'
import { fetchAllRows } from './csv'

describe('CSV 导出 Reader interface', () => {
  test('按服务端实际页长推进，不按请求页长跳过记录', async () => {
    const calls: Array<{ limit: number; offset: number; search?: string }> = []
    const reader: Pick<ResourceReader, 'query'> = {
      query: async (input) => {
        calls.push({
          limit: input.limit,
          offset: input.offset,
          search: input.search,
        })
        return input.offset === 0
          ? { count: 3, results: [{ id: '1' }, { id: '2' }] }
          : { count: 3, results: [{ id: '3' }] }
      },
    }

    await expect(fetchAllRows(reader, { search: '审计' })).resolves.toEqual([
      { id: '1' },
      { id: '2' },
      { id: '3' },
    ])
    expect(calls).toEqual([
      { limit: 200, offset: 0, search: '审计' },
      { limit: 200, offset: 2, search: '审计' },
    ])
  })
})
