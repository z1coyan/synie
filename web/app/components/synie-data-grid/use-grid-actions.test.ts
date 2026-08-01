import { describe, expect, test } from 'bun:test'
import {
  bindingFromResourceTransport,
  createResourceQueryCache,
  type QueryInvalidationAdapter,
  type ResourceBinding,
} from '~/lib/resources/catalog'
import {
  createCommandAdapter,
  defineCommand,
} from '~/lib/resources/catalog/commands'
import type { ResourceBindingResolver } from '~/lib/resources/command-invalidation'
import { runBindingMutation } from './use-grid-actions'

function bindingWithCommands(
  execute: (key: string, input: unknown) => Promise<void>,
  affectedResources?: readonly string[],
): ResourceBinding {
  const command = (key: string, target: 'row' | 'bulk' | 'rowOrBulk' | 'collection') =>
    defineCommand(
      target,
      async (input: unknown) => execute(key, input),
      { affectedResources },
    )
  return {
    resource: 'demo',
    reader: {
      query: async () => ({ results: [], pageInfo: { continueCursor: null, isDone: true } }),
      get: async () => null,
    },
    cache: createResourceQueryCache('demo', 'memory:demo'),
    commands: createCommandAdapter({
      setDefault: command('setDefault', 'row'),
      batchTag: command('batchTag', 'bulk'),
      audit: command('audit', 'rowOrBulk'),
      recalc: command('recalc', 'collection'),
    }),
    loadDocument: async () => {
      throw new Error('unused')
    },
  }
}

function cacheOnlyBinding(resource: string): ResourceBinding {
  return bindingFromResourceTransport(resource, {
      id: `memory:${resource}`,
      query: async () => ({ count: 0, results: [] }),
      get: async () => null,
    })
}

function testResolver(
  ...extraBindings: ResourceBinding[]
): ResourceBindingResolver {
  const bindings = new Map(
    [cacheOnlyBinding('sysAuditLogs'), ...extraBindings].map((binding) => [
      binding.resource,
      binding,
    ]),
  )
  return (resource) => {
    const binding = bindings.get(resource)
    if (!binding) {
      throw new Error(`资源「${resource}」未注册 ResourceBinding`)
    }
    return binding
  }
}

function recordingCache() {
  const queryKeys: Array<readonly unknown[]> = []
  const cache: QueryInvalidationAdapter = {
    invalidateQueries: async ({ queryKey }) => {
      queryKeys.push(queryKey)
    },
  }
  return { cache, queryKeys }
}

describe('runBindingMutation 命令 target 契约', () => {
  test('row：逐条传 { id }，不传 ids', async () => {
    const calls: Array<{ key: string; input: unknown }> = []
    const binding = bindingWithCommands(async (key, input) => {
      calls.push({ key, input })
    })
    const result = await runBindingMutation(
      [{ id: 'a' }, { id: 'b' }],
      binding,
      'setDefault',
      'row',
      recordingCache().cache,
      testResolver(),
    )
    expect(result.ok).toBe(2)
    expect(result.fail).toBe(0)
    expect(calls).toEqual([
      { key: 'setDefault', input: { id: 'a' } },
      { key: 'setDefault', input: { id: 'b' } },
    ])
  })

  test('bulk：一次传 { ids } 非空集合', async () => {
    const calls: Array<{ key: string; input: unknown }> = []
    const binding = bindingWithCommands(async (key, input) => {
      calls.push({ key, input })
    })
    const result = await runBindingMutation(
      [{ id: 'a' }, { id: 'b' }],
      binding,
      'batchTag',
      'bulk',
      recordingCache().cache,
      testResolver(),
    )
    expect(result.ok).toBe(2)
    expect(calls).toEqual([{ key: 'batchTag', input: { ids: ['a', 'b'] } }])
  })

  test('rowOrBulk：一次传 { ids }', async () => {
    const calls: Array<{ key: string; input: unknown }> = []
    const binding = bindingWithCommands(async (key, input) => {
      calls.push({ key, input })
    })
    await runBindingMutation(
      [{ id: 'x' }],
      binding,
      'audit',
      'rowOrBulk',
      recordingCache().cache,
      testResolver(),
    )
    expect(calls).toEqual([{ key: 'audit', input: { ids: ['x'] } }])
  })

  test('collection：不传记录 id', async () => {
    const calls: Array<{ key: string; input: unknown }> = []
    const binding = bindingWithCommands(async (key, input) => {
      calls.push({ key, input })
    })
    const result = await runBindingMutation(
      [],
      binding,
      'recalc',
      'collection',
      recordingCache().cache,
      testResolver(),
    )
    expect(result.ok).toBe(1)
    expect(calls).toEqual([{ key: 'recalc', input: {} }])
  })

  test('通用 Grid 命令也消费 affectedResources 并精确失效关联 binding', async () => {
    const binding = bindingWithCommands(async () => undefined, ['projection'])
    const { cache, queryKeys } = recordingCache()

    const result = await runBindingMutation(
      [{ id: 'x' }],
      binding,
      'setDefault',
      'row',
      cache,
      testResolver(cacheOnlyBinding('projection')),
    )

    expect(result).toEqual({ ok: 1, fail: 0, messages: [] })
    expect(queryKeys).toEqual([
      ['gridRows', 'memory:demo', 'demo'],
      ['rowById', 'memory:demo', 'demo'],
      ['gridRows', 'memory:sysAuditLogs', 'sysAuditLogs'],
      ['rowById', 'memory:sysAuditLogs', 'sysAuditLogs'],
      ['gridRows', 'memory:projection', 'projection'],
      ['rowById', 'memory:projection', 'projection'],
    ])
  })

  test('requiredCapability 与 key 分离：gridMetaFromDocument 携带字段', async () => {
    const { gridMetaFromDocument } = await import('~/lib/resources/catalog/grid-from-document')
    const meta = gridMetaFromDocument({
      schemaVersion: 2,
      name: 'sysStorages',
      label: '存储',
      permissionPrefix: 'sys.storage',
      capabilities: ['update'],
      fields: [
        {
          kind: 'scalar',
          scalarType: 'string',
          name: 'name',
          label: '名称',
          visibility: 'readable',
          input: { create: 'required', update: 'allowed' },
          filterable: true,
          sortable: true,
        },
      ],
      lookup: { labelField: 'name', searchFields: ['name'] },
      list: { columns: ['name'] },
      form: { kind: 'none' },
      commands: [
        {
          key: 'setDefault',
          label: '设为默认',
          target: 'row',
          requiredCapability: 'update',
        },
      ],
    })
    expect(meta.extendedActions[0]).toMatchObject({
      key: 'setDefault',
      requiredCapability: 'update',
      target: 'row',
    })
    // 门控应用 requiredCapability：持 update 即可见 setDefault
    expect(meta.capabilities).toContain('update')
  })
})
