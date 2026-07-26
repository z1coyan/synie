import type { components } from '../api/schema'
import { apiClient, apiData } from '../api/client'
import { isForbidden } from '../errors'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { gridMeta } from './meta'
import type { ResourceClient, ResourceQuery } from './types'

type ListQuery = components['schemas']['ListQuery']
type TodoQuery = components['schemas']['TodoQuery']
type TodoList = components['schemas']['TodoList']

export type SysTodo = components['schemas']['Todo']
export type TodoType = SysTodo['type']
export type TodoStatus = SysTodo['status']
export type TodoClosedReason = SysTodo['closedReason']
export type TodoTab = TodoQuery['tab']

function listBody(input: ResourceQuery): ListQuery {
  if (input.extraFields?.length || input.joinFields) {
    throw new Error('审计日志 REST 资源不支持额外字段或 joinFields')
  }
  return {
    limit: input.limit,
    offset: input.offset,
    search: input.search || undefined,
    sort: input.sort ?? undefined,
    filter: {
      ...(input.filter ?? {}),
      ...((input.fixedFilter ?? {}) as FilterState),
    } as components['schemas']['FilterState'],
  }
}

const readOnly = async (): Promise<Row> => {
  throw new Error('审计日志只读,不支持写入')
}

export const auditLogClient: ResourceClient = {
  id: 'rest:sysAuditLogs',

  async meta() {
    return gridMeta(
      await apiData(
        apiClient.GET('/meta/resources/{name}', {
          params: { path: { name: 'sysAuditLogs' } },
        })
      )
    )
  },

  async query(input) {
    const result = await apiData(
      apiClient.POST('/system/audit-logs/query', { body: listBody(input) })
    )
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return (await apiData(
      apiClient.GET('/system/audit-logs/{id}', {
        params: { path: { id } },
      })
    )) as Row
  },

  create: readOnly,
  update: readOnly,
  delete: async () => {
    await readOnly()
  },
}

export async function fetchTodos(
  tab: TodoTab,
  opts?: { limit?: number; offset?: number }
): Promise<TodoList> {
  const body: TodoQuery = {
    tab,
    includeDismissed: false,
    limit: opts?.limit ?? 20,
    offset: opts?.offset ?? 0,
  }
  try {
    return await apiData(apiClient.POST('/todos/query', { body }))
  } catch (error) {
    if (isForbidden(error)) return { results: [], count: 0 }
    throw error
  }
}

export async function fetchUnreadCount(): Promise<number> {
  try {
    const data = await apiData(apiClient.GET('/todos/unread-count'))
    return data.count ?? 0
  } catch (error) {
    if (isForbidden(error)) return 0
    throw error
  }
}

export async function markTodoRead(id: string): Promise<void> {
  await apiData(
    apiClient.POST('/todos/{id}/read', {
      params: { path: { id } },
    })
  )
}

export async function dismissTodo(id: string): Promise<void> {
  await apiData(
    apiClient.POST('/todos/{id}/dismiss', {
      params: { path: { id } },
    })
  )
}
