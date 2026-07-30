import { describe, expect, test } from 'bun:test'
import type { ResourceBinding } from '~/lib/resources/catalog'
import { runBindingMutation } from './use-grid-actions'

function bindingWithCommands(execute: (key: string, input: unknown) => Promise<void>): ResourceBinding {
  const calls: Array<{ key: string; input: unknown }> = []
  return {
    resource: 'demo',
    reader: {
      query: async () => ({ count: 0, results: [] }),
      get: async () => null,
    },
    commands: {
      commands: {} as never,
      execute: async (key, input) => {
        calls.push({ key, input })
        await execute(key, input)
        return undefined as never
      },
    },
    loadDocument: async () => {
      throw new Error('unused')
    },
    // expose for assertions
    ...({ _calls: calls } as object),
  } as ResourceBinding & { _calls?: Array<{ key: string; input: unknown }> }
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
    )
    expect(result.ok).toBe(2)
    expect(calls).toEqual([{ key: 'batchTag', input: { ids: ['a', 'b'] } }])
  })

  test('rowOrBulk：一次传 { ids }', async () => {
    const calls: Array<{ key: string; input: unknown }> = []
    const binding = bindingWithCommands(async (key, input) => {
      calls.push({ key, input })
    })
    await runBindingMutation([{ id: 'x' }], binding, 'audit', 'rowOrBulk')
    expect(calls).toEqual([{ key: 'audit', input: { ids: ['x'] } }])
  })

  test('collection：不传记录 id', async () => {
    const calls: Array<{ key: string; input: unknown }> = []
    const binding = bindingWithCommands(async (key, input) => {
      calls.push({ key, input })
    })
    const result = await runBindingMutation([], binding, 'recalc', 'collection')
    expect(result.ok).toBe(1)
    expect(calls).toEqual([{ key: 'recalc', input: {} }])
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
