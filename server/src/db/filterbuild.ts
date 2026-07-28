import { sql, type RawBuilder } from 'kysely'
import { decimal, isDecimalString, type ListQuery } from '@synie/shared'
import { ApiError } from '~/platform/http/errors.ts'
import type { FieldMeta, ResourceMeta } from '~/platform/meta/types.ts'

/**
 * 列表筛选构建器（Filter DSL v1 → 参数化 SQL 片段，KD20/KD27）。
 *
 * 安全纪律（与 server-go filterbuild 一致）：
 * - 列名只来自 Meta 注册（启动期已校验标识符合法），用户输入永远进参数位
 * - 未知字段 / kind 与字段类型不匹配 / 未知枚举值 → 400 validation
 *
 * 输出为 Kysely 表达式（不含 WHERE/ORDER BY 关键字），消费方式：
 *   const built = buildListQuery(resource, query)
 *   let q = db.selectFrom(resource.table).select(...)
 *   if (built.where) q = q.where(built.where)
 *   if (built.orderBy) q = q.orderBy(built.orderBy)
 */
export interface BuiltListQuery {
  where: RawBuilder<unknown> | null
  orderBy: RawBuilder<unknown> | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function buildListQuery(resource: ResourceMeta, query: ListQuery): BuiltListQuery {
  const byApi = new Map(resource.fields.map((field) => [field.apiName, field]))
  const parts: RawBuilder<unknown>[] = []

  const filter = query.filter ?? {}
  for (const key of Object.keys(filter).sort()) {
    const field = byApi.get(key)
    if (!field || !field.filterable) {
      throw validation(key, '未知或不可筛选的字段')
    }
    const part = buildColumnFilter(field, filter[key]!, byApi)
    if (part) parts.push(part)
  }

  const search = query.search?.trim()
  if (search) {
    if (search.length > 256) throw validation('search', '最多 256 个字符')
    const escaped = escapeLike(search)
    const searchParts = resource.fields
      .filter((field) => field.filterable && field.type === 'string')
      .map((field) => sql`${column(field)} ILIKE '%' || ${escaped} || '%' ESCAPE '\\'`)
    if (searchParts.length > 0) {
      parts.push(sql`(${sql.join(searchParts, sql` OR `)})`)
    }
  }

  return {
    where: parts.length > 0 ? sql.join(parts, sql` AND `) : null,
    orderBy: buildOrderBy(query, byApi),
  }
}

function buildColumnFilter(
  field: FieldMeta,
  filter: NonNullable<ListQuery['filter']>[string],
  byApi: Map<string, FieldMeta>,
): RawBuilder<unknown> | null {
  switch (filter.kind) {
    case 'text': {
      if (field.type !== 'string') throw kindMismatch(field, filter.kind)
      return buildText(field, filter.op, filter.value)
    }
    case 'bool': {
      if (field.type !== 'boolean') throw kindMismatch(field, filter.kind)
      return sql`${column(field)} = ${filter.eq}`
    }
    case 'enum': {
      if (field.type !== 'enum') throw kindMismatch(field, filter.kind)
      const values = enumValues(field, requireStringArray(field, filter.values))
      if (values.length === 0) return null
      return sql`${column(field)} = ANY(${values}::text[])`
    }
    case 'enumArray': {
      if (field.type !== 'enumArray') throw kindMismatch(field, filter.kind)
      const values = enumValues(field, requireStringArray(field, filter.values))
      if (values.length === 0) return null
      const expr = sql`${column(field)} && ${values}::text[]`
      return filter.op === 'notHas' ? sql`NOT (${expr})` : expr
    }
    case 'number': {
      if (field.type !== 'integer' && field.type !== 'decimal') throw kindMismatch(field, filter.kind)
      return buildNumber(field, filter)
    }
    case 'date': {
      if (field.type !== 'date' && field.type !== 'datetime') throw kindMismatch(field, filter.kind)
      return buildDate(field, filter)
    }
    case 'fk': {
      if (field.type !== 'fk' && field.type !== 'uuid') throw kindMismatch(field, filter.kind)
      if (filter.op === 'isNil') return sql`${column(field)} IS NULL`
      // 缺 values / 非数组不得 500：契约为 values[]（见 @synie/shared Filter DSL）
      const values = uuidValues(field, requireStringArray(field, filter.values))
      if (values.length === 0) return null
      return sql`${column(field)}::text = ANY(${values}::text[])`
    }
    case 'polyFk': {
      if (!field.ref?.discriminator) throw kindMismatch(field, filter.kind)
      return buildPolyFk(field, filter, byApi)
    }
    default:
      throw validation(field.apiName, '未知筛选 kind')
  }
}

function buildText(field: FieldMeta, op: string, value: string): RawBuilder<unknown> | null {
  if (value === '') return null
  const col = column(field)
  switch (op) {
    case 'contains':
      return sql`${col} ILIKE '%' || ${escapeLike(value)} || '%' ESCAPE '\\'`
    case 'notContains':
      return sql`NOT (${col} ILIKE '%' || ${escapeLike(value)} || '%' ESCAPE '\\')`
    case 'eq':
      return sql`${col} = ${value}`
    case 'notEq':
      return sql`${col} <> ${value}`
    default:
      throw validation(field.apiName, '文本 op 仅支持 contains/notContains/eq/notEq')
  }
}

type NumberFilter = Extract<NonNullable<ListQuery['filter']>[string], { kind: 'number' }>

function buildNumber(field: FieldMeta, filter: NumberFilter): RawBuilder<unknown> | null {
  const col = column(field)
  if (filter.op === 'between') {
    const parts: RawBuilder<unknown>[] = []
    if (filter.gte !== undefined) parts.push(sql`${col} >= ${decimalValue(field, filter.gte)}::numeric`)
    if (filter.lte !== undefined) parts.push(sql`${col} <= ${decimalValue(field, filter.lte)}::numeric`)
    return parts.length > 0 ? sql.join(parts, sql` AND `) : null
  }
  const operator = { eq: '=', gt: '>', lt: '<', gte: '>=', lte: '<=' }[filter.op]
  if (!operator) throw validation(field.apiName, '数值 op 仅支持 eq/gt/lt/gte/lte/between')
  return sql`${col} ${sql.raw(operator)} ${decimalValue(field, filter.value)}::numeric`
}

type DateFilter = Extract<NonNullable<ListQuery['filter']>[string], { kind: 'date' }>

function buildDate(field: FieldMeta, filter: DateFilter): RawBuilder<unknown> | null {
  const col = column(field)
  const isDatetime = field.type === 'datetime'
  if (filter.op === 'between') {
    const parts: RawBuilder<unknown>[] = []
    if (filter.gte !== undefined) {
      parts.push(sql`${col} >= ${dateValue(field, filter.gte)}::date`)
    }
    if (filter.lte !== undefined) {
      const value = dateValue(field, filter.lte)
      parts.push(isDatetime ? sql`${col} < (${value}::date + INTERVAL '1 day')` : sql`${col} <= ${value}::date`)
    }
    return parts.length > 0 ? sql.join(parts, sql` AND `) : null
  }
  const value = dateValue(field, filter.value)
  switch (filter.op) {
    case 'eq':
      return isDatetime
        ? sql`(${col} >= ${value}::date AND ${col} < (${value}::date + INTERVAL '1 day'))`
        : sql`${col} = ${value}::date`
    case 'before':
      return sql`${col} < ${value}::date`
    case 'after':
      return isDatetime ? sql`${col} >= (${value}::date + INTERVAL '1 day')` : sql`${col} > ${value}::date`
    default:
      throw validation(field.apiName, '日期 op 仅支持 eq/before/after/between')
  }
}

type PolyFkFilter = Extract<NonNullable<ListQuery['filter']>[string], { kind: 'polyFk' }>

function buildPolyFk(
  field: FieldMeta,
  filter: PolyFkFilter,
  byApi: Map<string, FieldMeta>,
): RawBuilder<unknown> | null {
  if (filter.op === 'isNil') return sql`${column(field)} IS NULL`
  const variant = field.ref?.variants?.find((candidate) => candidate.value === filter.variant)
  if (!variant) throw validation(field.apiName, '未知多态外键变体')
  const values = uuidValues(field, requireStringArray(field, filter.values))
  if (values.length === 0) return null
  const discriminator = byApi.get(field.ref!.discriminator!)
  if (!discriminator) throw validation(field.apiName, 'Meta 缺少多态判别字段')
  return sql`(${column(discriminator)} = ${filter.variant.toLowerCase()} AND ${column(field)}::text = ANY(${values}::text[]))`
}

/** 筛选 DSL 的 values 必须是 string[]；缺失/非数组 → 400（禁止 TypeError 变 500） */
function requireStringArray(field: FieldMeta, values: unknown): string[] {
  if (values === undefined || values === null) {
    throw validation(field.apiName, 'values 必填（string 数组）')
  }
  if (!Array.isArray(values)) {
    throw validation(field.apiName, 'values 必须是字符串数组')
  }
  for (const item of values) {
    if (typeof item !== 'string') {
      throw validation(field.apiName, 'values 必须是字符串数组')
    }
  }
  return values
}

function buildOrderBy(query: ListQuery, byApi: Map<string, FieldMeta>): RawBuilder<unknown> | null {
  const sort = query.sort
  if (!sort) return null
  const field = byApi.get(sort.column)
  if (!field || !field.sortable) {
    throw validation('sort.column', '未知或不可排序的字段')
  }
  if (sort.direction !== 'ascending' && sort.direction !== 'descending') {
    throw validation('sort.direction', '仅支持 ascending/descending')
  }
  return sql`${column(field)} ${sql.raw(sort.direction === 'descending' ? 'DESC' : 'ASC')}`
}

function column(field: FieldMeta): RawBuilder<unknown> {
  // dbColumn 经 Registry 启动期标识符校验（^[a-z_][a-z0-9_]*$），用户输入不可能进入
  return sql.id(field.dbColumn)
}

/** 枚举 wire 值为大写 token，PostgreSQL 存储值为 lowercase；校验在 wire 值上完成后转存储值 */
function enumValues(field: FieldMeta, values: string[]): string[] {
  const allowed = new Set((field.enumOptions ?? []).map((option) => option.value))
  return values.map((value) => {
    if (!allowed.has(value)) throw validation(field.apiName, '包含未知枚举值')
    return value.toLowerCase()
  })
}

function uuidValues(field: FieldMeta, values: string[]): string[] {
  for (const value of values) {
    if (!UUID_RE.test(value)) throw validation(field.apiName, '包含无效 UUID')
  }
  return [...values]
}

function decimalValue(field: FieldMeta, value: string): string {
  if (!isDecimalString(value)) throw validation(field.apiName, '数值必须是十进制字符串')
  return decimal(value).toFixed()
}

function dateValue(field: FieldMeta, value: string): string {
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw validation(field.apiName, '日期必须是 YYYY-MM-DD')
  }
  return value
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

function validation(field: string, message: string): ApiError {
  return ApiError.validation('筛选条件错误', { [field]: [message] })
}

function kindMismatch(field: FieldMeta, kind: string): ApiError {
  return validation(field.apiName, `kind ${kind} 与字段类型 ${field.type} 不匹配`)
}
