/**
 * 目标资源 lookup 的前端消费。
 * 优先用已缓存的 ResourceDocument.lookup（actor 投影）；否则读资源事实清单
 * （server meta.lookup 的构建期派生物，ADR 2026-08-07-resource-manifest），
 * 保证 RemoteSelect 在 Meta 尚未拉取时行为不退化。
 */
import type { ResourceLookupMeta, SortState } from '@synie/shared'
import { RESOURCE_MANIFEST } from '@synie/shared/generated/resource-manifest'
import { getCachedDocument } from './cache'

/**
 * 解析目标资源 lookup：catalog cache > 资源事实清单 > 通用 name 兜底。
 */
export function resolveResourceLookup(
  resource: string,
  fallbackLabelField = 'name',
): ResourceLookupMeta {
  const cached = getCachedDocument(resource)?.lookup
  if (cached) return cached
  const manifest = RESOURCE_MANIFEST[resource]?.lookup
  if (manifest) return manifest
  return {
    labelField: fallbackLabelField,
    searchFields: [fallbackLabelField],
  }
}

export function lookupDefaultSort(lookup: ResourceLookupMeta): SortState | undefined {
  return lookup.defaultSort
}
