/**
 * Catalog client：解码并缓存完整 ResourceDocument v2。
 * Meta 响应即 ResourceDocument（无 v1 grid/form envelope）。
 */
import {
  decodeResourceDocument,
  type ResourceDocument,
} from '@synie/shared'
import { api, apiData } from '~/lib/api/client'
import {
  getCachedDocument,
  setCachedDocument,
} from './cache'

export async function fetchResourceDocument(resource: string): Promise<ResourceDocument> {
  // SSR 下模块级缓存跨请求共享,而 Document 是按 Actor 投影的能力视图:
  // 不读不写,去重交给每请求独立的 queryClient,防止并发请求串 Actor
  const ssr = typeof window === 'undefined'
  if (!ssr) {
    const cached = getCachedDocument(resource)
    if (cached) return cached
  }

  const raw = await apiData(
    api.meta.resources[':name'].$get({ param: { name: resource } }),
  )

  const document = decodeResourceDocument(raw)
  if (!ssr) setCachedDocument(resource, document)
  return document
}
