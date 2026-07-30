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
  const cached = getCachedDocument(resource)
  if (cached) return cached

  const raw = await apiData<unknown>(
    api.meta.resources[':name'].$get({ param: { name: resource } }),
  )

  const document = decodeResourceDocument(raw)
  setCachedDocument(resource, document)
  return document
}
