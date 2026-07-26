import type { ReactNode } from 'react'
import type { FilterState, GridColumnRef, Row } from '../synie-data-grid/types'
import type { ResourceClient } from '~/lib/resources/types'
import { resourceClientFor } from '~/lib/resources/registry'

export interface RemoteSourceConfig {
  /** GridMeta 白名单资源名，如 "basCompanies"。 */
  resource: string
  /** 显式 REST 数据源；缺省时从资源 registry 解析，未知资源立即报错。 */
  client?: ResourceClient
  /** 显示字段，默认 gridMeta ref.labelField，再兜底 'name'。 */
  labelField?: string
  /** 排序字段，默认 labelField；labelField 为计算字段不可排序时使用。 */
  sortField?: string
  /** 远程搜索字段，默认 [labelField]。 */
  searchFields?: string[]
  /** REST ResourceClient 使用的结构化固定筛选。 */
  filterState?: FilterState
  /** 额外取回字段（renderItem/renderValue 使用）。 */
  fields?: string[]
  pageSize?: number
  /** 下拉项渲染，默认 label 单行。 */
  renderItem?: (row: Row) => ReactNode
  /** 选中回填渲染，默认 label 文本/chip。 */
  renderValue?: (row: Row) => ReactNode
  /** 默认下拉项的副行字段（值非空的用 · 连接）；自定义 renderItem 时无效。 */
  itemSubtitleFields?: string[]
}

export interface ResolvedSource {
  resource: string
  client: ResourceClient
  labelField: string
  sortField: string
  searchFields: string[]
  filterState?: FilterState
  fields: string[]
  pageSize: number
  itemSubtitleFields: string[]
}

/**
 * 资源级数据源默认（优先级：页面 config > 本表 > 通用兜底），全站该资源的
 * RemoteSelect 族与表格 fk 筛选器一并生效。员工按姓名/工号/考勤机编号三字段
 * 搜索并在下拉项带编号副行——大量占位 [未知] 员工只能靠编号区分。
 */
const RESOURCE_DEFAULTS: Record<string, Partial<RemoteSourceConfig>> = {
  hrEmployees: {
    searchFields: ['name', 'code', 'attendanceNo'],
    itemSubtitleFields: ['code', 'attendanceNo'],
  },
  // 分类/物料/单位：名称+编号（符号）双字段搜索，下拉带编号副行方便识别。
  invMaterialCategories: {
    searchFields: ['name', 'code'],
    itemSubtitleFields: ['code'],
  },
  invMaterials: {
    searchFields: ['name', 'code', 'spec'],
    itemSubtitleFields: ['code', 'spec'],
  },
  basUnits: {
    searchFields: ['name', 'symbol'],
    itemSubtitleFields: ['symbol'],
  },
}

/** gridMeta ref 提供默认，页面 config 覆盖；二者都无 resource 时返回 null。 */
export function resolveSource(cfg: Partial<RemoteSourceConfig>, ref?: GridColumnRef | null): ResolvedSource | null {
  const resource = cfg.resource ?? ref?.resource
  if (!resource) return null
  const defaults = RESOURCE_DEFAULTS[resource] ?? {}
  const labelField = cfg.labelField ?? ref?.labelField ?? 'name'
  const searchFields = cfg.searchFields?.length ? cfg.searchFields : defaults.searchFields
  return {
    resource,
    client: cfg.client ?? resourceClientFor(resource),
    labelField,
    sortField: cfg.sortField ?? labelField,
    searchFields: searchFields?.length ? searchFields : [labelField],
    filterState: cfg.filterState,
    fields: cfg.fields ?? defaults.fields ?? [],
    pageSize: cfg.pageSize ?? 20,
    itemSubtitleFields: cfg.renderItem ? [] : (cfg.itemSubtitleFields ?? defaults.itemSubtitleFields ?? []),
  }
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
