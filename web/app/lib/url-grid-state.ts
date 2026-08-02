/**
 * 数据网格状态 ↔ URL search params 编解码。
 *
 * 约定（与 url-record-drawer / route-loader-prefetch 共存）:
 * - 本模块只读写自有键 q/page/ps/sort/f，更新一律函数式 merge，绝不整包替换。
 * - 无参访问时全部键省略，行为与「组件内 useState 默认值」一致。
 * - FilterState 以 JSON 原样落 f 参数（与 wire 同构，含 fk labels，刷新后筛选 Chips 可还原）。
 */

import type { ColumnFilter, FilterState, SortState } from '@synie/shared'

/** 网格占用的 search 键；其它工作线（record/mode 等）不得占用这些名字 */
export const GRID_URL_KEYS = ['q', 'page', 'ps', 'sort', 'f'] as const
export type GridUrlKey = (typeof GRID_URL_KEYS)[number]

export const DEFAULT_PAGE = 1
export const DEFAULT_PAGE_SIZE = 20

/** 显式「无排序」标记：有 defaultSort 时，用户清掉排序需与「未写 sort 键 → 用 defaultSort」区分 */
export const SORT_NONE = 'none'

export interface GridUrlState {
  search: string
  page: number
  pageSize: number
  sort: SortState | null
  filters: FilterState
}

export interface GridUrlDefaults {
  sort: SortState | null
  filters: FilterState
  pageSize?: number
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

/** 宽松校验 ColumnFilter；非法结构丢弃该列，避免坏链拖垮整页 */
export function parseColumnFilter(raw: unknown): ColumnFilter | null {
  if (!isRecord(raw) || typeof raw.kind !== 'string') return null
  const kind = raw.kind
  switch (kind) {
    case 'text': {
      const op = raw.op
      if (
        (op === 'contains' || op === 'notContains' || op === 'eq' || op === 'notEq') &&
        typeof raw.value === 'string'
      ) {
        return { kind: 'text', op, value: raw.value }
      }
      return null
    }
    case 'bool':
      return typeof raw.eq === 'boolean' ? { kind: 'bool', eq: raw.eq } : null
    case 'enum':
      return Array.isArray(raw.values) && raw.values.every((x) => typeof x === 'string')
        ? { kind: 'enum', values: raw.values as string[] }
        : null
    case 'enumArray': {
      const op = raw.op
      if (
        (op === 'hasAny' || op === 'notHas') &&
        Array.isArray(raw.values) &&
        raw.values.every((x) => typeof x === 'string')
      ) {
        return { kind: 'enumArray', op, values: raw.values as string[] }
      }
      return null
    }
    case 'number': {
      if (raw.op === 'between') {
        const gte = raw.gte == null || typeof raw.gte === 'string' ? (raw.gte as string | undefined) : undefined
        const lte = raw.lte == null || typeof raw.lte === 'string' ? (raw.lte as string | undefined) : undefined
        if (raw.gte != null && typeof raw.gte !== 'string') return null
        if (raw.lte != null && typeof raw.lte !== 'string') return null
        return { kind: 'number', op: 'between', gte, lte }
      }
      const op = raw.op
      if (
        (op === 'eq' || op === 'gt' || op === 'lt' || op === 'gte' || op === 'lte') &&
        typeof raw.value === 'string'
      ) {
        return { kind: 'number', op, value: raw.value }
      }
      return null
    }
    case 'date': {
      if (raw.op === 'between') {
        if (raw.gte != null && typeof raw.gte !== 'string') return null
        if (raw.lte != null && typeof raw.lte !== 'string') return null
        return {
          kind: 'date',
          op: 'between',
          gte: typeof raw.gte === 'string' ? raw.gte : undefined,
          lte: typeof raw.lte === 'string' ? raw.lte : undefined,
        }
      }
      const op = raw.op
      if ((op === 'eq' || op === 'before' || op === 'after') && typeof raw.value === 'string') {
        return { kind: 'date', op, value: raw.value }
      }
      return null
    }
    case 'fk': {
      const op = raw.op
      if (op != null && op !== 'in' && op !== 'isNil') return null
      if (!Array.isArray(raw.values) || !raw.values.every((x) => typeof x === 'string')) return null
      if (!Array.isArray(raw.labels) || !raw.labels.every((x) => typeof x === 'string')) return null
      return {
        kind: 'fk',
        op: op as 'in' | 'isNil' | undefined,
        values: raw.values as string[],
        labels: raw.labels as string[],
      }
    }
    case 'polyFk': {
      if (raw.op === 'isNil') return { kind: 'polyFk', op: 'isNil' }
      if (raw.op !== 'in' || typeof raw.variant !== 'string') return null
      if (!Array.isArray(raw.values) || !raw.values.every((x) => typeof x === 'string')) return null
      if (!Array.isArray(raw.labels) || !raw.labels.every((x) => typeof x === 'string')) return null
      return {
        kind: 'polyFk',
        op: 'in',
        variant: raw.variant,
        values: raw.values as string[],
        labels: raw.labels as string[],
      }
    }
    default:
      return null
  }
}

export function parseFilterState(raw: unknown): FilterState | null {
  if (!isRecord(raw)) return null
  const out: FilterState = {}
  for (const [key, value] of Object.entries(raw)) {
    const col = parseColumnFilter(value)
    if (col) out[key] = col
  }
  return out
}

/** sort 编码：升序 `column`，降序 `-column`，显式无排序 `none` */
export function encodeSort(sort: SortState | null, defaultSort: SortState | null): string | undefined {
  if (sort == null) {
    // 有默认排序时，显式清除必须写入 none，否则刷新会回到 defaultSort
    return defaultSort != null ? SORT_NONE : undefined
  }
  if (
    defaultSort &&
    sort.column === defaultSort.column &&
    sort.direction === defaultSort.direction
  ) {
    return undefined
  }
  return sort.direction === 'descending' ? `-${sort.column}` : sort.column
}

export function parseSort(raw: unknown, defaultSort: SortState | null): SortState | null {
  if (raw == null || raw === '') return defaultSort
  if (typeof raw !== 'string') return defaultSort
  if (raw === SORT_NONE) return null
  if (raw.startsWith('-') && raw.length > 1) {
    return { column: raw.slice(1), direction: 'descending' }
  }
  return { column: raw, direction: 'ascending' }
}

export function parsePage(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) return Math.floor(raw)
  if (typeof raw === 'string' && raw !== '') {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 1) return Math.floor(n)
  }
  return DEFAULT_PAGE
}

export function parsePageSize(raw: unknown, fallback: number = DEFAULT_PAGE_SIZE): number {
  const allowed = new Set([10, 20, 50, 100])
  if (typeof raw === 'number' && allowed.has(raw)) return raw
  if (typeof raw === 'string' && raw !== '') {
    const n = Number(raw)
    if (allowed.has(n)) return n
  }
  return fallback
}

/**
 * 从当前 search 对象解析网格状态。
 * - f 缺席 → defaultFilters（如 entries 下钻 defaultFilters）
 * - f 在场（含 `{}`）→ 以解析结果为准，支持用户清空后刷新仍为空
 */
export function parseGridUrlSearch(
  search: Record<string, unknown>,
  defaults: GridUrlDefaults,
): GridUrlState {
  const pageSizeDefault = defaults.pageSize ?? DEFAULT_PAGE_SIZE
  let filters: FilterState = defaults.filters
  if ('f' in search && search.f !== undefined && search.f !== null && search.f !== '') {
    let raw: unknown = search.f
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw) as unknown
      } catch {
        raw = null
      }
    }
    const parsed = parseFilterState(raw)
    filters = parsed ?? defaults.filters
  }

  const q = search.q
  return {
    search: typeof q === 'string' ? q : q == null ? '' : String(q),
    page: parsePage(search.page),
    pageSize: parsePageSize(search.ps, pageSizeDefault),
    sort: parseSort(search.sort, defaults.sort),
    filters,
  }
}

/**
 * 把网格状态编码为「要写入 search 的补丁」。
 * 值为 `undefined` 表示删除该键（保持无参 URL 干净）。
 * 调用方对整包 GRID_URL_KEYS 应用补丁，并保留其它未知参数。
 */
export function encodeGridUrlPatch(
  state: GridUrlState,
  defaults: GridUrlDefaults,
): Record<GridUrlKey, string | number | undefined> {
  const pageSizeDefault = defaults.pageSize ?? DEFAULT_PAGE_SIZE
  const sortEnc = encodeSort(state.sort, defaults.sort)

  let f: string | undefined
  const filtersEmpty = Object.keys(state.filters).length === 0
  const defaultsEmpty = Object.keys(defaults.filters).length === 0
  if (filtersEmpty && defaultsEmpty) {
    f = undefined
  } else if (filtersEmpty && !defaultsEmpty) {
    // 显式清空（有 defaultFilters 的场景，如报表下钻）
    f = '{}'
  } else {
    f = JSON.stringify(state.filters)
  }

  return {
    q: state.search.trim() === '' ? undefined : state.search,
    page: state.page === DEFAULT_PAGE ? undefined : state.page,
    ps: state.pageSize === pageSizeDefault ? undefined : state.pageSize,
    sort: sortEnc,
    f,
  }
}

/**
 * 将网格补丁合并进既有 search：只动 GRID_URL_KEYS，其它键原样保留。
 * 供 navigate({ search: old => mergeGridUrlSearch(old, patch) }) 使用。
 */
export function mergeGridUrlSearch(
  prev: Record<string, unknown>,
  patch: Record<GridUrlKey, string | number | undefined>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...prev }
  for (const key of GRID_URL_KEYS) {
    const value = patch[key]
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next
}
