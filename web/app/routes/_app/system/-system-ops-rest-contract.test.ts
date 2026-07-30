import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fetchAllRows } from '~/components/synie-data-grid/csv'
import { resolveSource } from '~/components/synie-remote-select/remote-query'
import { resourceTransportFor } from '~/lib/resources/registry'
import type { ResourceQuery, ResourceTransport } from '~/lib/resources/types'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const logs = source('./logs.tsx')
const todos = source('../todos.tsx')
const todoBell = source('../../../components/todo-bell.tsx')
const todoFacade = source('../../../lib/todo.ts')
const clients = source('../../../lib/resources/system-ops.ts')
const registry = source('../../../lib/resources/registry.ts')
const sharedResourceSources = [
  '../../../components/synie-data-grid/SynieDataGrid.tsx',
  '../../../components/synie-data-grid/meta.ts',
  '../../../components/synie-data-grid/csv.ts',
  '../../../components/synie-data-grid/use-grid-actions.tsx',
  '../../../components/synie-data-grid/status-actions.ts',
  '../../../components/synie-record-drawer/SynieRecordDrawer.tsx',
  '../../../components/synie-remote-select/use-remote.ts',
  '../../../components/synie-editable-table/use-doc-items.ts',
].map(source)

describe('PR-2.18 系统操作面 REST 边界', () => {
  test('审计日志 Grid 与 Drawer 显式绑定只读 REST client', () => {
    expect(logs.match(/client=\{auditLogClient\}/g)).toHaveLength(2)
    expect(clients).toContain("id: 'rest:sysAuditLogs'")
    expect(clients).toContain("api.system['audit-logs'].query.\$post")
    expect(clients).toContain("api.system['audit-logs'][':id'].\$get")
    expect(clients).not.toMatch(/\b(create|update|delete)\s*:/)
  })

  test('审计与 Todo 消费面不再包含 GraphQL 请求或 operation', () => {
    for (const text of [logs, todos, todoBell, todoFacade, clients]) {
      expect(text).not.toContain('gqlFetch')
      expect(text).not.toMatch(/\b(query|mutation)\s+\(\$/)
    }
  })

  test('共享资源 seam 仅走 REST registry 且未知资源 fail-fast', () => {
    for (const text of sharedResourceSources) {
      expect(text).not.toContain('gqlFetch')
    }
    expect(registry).toContain('sysAuditLogs: auditLogClient')
    expect(resourceTransportFor('sysAuditLogs').id).toBe('rest:sysAuditLogs')
    expect(resolveSource({ resource: 'sysAuditLogs' })?.client.id).toBe(
      'rest:sysAuditLogs',
    )
    expect(() => resourceTransportFor('missingResource')).toThrow(
      '资源「missingResource」未注册 ResourceBinding',
    )
    expect(() => resolveSource({ resource: 'missingRemoteResource' })).toThrow(
      '资源「missingRemoteResource」未注册 ResourceBinding',
    )
  })

  test('CSV 导出通过显式 client 按实际页长连续取数', async () => {
    const calls: Array<{ limit: number; offset: number; search?: string }> = []
    const client = {
      id: 'test:csv',
      query: async (input: ResourceQuery) => {
        calls.push({ limit: input.limit, offset: input.offset, search: input.search })
        return input.offset === 0
          ? { count: 3, results: [{ id: '1' }, { id: '2' }] }
          : { count: 3, results: [{ id: '3' }] }
      },
    } as ResourceTransport

    await expect(fetchAllRows(client, { search: '审计' })).resolves.toEqual([
      { id: '1' },
      { id: '2' },
      { id: '3' },
    ])
    expect(calls).toEqual([
      { limit: 200, offset: 0, search: '审计' },
      { limit: 200, offset: 2, search: '审计' },
    ])
  })

  test('Todo 列表、未读、已读与忽略全部经 REST', () => {
    for (const endpoint of [
      "api.todos.query.\$post",
      "api.todos['unread-count'].\$get",
      "api.todos[':id'].read.\$post",
      "api.todos[':id'].dismiss.\$post",
    ]) {
      expect(clients).toContain(endpoint)
    }
    expect(clients).toContain('includeDismissed: false')
    expect(todoFacade).toContain("from './resources/system-ops'")
  })
})
