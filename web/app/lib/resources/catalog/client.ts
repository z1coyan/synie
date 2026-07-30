/**
 * Catalog client：解码并缓存完整 ResourceDocument v2。
 * 不再只保留 Grid 子集。
 */
import {
  decodeResourceDocument,
  type ResourceDocument,
  type ResourceMetaDocument,
} from '@synie/shared'
import { api, apiData } from '~/lib/api/client'
import {
  getCachedDocument,
  setCachedDocument,
} from './cache'

export async function fetchResourceDocument(resource: string): Promise<ResourceDocument> {
  const cached = getCachedDocument(resource)
  if (cached) return cached

  const envelope = await apiData<ResourceMetaDocument>(
    api.meta.resources[':name'].$get({ param: { name: resource } }),
  )

  if (!envelope.catalog) {
    throw new Error(
      `资源「${resource}」的 Meta 响应缺少 catalog v2（服务端 expand 未完成或版本不匹配）`,
    )
  }

  const document = decodeResourceDocument(envelope.catalog)
  setCachedDocument(resource, document)
  return document
}
