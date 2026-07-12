import { useQuery } from '@tanstack/react-query'
import { gqlFetch } from '~/lib/graphql'
import type { GridMeta } from './types'

const GRID_META_QUERY = `
  query GridMeta($resource: String!) {
    gridMeta(resource: $resource) {
      columns { name type label sortable filterable enumOptions { value label } ref { resource relation labelField discriminator variants { value resource labelField label } } }
      capabilities
      extendedActions { key label scope mutation isDanger }
      destroyMutation
    }
  }
`

export function useGridMeta(resource: string, enabled = true) {
  return useQuery({
    queryKey: ['gridMeta', resource],
    queryFn: () =>
      gqlFetch<{ gridMeta: GridMeta }>(GRID_META_QUERY, { resource }).then((d) => d.gridMeta),
    staleTime: 5 * 60_000,
    enabled,
  })
}
