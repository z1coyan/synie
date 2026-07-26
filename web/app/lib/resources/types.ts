import type { FilterState, GridMeta, Row, SortState } from '~/components/synie-data-grid/types'

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

export interface ResourceClient {
  readonly id: string
  meta(): Promise<GridMeta>
  query(input: ResourceQuery): Promise<ResourceList>
  get(id: string): Promise<Row | null>
  create(input: Record<string, unknown>): Promise<Row>
  update(id: string, input: Record<string, unknown>): Promise<Row>
  delete(id: string): Promise<void>
  action?(key: string, ids: string[]): Promise<void>
}
