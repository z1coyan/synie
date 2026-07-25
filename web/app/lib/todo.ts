import { gqlFetch, isForbidden } from './graphql'

export type TodoType = 'ISSUE_INVOICE' | 'RECEIVE_INVOICE'
export type TodoStatus = 'ACTIVE' | 'CLOSED'
export type TodoClosedReason = 'UNCONFIRM' | 'INVOICE_AUDIT' | null
export type TodoTab = 'active' | 'history' | 'recent'

export interface SysTodo {
  id: string
  type: TodoType
  sourceType: string
  sourceId: string
  sourceNo: string
  partyType: string
  partyId: string
  partyName: string
  amount: string | number
  status: TodoStatus
  closedReason: TodoClosedReason
  sourceChangedAt: string
  closedAt: string | null
  insertedAt: string
  draftInvoiceLinked: boolean
  myReadAt: string | null
  myDismissedAt: string | null
  dismissed: boolean
  companyId: string
  company?: { id: string; name: string; shortName?: string | null } | null
}

const TODO_FIELDS = `
  id
  type
  sourceType
  sourceId
  sourceNo
  partyType
  partyId
  partyName
  amount
  status
  closedReason
  sourceChangedAt
  closedAt
  insertedAt
  draftInvoiceLinked
  myReadAt
  myDismissedAt
  dismissed
  companyId
  company { id name shortName }
`

export async function fetchTodos(
  tab: TodoTab,
  opts?: { limit?: number; offset?: number }
): Promise<{ results: SysTodo[]; count: number }> {
  const limit = opts?.limit ?? 20
  const offset = opts?.offset ?? 0
  try {
    const data = await gqlFetch<{
      sysTodos: { results: SysTodo[]; count: number }
    }>(
      `query ($tab: String, $limit: Int, $offset: Int) {
        sysTodos(tab: $tab, limit: $limit, offset: $offset) {
          results { ${TODO_FIELDS} }
          count
        }
      }`,
      { tab, limit, offset }
    )
    return data.sysTodos
  } catch (e) {
    if (isForbidden(e)) return { results: [], count: 0 }
    throw e
  }
}

export async function fetchUnreadCount(): Promise<number> {
  try {
    const data = await gqlFetch<{ sysTodoUnreadCount: number }>(
      `query { sysTodoUnreadCount }`
    )
    return data.sysTodoUnreadCount ?? 0
  } catch (e) {
    if (isForbidden(e)) return 0
    throw e
  }
}

export async function markTodoRead(id: string): Promise<void> {
  await gqlFetch(
    `mutation ($id: ID!) {
      markReadSysTodo(id: $id) { result { id } errors { message } }
    }`,
    { id }
  )
}

export async function dismissTodo(id: string): Promise<void> {
  await gqlFetch(
    `mutation ($id: ID!) {
      dismissSysTodo(id: $id) { result { id } errors { message } }
    }`,
    { id }
  )
}

export function todoTypeLabel(type: TodoType): string {
  return type === 'ISSUE_INVOICE' ? '开票' : '收票'
}

export function todoSourcePath(todo: SysTodo): string {
  if (todo.sourceType === 'sales.reconciliation') {
    return '/scm/sales-reconciliations/reconciliations'
  }
  if (todo.sourceType === 'purchase.reconciliation') {
    return '/scm/purchase-reconciliations/reconciliations'
  }
  return '/todos'
}

export function formatTodoTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
