import { describe, expect, test } from 'bun:test'
import { paginateAccountDocs, presentAccount } from './accounts'

type FakeAccount = {
  _id: string
  companyId: string
  codeKey: string
  active: boolean
  isGroup: boolean
  role: string | null
  searchText: string
}

type QueryCall = {
  kind: 'index' | 'search'
  name: string
  equals: Array<[string, unknown]>
  term?: string
  options?: { numItems: number; cursor: string | null }
}

function fakeDb(rows: FakeAccount[]) {
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
          call.equals.every(([field, value]) => row[field as keyof FakeAccount] === value),
        )
        if (call.kind === 'search') {
          const term = call.term!.toLocaleLowerCase()
          selected = selected.filter((row) => row.searchText.includes(term))
        } else {
          selected.sort((left, right) => left.codeKey.localeCompare(right.codeKey))
          if (direction === 'desc') selected.reverse()
        }
        const start = options.cursor === null
          ? 0
          : Number(options.cursor.replace('cursor:', ''))
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
        expect(table).toBe('accounts')
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

const rows: FakeAccount[] = [
  { _id: 'cash-1', companyId: 'company-a', codeKey: '1001', active: true, isGroup: false, role: 'receivable', searchText: '1001 cash receivable' },
  { _id: 'cash-2', companyId: 'company-a', codeKey: '1002', active: true, isGroup: false, role: 'office', searchText: '1002 cash office' },
  { _id: 'group', companyId: 'company-a', codeKey: '1000', active: true, isGroup: true, role: null, searchText: '1000 cash group' },
  { _id: 'inactive', companyId: 'company-a', codeKey: '1003', active: false, isGroup: false, role: 'receivable', searchText: '1003 cash inactive' },
  { _id: 'other-company', companyId: 'company-b', codeKey: '1001', active: true, isGroup: false, role: 'receivable', searchText: '1001 cash other' },
]

describe('accounts.list indexed query profiles', () => {
  test('role 存储值按 Catalog enum 的大写 wire 值投影', () => {
    expect(presentAccount({ role: 'unbilled_receivable' } as never).role).toBe('UNBILLED_RECEIVABLE')
    expect(presentAccount({ role: null } as never).role).toBeNull()
  })

  test('lookup 的所有可选筛选组合都落在 codeKey 结尾的复合索引', async () => {
    const cases = [
      [{}, 'by_company_code_key'],
      [{ active: true }, 'by_company_active_code_key'],
      [{ isGroup: false }, 'by_company_is_group_code_key'],
      [{ role: 'receivable' }, 'by_company_role_code_key'],
      [{ active: true, isGroup: false }, 'by_company_active_is_group_code_key'],
      [{ active: true, role: 'receivable' }, 'by_company_active_role_code_key'],
      [{ isGroup: false, role: 'receivable' }, 'by_company_is_group_role_code_key'],
      [{ active: true, isGroup: false, role: 'receivable' }, 'by_company_active_is_group_role_code_key'],
    ] as const

    for (const [filters, expectedIndex] of cases) {
      const { db, calls } = fakeDb(rows)
      await paginateAccountDocs(db as never, {
        profile: 'lookup',
        companyId: 'company-a' as never,
        numItems: 20,
        cursor: null,
        ...filters,
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]?.name).toBe(expectedIndex)
    }
  })

  test('普通 lookup 每一页都保持 company/active/isGroup 前缀与 opaque cursor', async () => {
    const { db, calls } = fakeDb(rows)
    const first = await paginateAccountDocs(db as never, {
      profile: 'lookup', companyId: 'company-a' as never,
      active: true, isGroup: false, numItems: 1, cursor: null,
    })
    const second = await paginateAccountDocs(db as never, {
      profile: 'lookup', companyId: 'company-a' as never,
      active: true, isGroup: false, numItems: 1, cursor: first.continueCursor,
    })

    expect(first.page.map((row) => row._id)).toEqual(['cash-1'])
    expect(second.page.map((row) => row._id)).toEqual(['cash-2'])
    expect(calls.map((call) => ({ equals: call.equals, options: call.options }))).toEqual([
      {
        equals: [['companyId', 'company-a'], ['active', true], ['isGroup', false]],
        options: { numItems: 1, cursor: null },
      },
      {
        equals: [['companyId', 'company-a'], ['active', true], ['isGroup', false]],
        options: { numItems: 1, cursor: 'cursor:1' },
      },
    ])
  })

  test('role lookup 与 search 都在数据库查询中保持全部限定', async () => {
    const lookup = fakeDb(rows)
    const rolePage = await paginateAccountDocs(lookup.db as never, {
      profile: 'lookup', companyId: 'company-a' as never,
      active: true, isGroup: false, role: 'receivable', numItems: 20, cursor: null,
    })
    expect(rolePage.page.map((row) => row._id)).toEqual(['cash-1'])
    expect(lookup.calls[0]).toMatchObject({
      kind: 'index',
      name: 'by_company_active_is_group_role_code_key',
      equals: [['companyId', 'company-a'], ['active', true], ['isGroup', false], ['role', 'receivable']],
    })

    const search = fakeDb(rows)
    const searchPage = await paginateAccountDocs(search.db as never, {
      profile: 'search', companyId: 'company-a' as never,
      active: true, isGroup: false, role: 'receivable', search: 'cash', numItems: 20, cursor: null,
    })
    expect(searchPage.page.map((row) => row._id)).toEqual(['cash-1'])
    expect(search.calls[0]).toMatchObject({
      kind: 'search',
      name: 'search_text',
      term: 'cash',
      equals: [['companyId', 'company-a'], ['active', true], ['isGroup', false], ['role', 'receivable']],
    })
  })

  test('schema 提供所需复合索引，query 不得退化为 post-filter/collect', async () => {
    const [schema, source] = await Promise.all([
      Bun.file('convex/schema.ts').text(),
      Bun.file('convex/domains/base/accounts.ts').text(),
    ])
    for (const index of [
      "['companyId', 'active', 'codeKey']",
      "['companyId', 'isGroup', 'codeKey']",
      "['companyId', 'role', 'codeKey']",
      "['companyId', 'active', 'isGroup', 'codeKey']",
      "['companyId', 'active', 'role', 'codeKey']",
      "['companyId', 'isGroup', 'role', 'codeKey']",
      "['companyId', 'active', 'isGroup', 'role', 'codeKey']",
    ]) {
      expect(schema).toContain(index)
    }
    expect(source).not.toContain('.filter(')
    expect(source).not.toContain('.collect(')
  })

  test('Catalog 声明 lookup/treeChildren profile 与 code 升序契约', async () => {
    const documents = await Bun.file('convex/catalog/generatedDocuments.json').json() as Record<string, {
      lookup: { defaultSort?: { column: string; direction: string } }
      queryProfiles?: Array<{ key: string }>
    }>
    expect(documents.basAccounts?.lookup.defaultSort).toEqual({ column: 'code', direction: 'ascending' })
    expect(documents.basAccounts?.queryProfiles?.map((profile) => profile.key)).toEqual([
      'default', 'lookup', 'treeChildren', 'search',
    ])
  })
})
