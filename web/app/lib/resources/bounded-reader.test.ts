import { describe, expect, test } from 'bun:test'
import { MAX_RESOURCE_PAGE_SIZE } from '@synie/shared'
import type { ResourceReader } from './catalog'
import {
  readResourceRowsBounded,
  readResourceRowsForParentsBounded,
} from './bounded-reader'

function readerWith(
  query: ResourceReader['query'],
): Pick<ResourceReader, 'query'> {
  return { query }
}

describe('bounded opaque-cursor reader', () => {
  test('总上限必须是正整数', async () => {
    const reader = readerWith(async () => ({
      results: [],
      pageInfo: { continueCursor: null, isDone: true },
    }))

    await expect(
      readResourceRowsBounded(reader, { profile: 'default' }, 0),
    ).rejects.toThrow(/正整数/)
  })

  test('每页不超过统一上限，并严格截在总上限', async () => {
    const calls: Array<{ numItems: number; cursor?: string | null }> = []
    const reader = readerWith(async (input) => {
      calls.push({ numItems: input.numItems, cursor: input.cursor })
      const index = calls.length
      return {
        results: Array.from(
          { length: input.numItems + (index === 3 ? 5 : 0) },
          (_, offset) => ({ id: `${index}-${offset}` }),
        ),
        pageInfo: {
          continueCursor: index === 1 ? 'opaque/2' : 'opaque/3',
          isDone: false,
        },
      }
    })

    const rows = await readResourceRowsBounded(
      reader,
      { profile: 'default' },
      MAX_RESOURCE_PAGE_SIZE * 2 + 50,
    )

    expect(rows).toHaveLength(250)
    expect(calls).toEqual([
      { numItems: 100, cursor: null },
      { numItems: 100, cursor: 'opaque/2' },
      { numItems: 50, cursor: 'opaque/3' },
    ])
  })

  test('isDone 为 true 时立即结束', async () => {
    let calls = 0
    const reader = readerWith(async () => {
      calls += 1
      return {
        results: [{ id: 'only' }],
        pageInfo: { continueCursor: 'ignored', isDone: true },
      }
    })

    await expect(
      readResourceRowsBounded(reader, { profile: 'default' }, 200),
    ).resolves.toEqual([{ id: 'only' }])
    expect(calls).toBe(1)
  })

  test('未结束的空页仍沿服务端 cursor 继续读取', async () => {
    let calls = 0
    const reader = readerWith(async () => {
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
    })

    await expect(
      readResourceRowsBounded(reader, { profile: 'default' }, 200),
    ).resolves.toEqual([{ id: 'visible' }])
    expect(calls).toBe(2)
  })

  test('分页未结束却缺少 cursor 时 fail-closed', async () => {
    const reader = readerWith(async () => ({
      results: [{ id: '1' }],
      pageInfo: { continueCursor: null, isDone: false },
    }))

    await expect(
      readResourceRowsBounded(reader, { profile: 'default' }, 200),
    ).rejects.toThrow(/缺少 continueCursor/)
  })

  test('重复 cursor 时 fail-closed', async () => {
    const reader = readerWith(async () => ({
      results: [{ id: '1' }],
      pageInfo: { continueCursor: 'same', isDone: false },
    }))

    await expect(
      readResourceRowsBounded(reader, { profile: 'default' }, 200),
    ).rejects.toThrow(/cursor 重复/)
  })

  test('多个父条目逐个按单值 FK 分页，且合并结果不超过总上限', async () => {
    const calls: Array<{
      numItems: number
      cursor?: string | null
      fixedFilter?: Record<string, unknown>
    }> = []
    const reader = readerWith(async (input) => {
      calls.push({
        numItems: input.numItems,
        cursor: input.cursor,
        fixedFilter: input.fixedFilter,
      })
      const parent = input.fixedFilter?.receiptItemId as {
        values: string[]
      }
      if (parent.values[0] === 'item-a' && input.cursor === null) {
        return {
          results: Array.from({ length: 100 }, (_, index) => ({ id: `a-${index}` })),
          pageInfo: { continueCursor: 'item-a/page-2', isDone: false },
        }
      }
      if (parent.values[0] === 'item-a') {
        return {
          results: Array.from({ length: 50 }, (_, index) => ({ id: `a-${index + 100}` })),
          pageInfo: { continueCursor: null, isDone: true },
        }
      }
      return {
        results: Array.from({ length: 50 }, (_, index) => ({ id: `b-${index}` })),
        pageInfo: { continueCursor: 'not-followed-at-global-limit', isDone: false },
      }
    })

    const rows = await readResourceRowsForParentsBounded(
      reader,
      {
        profile: 'default',
        sort: { column: 'idx', direction: 'ascending' },
      },
      'receiptItemId',
      ['item-a', 'item-b', 'item-c'],
      200,
    )

    expect(rows).toHaveLength(200)
    expect(rows[0]?.id).toBe('a-0')
    expect(rows[199]?.id).toBe('b-49')
    expect(calls).toEqual([
      {
        numItems: 100,
        cursor: null,
        fixedFilter: {
          receiptItemId: {
            kind: 'fk', op: 'in', values: ['item-a'], labels: [],
          },
        },
      },
      {
        numItems: 100,
        cursor: 'item-a/page-2',
        fixedFilter: {
          receiptItemId: {
            kind: 'fk', op: 'in', values: ['item-a'], labels: [],
          },
        },
      },
      {
        numItems: 50,
        cursor: null,
        fixedFilter: {
          receiptItemId: {
            kind: 'fk', op: 'in', values: ['item-b'], labels: [],
          },
        },
      },
    ])
  })
})
