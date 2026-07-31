import { describe, expect, test } from 'bun:test'
import {
  bindingFromResourceTransport,
  type QueryInvalidationAdapter,
  type ResourceBinding,
} from './catalog'
import { createRowCommandAdapter } from './catalog/commands'
import {
  executeSingleRowCommandWithInvalidation,
  type ResourceBindingResolver,
} from './command-invalidation'

function bindingHarness(): {
  register: (
    resource: string,
    commands?: ReturnType<typeof createRowCommandAdapter>,
  ) => void
  resolve: ResourceBindingResolver
} {
  const bindings = new Map<string, ResourceBinding>()
  return {
    register: (resource, commands) => {
      bindings.set(resource, {
        ...bindingFromResourceTransport(resource, {
          id: `memory:${resource}`,
          query: async () => ({ count: 0, results: [] }),
          get: async () => null,
        }),
        ...(commands ? { commands } : {}),
      })
    },
    resolve: (resource) => {
      const binding = bindings.get(resource)
      if (!binding) {
        throw new Error(`资源「${resource}」未注册 ResourceBinding`)
      }
      return binding
    },
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

function allCacheKeys(resources: readonly string[]): string[] {
  return resources
    .flatMap((resource) => [
      ['gridRows', `memory:${resource}`, resource],
      ['rowById', `memory:${resource}`, resource],
    ])
    .map((key) => JSON.stringify(key))
    .sort()
}

describe('post-command cache invalidation module', () => {
  test('无 effects 的旧 handler 至少失效当前资源与系统审计日志', async () => {
    const bindings = bindingHarness()
    bindings.register('sysAuditLogs')
    const handled: string[] = []
    bindings.register(
      'source',
      createRowCommandAdapter({
        audit: async (id) => {
          handled.push(id)
        },
      }),
    )
    const { cache, queryKeys } = recordingCache()

    await executeSingleRowCommandWithInvalidation(
      'source',
      'audit',
      'row-1',
      cache,
      bindings.resolve,
    )

    expect(handled).toEqual(['row-1'])
    expect(queryKeys.map((key) => JSON.stringify(key)).sort()).toEqual(
      allCacheKeys(['source', 'sysAuditLogs']),
    )
  })

  test('effects 精确跨资源失效，并对当前资源与重复声明去重', async () => {
    const bindings = bindingHarness()
    bindings.register('sysAuditLogs')
    bindings.register(
      'source',
      createRowCommandAdapter({
        audit: {
          handler: async () => undefined,
          affectedResources: ['child-b', 'source', 'child-a', 'child-b'],
        },
      }),
    )
    bindings.register('child-a')
    bindings.register('child-b')
    const { cache, queryKeys } = recordingCache()

    await executeSingleRowCommandWithInvalidation(
      'source',
      'audit',
      'row-1',
      cache,
      bindings.resolve,
    )

    expect(queryKeys.map((key) => JSON.stringify(key)).sort()).toEqual(
      allCacheKeys(['source', 'sysAuditLogs', 'child-a', 'child-b']),
    )
  })

  test('未知 affected resource 在任何失效发生前 fail-closed', async () => {
    const bindings = bindingHarness()
    bindings.register('sysAuditLogs')
    let handled = false
    bindings.register(
      'source',
      createRowCommandAdapter({
        audit: {
          handler: async () => {
            handled = true
          },
          affectedResources: ['missing-resource'],
        },
      }),
    )
    const { cache, queryKeys } = recordingCache()

    await expect(
      executeSingleRowCommandWithInvalidation(
        'source',
        'audit',
        'row-1',
        cache,
        bindings.resolve,
      ),
    ).rejects.toThrow(/missing-resource.*未注册 ResourceBinding/)
    expect(handled).toBe(false)
    expect(queryKeys).toEqual([])
  })

  test('Generic Drawer 调用的 helper 对未知 command 与 source resource 均失败', async () => {
    const bindings = bindingHarness()
    bindings.register('sysAuditLogs')
    bindings.register(
      'source',
      createRowCommandAdapter({ audit: async () => undefined }),
    )
    const { cache, queryKeys } = recordingCache()

    await expect(
      executeSingleRowCommandWithInvalidation(
        'source',
        'missing-command',
        'row-1',
        cache,
        bindings.resolve,
      ),
    ).rejects.toThrow(/source.*missing-command/)
    await expect(
      executeSingleRowCommandWithInvalidation(
        'missing-source',
        'audit',
        'row-1',
        cache,
        bindings.resolve,
      ),
    ).rejects.toThrow(/missing-source.*未注册 ResourceBinding/)
    expect(queryKeys).toEqual([])
  })
})
