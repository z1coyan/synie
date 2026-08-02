/**
 * 数据网格状态 ↔ URL search params 编解码。
 *
 * 约定（与 url-record-drawer / route-loader-prefetch 共存）:
 * - 本模块只读写自有键 q/page/ps/sort/f，更新一律函数式 merge，绝不整包替换。
 * - 无参访问时全部键省略，行为与「组件内 useState 默认值」一致。
 * - `f` 用紧凑 DSL；旧 JSON 书签仍可读。
 *
 * DSL 示例:
 *   物料编号含 1          → f=code~1
 *   多条件                 → f=code~1;active~b~1;status~e~DRAFT,AUDITED
 *   外键                   → f=companyId~f~u1:甲公司
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

// ---------------------------------------------------------------------------
// 紧凑 filter DSL
//
// 字段条目用 `;` 连接。每条 `field~clause`:
//   field~value                    text contains（默认、最短）
//   field~c|nc|eq|ne~value         text 显式 op
//   field~b~0|1                    bool
//   field~e~v1,v2                  enum
//   field~a|na~v1,v2               enumArray hasAny / notHas
//   field~n|ngt|nlt|ngte|nlte~v    number 单值
//   field~nb~gte,lte                number between（端可空）
//   field~d|db|da~value            date eq / before / after
//   field~dr~gte,lte                date between
//   field~f~id:label,...           fk in（label 可空）
//   field~fn                       fk isNil
//   field~p~VARIANT~id:label,...   polyFk in
//   field~pn                       polyFk isNil
//
// 值内特殊字符 ~ ; , : \ 用反斜杠转义。
// ---------------------------------------------------------------------------

const TEXT_OP_MAP = {
  c: 'contains',
  nc: 'notContains',
  eq: 'eq',
  ne: 'notEq',
} as const

type TextOpCode = keyof typeof TEXT_OP_MAP
const TEXT_OP_REV: Record<string, TextOpCode> = {
  contains: 'c',
  notContains: 'nc',
  eq: 'eq',
  notEq: 'ne',
}

const NUM_OP_MAP = {
  n: 'eq',
  ngt: 'gt',
  nlt: 'lt',
  ngte: 'gte',
  nlte: 'lte',
} as const
type NumOpCode = keyof typeof NUM_OP_MAP
const NUM_OP_REV: Record<string, NumOpCode> = {
  eq: 'n',
  gt: 'ngt',
  lt: 'nlt',
  gte: 'ngte',
  lte: 'nlte',
}

/** 转义 DSL 原子串（字段名 / 文本值 / enum 成员 / id / label） */
export function escapeFilterAtom(s: string): string {
  return s.replace(/[\\~;,:]/g, (ch) => `\\${ch}`)
}

/** 解转义 */
export function unescapeFilterAtom(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      out += s[i + 1]
      i++
    } else {
      out += s[i]
    }
  }
  return out
}

/** 按未转义分隔符切分（`\\sep` 不切开） */
export function splitUnescaped(s: string, sep: string): string[] {
  const parts: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      cur += s[i] + s[i + 1]
      i++
      continue
    }
    if (s[i] === sep) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += s[i]
  }
  parts.push(cur)
  return parts
}

function encodeIdLabels(values: string[], labels: string[]): string {
  const n = Math.max(values.length, labels.length)
  const parts: string[] = []
  for (let i = 0; i < n; i++) {
    const id = escapeFilterAtom(values[i] ?? '')
    const label = escapeFilterAtom(labels[i] ?? '')
    parts.push(label === '' ? id : `${id}:${label}`)
  }
  return parts.join(',')
}

function parseIdLabels(raw: string): { values: string[]; labels: string[] } {
  if (raw === '') return { values: [], labels: [] }
  const values: string[] = []
  const labels: string[] = []
  for (const item of splitUnescaped(raw, ',')) {
    const pair = splitUnescaped(item, ':')
    if (pair.length === 1) {
      const v = unescapeFilterAtom(pair[0]!)
      values.push(v)
      labels.push(v)
    } else {
      values.push(unescapeFilterAtom(pair[0]!))
      labels.push(unescapeFilterAtom(pair.slice(1).join(':')))
    }
  }
  return { values, labels }
}

function encodeList(values: string[]): string {
  return values.map(escapeFilterAtom).join(',')
}

function parseList(raw: string): string[] {
  if (raw === '') return []
  return splitUnescaped(raw, ',').map(unescapeFilterAtom)
}

function parseRange(raw: string): { gte?: string; lte?: string } {
  const range = splitUnescaped(raw, ',')
  const gteRaw = range[0] ?? ''
  const lteRaw = range.length > 1 ? range.slice(1).join(',') : ''
  return {
    gte: gteRaw === '' ? undefined : unescapeFilterAtom(gteRaw),
    lte: lteRaw === '' ? undefined : unescapeFilterAtom(lteRaw),
  }
}

/** 单条 ColumnFilter → clause（`field~` 右侧） */
export function encodeColumnFilterCompact(filter: ColumnFilter): string {
  switch (filter.kind) {
    case 'text':
      // contains 省略 op：code~1
      if (filter.op === 'contains') return escapeFilterAtom(filter.value)
      return `${TEXT_OP_REV[filter.op]}~${escapeFilterAtom(filter.value)}`
    case 'bool':
      return `b~${filter.eq ? '1' : '0'}`
    case 'enum':
      return `e~${encodeList(filter.values)}`
    case 'enumArray':
      return `${filter.op === 'hasAny' ? 'a' : 'na'}~${encodeList(filter.values)}`
    case 'number':
      if (filter.op === 'between') {
        const gte = filter.gte != null ? escapeFilterAtom(filter.gte) : ''
        const lte = filter.lte != null ? escapeFilterAtom(filter.lte) : ''
        return `nb~${gte},${lte}`
      }
      return `${NUM_OP_REV[filter.op]}~${escapeFilterAtom(filter.value)}`
    case 'date':
      if (filter.op === 'between') {
        const gte = filter.gte != null ? escapeFilterAtom(filter.gte) : ''
        const lte = filter.lte != null ? escapeFilterAtom(filter.lte) : ''
        return `dr~${gte},${lte}`
      }
      if (filter.op === 'before') return `db~${escapeFilterAtom(filter.value)}`
      if (filter.op === 'after') return `da~${escapeFilterAtom(filter.value)}`
      return `d~${escapeFilterAtom(filter.value)}`
    case 'fk':
      if (filter.op === 'isNil') return 'fn'
      return `f~${encodeIdLabels(filter.values, filter.labels)}`
    case 'polyFk':
      if (filter.op === 'isNil') return 'pn'
      return `p~${escapeFilterAtom(filter.variant)}~${encodeIdLabels(filter.values, filter.labels)}`
  }
}

/** 解析 clause → ColumnFilter；非法返回 null */
export function parseColumnFilterCompact(clause: string): ColumnFilter | null {
  const parts = splitUnescaped(clause, '~')
  if (parts.length === 0) return null

  // 单段：fn / pn / text contains
  if (parts.length === 1) {
    const token = parts[0]!
    if (token === 'fn') return { kind: 'fk', op: 'isNil', values: [], labels: [] }
    if (token === 'pn') return { kind: 'polyFk', op: 'isNil' }
    if (token === '') return null
    return { kind: 'text', op: 'contains', value: unescapeFilterAtom(token) }
  }

  const head = parts[0]!

  if (head in TEXT_OP_MAP && parts.length === 2) {
    return {
      kind: 'text',
      op: TEXT_OP_MAP[head as TextOpCode],
      value: unescapeFilterAtom(parts[1]!),
    }
  }

  if (head === 'b' && parts.length === 2) {
    if (parts[1] === '1') return { kind: 'bool', eq: true }
    if (parts[1] === '0') return { kind: 'bool', eq: false }
    return null
  }

  if (head === 'e' && parts.length === 2) {
    return { kind: 'enum', values: parseList(parts[1]!) }
  }

  if ((head === 'a' || head === 'na') && parts.length === 2) {
    return {
      kind: 'enumArray',
      op: head === 'a' ? 'hasAny' : 'notHas',
      values: parseList(parts[1]!),
    }
  }

  if (head in NUM_OP_MAP && parts.length === 2) {
    return {
      kind: 'number',
      op: NUM_OP_MAP[head as NumOpCode],
      value: unescapeFilterAtom(parts[1]!),
    }
  }

  if (head === 'nb' && parts.length === 2) {
    const { gte, lte } = parseRange(parts[1]!)
    return { kind: 'number', op: 'between', gte, lte }
  }

  if ((head === 'd' || head === 'db' || head === 'da') && parts.length === 2) {
    const value = unescapeFilterAtom(parts[1]!)
    if (head === 'db') return { kind: 'date', op: 'before', value }
    if (head === 'da') return { kind: 'date', op: 'after', value }
    return { kind: 'date', op: 'eq', value }
  }

  if (head === 'dr' && parts.length === 2) {
    const { gte, lte } = parseRange(parts[1]!)
    return { kind: 'date', op: 'between', gte, lte }
  }

  if (head === 'f' && parts.length === 2) {
    const { values, labels } = parseIdLabels(parts[1]!)
    return { kind: 'fk', values, labels }
  }

  if (head === 'p' && parts.length === 3) {
    const { values, labels } = parseIdLabels(parts[2]!)
    return {
      kind: 'polyFk',
      op: 'in',
      variant: unescapeFilterAtom(parts[1]!),
      values,
      labels,
    }
  }

  return null
}

/** FilterState → 紧凑 DSL 字符串；空对象返回 '' */
export function encodeFiltersCompact(filters: FilterState): string {
  const parts: string[] = []
  for (const [field, filter] of Object.entries(filters)) {
    parts.push(`${escapeFilterAtom(field)}~${encodeColumnFilterCompact(filter)}`)
  }
  return parts.join(';')
}

/** 紧凑 DSL → FilterState；跳过非法条目，始终返回对象（调用方以「f 是否在场」区分缺省） */
export function parseFiltersCompact(raw: string): FilterState {
  if (raw === '') return {}
  const out: FilterState = {}
  for (const entry of splitUnescaped(raw, ';')) {
    if (entry === '') continue
    const segs = splitUnescaped(entry, '~')
    if (segs.length < 2) continue
    const field = unescapeFilterAtom(segs[0]!)
    if (field === '') continue
    // clause 可能含未转义的 ~（op 分隔）；用 slice(1).join 还原
    const clause = segs.slice(1).join('~')
    const col = parseColumnFilterCompact(clause)
    if (col) out[field] = col
  }
  return out
}

/** 宽松校验 ColumnFilter（JSON 形态）；非法结构丢弃该列 */
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
        if (raw.gte != null && typeof raw.gte !== 'string') return null
        if (raw.lte != null && typeof raw.lte !== 'string') return null
        return {
          kind: 'number',
          op: 'between',
          gte: typeof raw.gte === 'string' ? raw.gte : undefined,
          lte: typeof raw.lte === 'string' ? raw.lte : undefined,
        }
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

/**
 * 解析 f 参数：优先紧凑 DSL；以 `{` 开头则走旧 JSON（书签兼容）。
 * 返回 null 表示整串无法解析（仅 JSON 坏串）。
 */
export function parseFiltersParam(raw: unknown): FilterState | null {
  if (raw == null || raw === '') return {}
  if (isRecord(raw)) return parseFilterState(raw)
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === '{}') return {}
  if (trimmed.startsWith('{')) {
    try {
      return parseFilterState(JSON.parse(trimmed) as unknown)
    } catch {
      return null
    }
  }
  return parseFiltersCompact(trimmed)
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
 * - f 在场（含 `{}` / 空紧凑串）→ 以解析结果为准，支持用户清空后刷新仍为空
 */
export function parseGridUrlSearch(
  search: Record<string, unknown>,
  defaults: GridUrlDefaults,
): GridUrlState {
  const pageSizeDefault = defaults.pageSize ?? DEFAULT_PAGE_SIZE
  let filters: FilterState = defaults.filters
  if ('f' in search && search.f !== undefined && search.f !== null && search.f !== '') {
    const parsed = parseFiltersParam(search.f)
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
    f = encodeFiltersCompact(state.filters)
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
