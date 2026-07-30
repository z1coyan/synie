import { beforeEach, describe, expect, test } from 'bun:test'
import type { ResourceDocument } from '@synie/shared'
import {
  clearBindingsForTests,
  clearCatalogCache,
  getCatalogActor,
  resourceBindingFor,
  setCatalogActor,
  bindingFromResourceClient,
  registerBinding,
  resourceClientFromBinding,
  catalogCacheSize,
  setCachedDocument,
  getCachedDocument,
} from './index'
import type { ResourceClient } from '../types'

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
    meta: async () => ({
      columns: [],
      capabilities: ['create'],
      extendedActions: [],
      destroyMutation: null,
    }),
    query: async () => ({ count: 0, results: [] }),
    get: async () => null,
    create: async (input) => ({ id: '1', ...input }),
    update: async (id, input) => ({ id, ...input }),
    delete: async () => {},
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
    const binding = bindingFromResourceClient('basCurrencies', client)
    registerBinding(binding)
    const got = resourceBindingFor('basCurrencies')
    expect(got.resource).toBe('basCurrencies')
    expect(got.reader).toBeDefined()
    expect(got.writer).toBeDefined()
    const created = await got.writer!.create!({ name: 'CNY' } as never)
    expect(created).toMatchObject({ id: '1', name: 'CNY' })
  })

  test('只读 binding 省略写方法', () => {
    const client = mockClient()
    const binding = bindingFromResourceClient('sysAuditLogs', client, {
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

  test('ResourceClient 兼容外观不暴露不支持的写', async () => {
    const client = mockClient()
    const binding = bindingFromResourceClient('ro', client, {
      canCreate: false,
      canUpdate: false,
      canDelete: false,
    })
    const legacy = resourceClientFromBinding(binding)
    expect(() => {
      void legacy.create({})
    }).toThrow(/不支持 create/)
    expect(() => {
      void legacy.update('1', {})
    }).toThrow(/不支持 update/)
    expect(() => {
      void legacy.delete('1')
    }).toThrow(/不支持 delete/)
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
})
