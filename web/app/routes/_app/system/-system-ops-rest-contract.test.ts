import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const logs = source('./logs.tsx')
const todos = source('../todos.tsx')
const todoBell = source('../../../components/todo-bell.tsx')
const todoFacade = source('../../../lib/todo.ts')
const clients = source('../../../lib/resources/system-ops.ts')

describe('PR-2.18 系统操作面 REST 边界', () => {
  test('审计日志 Grid 与 Drawer 显式绑定只读 REST client', () => {
    expect(logs.match(/client=\{auditLogClient\}/g)).toHaveLength(2)
    expect(clients).toContain("id: 'rest:sysAuditLogs'")
    expect(clients).toContain("apiClient.POST('/system/audit-logs/query'")
    expect(clients).toContain("apiClient.GET('/system/audit-logs/{id}'")
    expect(clients).toContain('create: readOnly')
    expect(clients).toContain('update: readOnly')
  })

  test('审计与 Todo 消费面不再包含 GraphQL 请求或 operation', () => {
    for (const text of [logs, todos, todoBell, todoFacade, clients]) {
      expect(text).not.toContain('gqlFetch')
      expect(text).not.toMatch(/\b(query|mutation)\s+\(\$/)
    }
  })

  test('Todo 列表、未读、已读与忽略全部经 REST', () => {
    for (const endpoint of [
      "'/todos/query'",
      "'/todos/unread-count'",
      "'/todos/{id}/read'",
      "'/todos/{id}/dismiss'",
    ]) {
      expect(clients).toContain(endpoint)
    }
    expect(clients).toContain('includeDismissed: false')
    expect(todoFacade).toContain("from './resources/system-ops'")
  })
})
