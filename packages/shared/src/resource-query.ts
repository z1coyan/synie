/**
 * Resource list wire contract used by both REST and Convex adapters.
 *
 * Pages only know opaque cursors and named query profiles. A backend adapter may
 * translate the cursor internally, but offset/count never leak through this seam.
 */

/** 单次资源查询的统一上限；需要更多结果的调用方必须沿 opaque cursor 继续拉页。 */
export const MAX_RESOURCE_PAGE_SIZE = 100

export type ResourceQueryArgument = string | boolean | null

export interface ResourceCursorQuery {
  profile: string
  numItems: number
  cursor?: string | null
  search?: string
  args?: Record<string, ResourceQueryArgument>
}

export interface ResourcePageInfo {
  continueCursor: string | null
  isDone: boolean
}

export interface ResourcePage<Row> {
  results: Row[]
  pageInfo: ResourcePageInfo
  /** Only backed by a maintained counter/projection; never synthesized by scanning. */
  totalCount?: number
}

export type ResourceQueryProfileKind = 'index' | 'search'

/** Public, transport-neutral query capabilities projected by Resource Catalog. */
export interface ResourceQueryProfileDocument {
  key: string
  kind: ResourceQueryProfileKind
  /** Arguments accepted by this profile, in equality-prefix order. */
  equalityFields: string[]
  /** At most one indexed range argument. */
  rangeField?: string
  /** Stable ordering is owned by the profile and cannot be overridden by a page. */
  fixedSort: 'ascending' | 'descending'
  /** Search profiles accept the top-level `search` input. */
  acceptsSearch?: boolean
  /** The named argument that is checked against Actor company scope. */
  companyScopeField?: string
  /** Present only when a maintained exact-count projection exists. */
  exactCounterKey?: string
}
