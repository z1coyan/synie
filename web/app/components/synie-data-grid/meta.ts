import { useQuery } from '@tanstack/react-query'
import { fetchResourceDocument, gridMetaFromDocument } from '~/lib/resources/catalog'

/**
 * Grid Meta：从 ResourceDocument v2 派生。
 * 不再经传输层 meta()。
 */
export function useGridMeta(resource: string, enabled = true) {
  return useQuery({
    queryKey: ['gridMeta', resource],
    queryFn: async () => gridMetaFromDocument(await fetchResourceDocument(resource)),
    staleTime: 5 * 60_000,
    enabled: enabled && Boolean(resource),
  })
}
