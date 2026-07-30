import type { ListQuery } from '@synie/shared'
import { api, apiData } from '../api/client'
import { isForbidden } from '../errors'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import type { ResourceQuery, ResourceTransport } from './types'

export type TodoTab = 'active' | 'history' | 'recent'
export type TodoType = 'ISSUE_INVOICE' | 'RECEIVE_INVOICE'
export type TodoStatus = 'ACTIVE' | 'CLOSED'
export type TodoClosedReason = 'UNCONFIRM' | 'INVOICE_AUDIT' | null

export interface SysTodo {
  id: string
  type: TodoType
  sourceType: string
  sourceId: string
  sourceNo: string
  partyType: string
  partyId: string
  partyName: string
    company?: { name?: string | null; shortName?: string | null } | null
  amount: string
  status: TodoStatus
  closedReason: TodoClosedReason
  sourceChangedAt: string
  closedAt: string | null
  insertedAt: string
  updatedAt: string
  draftInvoiceLinked: boolean
  myReadAt: string | null
  myDismissedAt: string | null
}

export interface TodoList {
  count: number
  results: SysTodo[]
}

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
    },
  }
}

export const auditLogClient: ResourceTransport = {
  id: 'rest:sysAuditLogs',

  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.system['audit-logs'].query.$post({ json: listBody(input) }),
    )
    return { count: result.count, results: result.results }
  },

  async get(id) {
    return (await apiData(
      api.system['audit-logs'][':id'].$get({
        param: { id },
      }),
    )) as Row
  },

}

export async function fetchTodos(
  tab: TodoTab,
  opts?: { limit?: number; offset?: number },
): Promise<TodoList> {
  const body = {
    tab,
    includeDismissed: false,
    limit: opts?.limit ?? 20,
    offset: opts?.offset ?? 0,
  }
  try {
    return await apiData<TodoList>(api.todos.query.$post({ json: body }))
  } catch (error) {
    if (isForbidden(error)) return { results: [], count: 0 }
    throw error
  }
}

export async function fetchUnreadCount(): Promise<number> {
  try {
    const data = await apiData<{ count: number }>(api.todos['unread-count'].$get())
    return data.count ?? 0
  } catch (error) {
    if (isForbidden(error)) return 0
    throw error
  }
}

export async function markTodoRead(id: string): Promise<void> {
  await apiData(
    api.todos[':id'].read.$post({
      param: { id },
    }),
  )
}

export async function dismissTodo(id: string): Promise<void> {
  await apiData(
    api.todos[':id'].dismiss.$post({
      param: { id },
    }),
  )
}
