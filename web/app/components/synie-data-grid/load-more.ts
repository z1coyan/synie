import type { Row } from './types'

/**
 * 加载更多的累积合并:第 1 页整体替换(查询条件变更即重置),
 * 后续页按 id 去重追加(keepPreviousData 期间旧页可能重复抵达)。
 */
export function mergeLoadedRows(prev: Row[], incoming: Row[], page: number): Row[] {
  if (page <= 1) return incoming
  const seen = new Set(prev.map((r) => r.id))
  return [...prev, ...incoming.filter((r) => !seen.has(r.id))]
}

/** 是否还有下一页可加载；游标 isDone 是权威，total 仅供显示。 */
export function hasMoreRows(isDone: boolean): boolean {
  return !isDone
}
