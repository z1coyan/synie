import type { Selection } from 'react-aria-components'
import type { Row } from './types'

/**
 * 跨页/跨搜索累积选中:本页以 selection 为准(勾了加、去了删),不在本页的历史选中原样保留。
 * single 只留一条:本页有选中即替换;本页无选中 = 取消(清掉本页的),翻页场景自然保留。
 */
export function mergePick(prev: Row[], pageRows: Row[], selection: Selection, mode: 'single' | 'multiple'): Row[] {
  const pageIds = new Set(pageRows.map((r) => r.id))
  const sel = selection === 'all' ? new Set(pageRows.map((r) => r.id)) : new Set([...selection].map(String))
  if (mode === 'single') {
    const hit = pageRows.find((row) => sel.has(row.id))
    if (hit) return [hit]
    return prev.filter((row) => !pageIds.has(row.id))
  }
  return [...prev.filter((row) => !pageIds.has(row.id)), ...pageRows.filter((row) => sel.has(row.id))]
}
