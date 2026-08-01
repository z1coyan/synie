import { describe, expect, test } from 'bun:test'
import type { ResourceReader } from '~/lib/resources/catalog'
import { fetchAllRows } from './csv'

describe('CSV 导出 Reader interface', () => {
  test('按 opaque cursor 拉完并保留查询 profile', async () => {
    const calls: Array<{ numItems: number; cursor?: string | null; search?: string }> = []
    const reader: Pick<ResourceReader, 'query'> = {
      query: async (input) => {
        calls.push({
          numItems: input.numItems,
          cursor: input.cursor,
          search: input.search,
        })
        return input.cursor == null
          ? { results: [{ id: '1' }, { id: '2' }], pageInfo: { continueCursor: 'next/opaque', isDone: false } }
          : { results: [{ id: '3' }], pageInfo: { continueCursor: null, isDone: true } }
      },
    }

    await expect(fetchAllRows(reader, { profile: 'search', search: '审计' })).resolves.toEqual([
      { id: '1' },
      { id: '2' },
      { id: '3' },
    ])
    expect(calls).toEqual([
      { numItems: 100, cursor: null, search: '审计' },
      { numItems: 100, cursor: 'next/opaque', search: '审计' },
    ])
  })

  test('重复 cursor fail-closed，避免导出死循环', async () => {
    const reader: Pick<ResourceReader, 'query'> = {
      query: async () => ({
        results: [{ id: '1' }],
        pageInfo: { continueCursor: 'same', isDone: false },
      }),
    }
    await expect(fetchAllRows(reader, { profile: 'default' })).rejects.toThrow(/cursor 重复/)
  })

  test('未结束的空页继续跟随 opaque cursor', async () => {
    let calls = 0
    const reader: Pick<ResourceReader, 'query'> = {
      query: async () => {
        calls += 1
        return calls === 1
          ? {
              results: [],
              pageInfo: { continueCursor: 'after-empty', isDone: false },
            }
          : {
              results: [{ id: 'visible' }],
              pageInfo: { continueCursor: null, isDone: true },
            }
      },
    }

    await expect(fetchAllRows(reader, { profile: 'default' })).resolves.toEqual([
      { id: 'visible' },
    ])
    expect(calls).toBe(2)
  })
})
