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

function columnClause(name: string, filter: FilterState[string], columns: GridColumnMeta[]): string | null {
  const col = columns.find((c) => c.name === name)
  if (!col) return null
  switch (filter.kind) {
    case 'text':
      return filter.contains ? `{${name}: {contains: ${str(filter.contains)}}}` : null
    case 'bool':
      return `{${name}: {eq: ${filter.eq}}}`
    case 'enum': {
      // AshGraphql 枚举字面量为大写 token,不带引号;先按 enumOptions 白名单过滤,防止任意串裸拼进查询
      const allowed = filter.values.filter((v) => col.enumOptions?.some((o) => o.value === v))
      return allowed.length > 0
        ? `{${name}: {in: [${allowed.map((v) => v.toUpperCase()).join(', ')}]}}`
        : null
    }
    case 'range': {
      const parts: string[] = []
      const numeric = col.type === 'integer' || col.type === 'decimal'
      // 数值列不带引号内联,须 Number.isFinite 校验;非法值跳过该端,两端都非法则整个子句为 null
      const valid = (v: string) => !numeric || Number.isFinite(Number(v))
      const lit = (v: string) => (numeric ? v : str(v))
      if (filter.gte && valid(filter.gte)) parts.push(`greaterThanOrEqual: ${lit(filter.gte)}`)
      if (filter.lte && valid(filter.lte)) parts.push(`lessThanOrEqual: ${lit(filter.lte)}`)
      return parts.length > 0 ? `{${name}: {${parts.join(', ')}}}` : null
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
