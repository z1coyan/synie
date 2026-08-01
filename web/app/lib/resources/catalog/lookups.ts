/**
 * 目标资源 lookup 的前端消费。
 * 优先用已缓存的 ResourceDocument.lookup；否则使用与服务端分类表对齐的种子，
 * 保证 RemoteSelect 在 Meta 尚未拉取时行为不退化。
 */
import type { ResourceLookupMeta, SortState } from '@synie/shared'
import { getCachedDocument } from './cache'

/** 与 server resource-classification / 模块 meta.lookup 对齐的种子 */
export const LOOKUP_SEEDS: Record<string, ResourceLookupMeta> = {
  basAccounts: {
    labelField: 'name',
    searchFields: ['code', 'name'],
    defaultSort: { column: 'code', direction: 'ascending' },
  },
  hrEmployees: {
    labelField: 'name',
    searchFields: ['name', 'code', 'attendanceNo'],
    subtitleFields: ['code', 'attendanceNo'],
  },
  invMaterialCategories: {
    labelField: 'name',
    searchFields: ['name', 'code'],
    subtitleFields: ['code'],
  },
  invMaterials: {
    labelField: 'name',
    searchFields: ['name', 'code', 'spec'],
    subtitleFields: ['code', 'spec'],
  },
  basUnits: {
    labelField: 'name',
    searchFields: ['name', 'symbol'],
    subtitleFields: ['symbol'],
  },
  basCurrencies: {
    labelField: 'name',
    searchFields: ['name', 'isoCode'],
    subtitleFields: ['isoCode'],
  },
}

/**
 * 解析目标资源 lookup：catalog cache > 种子 > 通用 name 兜底。
 */
export function resolveResourceLookup(
  resource: string,
  fallbackLabelField = 'name',
): ResourceLookupMeta {
  const cached = getCachedDocument(resource)?.lookup
  if (cached) return cached
  const seed = LOOKUP_SEEDS[resource]
  if (seed) return seed
  return {
    labelField: fallbackLabelField,
    searchFields: [fallbackLabelField],
  }
}

export function lookupDefaultSort(lookup: ResourceLookupMeta): SortState | undefined {
  return lookup.defaultSort
}
