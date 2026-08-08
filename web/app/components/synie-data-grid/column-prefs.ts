/**
 * 网格列显示偏好：localStorage 持久化的可见列有序集合。
 *
 * - 候选全集 = meta 列（调用方已去掉 id/exclude）± 合成列（如 __attachmentImages）
 * - 无偏好时默认 = 页面 props.columns（或全候选）
 * - 偏好只记可见列顺序；隐藏 = 候选中不在 order 的列
 * - widths 预留，UI 第一版不写
 */

export const ATTACHMENT_IMAGES_COLUMN = '__attachmentImages'

export interface GridColumnPrefs {
  v: 1
  /** 可见列有序；顺序即表头顺序 */
  order: string[]
  /** 预留列宽；第一版 UI 不读写 */
  widths?: Record<string, number>
}

export function storageKeyForColumnPrefs(prefsKey: string): string {
  return `synie.grid.columnPrefs.${prefsKey}`
}

/** 解析 storage 原始值；非法/空 order 返回 null（视为无偏好）。 */
export function parseColumnPrefs(raw: unknown): GridColumnPrefs | null {
  if (raw == null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.v !== 1 || !Array.isArray(o.order)) return null
  const order = o.order.filter((x): x is string => typeof x === 'string' && x.length > 0)
  if (order.length === 0) return null
  let widths: Record<string, number> | undefined
  if (o.widths != null && typeof o.widths === 'object' && !Array.isArray(o.widths)) {
    const next: Record<string, number> = {}
    for (const [k, v] of Object.entries(o.widths as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) next[k] = v
    }
    if (Object.keys(next).length > 0) widths = next
  }
  return widths ? { v: 1, order, widths } : { v: 1, order }
}

/**
 * 解析可见列顺序。
 * - prefs 无效键静默丢弃
 * - 过滤后为空则回退 defaultOrder（再空则全候选）
 * - 新候选列不自动插入已有偏好
 */
export function resolveVisibleOrder(
  prefs: GridColumnPrefs | null,
  defaultOrder: string[],
  candidates: string[],
): string[] {
  const candSet = new Set(candidates)
  const fallback = defaultOrder.filter((n) => candSet.has(n))
  const safeDefault = fallback.length > 0 ? fallback : [...candidates]
  if (safeDefault.length === 0) return []
  if (!prefs) return safeDefault
  const fromPrefs = prefs.order.filter((n) => candSet.has(n))
  return fromPrefs.length > 0 ? fromPrefs : safeDefault
}

/** 切换可见：开则追加到末尾；关则移除。最后一列不可关（返回原 order）。 */
export function toggleColumnVisible(order: string[], name: string, visible: boolean): string[] {
  const has = order.includes(name)
  if (visible) {
    if (has) return order
    return [...order, name]
  }
  if (!has) return order
  if (order.length <= 1) return order
  return order.filter((n) => n !== name)
}

/** 在可见序列内移动；delta = -1 上移 / +1 下移。 */
export function moveVisibleColumn(order: string[], name: string, delta: -1 | 1): string[] {
  const i = order.indexOf(name)
  if (i < 0) return order
  const j = i + delta
  if (j < 0 || j >= order.length) return order
  const next = order.slice()
  const tmp = next[i]!
  next[i] = next[j]!
  next[j] = tmp
  return next
}

/** 默认可见序：页面白名单（有则）+ 合成列默认挂末尾。 */
export function buildDefaultOrder(
  pageColumns: string[] | undefined,
  candidateNames: string[],
  syntheticAtEnd: string[] = [],
): string[] {
  const candSet = new Set(candidateNames)
  const core =
    pageColumns && pageColumns.length > 0
      ? pageColumns.filter((n) => candSet.has(n))
      : candidateNames.filter((n) => !syntheticAtEnd.includes(n))
  const extra = syntheticAtEnd.filter((n) => candSet.has(n) && !core.includes(n))
  return [...core, ...extra]
}

export function readColumnPrefs(storageKey: string): GridColumnPrefs | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (raw == null) return null
    return parseColumnPrefs(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

export function writeColumnPrefs(storageKey: string, prefs: GridColumnPrefs): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(prefs))
  } catch {
    // quota / 隐私模式：忽略，会话内仍可用内存态
  }
}

export function clearColumnPrefs(storageKey: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(storageKey)
  } catch {
    // ignore
  }
}

/**
 * 列设置是否默认启用：与 URL 状态同口径——
 * pick / 显式内嵌(urlState=false) 默认关；页面网格默认开。columnSettings 可强开/强关。
 */
export function resolveColumnSettingsEnabled(
  columnSettings: boolean | undefined,
  urlState: boolean | undefined,
  pick: 'single' | 'multiple' | undefined,
): boolean {
  if (columnSettings != null) return columnSettings
  if (urlState != null) return urlState
  return pick == null
}
