import { describe, expect, test } from 'bun:test'
import { paginateCurrencyDocs } from './currencies'

type FakeCurrency = {
  _id: string
  active: boolean
  isoCodeKey: string
  searchText: string
}

type QueryCall = {
  kind: 'index' | 'search'
  name: string
  equals: Array<[string, unknown]>
  term?: string
  options?: { numItems: number; cursor: string | null }
}

function fakeDb(rows: FakeCurrency[]) {
  const calls: QueryCall[] = []

  function pageable(call: QueryCall) {
    return {
      order(_direction: 'asc' | 'desc') {
        return this
      },
      async paginate(options: { numItems: number; cursor: string | null }) {
        call.options = options
        let selected = rows.filter((row) =>
          call.equals.every(([field, value]) => row[field as keyof FakeCurrency] === value),
        )
        if (call.kind === 'search') {
          const term = call.term!.toLocaleLowerCase()
          selected = selected.filter((row) => row.searchText.includes(term))
        }
        const start = options.cursor === null ? 0 : Number(options.cursor.replace('cursor:', ''))
        const end = Math.min(start + options.numItems, selected.length)
        return {
          page: selected.slice(start, end),
          continueCursor: `cursor:${end}`,
          isDone: end >= selected.length,
        }
      },
    }
  }

  return {
    calls,
    db: {
      query(table: string) {
        expect(table).toBe('currencies')
        return {
          withIndex(name: string, configure: (query: { eq: (field: string, value: unknown) => unknown }) => unknown) {
            const call: QueryCall = { kind: 'index', name, equals: [] }
            const query = {
              eq(field: string, value: unknown) {
                call.equals.push([field, value])
                return query
              },
            }
            configure(query)
            calls.push(call)
            return pageable(call)
          },
          withSearchIndex(name: string, configure: (query: {
            search: (field: string, value: string) => unknown
            eq: (field: string, value: unknown) => unknown
          }) => unknown) {
            const call: QueryCall = { kind: 'search', name, equals: [] }
            const query = {
              search(field: string, value: string) {
                expect(field).toBe('searchText')
                call.term = value
                return query
              },
              eq(field: string, value: unknown) {
                call.equals.push([field, value])
                return query
              },
            }
            configure(query)
            calls.push(call)
            return pageable(call)
          },
        }
      },
    },
  }
}

const rows: FakeCurrency[] = [
  { _id: 'cny', active: true, isoCodeKey: 'CNY', searchText: 'cny renminbi' },
  { _id: 'usd', active: true, isoCodeKey: 'USD', searchText: 'usd dollar' },
  { _id: 'aud', active: true, isoCodeKey: 'AUD', searchText: 'aud dollar' },
  { _id: 'inactive-usd', active: false, isoCodeKey: 'ZZZ', searchText: 'usd old dollar' },
]

describe('currencies.list indexed query profiles', () => {
  test('active 搜索每一页都下推 active 并沿用 opaque cursor', async () => {
    const { db, calls } = fakeDb(rows)
    const first = await paginateCurrencyDocs(db as never, {
      profile: 'search', active: true, search: 'd', numItems: 1, cursor: null,
    })
    const second = await paginateCurrencyDocs(db as never, {
      profile: 'search', active: true, search: 'd', numItems: 1, cursor: first.continueCursor,
    })

    expect(first.page.map((row) => row._id)).toEqual(['usd'])
    expect(second.page.map((row) => row._id)).toEqual(['aud'])
    expect(calls).toEqual([
      {
        kind: 'search', name: 'search_text', term: 'd', equals: [['active', true]],
        options: { numItems: 1, cursor: null },
      },
      {
        kind: 'search', name: 'search_text', term: 'd', equals: [['active', true]],
        options: { numItems: 1, cursor: 'cursor:1' },
      },
    ])
  })

  test('不带 active 的搜索仍覆盖启用与停用货币', async () => {
    const { db, calls } = fakeDb(rows)
    const result = await paginateCurrencyDocs(db as never, {
      profile: 'search', search: 'usd', numItems: 20, cursor: null,
    })

    expect(result.page.map((row) => row._id)).toEqual(['usd', 'inactive-usd'])
    expect(calls).toEqual([{
      kind: 'search', name: 'search_text', term: 'usd', equals: [],
      options: { numItems: 20, cursor: null },
    }])
  })

  test('错误 profile 参数组合在访问数据库前 fail-closed', async () => {
    const { db, calls } = fakeDb(rows)

    await expect(paginateCurrencyDocs(db as never, {
      profile: 'lookup', numItems: 20, cursor: null,
    })).rejects.toThrow('lookup profile 需要 active 参数')
    await expect(paginateCurrencyDocs(db as never, {
      profile: 'default', active: true, numItems: 20, cursor: null,
    })).rejects.toThrow('default profile 不接受参数')
    await expect(paginateCurrencyDocs(db as never, {
      profile: 'lookup', active: true, search: 'usd', numItems: 20, cursor: null,
    })).rejects.toThrow('当前 query profile 不接受搜索词')
    await expect(paginateCurrencyDocs(db as never, {
      profile: 'invalid' as never, numItems: 20, cursor: null,
    })).rejects.toThrow('未知 currency query profile')
    expect(calls).toEqual([])
  })
})
