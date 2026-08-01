import { beforeEach, describe, expect, test } from 'bun:test'
import type { ResourceDocument } from '@synie/shared'
import {
  clearBindingsForTests,
  clearCatalogCache,
  getCatalogActor,
  resourceBindingFor,
  setCatalogActor,
  bindingFromResourceTransport,
  readerFromResourceTransport,
  registerBinding,
  resourceTransportFromBinding,
  catalogCacheSize,
  setCachedDocument,
  getCachedDocument,
  createResourceQueryCache,
} from './index'
import type { ResourceBinding } from './types'
import type { ResourceClient, ResourceQuery, ResourceTransport } from '../types'
import { currencyClient } from '../currencies'

function sampleDocument(name = 'basCurrencies'): ResourceDocument {
  return {
    schemaVersion: 2,
    name,
    label: '货币',
    permissionPrefix: 'base.currency',
    capabilities: ['create', 'update', 'delete'],
    fields: [
      {
        kind: 'scalar',
        scalarType: 'string',
        name: 'name',
        label: '货币名称',
        visibility: 'readable',
        input: { create: 'required', update: 'allowed' },
        filterable: true,
        sortable: true,
        searchable: true,
      },
    ],
    lookup: { labelField: 'name', searchFields: ['name'] },
    list: { columns: ['name'] },
    form: { kind: 'basic', layout: { fields: [{ field: 'name' }] } },
    commands: [],
  }
}

function mockClient(id = 'rest:basCurrencies'): ResourceClient {
  return {
    id,
    query: async () => ({ count: 0, results: [] }),
    get: async () => null,
    create: async (input) => ({ id: '1', ...input }),
    update: async (id, input) => ({ id, ...input }),
    delete: async () => {},
  }
}

function inMemoryResourceAdapter(
  resource: string,
  initial: Array<Record<string, unknown>> = [],
): ResourceTransport {
  let rows = initial.map((row) => ({ ...row })) as Array<{ id: string } & Record<string, unknown>>
  return {
    id: `memory:${resource}`,
    query: async ({ limit = 20, offset = 0 }) => ({
      count: rows.length,
      results: rows.slice(offset, offset + limit),
    }),
    get: async (id) => rows.find((row) => row.id === id) ?? null,
    create: async (input) => {
      const saved = { id: `memory-${rows.length + 1}`, ...input }
      rows = [...rows, saved]
      return saved
    },
    update: async (id, input) => {
      const saved = { id, ...input }
      rows = rows.map((row) => (row.id === id ? saved : row))
      return saved
    },
    delete: async (id) => {
      rows = rows.filter((row) => row.id !== id)
    },
  }
}

describe('Resource Catalog 前端 binding 与缓存', () => {
  beforeEach(() => {
    clearCatalogCache()
    clearBindingsForTests()
  })

  test('unknown binding 显式失败', () => {
    expect(() => resourceBindingFor('noSuchResource')).toThrow(/未注册 ResourceBinding/)
  })

  test('known binding 可取得 reader/writer', async () => {
    const client = mockClient()
    const binding = bindingFromResourceTransport('basCurrencies', client)
    registerBinding(binding)
    const got = resourceBindingFor('basCurrencies')
    expect(got.resource).toBe('basCurrencies')
    expect(got.reader).toBeDefined()
    expect(got.writer).toBeDefined()
    const created = await got.writer!.create!({ name: 'CNY' } as never)
    expect(created).toMatchObject({ id: '1', name: 'CNY' })
  })

  test('binding 拥有 reader 对应的查询缓存身份；调用者不拼 Adapter id', async () => {
    const binding = bindingFromResourceTransport(
      'basCurrencies',
      inMemoryResourceAdapter('basCurrencies', [{ id: 'cny', name: '人民币' }]),
    )

    expect(binding.cache.gridScope).toEqual([
      'gridRows',
      'memory:basCurrencies',
      'basCurrencies',
    ])
    expect(binding.cache.gridKey(1, 20, '人民币')).toEqual([
      'gridRows',
      'memory:basCurrencies',
      'basCurrencies',
      1,
      20,
      '人民币',
    ])
    expect(binding.cache.rowKey('cny')).toEqual([
      'rowById',
      'memory:basCurrencies',
      'basCurrencies',
      'cny',
    ])
    await expect(binding.reader.get('cny')).resolves.toMatchObject({ name: '人民币' })
  })

  test('binding cache 通过 interface 精确失效列表与单条查询', async () => {
    const binding = bindingFromResourceTransport(
      'basCurrencies',
      inMemoryResourceAdapter('basCurrencies'),
    )
    const invalidated: Array<readonly unknown[]> = []
    const cache = {
      invalidateQueries: async ({ queryKey }: { queryKey: readonly unknown[] }) => {
        invalidated.push(queryKey)
      },
    }

    await binding.cache.invalidateGrid(cache)
    await binding.cache.invalidateRow(cache, 'cny')
    await binding.cache.invalidateAll(cache)

    expect(invalidated).toEqual([
      ['gridRows', 'memory:basCurrencies', 'basCurrencies'],
      ['rowById', 'memory:basCurrencies', 'basCurrencies', 'cny'],
      ['gridRows', 'memory:basCurrencies', 'basCurrencies'],
      ['rowById', 'memory:basCurrencies', 'basCurrencies'],
    ])
  })

  test('生产 Convex 绑定占位与测试 in-memory Adapter 隔离缓存身份', () => {
    const production = bindingFromResourceTransport(
      'basCurrencies',
      currencyClient,
    )
    const memory = bindingFromResourceTransport(
      'basCurrencies',
      inMemoryResourceAdapter('basCurrencies'),
    )
    const custom = bindingFromResourceTransport(
      'basCurrencies',
      mockClient('custom:currency-read-model'),
    )

    expect(production.cache.gridScope).not.toEqual(memory.cache.gridScope)
    expect(production.cache.gridScope).toEqual([
      'gridRows',
      'convex-unbound:basCurrencies',
      'basCurrencies',
    ])
    for (const binding of [production, memory, custom]) {
      const transport = resourceTransportFromBinding(binding)
      expect(transport.id).toBe(binding.cache.adapterId)
      expect(binding.cache.gridScope).toEqual([
        'gridRows',
        transport.id,
        'basCurrencies',
      ])
    }
  })

  test('binding 兼容 transport 用真实 opaque cursor 分批满足 limit/offset', async () => {
    const rows = Array.from({ length: 250 }, (_, index) => ({
      id: `row-${index}`,
    }))
    const calls: Array<Pick<ResourceQuery, 'numItems' | 'cursor'>> = []
    const binding: ResourceBinding = {
      resource: 'rows',
      reader: {
        query: async (input) => {
          calls.push({ numItems: input.numItems, cursor: input.cursor })
          if (input.numItems > 100) {
            throw new Error('每页条数必须是 1..100 的整数')
          }
          if (input.cursor?.startsWith('transport-offset:')) {
            throw new Error('兼容层不得伪造 Convex cursor')
          }
          const start = input.cursor == null
            ? 0
            : Number(input.cursor.replace('opaque:', ''))
          const end = Math.min(start + input.numItems, rows.length)
          return {
            results: rows.slice(start, end),
            pageInfo: {
              continueCursor: end < rows.length ? `opaque:${end}` : null,
              isDone: end >= rows.length,
            },
          }
        },
        get: async () => null,
      },
      cache: createResourceQueryCache('rows', 'memory:cursor-rows'),
      loadDocument: async () => sampleDocument('rows'),
    }
    const transport = resourceTransportFromBinding(binding)

    const first = await transport.query({ limit: 200, offset: 0 })
    expect(first.results).toHaveLength(200)
    expect(first.results[0]?.id).toBe('row-0')
    expect(first.results.at(-1)?.id).toBe('row-199')
    expect(first.count).toBe(201)

    const second = await transport.query({ limit: 200, offset: 200 })
    expect(second.results).toHaveLength(50)
    expect(second.results[0]?.id).toBe('row-200')
    expect(second.results.at(-1)?.id).toBe('row-249')
    expect(second.count).toBe(250)
    expect(calls).toEqual([
      { numItems: 100, cursor: null },
      { numItems: 100, cursor: 'opaque:100' },
      { numItems: 100, cursor: null },
      { numItems: 100, cursor: 'opaque:100' },
      { numItems: 100, cursor: 'opaque:200' },
    ])
  })

  test('binding 兼容 transport 被 Reader 包装后可沿返回 cursor 读取第二页', async () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      id: `row-${index}`,
    }))
    const binding: ResourceBinding = {
      resource: 'rows',
      reader: {
        query: async (input) => {
          if (input.cursor?.startsWith('transport-offset:')) {
            throw new Error('synthetic transport cursor 泄漏到资源 Reader')
          }
          const start = input.cursor == null
            ? 0
            : Number(input.cursor.replace('opaque:', ''))
          const end = Math.min(start + input.numItems, rows.length)
          return {
            results: rows.slice(start, end),
            pageInfo: {
              continueCursor: end < rows.length ? `opaque:${end}` : null,
              isDone: end >= rows.length,
            },
          }
        },
        get: async () => null,
      },
      cache: createResourceQueryCache('rows', 'memory:wrapped-cursor-rows'),
      loadDocument: async () => sampleDocument('rows'),
    }
    const reader = readerFromResourceTransport(
      resourceTransportFromBinding(binding),
    )

    const first = await reader.query({
      profile: 'default',
      numItems: 20,
      cursor: null,
    })
    expect(first.results.map((row) => row.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `row-${index}`),
    )
    expect(first.pageInfo.isDone).toBe(false)

    const second = await reader.query({
      profile: 'default',
      numItems: 20,
      cursor: first.pageInfo.continueCursor,
    })
    expect(second.results.map((row) => row.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `row-${index + 20}`),
    )
    expect(second.pageInfo).toEqual({ continueCursor: null, isDone: true })
  })

  test('单位/供应商/公司 binding 闭环 create', async () => {
    for (const resource of ['basUnits', 'purSuppliers', 'basCompanies'] as const) {
      const client = mockClient(`rest:${resource}`)
      registerBinding(bindingFromResourceTransport(resource, client))
      const binding = resourceBindingFor(resource)
      expect(binding.resource).toBe(resource)
      expect(binding.writer && 'create' in binding.writer).toBe(true)
      const saved = await binding.writer!.create!({ name: 'x' } as never)
      expect(saved).toMatchObject({ id: '1' })
    }
  })

  test('只读 binding 省略写方法', () => {
    const client = mockClient()
    const binding = bindingFromResourceTransport('sysAuditLogs', client, {
      canCreate: false,
      canUpdate: false,
      canDelete: false,
    })
    registerBinding(binding)
    const writer = binding.writer as Record<string, unknown> | undefined
    expect(writer && 'create' in writer && writer.create).toBeFalsy()
    expect(writer && 'update' in writer && writer.update).toBeFalsy()
    expect(writer && 'delete' in writer && writer.delete).toBeFalsy()
  })

  test('部分写能力：update-only / create+delete 省略 stub', () => {
    const updateOnly = bindingFromResourceTransport('mfgSettings', mockClient('mfg'), {
      canCreate: false,
      canUpdate: true,
      canDelete: false,
    })
    const uw = updateOnly.writer as Record<string, unknown> | undefined
    expect(uw && 'create' in uw && uw.create).toBeFalsy()
    expect(uw && 'update' in uw && uw.update).toBeTruthy()
    expect(uw && 'delete' in uw && uw.delete).toBeFalsy()

    const createDelete = bindingFromResourceTransport('sysFiles', mockClient('files'), {
      canCreate: true,
      canUpdate: false,
      canDelete: true,
    })
    const cw = createDelete.writer as Record<string, unknown> | undefined
    expect(cw && 'create' in cw && cw.create).toBeTruthy()
    expect(cw && 'update' in cw && cw.update).toBeFalsy()
    expect(cw && 'delete' in cw && cw.delete).toBeTruthy()
  })

  test('lookup 种子：员工/物料/分类/单位 search 与 subtitle', async () => {
    const { resolveResourceLookup, LOOKUP_SEEDS } = await import('./lookups')
    expect(LOOKUP_SEEDS.hrEmployees.searchFields).toEqual(['name', 'code', 'attendanceNo'])
    expect(resolveResourceLookup('hrEmployees').subtitleFields).toEqual([
      'code',
      'attendanceNo',
    ])
    expect(resolveResourceLookup('invMaterials').searchFields).toContain('spec')
    expect(resolveResourceLookup('invMaterialCategories').subtitleFields).toEqual(['code'])
    expect(resolveResourceLookup('basUnits').subtitleFields).toEqual(['symbol'])
  })

  test('transport 与 binding.writer 都省略不支持的写方法', () => {
    const client = mockClient()
    const binding = bindingFromResourceTransport('ro', client, {
      canCreate: false,
      canUpdate: false,
      canDelete: false,
    })
    expect(binding.writer).toBeUndefined()
    const transport = resourceTransportFromBinding(binding)
    expect(transport.create).toBeUndefined()
    expect(transport.update).toBeUndefined()
    expect(transport.delete).toBeUndefined()
  })

  test('Catalog 缓存按 actor 隔离；切换 actor 清空', () => {
    setCatalogActor('user-a')
    setCachedDocument('basCurrencies', sampleDocument())
    expect(getCachedDocument('basCurrencies')?.label).toBe('货币')
    expect(catalogCacheSize()).toBe(1)

    setCatalogActor('user-b')
    expect(getCatalogActor()).toBe('user-b')
    expect(getCachedDocument('basCurrencies')).toBeUndefined()
    expect(catalogCacheSize()).toBe(0)

    setCachedDocument('basCurrencies', {
      ...sampleDocument(),
      capabilities: ['update'],
      label: '货币-b',
    })
    expect(getCachedDocument('basCurrencies')?.capabilities).toEqual(['update'])

    // 回到 A 不复用 B 的缓存
    setCatalogActor('user-a')
    expect(getCachedDocument('basCurrencies')).toBeUndefined()
  })

  test('clearCatalogCache 登出后无残留', () => {
    setCatalogActor('user-a')
    setCachedDocument('basCurrencies', sampleDocument())
    clearCatalogCache()
    expect(getCatalogActor()).toBeNull()
    expect(catalogCacheSize()).toBe(0)
  })

  test('binding 可挂载 CommandAdapter 且标准 CRUD 不经 commands', async () => {
    const client = mockClient()
    const { createCommandAdapter, defineCommand } = await import('./commands')
    const commands = createCommandAdapter({
      setDefault: defineCommand('row', async (input: { id: string }) => {
        expect(input.id).toBe('sid')
      }),
    })
    registerBinding({
      ...bindingFromResourceTransport('sysStorages', client),
      commands,
    })
    const got = resourceBindingFor('sysStorages')
    expect(got.commands).toBeDefined()
    await got.commands!.execute('setDefault', { id: 'sid' })
    // Writer 仍管 CRUD，不进 commands
    expect(got.writer && 'create' in got.writer).toBe(true)
    expect(Object.keys(got.commands!.commands)).not.toContain('create')
  })

  test('binding 可挂载 AggregateDraftAdapter；Draft 与 Saved 类型分离', async () => {
    const client = mockClient()
    registerBinding({
      ...bindingFromResourceTransport('salDeliveries', client, {
        canCreate: false,
        canUpdate: false,
        canDelete: true,
      }),
      draft: {
        loadDraft: async (id) => ({ id, items: [{ id: 'i1' }], packBoxes: [] }),
        createDraft: async (input: { companyId: string }) => ({
          id: 'd1',
          companyId: input.companyId,
          items: [],
          packBoxes: [],
        }),
        replaceDraft: async (id, input: { companyId: string }) => ({
          id,
          companyId: input.companyId,
          items: [],
          packBoxes: [],
        }),
      },
    })
    const got = resourceBindingFor('salDeliveries')
    expect(got.draft).toBeDefined()
    expect(got.writer && 'create' in got.writer && (got.writer as { create?: unknown }).create).toBeFalsy()
    const saved = await got.draft!.loadDraft('x')
    expect(saved).toMatchObject({ id: 'x', items: [{ id: 'i1' }] })
    const created = await got.draft!.createDraft({ companyId: 'c1' })
    expect(created).toMatchObject({ id: 'd1', companyId: 'c1' })
  })
})
