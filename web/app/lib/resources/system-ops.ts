import { isForbidden } from '../errors'
import { unboundResourceClient } from './unbound'

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

export interface TodoSemanticOperations {
  list(tab: TodoTab, opts?: { limit?: number; offset?: number }): Promise<TodoList>
  unreadCount(): Promise<number>
  markRead(id: string): Promise<void>
  dismiss(id: string): Promise<void>
}

let semanticOperations: TodoSemanticOperations | null = null

export function activateTodoSemanticOperations(
  operations: TodoSemanticOperations,
): void {
  semanticOperations = operations
}

function todos(): TodoSemanticOperations {
  if (!semanticOperations) throw new Error('待办能力尚未由 Convex 应用壳装配')
  return semanticOperations
}

export const auditLogClient = unboundResourceClient('sysAuditLogs')

export async function fetchTodos(
  tab: TodoTab,
  opts?: { limit?: number; offset?: number },
): Promise<TodoList> {
  try {
    return await todos().list(tab, opts)
  } catch (error) {
    if (isForbidden(error)) return { results: [], count: 0 }
    throw error
  }
}

export async function fetchUnreadCount(): Promise<number> {
  try {
    return await todos().unreadCount()
  } catch (error) {
    if (isForbidden(error)) return 0
    throw error
  }
}

export const markTodoRead = (id: string) => todos().markRead(id)
export const dismissTodo = (id: string) => todos().dismiss(id)
