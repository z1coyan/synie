import { useQuery } from '@tanstack/react-query'
import { resourceClientFor } from '~/lib/resources/registry'
import type { ResourceClient } from '~/lib/resources/types'

export function useGridMeta(resource: string, enabled = true, client?: ResourceClient) {
  const resolvedClient = client ?? (enabled ? resourceClientFor(resource) : undefined)
  return useQuery({
    queryKey: ['gridMeta', resolvedClient?.id, resource],
    queryFn: () => resolvedClient!.meta(),
    staleTime: 5 * 60_000,
    enabled,
  })
}
