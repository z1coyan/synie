/**
 * 路由 loader 预取辅助。
 *
 * 约定：
 * - 鉴权数据仅在浏览器预取（`typeof window === 'undefined'` 时直接返回）
 * - 列表/单条缓存键一律经 `resourceBindingFor(resource).cache`，禁止手写 gridRows/rowById
 * - 默认维度与 SynieDataGrid 组件内初始 state 对齐，保证 ensureQueryData 与 useQuery 命中同一 key
 */
import type { QueryClient } from '@tanstack/react-query'
import type { FilterState, SortState } from '~/components/synie-data-grid/types'
import {
  fetchResourceDocument,
  gridMetaFromDocument,
} from '~/lib/resources/catalog'
import { resourceBindingFor } from '~/lib/resources/registry'

/** 与 SynieDataGrid 默认首屏 state 对齐的预取选项 */
export type DefaultGridPrefetchOptions = {
  page?: number
  pageSize?: number
  search?: string
  sort?: SortState | null
  filters?: FilterState
  /** 未传时与 Grid 默认一致（key 维度为 null） */
  fixedFilter?: Record<string, unknown> | null
  extraFields?: string[]
  joinFields?: Record<string, string[]>
  treeActive?: boolean
}

/**
 * 展开与 SynieDataGrid 首屏 queryKey 一致的维度。
 * 供测试断言 key 对齐；业务调用优先用 ensureDefaultGridPage。
 */
export function defaultGridKeyParts(options: DefaultGridPrefetchOptions = {}) {
  const page = options.page ?? 1
  const pageSize = options.pageSize ?? 20
  const search = options.search ?? ''
  const sort = options.sort ?? null
  const filters = options.filters ?? {}
  const fixedFilter = options.fixedFilter ?? null
  const treeActive = options.treeActive ?? false
  const extraFieldsKey =
    options.extraFields?.slice().sort().join(',') ?? ''

  return {
    treeActive,
    page,
    pageSize,
    search,
    sort,
    filters,
    fixedFilter,
    sortJson: JSON.stringify(sort),
    filtersJson: JSON.stringify(filters),
    fixedFilterKey: JSON.stringify(fixedFilter),
    extraFieldsKey,
  }
}

/** 默认首屏列表 queryKey（经 binding.cache.gridKey） */
export function defaultGridQueryKey(
  resource: string,
  options: DefaultGridPrefetchOptions = {},
) {
  const binding = resourceBindingFor(resource)
  const p = defaultGridKeyParts(options)
  return binding.cache.gridKey(
    p.treeActive,
    p.page,
    p.pageSize,
    p.search,
    p.sortJson,
    p.filtersJson,
    p.fixedFilterKey,
    p.extraFieldsKey,
  )
}

/**
 * 预取 Grid Meta + 默认首屏列表。
 * SSR 阶段跳过（token 在 localStorage、API 相对路径，与 _app beforeLoad 先例一致）。
 */
export async function ensureDefaultGridPage(
  queryClient: QueryClient,
  resource: string,
  options: DefaultGridPrefetchOptions = {},
): Promise<void> {
  if (typeof window === 'undefined') return

  const binding = resourceBindingFor(resource)
  const p = defaultGridKeyParts(options)
  const extraFields =
    options.extraFields && options.extraFields.length > 0
      ? options.extraFields
      : undefined

  await Promise.all([
    queryClient.ensureQueryData({
      queryKey: ['gridMeta', resource],
      queryFn: async () =>
        gridMetaFromDocument(await fetchResourceDocument(resource)),
      staleTime: 5 * 60_000,
    }),
    queryClient.ensureQueryData({
      queryKey: binding.cache.gridKey(
        p.treeActive,
        p.page,
        p.pageSize,
        p.search,
        p.sortJson,
        p.filtersJson,
        p.fixedFilterKey,
        p.extraFieldsKey,
      ),
      queryFn: () =>
        binding.reader.query({
          limit: p.pageSize,
          offset: (p.page - 1) * p.pageSize,
          search: p.treeActive ? undefined : p.search,
          sort: p.sort,
          filter: p.filters,
          fixedFilter: p.fixedFilter ?? undefined,
          extraFields,
          joinFields: options.joinFields,
        }),
    }),
  ])
}
