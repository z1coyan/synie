import type { FilterState, GridColumnMeta, SortState } from './types'

/** 手拼查询字面量的 uuid 白名单(fk 筛选/回显反查共用):非法串一律剔除,防注入 */
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** camelCase → SNAKE 大写(AshGraphql sort field 枚举值) */
export function toSortField(column: string): string {
  return column.replace(/([A-Z])/g, '_$1').toUpperCase()
}

export function toSortLiteral(sort: SortState | null): string | null {
  if (!sort) return null
  return `[{field: ${toSortField(sort.column)}, order: ${sort.direction === 'descending' ? 'DESC' : 'ASC'}}]`
}

/** 表头点击三态循环:RAC 原生只在顺/逆序间切换,同列逆序后再点(回绕成顺序)视为第三态「取消排序」 */
export function nextSort(prev: SortState | null, column: string, direction: SortState['direction']): SortState | null {
  if (prev && prev.column === column && prev.direction === 'descending' && direction === 'ascending') return null
  return { column, direction }
}

const str = (v: string) => JSON.stringify(v)

// 数值不带引号内联,过 Number() 归一化再转回字符串:封掉 "0x10"/" 10 " 等 Number 可解析但 GraphQL 字面量非法的写法;非法值返回 null
const numLit = (v: string) => (Number.isFinite(Number(v)) ? String(Number(v)) : null)

// datetime 列存的是 UTC 瞬时,筛选值是本地日期 YYYY-MM-DD:取本地日界转 ISO
export const dayStart = (d: string) => new Date(`${d}T00:00:00`).toISOString()
export const dayEnd = (d: string) => new Date(`${d}T23:59:59.999`).toISOString()

function columnClause(name: string, filter: FilterState[string], columns: GridColumnMeta[]): string | null {
  const col = columns.find((c) => c.name === name)
  if (!col) return null
  switch (filter.kind) {
    case 'text': {
      if (!filter.value) return null
      const v = str(filter.value)
      switch (filter.op) {
        case 'contains':
          return `{${name}: {contains: ${v}}}`
        // AshGraphql 无 notContains 操作符,用 not 组合子包 contains
        case 'notContains':
          return `{not: [{${name}: {contains: ${v}}}]}`
        case 'eq':
          return `{${name}: {eq: ${v}}}`
        case 'notEq':
          return `{${name}: {notEq: ${v}}}`
      }
      break
    }
    case 'bool':
      return `{${name}: {eq: ${filter.eq}}}`
    case 'enum': {
      // AshGraphql 枚举字面量为大写 token,不带引号;先按 enumOptions 白名单过滤,防止任意串裸拼进查询
      const allowed = filter.values.filter((v) => col.enumOptions?.some((o) => o.value === v))
      return allowed.length > 0
        ? `{${name}: {in: [${allowed.map((v) => v.toUpperCase()).join(', ')}]}}`
        : null
    }
    case 'fk': {
      const ids = filter.values.filter((v) => UUID_RE.test(v))
      return ids.length > 0 ? `{${name}: {in: [${ids.map(str).join(', ')}]}}` : null
    }
    case 'polyFk': {
      const disc = col.ref?.discriminator
      if (!disc) return null
      if (filter.op === 'isNil') return `{${name}: {isNil: true}}`
      // 变体 token 裸拼进查询(枚举字面量不带引号),按 variants 白名单校验,同 enum 分支纪律
      if (!col.ref?.variants?.some((v) => v.value === filter.variant)) return null
      const ids = filter.values.filter((v) => UUID_RE.test(v))
      if (ids.length === 0) return null
      return `{and: [{${disc}: {eq: ${filter.variant}}}, {${name}: {in: [${ids.map(str).join(', ')}]}}]}`
    }
    case 'number': {
      if (filter.op === 'between') {
        const parts: string[] = []
        const g = filter.gte ? numLit(filter.gte) : null
        const l = filter.lte ? numLit(filter.lte) : null
        if (g !== null) parts.push(`greaterThanOrEqual: ${g}`)
        if (l !== null) parts.push(`lessThanOrEqual: ${l}`)
        return parts.length > 0 ? `{${name}: {${parts.join(', ')}}}` : null
      }
      const v = filter.value ? numLit(filter.value) : null
      if (v === null) return null
      const field = { eq: 'eq', gt: 'greaterThan', lt: 'lessThan', gte: 'greaterThanOrEqual', lte: 'lessThanOrEqual' }[filter.op]
      return `{${name}: {${field}: ${v}}}`
    }
    case 'date': {
      const dt = col.type === 'datetime'
      // date 列直接比日期字符串;datetime 列把日期换算成当天的起止瞬时
      const lo = (v: string) => str(dt ? dayStart(v) : v)
      const hi = (v: string) => str(dt ? dayEnd(v) : v)
      if (filter.op === 'between') {
        const parts: string[] = []
        if (filter.gte) parts.push(`greaterThanOrEqual: ${lo(filter.gte)}`)
        if (filter.lte) parts.push(`lessThanOrEqual: ${hi(filter.lte)}`)
        return parts.length > 0 ? `{${name}: {${parts.join(', ')}}}` : null
      }
      if (!filter.value) return null
      switch (filter.op) {
        case 'eq':
          return dt
            ? `{${name}: {greaterThanOrEqual: ${lo(filter.value)}, lessThanOrEqual: ${hi(filter.value)}}}`
            : `{${name}: {eq: ${str(filter.value)}}}`
        case 'before':
          return `{${name}: {lessThan: ${lo(filter.value)}}}`
        case 'after':
          return `{${name}: {greaterThan: ${hi(filter.value)}}}`
      }
    }
  }
}

export function buildFilterLiteral(
  filters: FilterState,
  search: string,
  columns: GridColumnMeta[]
): string | null {
  const clauses = Object.entries(filters)
    .map(([name, f]) => columnClause(name, f, columns))
    .filter((c): c is string => c !== null)

  const trimmed = search.trim()
  if (trimmed) {
    const searchable = columns.filter((c) => c.filterable && c.type === 'string' && c.name !== 'id')
    if (searchable.length > 0) {
      const ors = searchable.map((c) => `{${c.name}: {contains: ${str(trimmed)}}}`)
      clauses.push(`{or: [${ors.join(', ')}]}`)
    }
  }

  if (clauses.length === 0) return null
  if (clauses.length === 1) return clauses[0]
  return `{and: [${clauses.join(', ')}]}`
}

/** JS 对象 → GraphQL 输入字面量(键不带引号)。只用于组件 props 传入的受信条件(fixedFilter),字符串值经 JSON 转义 */
export function toGqlLiteral(value: unknown): string {
  if (value == null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(toGqlLiteral).join(', ')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${toGqlLiteral(v)}`)
    .join(', ')}}`
}

/** 多个 filter 字面量按 and 合并;null/空项剔除,全空返回 null */
export function mergeFilterLiterals(literals: (string | null)[]): string | null {
  const parts = literals.filter((l): l is string => !!l)
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]
  return `{and: [${parts.join(', ')}]}`
}

export function buildRowQuery(
  resource: string,
  columns: GridColumnMeta[],
  opts: { limit: number; offset: number; sortLiteral: string | null; filterLiteral: string | null; extraFields?: string[] }
): string {
  const names = columns.map((c) => c.name)
  // extraFields:列以外还要取回的标量字段(树形模式的 parentId/childrenCount),Set 去重
  const scalar = [...new Set(['id', ...names, ...(opts.extraFields ?? [])])]
  // fk 列带 join:relation { id labelField },单元格/详情显示 label 零额外请求;多态 fk 无 relation 可 join
  const joins = columns.filter((c) => c.ref?.relation).map((c) => `${c.ref!.relation} { id ${c.ref!.labelField} }`)
  const fields = [...scalar, ...joins].join(' ')
  const args = [`limit: ${opts.limit}`, `offset: ${opts.offset}`]
  if (opts.sortLiteral) args.push(`sort: ${opts.sortLiteral}`)
  if (opts.filterLiteral) args.push(`filter: ${opts.filterLiteral}`)
  return `query { ${resource}(${args.join(', ')}) { count results { ${fields} } } }`
}
