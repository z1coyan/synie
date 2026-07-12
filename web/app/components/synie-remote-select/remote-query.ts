import type { ReactNode } from 'react'
import { toSortField, UUID_RE } from '../synie-data-grid/query'
import type { GridColumnRef, Row } from '../synie-data-grid/types'

export interface RemoteSourceConfig {
  /** GridMeta 白名单资源名(即 GraphQL list query 名),如 "basCompanies" */
  resource: string
  /** 显示字段,默认 gridMeta ref.labelField,再兜底 'name' */
  labelField?: string
  /** 远程搜索 contains OR 字段,默认 [labelField] */
  searchFields?: string[]
  /** 固定过滤字面量,如 `{enabled: {eq: true}}` */
  filter?: string
  /** 额外取回字段(renderItem/renderValue 用) */
  fields?: string[]
  pageSize?: number
  /** 下拉项渲染,默认 label 单行 */
  renderItem?: (row: Row) => ReactNode
  /** 选中回填渲染,默认 label 文本/chip */
  renderValue?: (row: Row) => ReactNode
}

export interface ResolvedSource {
  resource: string
  labelField: string
  searchFields: string[]
  filter: string | null
  fields: string[]
  pageSize: number
}

/** gridMeta ref 提供默认,页面 config 覆盖;二者都无 resource 时 null(调用方退化 TextField) */
export function resolveSource(cfg: Partial<RemoteSourceConfig>, ref?: GridColumnRef | null): ResolvedSource | null {
  const resource = cfg.resource ?? ref?.resource
  if (!resource) return null
  const labelField = cfg.labelField ?? ref?.labelField ?? 'name'
  return {
    resource,
    labelField,
    searchFields: cfg.searchFields?.length ? cfg.searchFields : [labelField],
    filter: cfg.filter ?? null,
    fields: cfg.fields ?? [],
    pageSize: cfg.pageSize ?? 20,
  }
}

/** fk 目标解析:多态 fk 按行判别值选变体,普通 fk 取自身三件套;解析不了(变体被权限裁剪/判别值未知)为 null */
export function resolveFkTarget(ref: GridColumnRef, row: Row): { resource: string; labelField: string } | null {
  if (ref.discriminator) {
    const v = ref.variants?.find((x) => x.value === String(row[ref.discriminator!] ?? ''))
    return v ? { resource: v.resource, labelField: v.labelField } : null
  }
  return ref.resource ? { resource: ref.resource, labelField: ref.labelField ?? 'name' } : null
}

const selectionFields = (src: ResolvedSource): string => [...new Set(['id', src.labelField, ...src.fields])].join(' ')

/** 选项分页查询:labelField 升序稳定排序;搜索词 JSON.stringify 转义后拼 contains OR */
export function buildOptionsQuery(src: ResolvedSource, search: string, offset: number): string {
  const clauses: string[] = []
  if (src.filter) clauses.push(src.filter)
  const s = search.trim()
  if (s) {
    const ors = src.searchFields.map((f) => `{${f}: {contains: ${JSON.stringify(s)}}}`)
    clauses.push(ors.length === 1 ? ors[0] : `{or: [${ors.join(', ')}]}`)
  }
  const args = [`limit: ${src.pageSize}`, `offset: ${offset}`, `sort: [{field: ${toSortField(src.labelField)}, order: ASC}]`]
  if (clauses.length === 1) args.push(`filter: ${clauses[0]}`)
  if (clauses.length > 1) args.push(`filter: {and: [${clauses.join(', ')}]}`)
  return `query { ${src.resource}(${args.join(', ')}) { count results { ${selectionFields(src)} } } }`
}

/** 回显反查:去重 + uuid 白名单,一次 in 批量;全非法/为空返回 null(调用方跳过请求) */
export function buildByIdQuery(src: ResolvedSource, ids: string[]): string | null {
  const valid = [...new Set(ids)].filter((v) => UUID_RE.test(v))
  if (valid.length === 0) return null
  const lit = valid.map((v) => JSON.stringify(v)).join(', ')
  return `query { ${src.resource}(limit: ${valid.length}, offset: 0, filter: {id: {in: [${lit}]}}) { count results { ${selectionFields(src)} } } }`
}

/** 行的显示文本:labelField 值,缺失退截断 id(已删/无权限时不至于空白) */
export function optionLabel(src: ResolvedSource, row: Row | null | undefined): string {
  if (!row) return ''
  const v = row[src.labelField]
  return v == null ? String(row.id).slice(0, 8) : String(v)
}
