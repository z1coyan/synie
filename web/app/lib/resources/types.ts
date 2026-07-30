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
 * 资源 HTTP 传输对象：query/get + 实际存在的普通记录写。
 *
 * 命令不属于 transport；只经 ResourceBinding.commands 暴露。不支持的写方法省略，
 * 禁止用抛错 stub 伪装能力。
 */
export interface ResourceTransport {
  readonly id: string
  query(input: ResourceQuery): Promise<ResourceList>
  get(id: string): Promise<Row | null>
  create?(input: Record<string, unknown>): Promise<Row>
  update?(id: string, input: Record<string, unknown>): Promise<Row>
  delete?(id: string): Promise<void>
}

/**
 * 需要完整普通 CRUD 的旧调用点。新模块优先依赖 ResourceBinding.writer 的实际能力。
 * 该别名不会被只读/部分写资源实现。
 */
export type ResourceClient = ResourceTransport &
  Required<Pick<ResourceTransport, 'create' | 'update' | 'delete'>>
