import type { FilterState, ListQuery } from '@synie/shared'
import { RESOURCE_MANIFEST } from '@synie/shared/generated/resource-manifest'
import type { ResourceQuery } from './types'

export interface ResourceListWireOptions {
  /** 报错时使用的业务资源名称。 */
  readonly resourceLabel?: string
  /** 默认 merge；reject 用于不接受受信 fixedFilter 的 endpoint。 */
  readonly fixedFilter?: 'merge' | 'reject'
  /** 默认沿用旧行为忽略；strict endpoint 可显式 reject。 */
  readonly extraFields?: 'ignore' | 'reject'
  /** 默认沿用旧行为忽略；strict endpoint 可显式 reject。 */
  readonly joinFields?: 'ignore' | 'reject'
}

function unsupportedQueryParts(
  input: ResourceQuery,
  options: ResourceListWireOptions,
): string[] {
  const parts: string[] = []
  if (options.fixedFilter === 'reject' && input.fixedFilter) {
    parts.push('fixedFilter')
  }
  if (
    options.extraFields === 'reject' &&
    (input.extraFields?.length ?? 0) > 0
  ) {
    parts.push('extraFields')
  }
  if (options.joinFields === 'reject' && input.joinFields) {
    parts.push('joinFields')
  }
  return parts
}

/**
 * ResourceQuery → REST ListQuery 的唯一 implementation。
 *
 * 默认把页面筛选与受信 fixedFilter 合并；extraFields/joinFields 不属于当前 ListQuery
 * wire contract，旧 endpoint 默认忽略，严格 endpoint 可选择 fail-closed。
 */
export function resourceListBody(
  input: ResourceQuery,
  options: ResourceListWireOptions = {},
): ListQuery {
  const unsupported = unsupportedQueryParts(input, options)
  if (unsupported.length > 0) {
    const label = options.resourceLabel ?? '该'
    throw new Error(
      `${label} REST 资源不支持 ${unsupported.join('、')}`,
    )
  }

  const filter: FilterState =
    options.fixedFilter === 'reject'
      ? (input.filter ?? {})
      : {
          ...(input.filter ?? {}),
          ...((input.fixedFilter ?? {}) as FilterState),
        }

  return {
    limit: input.limit,
    offset: input.offset,
    search: input.search || undefined,
    sort: input.sort ?? undefined,
    filter,
  }
}

/**
 * 完全不支持 ResourceQuery 扩展维度的 endpoint：只接受标准 ListQuery。
 */
export function strictResourceListBody(
  input: ResourceQuery,
  resourceLabel: string,
): ListQuery {
  return resourceListBody(input, {
    resourceLabel,
    fixedFilter: 'reject',
    extraFields: 'reject',
    joinFields: 'reject',
  })
}

export interface DecimalWireOptions {
  /** 空值的 wire 口径；普通 decimal 默认 null，借贷金额等可指定 '0'。 */
  readonly empty?: null | '0'
}

/**
 * 把指定字段收口为 decimal wire string。未出现的字段保持 absent，便于 PATCH。
 */
export function decimalWireInput(
  input: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  options: DecimalWireOptions = {},
): Record<string, unknown> {
  const result = { ...input }
  const empty = options.empty ?? null
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) continue
    const value = input[field]
    result[field] = value == null || value === '' ? empty : String(value)
  }
  return result
}

/** 日期选择器的 YYYY-MM-DD 值转为服务端 datetime wire；其他值原样保留。 */
export function dateTimeWireValue(value: unknown): unknown {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T00:00:00Z`
  }
  return value
}

/** 对指定日期字段应用 dateTimeWireValue；未出现的字段保持 absent。 */
export function dateTimeWireInput(
  input: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Record<string, unknown> {
  const result = { ...input }
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) continue
    result[field] = dateTimeWireValue(input[field])
  }
  return result
}

/**
 * 按资源事实清单（ADR 2026-08-07-resource-manifest）编码写体：
 * decimal 出现的键收口为 wire string（decimalZero 成员空值发 '0'，其余空值发 null），
 * date/datetime 出现的 YYYY-MM-DD 键转 ISO datetime。只对输入里出现的键生效；
 * 资源不在清单（custom/in-memory 局部读模型等）时原样返回。
 */
export function encodeResourceWrite(
  resource: string,
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const wire = RESOURCE_MANIFEST[resource]?.wire
  if (!wire) return input
  const decimal = new Set(wire.decimal)
  const decimalZero = new Set(wire.decimalZero)
  const date = new Set(wire.date)
  let body: Record<string, unknown> | null = null
  for (const key of Object.keys(input)) {
    let value = input[key]
    if (decimal.has(key)) {
      value = value == null || value === '' ? (decimalZero.has(key) ? '0' : null) : String(value)
    } else if (date.has(key)) {
      value = dateTimeWireValue(value)
    }
    if (value !== input[key]) {
      body ??= { ...input }
      body[key] = value
    }
  }
  return body ?? input
}
