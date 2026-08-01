/**
 * Catalog client：解码并缓存完整 ResourceDocument v2。
 * Meta 响应即 ResourceDocument（无 v1 grid/form envelope）。
 */
import type { ResourceDocument } from '@synie/shared'
import { resourceBindingFor } from './binding-registry'
import {
  getCachedDocument,
  setCachedDocument,
} from './cache'

export async function fetchResourceDocument(resource: string): Promise<ResourceDocument> {
  const cached = getCachedDocument(resource)
  if (cached) return cached

  const document = await resourceBindingFor(resource).loadDocument()
  setCachedDocument(resource, document)
  return document
}
