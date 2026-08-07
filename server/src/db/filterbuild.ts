import { sql, type RawBuilder } from 'kysely'
import { decimal, isDecimalString, type ListQuery } from '@synie/shared'
import { ApiError } from '~/platform/http/errors.ts'
import { enumDbValue } from '~/platform/meta/enum-storage.ts'
import type { ResourceReadFieldSpec, ResourceReadSpec } from '~/platform/meta/read-spec.ts'

/**
 * 列表筛选构建器（Filter DSL v1 → 参数化 SQL 片段，KD20/KD27）。
 *
 * 安全纪律：
 * - 列名只来自 ResourceReadSpec 白名单（启动期已校验标识符合法），用户输入永远进参数位
 * - 未知字段 / kind 与字段类型不匹配 / 未知枚举值 → 400 validation
 * - 不接收完整 ResourceMeta / ResourceDefinition
 *
 * 输出为 Kysely 表达式（不含 WHERE/ORDER BY 关键字），消费方式：
 *   const built = buildListQuery(toReadSpec(resource), query)
 *   let q = db.selectFrom(...).select(...)
 *   if (built.where) q = q.where(built.where)
 *   if (built.orderBy) q = q.orderBy(built.orderBy)
 */
export interface BuiltListQuery {
  where: RawBuilder<unknown> | null
  orderBy: RawBuilder<unknown> | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function buildListQuery(spec: ResourceReadSpec, query: ListQuery): BuiltListQuery {
  const byApi = new Map(spec.fields.map((field) => [field.apiName, field]))
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
    const searchParts = spec.fields
      .filter((field) => field.searchable && field.type === 'string')
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
  field: ResourceReadFieldSpec,
  filter: NonNullable<ListQuery['filter']>[string],
  byApi: Map<string, ResourceReadFieldSpec>,
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
      const values = uuidValues(field, requireStringArray(field, filter.values))
      if (values.length === 0) return null
      return sql`${column(field)}::text = ANY(${values}::text[])`
    }
    case 'polyFk': {
      if (!field.discriminatorApiName) throw kindMismatch(field, filter.kind)
      return buildPolyFk(field, filter, byApi)
    }
    default:
      throw validation(field.apiName, '未知筛选 kind')
  }
}

function buildText(
  field: ResourceReadFieldSpec,
  op: string,
  value: string,
): RawBuilder<unknown> | null {
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

function buildNumber(
  field: ResourceReadFieldSpec,
  filter: NumberFilter,
): RawBuilder<unknown> | null {
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

function buildDate(field: ResourceReadFieldSpec, filter: DateFilter): RawBuilder<unknown> | null {
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
  field: ResourceReadFieldSpec,
  filter: PolyFkFilter,
  byApi: Map<string, ResourceReadFieldSpec>,
): RawBuilder<unknown> | null {
  if (filter.op === 'isNil') return sql`${column(field)} IS NULL`
  const variants = field.polyVariants ?? []
  if (!variants.includes(filter.variant)) throw validation(field.apiName, '未知多态外键变体')
  const values = uuidValues(field, requireStringArray(field, filter.values))
  if (values.length === 0) return null
  const discriminator = byApi.get(field.discriminatorApiName!)
  if (!discriminator) throw validation(field.apiName, 'Meta 缺少多态判别字段')
  // 判别列同为枚举：库内大小写随判别字段 enumStorage（缺省小写）
  return sql`(${column(discriminator)} = ${enumDbValue(discriminator.enumStorage, filter.variant)} AND ${column(field)}::text = ANY(${values}::text[]))`
}

function requireStringArray(field: ResourceReadFieldSpec, values: unknown): string[] {
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

function buildOrderBy(
  query: ListQuery,
  byApi: Map<string, ResourceReadFieldSpec>,
): RawBuilder<unknown> | null {
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

function column(field: ResourceReadFieldSpec): RawBuilder<unknown> {
  return sql.id(field.dbColumn)
}

function enumValues(field: ResourceReadFieldSpec, values: string[]): string[] {
  const allowed = new Set(field.enumValues ?? [])
  return values.map((value) => {
    if (!allowed.has(value)) throw validation(field.apiName, '包含未知枚举值')
    // 库内大小写随字段 enumStorage（写路径同款换算，见 enum-storage.ts）
    return enumDbValue(field.enumStorage, value)
  })
}

function uuidValues(field: ResourceReadFieldSpec, values: string[]): string[] {
  for (const value of values) {
    if (!UUID_RE.test(value)) throw validation(field.apiName, '包含无效 UUID')
  }
  return [...values]
}

function decimalValue(field: ResourceReadFieldSpec, value: string): string {
  if (!isDecimalString(value)) throw validation(field.apiName, '数值必须是十进制字符串')
  return decimal(value).toFixed()
}

function dateValue(field: ResourceReadFieldSpec, value: string): string {
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

function kindMismatch(field: ResourceReadFieldSpec, kind: string): ApiError {
  return validation(field.apiName, `kind ${kind} 与字段类型 ${field.type} 不匹配`)
}
