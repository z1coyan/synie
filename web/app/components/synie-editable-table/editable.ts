import type { GridColumnMeta, Row } from '../synie-data-grid/types'

/** 未持久化草稿行的本地 id 前缀;父级提交 mutation 前用 isLocalRow 判别新增/存量 */
export const LOCAL_ID_PREFIX = 'local:'

export const isLocalRow = (row: Row) => row.id.startsWith(LOCAL_ID_PREFIX)

export const localRowId = () => `${LOCAL_ID_PREFIX}${crypto.randomUUID()}`

/** 系统字段与表单侧(fields.ts SYSTEM_FIELDS)对齐:草稿子条目没有时间戳语义 */
const HIDDEN = ['id', 'insertedAt', 'updatedAt']

/**
 * 表格显示列:meta 列剔 id/系统字段/exclude;columns 传了则按其顺序取白名单
 * (columns 只影响表格显示,不影响二级抽屉字段集)
 */
export function displayColumns(
  metaColumns: GridColumnMeta[],
  columns?: string[],
  exclude: string[] = []
): GridColumnMeta[] {
  const base = metaColumns.filter((c) => !HIDDEN.includes(c.name) && !exclude.includes(c.name))
  if (!columns) return base
  const byName = new Map(base.map((c) => [c.name, c]))
  return columns.flatMap((n) => byName.get(n) ?? [])
}

export function appendItem<T extends Row>(items: T[], values: Record<string, unknown>, id: string): T[] {
  return [...items, { ...values, id } as T]
}

/**
 * 编辑合并:values 覆盖原行;fk 值变了则清掉行上挂的旧 join 对象,
 * 否则 cellText/FkText 优先读 join 会显示改前的旧标签
 */
export function mergeItem<T extends Row>(
  items: T[],
  editing: T,
  values: Record<string, unknown>,
  metaColumns: GridColumnMeta[]
): T[] {
  const merged = { ...editing, ...values } as Record<string, unknown>
  for (const c of metaColumns) {
    if (c.type === 'fk' && c.ref && c.name in values && values[c.name] !== editing[c.name]) {
      merged[c.ref.relation] = null
    }
  }
  return items.map((it) => (it.id === editing.id ? (merged as T) : it))
}

export function removeItem<T extends Row>(items: T[], id: string): T[] {
  return items.filter((it) => it.id !== id)
}
