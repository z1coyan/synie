import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { Row } from '../synie-data-grid/types'
import { UUID_RE } from '../synie-data-grid/query'
import type { ResolvedSource } from './remote-query'

/** 选项无限滚动：弹层打开后查询 REST 资源；影响结果的维度全部进入缓存 key。 */
export function useRemoteOptions(src: ResolvedSource | null, search: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: [
      'remoteOptions',
      src?.resource,
      src?.client?.id,
      src?.labelField,
      src?.sortField,
      JSON.stringify(src?.filterState ?? null),
      src?.searchFields.join('|'),
      src?.fields.join('|'),
      src?.pageSize,
      search,
    ],
    enabled: enabled && src != null,
    staleTime: 30_000,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => src!.client.query({
      limit: src!.pageSize,
      offset: pageParam,
      search,
      sort: { column: src!.sortField, direction: 'ascending' },
      filter: src!.filterState,
    }),
    getNextPageParam: (last, pages) => {
      // 按实际返回行数推进(csv fetchAllRows 先例:limit 可能被服务端钳制)
      const loaded = pages.reduce((n, p) => n + p.results.length, 0)
      return last.results.length > 0 && loaded < last.count ? loaded : undefined
    },
  })
}

/** id → 资源记录批量反查（回显）；空或非法 id 跳过，影响结果的维度进入缓存 key。 */
export function useRemoteRecords(src: ResolvedSource | null, ids: string[]) {
  const validIds = [...new Set(ids)].filter((id) => UUID_RE.test(id))
  return useQuery({
    queryKey: ['remoteRecords', src?.resource, src?.client.id, src?.labelField, src?.fields.join('|'), validIds.slice().sort().join(',')],
    enabled: src != null && validIds.length > 0,
    staleTime: 5 * 60_000,
    queryFn: () =>
      Promise.all(validIds.map((id) => src!.client.get(id))).then((rows) =>
        rows.filter((row): row is Row => row != null),
      ),
  })
}
