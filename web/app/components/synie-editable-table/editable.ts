import type { GridColumnMeta, Row } from '../synie-data-grid/types'

/** 未持久化草稿行的本地 id 前缀;父级提交 mutation 前用 isLocalRow 判别新增/存量 */
export const LOCAL_ID_PREFIX = 'local:'

export const isLocalRow = (row: Row) => row.id.startsWith(LOCAL_ID_PREFIX)

// crypto.randomUUID 仅存在于安全上下文(https/localhost),经局域网 IP 走 http 访问时
// 没有;本地草稿 id 只需列表内唯一,退化用时间戳+随机数足够
export const localRowId = () =>
  `${LOCAL_ID_PREFIX}${
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }`

/** 系统字段与表单侧(fields.ts SYSTEM_FIELDS)对齐:草稿子条目没有时间戳语义 */
const HIDDEN = ['id', 'insertedAt', 'updatedAt']

/**
 * 表格显示列:meta 列剔 id/系统字段/exclude;columns 传了则按其顺序取白名单
 * (columns 只影响表格显示,不影响二级抽屉字段集)。
 * columns 含 meta 之外的名字且 overrides 有同名声明时,合成「计算列」
 * (如盘点差异=折算实盘−账面,值由 overrides.render 从行数据现算):仅展示,
 * 不可排序/筛选;二级抽屉字段集仍只来自 meta,计算列不进录入表单。
 */
export function displayColumns(
  metaColumns: GridColumnMeta[],
  columns?: string[],
  exclude: string[] = [],
  overrides: Record<string, { label?: string }> = {}
): GridColumnMeta[] {
  const base = metaColumns.filter((c) => !HIDDEN.includes(c.name) && !exclude.includes(c.name))
  if (!columns) return base
  const byName = new Map(base.map((c) => [c.name, c]))
  return columns.flatMap((n) => {
    const found = byName.get(n)
    if (found) return [found]
    // meta 之外的计算列:overrides 声明了才合成(类型取中性的 string,对齐/渲染走 overrides);
    // 未声明按未知名忽略(与原行为一致)
    if (!(n in overrides)) return []
    return [{ name: n, type: 'string' as const, label: overrides[n].label ?? n, sortable: false, filterable: false, enumOptions: null, ref: null }]
  })
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
    // 多态 fk 无 join(relation null),行上没有旧 join 对象可清
    if (c.type === 'fk' && c.ref?.relation && c.name in values && values[c.name] !== editing[c.name]) {
      merged[c.ref.relation] = null
    }
  }
  return items.map((it) => (it.id === editing.id ? (merged as T) : it))
}

export function removeItem<T extends Row>(items: T[], id: string): T[] {
  return items.filter((it) => it.id !== id)
}
