import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { gqlFetch } from '~/lib/graphql'
import type { Row } from '../synie-data-grid/types'
import { buildByIdQuery, buildOptionsQuery, type ResolvedSource } from './remote-query'

interface PageResult {
  count: number
  results: Row[]
}

/** 选项无限滚动:enabled=弹层打开才发请求;search/filter 进 queryKey 自动重查 */
export function useRemoteOptions(src: ResolvedSource | null, search: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ['remoteOptions', src?.resource, src?.filter, src?.searchFields.join('|'), search],
    enabled: enabled && src != null,
    staleTime: 30_000,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      gqlFetch<Record<string, PageResult>>(buildOptionsQuery(src!, search, pageParam)).then((d) => d[src!.resource]),
    getNextPageParam: (last, pages) => {
      // 按实际返回行数推进(csv fetchAllRows 先例:limit 可能被服务端钳制)
      const loaded = pages.reduce((n, p) => n + p.results.length, 0)
      return last.results.length > 0 && loaded < last.count ? loaded : undefined
    },
  })
}

/** id → 行数据批量反查(回显);ids 空/全非法跳过;回显数据不常变,staleTime 放长 */
export function useRemoteRecords(src: ResolvedSource | null, ids: string[]) {
  const query = src ? buildByIdQuery(src, ids) : null
  return useQuery({
    queryKey: ['remoteRecords', src?.resource, [...ids].sort().join(',')],
    enabled: query != null,
    staleTime: 5 * 60_000,
    queryFn: () => gqlFetch<Record<string, PageResult>>(query!).then((d) => d[src!.resource].results),
  })
}
