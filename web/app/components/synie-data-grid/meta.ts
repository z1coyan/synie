import { useQuery } from '@tanstack/react-query'
import { gridMetaFromDocument, useResourceDocument } from '~/lib/resources/catalog'

/**
 * Grid Meta：从 ResourceDocument v2 派生。
 * 不再经传输层 meta()。
 */
export function useGridMeta(resource: string, enabled = true) {
  const document = useResourceDocument(resource, enabled)
  return useQuery({
    queryKey: ['gridMeta', resource, document.dataUpdatedAt],
    queryFn: () => gridMetaFromDocument(document.data!),
    staleTime: 5 * 60_000,
    enabled: enabled && Boolean(resource) && document.data !== undefined,
  })
}
