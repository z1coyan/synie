import type { ResourcePage, ResourceQueryArgument } from '@synie/shared'
import type { FilterState, Row, SortState } from '~/components/synie-data-grid/types'

export interface ResourceQuery {
  profile: string
  numItems: number
  cursor?: string | null
  search?: string
  args?: Record<string, ResourceQueryArgument>
  /** 结构化条件；Convex binding 必须按 profile 解析或显式拒绝。 */
  sort?: SortState | null
  filter?: FilterState
  fixedFilter?: Record<string, unknown>
  extraFields?: string[]
  joinFields?: Record<string, string[]>
}

/** 组件级 transport 接口，可由 ResourceBinding 或内存测试适配。 */
export interface ResourceTransportQuery {
  profile?: string
  numItems?: number
  cursor?: string | null
  limit?: number
  offset?: number
  search?: string
  args?: Record<string, ResourceQueryArgument>
  sort?: SortState | null
  filter?: FilterState
  fixedFilter?: Record<string, unknown>
  extraFields?: string[]
  joinFields?: Record<string, string[]>
}

export type ResourceList = ResourcePage<Row>

export interface ResourceTransportList {
  count: number
  results: Row[]
}

/**
 * 组件可注入的资源 transport：query/get + 实际存在的普通记录写。
 *
 * 命令不属于 transport；只经 ResourceBinding.commands 暴露。不支持的写方法省略，
 * 禁止用抛错 stub 伪装能力。
 */
export interface ResourceTransport {
  readonly id: string
  query(input: ResourceTransportQuery): Promise<ResourceTransportList>
  get(id: string): Promise<Row | null>
  create?(input: Record<string, unknown>): Promise<Row>
  update?(id: string, input: Record<string, unknown>): Promise<Row>
  delete?(id: string): Promise<void>
}

/**
 * 需要完整普通 CRUD 的组件调用点。新模块优先依赖 ResourceBinding.writer 的实际能力。
 * 该别名不会被只读/部分写资源实现。
 */
export type ResourceClient = ResourceTransport &
  Required<Pick<ResourceTransport, 'create' | 'update' | 'delete'>>
