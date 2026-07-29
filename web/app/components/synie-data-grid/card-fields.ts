import type { GridColumnMeta } from './types'

/** 列在卡片上的角色;缺省走位置约定(第 1 列标题、第 2 列副标题、第 3-5 列摘要) */
export type MobileRole = 'title' | 'subtitle' | 'summary' | 'hide'

/** 卡片字段映射:title/subtitle 为列名(无则 null),summary 为有序列名(至多 3) */
export interface CardFields {
  title: string | null
  subtitle: string | null
  summary: string[]
}

/**
 * 卡片字段角色推导:显式 mobileRole 优先于位置约定,被显式角色占用的列退出位置池,
 * 其余可见列按原顺序顺延补位(title → subtitle → summary,summary 显式列在前、位置填充在后,封顶 3)。
 */
export function cardFields(columns: GridColumnMeta[], roles: Record<string, MobileRole | undefined>): CardFields {
  const visible = columns.filter((c) => roles[c.name] !== 'hide')
  const byRole = (role: MobileRole) => visible.filter((c) => roles[c.name] === role).map((c) => c.name)

  const explicitTitle = byRole('title')[0] ?? null
  const explicitSubtitle = byRole('subtitle')[0] ?? null
  const explicitSummary = byRole('summary')
  // 全部显式角色列退出位置池:误配两个 title 时,第二个不得回落抢副标题/摘要位
  const explicit = new Set([...byRole('title'), ...byRole('subtitle'), ...explicitSummary])

  const pool = visible.map((c) => c.name).filter((n) => !explicit.has(n))
  const title = explicitTitle ?? pool.shift() ?? null
  const subtitle = explicitSubtitle ?? pool.shift() ?? null
  const summary = [...explicitSummary, ...pool].slice(0, 3)

  return { title, subtitle, summary }
}
