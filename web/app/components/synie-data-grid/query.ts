import type { SortState } from './types'

/** REST 资源 id 白名单；非法值不参与远程查询。 */
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** 表头点击三态循环：顺序 → 逆序 → 取消排序。 */
export function nextSort(prev: SortState | null, column: string, direction: SortState['direction']): SortState | null {
  if (prev && prev.column === column && prev.direction === 'descending' && direction === 'ascending') return null
  return { column, direction }
}

/** datetime 资源字段存 UTC 瞬时，筛选日期按本地日界换算。 */
export const dayStart = (date: string) => new Date(`${date}T00:00:00`).toISOString()
export const dayEnd = (date: string) => new Date(`${date}T23:59:59.999`).toISOString()
