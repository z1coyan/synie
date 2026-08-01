import { api, apiData } from '../api/client'
import { isForbidden } from '../errors'
import { restTransport } from './rest-transport'

export type TodoTab = 'active' | 'history' | 'recent'
export type TodoType = string
export type TodoStatus = string
export type TodoClosedReason = string | null

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

export const auditLogClient = restTransport(
  'sysAuditLogs',
  api.system['audit-logs'],
  {
    capabilities: { create: false, update: false, delete: false },
    listOptions: {
      resourceLabel: '审计日志',
      extraFields: 'reject',
      joinFields: 'reject',
    },
  },
)

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
    return await apiData(api.todos.query.$post({ json: body }))
  } catch (error) {
    if (isForbidden(error)) return { results: [], count: 0 }
    throw error
  }
}

export async function fetchUnreadCount(): Promise<number> {
  try {
    const data = await apiData(api.todos['unread-count'].$get())
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
