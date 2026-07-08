import type { FilterState, GridColumnMeta, SortState } from './types'

/** camelCase → SNAKE 大写(AshGraphql sort field 枚举值) */
export function toSortField(column: string): string {
  return column.replace(/([A-Z])/g, '_$1').toUpperCase()
}

export function toSortLiteral(sort: SortState | null): string | null {
  if (!sort) return null
  return `[{field: ${toSortField(sort.column)}, order: ${sort.direction === 'descending' ? 'DESC' : 'ASC'}}]`
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

export function buildRowQuery(
  resource: string,
  columns: GridColumnMeta[],
  opts: { limit: number; offset: number; sortLiteral: string | null; filterLiteral: string | null }
): string {
  const names = columns.map((c) => c.name)
  const fields = (names.includes('id') ? names : ['id', ...names]).join(' ')
  const args = [`limit: ${opts.limit}`, `offset: ${opts.offset}`]
  if (opts.sortLiteral) args.push(`sort: ${opts.sortLiteral}`)
  if (opts.filterLiteral) args.push(`filter: ${opts.filterLiteral}`)
  return `query { ${resource}(${args.join(', ')}) { count results { ${fields} } } }`
}
