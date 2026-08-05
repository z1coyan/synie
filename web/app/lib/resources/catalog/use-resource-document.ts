import { useQuery } from '@tanstack/react-query'
import type { ResourceDocument } from '@synie/shared'
import { resourceBindingFor } from '../registry'
import { resourceDocumentQuery } from './client'

/** 经 ResourceBinding 加载并缓存 ResourceDocument v3 */
export function useResourceDocument(resource: string, enabled = true) {
  const binding = enabled ? resourceBindingFor(resource) : null
  return useQuery<ResourceDocument>({
    ...resourceDocumentQuery(resource),
    enabled: enabled && binding !== null,
  })
}
