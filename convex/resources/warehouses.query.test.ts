import { describe, expect, test } from 'bun:test'
import { pilotQueryProfiles } from '../lib/queryProfiles'
import { paginateWarehouseDocs } from './warehouses'

type FakeWarehouse = {
  _id: string
  companyId: string
  active: boolean
  isLeaf: boolean
  nameKey: string
  searchText: string
}

type QueryCall = {
  kind: 'index' | 'search'
  name: string
  equals: Array<[string, unknown]>
  term?: string
  options?: { numItems: number; cursor: string | null }
}

function fakeDb(rows: FakeWarehouse[]) {
  const calls: QueryCall[] = []

  function pageable(call: QueryCall) {
    let direction: 'asc' | 'desc' = 'asc'
    return {
      order(next: 'asc' | 'desc') {
        direction = next
        return this
      },
      async paginate(options: { numItems: number; cursor: string | null }) {
        call.options = options
        let selected = rows.filter((row) =>
          call.equals.every(([field, value]) => row[field as keyof FakeWarehouse] === value),
        )
        if (call.kind === 'search') {
          const term = call.term!.toLocaleLowerCase()
          selected = selected.filter((row) => row.searchText.includes(term))
        } else {
          selected.sort((left, right) => left.nameKey.localeCompare(right.nameKey))
          if (direction === 'desc') selected.reverse()
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
        expect(table).toBe('warehouses')
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

const rows: FakeWarehouse[] = [
  { _id: 'default', companyId: 'company-a', active: true, isLeaf: true, nameKey: 'default', searchText: 'default warehouse' },
  { _id: 'transit', companyId: 'company-a', active: true, isLeaf: true, nameKey: 'transit', searchText: 'transit warehouse' },
  { _id: 'root', companyId: 'company-a', active: true, isLeaf: false, nameKey: 'root', searchText: 'root warehouse' },
  { _id: 'inactive', companyId: 'company-a', active: false, isLeaf: true, nameKey: 'inactive', searchText: 'inactive warehouse' },
  { _id: 'other-company', companyId: 'company-b', active: true, isLeaf: true, nameKey: 'default', searchText: 'default warehouse' },
]

describe('warehouses.list indexed query profiles', () => {
  test('lookup 每一页都限定为本公司启用叶子仓并沿用 opaque cursor', async () => {
    const { db, calls } = fakeDb(rows)
    const first = await paginateWarehouseDocs(db as never, {
      profile: 'lookup', companyId: 'company-a', active: true, isLeaf: true,
      numItems: 1, cursor: null,
    })
    const second = await paginateWarehouseDocs(db as never, {
      profile: 'lookup', companyId: 'company-a', active: true, isLeaf: true,
      numItems: 1, cursor: first.continueCursor,
    })

    expect(first.page.map((row) => row._id)).toEqual(['default'])
    expect(second.page.map((row) => row._id)).toEqual(['transit'])
    expect(calls).toEqual([
      {
        kind: 'index', name: 'by_company_active_is_leaf_name_key',
        equals: [['companyId', 'company-a'], ['active', true], ['isLeaf', true]],
        options: { numItems: 1, cursor: null },
      },
      {
        kind: 'index', name: 'by_company_active_is_leaf_name_key',
        equals: [['companyId', 'company-a'], ['active', true], ['isLeaf', true]],
        options: { numItems: 1, cursor: 'cursor:1' },
      },
    ])
  })

  test('候选搜索保留 company/active/isLeaf 限定', async () => {
    const { db, calls } = fakeDb(rows)
    const page = await paginateWarehouseDocs(db as never, {
      profile: 'search', companyId: 'company-a', active: true, isLeaf: true,
      search: 'warehouse', numItems: 20, cursor: null,
    })

    expect(page.page.map((row) => row._id)).toEqual(['default', 'transit'])
    expect(calls).toEqual([{
      kind: 'search', name: 'search_text', term: 'warehouse',
      equals: [['companyId', 'company-a'], ['active', true], ['isLeaf', true]],
      options: { numItems: 20, cursor: null },
    }])
  })

  test('Catalog lookup 轮廓声明与复合索引一致', () => {
    const lookup = pilotQueryProfiles.invWarehouses.find((profile) => profile.key === 'lookup')

    expect(lookup).toMatchObject({
      equalityFields: ['companyId', 'active', 'isLeaf'],
      fixedSort: 'ascending',
      source: {
        kind: 'index',
        name: 'by_company_active_is_leaf_name_key',
        fields: ['companyId', 'active', 'isLeaf', 'nameKey'],
      },
    })
  })

  test('未声明的候选筛选组合 fail-closed', async () => {
    const { db, calls } = fakeDb(rows)

    await expect(paginateWarehouseDocs(db as never, {
      profile: 'lookup', companyId: 'company-a', active: true,
      numItems: 20, cursor: null,
    })).rejects.toThrow('lookup profile 需要 active 与 isLeaf 参数')
    await expect(paginateWarehouseDocs(db as never, {
      profile: 'search', companyId: 'company-a', isLeaf: true,
      search: 'warehouse', numItems: 20, cursor: null,
    })).rejects.toThrow('候选筛选必须同时提供 active 与 isLeaf 参数')
    await expect(paginateWarehouseDocs(db as never, {
      profile: 'default', companyId: 'company-a', active: true, isLeaf: true,
      numItems: 20, cursor: null,
    })).rejects.toThrow('default profile 不接受候选筛选参数')
    expect(calls).toEqual([])
  })
})
