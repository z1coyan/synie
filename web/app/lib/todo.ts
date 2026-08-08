import type { SysTodo, TodoType } from './resources/system-ops'

export { dismissTodo, fetchTodos, fetchUnreadCount, markTodoRead } from './resources/system-ops'
export type {
  SysTodo,
  TodoClosedReason,
  TodoStatus,
  TodoTab,
  TodoType,
} from './resources/system-ops'

export function todoTypeLabel(type: TodoType): string {
  return type === 'ISSUE_INVOICE' ? '开票' : '收票'
}

export function todoSourcePath(todo: SysTodo): string {
  if (todo.sourceType === 'sales.reconciliation') {
    return '/sales/reconciliations'
  }
  if (todo.sourceType === 'purchase.reconciliation') {
    return '/purchase/reconciliations/reconciliations'
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
