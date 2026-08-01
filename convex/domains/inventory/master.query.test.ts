import { describe, expect, test } from 'bun:test'
import { resourceManifest } from '../../migration/resourceManifest'
import { paginateMaterialCategoryDocs } from './master'

type FakeCategory = {
  _id: string
  codeKey: string
  active: boolean
  isLeaf: boolean
  parentId: string | null
  searchText: string
}

type QueryCall = {
  kind: 'index' | 'search'
  name: string
  equals: Array<[string, unknown]>
  term?: string
  options?: { numItems: number; cursor: string | null }
}

function fakeDb(rows: FakeCategory[]) {
  const calls: QueryCall[] = []

  function pageable(call: QueryCall) {
    return {
      order(_direction: 'asc' | 'desc') {
        return this
      },
      async paginate(options: { numItems: number; cursor: string | null }) {
        call.options = options
        let selected = rows.filter((row) =>
          call.equals.every(([field, value]) => row[field as keyof FakeCategory] === value),
        )
        if (call.kind === 'search') {
          const term = call.term!.toLocaleLowerCase()
          selected = selected.filter((row) => row.searchText.includes(term))
        } else {
          selected.sort((left, right) => left.codeKey.localeCompare(right.codeKey))
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
        expect(table).toBe('materialCategories')
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

const rows: FakeCategory[] = [
  { _id: 'root-a', codeKey: '01', active: true, isLeaf: false, parentId: null, searchText: '01 原材料' },
  { _id: 'leaf-a', codeKey: '0101', active: true, isLeaf: true, parentId: 'root-a', searchText: '0101 铜材' },
  { _id: 'root-b', codeKey: '02', active: false, isLeaf: false, parentId: null, searchText: '02 旧分类' },
  { _id: 'leaf-inactive', codeKey: '0201', active: false, isLeaf: true, parentId: 'root-b', searchText: '0201 旧叶子' },
]

describe('materialCategories indexed query profiles', () => {
  test('上级分类 lookup 只返回非叶子并沿用 opaque cursor', async () => {
    const { db, calls } = fakeDb(rows)
    const first = await paginateMaterialCategoryDocs(db as never, {
      profile: 'lookup', isLeaf: false, numItems: 1, cursor: null,
    })
    const second = await paginateMaterialCategoryDocs(db as never, {
      profile: 'lookup', isLeaf: false, numItems: 1, cursor: first.continueCursor,
    })

    expect(first.page.map((row) => row._id)).toEqual(['root-a'])
    expect(second.page.map((row) => row._id)).toEqual(['root-b'])
    expect(calls).toEqual([
      {
        kind: 'index', name: 'by_is_leaf_code_key', equals: [['isLeaf', false]],
        options: { numItems: 1, cursor: null },
      },
      {
        kind: 'index', name: 'by_is_leaf_code_key', equals: [['isLeaf', false]],
        options: { numItems: 1, cursor: 'cursor:1' },
      },
    ])
  })

  test('物料分类 lookup 只返回启用叶子分类', async () => {
    const { db, calls } = fakeDb(rows)
    const page = await paginateMaterialCategoryDocs(db as never, {
      profile: 'lookup', active: true, isLeaf: true, numItems: 20, cursor: null,
    })

    expect(page.page.map((row) => row._id)).toEqual(['leaf-a'])
    expect(calls).toEqual([{
      kind: 'index', name: 'by_active_is_leaf_code_key',
      equals: [['active', true], ['isLeaf', true]],
      options: { numItems: 20, cursor: null },
    }])
  })

  test('候选搜索保留两种严格筛选形状', async () => {
    const parent = fakeDb(rows)
    const parentPage = await paginateMaterialCategoryDocs(parent.db as never, {
      profile: 'search', isLeaf: false, search: '旧', numItems: 20, cursor: null,
    })
    expect(parentPage.page.map((row) => row._id)).toEqual(['root-b'])
    expect(parent.calls).toEqual([{
      kind: 'search', name: 'search_text', term: '旧', equals: [['isLeaf', false]],
      options: { numItems: 20, cursor: null },
    }])

    const material = fakeDb(rows)
    const materialPage = await paginateMaterialCategoryDocs(material.db as never, {
      profile: 'search', active: true, isLeaf: true, search: '铜材', numItems: 20, cursor: null,
    })
    expect(materialPage.page.map((row) => row._id)).toEqual(['leaf-a'])
    expect(material.calls).toEqual([{
      kind: 'search', name: 'search_text', term: '铜材',
      equals: [['active', true], ['isLeaf', true]],
      options: { numItems: 20, cursor: null },
    }])
  })

  test('Catalog 与迁移 manifest 声明有限分类查询轮廓和索引', async () => {
    const documents = await Bun.file('convex/catalog/generatedDocuments.json').json() as Record<string, {
      queryProfiles?: Array<{ key: string; equalityFields: string[] }>
    }>
    const profiles = documents.invMaterialCategories?.queryProfiles ?? []
    expect(profiles.map((profile) => profile.key)).toEqual([
      'default', 'lookup', 'treeChildren', 'search',
    ])
    expect(profiles.find((profile) => profile.key === 'lookup')?.equalityFields).toEqual(['isLeaf'])
    expect(profiles.find((profile) => profile.key === 'treeChildren')?.equalityFields).toEqual(['parentId'])

    const migration = resourceManifest.find((entry) => entry.resource === 'invMaterialCategories')
    expect(migration?.queryProfiles).toEqual(['default', 'lookup', 'treeChildren', 'search'])
    expect(migration?.indexes).toContain('materialCategories.by_is_leaf_code_key')
    expect(migration?.indexes).toContain('materialCategories.by_active_is_leaf_code_key')
    expect(migration?.indexes).toContain('materialCategories.search_text')
  })

  test('仅两种候选筛选形状可用，default/tree 不放宽', async () => {
    const { db, calls } = fakeDb(rows)
    const invalidLookups = [
      {},
      { isLeaf: true },
      { active: true },
      { active: false, isLeaf: true },
      { active: true, isLeaf: false },
      { active: false, isLeaf: false },
    ]
    for (const filters of invalidLookups) {
      await expect(paginateMaterialCategoryDocs(db as never, {
        profile: 'lookup', numItems: 20, cursor: null, ...filters,
      })).rejects.toThrow('物料分类候选筛选组合暂不支持')
    }
    await expect(paginateMaterialCategoryDocs(db as never, {
      profile: 'default', active: true, isLeaf: true, numItems: 20, cursor: null,
    })).rejects.toThrow('default profile 不接受候选筛选')
    await expect(paginateMaterialCategoryDocs(db as never, {
      profile: 'treeChildren', parentId: null, isLeaf: false, numItems: 20, cursor: null,
    })).rejects.toThrow('treeChildren profile 不接受候选筛选')
    await expect(paginateMaterialCategoryDocs(db as never, {
      profile: 'search', active: true, search: '分类', numItems: 20, cursor: null,
    })).rejects.toThrow('物料分类候选筛选组合暂不支持')
    await expect(paginateMaterialCategoryDocs(db as never, {
      profile: 'unknown' as never, numItems: 20, cursor: null,
    })).rejects.toThrow('未知 material category query profile')
    expect(calls).toEqual([])
  })
})
