import type { SortState } from './types'

/** Convex opaque ID 门槛：仅要求非空且不接受隐式 trim。 */
export function isOpaqueResourceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

/** 表头点击三态循环：顺序 → 逆序 → 取消排序。 */
export function nextSort(prev: SortState | null, column: string, direction: SortState['direction']): SortState | null {
  if (prev && prev.column === column && prev.direction === 'descending' && direction === 'ascending') return null
  return { column, direction }
}

/** 排序选择器(卡片模式)点按循环:新列顺序 → 逆序 → 取消,与表头三态同语义 */
export function toggleSort(prev: SortState | null, column: string): SortState | null {
  if (!prev || prev.column !== column) return { column, direction: 'ascending' }
  if (prev.direction === 'ascending') return { column, direction: 'descending' }
  return null
}

/** datetime 资源字段存 UTC 瞬时，筛选日期按本地日界换算。 */
export const dayStart = (date: string) => new Date(`${date}T00:00:00`).toISOString()
export const dayEnd = (date: string) => new Date(`${date}T23:59:59.999`).toISOString()
