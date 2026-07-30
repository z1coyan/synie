import type { ReactNode } from 'react'
import type { FilterState, GridColumnRef, Row } from '../synie-data-grid/types'
import type { ResourceTransport } from '~/lib/resources/types'
import { resourceTransportFromResourceBinding } from '~/lib/resources/registry'
import { resolveResourceLookup } from '~/lib/resources/catalog/lookups'
import { createReferencePresentation } from '~/lib/resources/catalog/reference-presentation'

export interface RemoteSourceConfig {
  /** GridMeta 白名单资源名，如 "basCompanies"。 */
  resource: string
  /** 显式 REST 数据源；缺省时从资源 registry 解析，未知资源立即报错。 */
  client?: ResourceTransport
  /** 显示字段，默认 gridMeta ref.labelField，再兜底目标 lookup.labelField / 'name'。 */
  labelField?: string
  /** 排序字段，默认 lookup.defaultSort 或 labelField。 */
  sortField?: string
  /** 远程搜索字段，默认目标资源 lookup.searchFields。 */
  searchFields?: string[]
  /** REST ResourceClient 使用的结构化固定筛选。 */
  filterState?: FilterState
  /** 额外取回字段（renderItem/renderValue 使用）。 */
  fields?: string[]
  pageSize?: number
  /** 下拉项渲染；缺省用 ReferencePresentation（副行来自 lookup.subtitleFields）。 */
  renderItem?: (row: Row) => ReactNode
  /** 选中回填渲染，默认 label 文本/chip。 */
  renderValue?: (row: Row) => ReactNode
  /** 默认下拉项的副行字段；优先页面覆盖，否则 lookup.subtitleFields。 */
  itemSubtitleFields?: string[]
}

export interface ResolvedSource {
  resource: string
  client: ResourceTransport
  labelField: string
  sortField: string
  searchFields: string[]
  filterState?: FilterState
  fields: string[]
  pageSize: number
  itemSubtitleFields: string[]
}

// contract：无 resource-key remote defaults；lookup 归 Catalog，渲染归 ReferencePresentation。

/** gridMeta ref 提供默认，页面 config 覆盖；lookup 归目标资源 Catalog。 */
export function resolveSource(cfg: Partial<RemoteSourceConfig>, ref?: GridColumnRef | null): ResolvedSource | null {
  const resource = cfg.resource ?? ref?.resource
  if (!resource) return null
  const lookup = resolveResourceLookup(resource, ref?.labelField ?? 'name')
  const labelField = cfg.labelField ?? ref?.labelField ?? lookup.labelField
  const searchFields = cfg.searchFields?.length
    ? cfg.searchFields
    : lookup.searchFields
  const itemSubtitleFields = cfg.renderItem
    ? []
    : (cfg.itemSubtitleFields ?? lookup.subtitleFields ?? [])
  const sortField =
    cfg.sortField ?? lookup.defaultSort?.column ?? labelField
  // 确保 subtitle 字段被取回
  const extraFields = new Set([
    ...(cfg.fields ?? []),
    ...itemSubtitleFields,
    ...searchFields.filter((f) => f !== labelField),
  ])
  return {
    resource,
    client: cfg.client ?? resourceTransportFromResourceBinding(resource),
    labelField,
    sortField,
    searchFields: searchFields.length > 0 ? searchFields : [labelField],
    filterState: cfg.filterState,
    fields: [...extraFields],
    pageSize: cfg.pageSize ?? 20,
    itemSubtitleFields,
  }
}

/** 无自定义 renderItem 时，用 ReferencePresentation 画副行 */
export function defaultReferenceRenderers(resource: string, labelField?: string) {
  const pe = createReferencePresentation(resource, labelField)
  return {
    renderItem: pe.renderItem,
    renderValue: pe.renderValue,
  }
}

/** 基线报告：remote defaults 键（应为空） */
export function listRemoteDefaultKeys(): string[] {
  return []
}

/** fk 目标解析：多态 fk 按行判别值选变体，普通 fk 取自身资源配置。 */
export function resolveFkTarget(ref: GridColumnRef, row: Row): { resource: string; labelField: string } | null {
  if (ref.discriminator) {
    const variant = ref.variants?.find((item) => item.value === String(row[ref.discriminator!] ?? ''))
    return variant ? { resource: variant.resource, labelField: variant.labelField } : null
  }
  return ref.resource ? { resource: ref.resource, labelField: ref.labelField ?? 'name' } : null
}

/** 行的显示文本：labelField 缺失时退回截断 id。 */
export function optionLabel(src: ResolvedSource, row: Row | null | undefined): string {
  if (!row) return ''
  const value = row[src.labelField]
  return value == null ? String(row.id).slice(0, 8) : String(value)
}
