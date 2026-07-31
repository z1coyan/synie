/**
 * ResourceBinding 的查询缓存身份。
 *
 * 调用者只提供资源内的查询维度，不需要知道生产 Hono Adapter 的 id。缓存失效也经同一
 * interface 完成，避免 key 结构散落在页面。
 */

export type ResourceQueryKey = readonly unknown[]

/**
 * TanStack QueryClient 满足这个最小 port；测试使用 in-memory Adapter 记录失效动作。
 */
export interface QueryInvalidationAdapter {
  invalidateQueries(options: { queryKey: ResourceQueryKey }): Promise<unknown>
}

export interface ResourceQueryCache {
  /**
   * 与 Reader 配对的 Adapter identity。
   * 仅供兼容 transport 适配层原样保真；业务调用者应使用下方 key/失效 interface。
   */
  readonly adapterId: string
  /** 当前资源全部列表查询的稳定 scope。 */
  readonly gridScope: ResourceQueryKey
  /** 当前资源全部单条查询的稳定 scope。 */
  readonly rowScope: ResourceQueryKey
  /** 列表查询 key；parts 仅描述分页、搜索、筛选等资源内维度。 */
  gridKey(...parts: readonly unknown[]): ResourceQueryKey
  /** 单条查询 key。省略 id 时等同 rowScope。 */
  rowKey(id?: string): ResourceQueryKey
  invalidateGrid(cache: QueryInvalidationAdapter): Promise<void>
  invalidateRow(cache: QueryInvalidationAdapter, id?: string): Promise<void>
  invalidateAll(cache: QueryInvalidationAdapter): Promise<void>
}

/**
 * cache identity 由资源与 Adapter 共同决定。ResourceBinding 只在构造时知道 Adapter id；
 * Grid、Drawer 与业务页面都不应复制这个事实。
 */
export function createResourceQueryCache(
  resource: string,
  adapterId: string,
): ResourceQueryCache {
  const gridScope = Object.freeze(['gridRows', adapterId, resource] as const)
  const rowScope = Object.freeze(['rowById', adapterId, resource] as const)

  const invalidate = async (
    cache: QueryInvalidationAdapter,
    queryKey: ResourceQueryKey,
  ): Promise<void> => {
    await cache.invalidateQueries({ queryKey })
  }

  return {
    adapterId,
    gridScope,
    rowScope,
    gridKey: (...parts) => [...gridScope, ...parts],
    rowKey: (id) => (id == null ? rowScope : [...rowScope, id]),
    invalidateGrid: (cache) => invalidate(cache, gridScope),
    invalidateRow: (cache, id) => invalidate(cache, id == null ? rowScope : [...rowScope, id]),
    invalidateAll: async (cache) => {
      await Promise.all([
        invalidate(cache, gridScope),
        invalidate(cache, rowScope),
      ])
    },
  }
}
