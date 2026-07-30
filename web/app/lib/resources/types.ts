import type { FilterState, Row, SortState } from '~/components/synie-data-grid/types'

export interface ResourceQuery {
  limit: number
  offset: number
  search?: string
  sort?: SortState | null
  filter?: FilterState
  fixedFilter?: Record<string, unknown>
  extraFields?: string[]
  joinFields?: Record<string, string[]>
}

export interface ResourceList {
  count: number
  results: Row[]
}

/**
 * 资源 HTTP 传输对象：query/get + 可选写。
 * contract 后：
 * - 不再拥有 meta()（Grid Meta 从 ResourceDocument 派生）
 * - 不再拥有 action()（命令经 CommandAdapter）
 * - 不支持的写方法可省略或在 binding 层不暴露
 *
 * 能力边界以 ResourceBinding 为准；本类型仅是 transport 实现细节。
 */
export interface ResourceTransport {
  readonly id: string
  query(input: ResourceQuery): Promise<ResourceList>
  get(id: string): Promise<Row | null>
  create(input: Record<string, unknown>): Promise<Row>
  update(id: string, input: Record<string, unknown>): Promise<Row>
  delete(id: string): Promise<void>
  /**
   * 历史命令桥：仅用于构造 binding.commands；不进 Grid Meta transport。
   * 新代码请用 createCommandAdapter / defineCommand。
   */
  action?(key: string, ids: string[]): Promise<void>
}

/** @deprecated 使用 ResourceTransport；能力组合请用 ResourceBinding */
export type ResourceClient = ResourceTransport
