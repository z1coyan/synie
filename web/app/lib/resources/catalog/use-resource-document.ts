import { useQuery } from '@tanstack/react-query'
import type { ResourceDocument } from '@synie/shared'
import { resourceBindingFor } from '../registry'

/** 经 ResourceBinding 加载并缓存 ResourceDocument v2 */
export function useResourceDocument(resource: string, enabled = true) {
  const binding = enabled ? resourceBindingFor(resource) : null
  return useQuery<ResourceDocument>({
    queryKey: ['resourceDocument', resource],
    queryFn: () => binding!.loadDocument(),
    staleTime: 5 * 60_000,
    enabled: enabled && binding !== null,
  })
}
