/**
 * Filter DSL v1 ≡ 前端 FilterState 的 JSON 同构（见 web/app/components/synie-data-grid/types.ts
 * 与迁移规划 KD20）。本文件是该契约的唯一事实源，server 的 filterbuild 与 web 的
 * Resource Client 共用；改动视为 wire 契约变更。
 */

export type TextOp = 'contains' | 'notContains' | 'eq' | 'notEq'
export type NumberOp = 'eq' | 'gt' | 'lt' | 'gte' | 'lte'
export type DateOp = 'eq' | 'before' | 'after'

/** number/date 的区间取 gte/lte，单值操作符取 value；日期值一律 YYYY-MM-DD */
export type ColumnFilter =
  | { kind: 'text'; op: TextOp; value: string }
  | { kind: 'bool'; eq: boolean }
  | { kind: 'enum'; values: string[] }
  // 枚举数组：hasAny = 含任一勾选值，notHas = 所有勾选值都没有（空数组也命中）
  | { kind: 'enumArray'; op: 'hasAny' | 'notHas'; values: string[] }
  | { kind: 'number'; op: NumberOp; value: string }
  | { kind: 'number'; op: 'between'; gte?: string; lte?: string }
  | { kind: 'date'; op: DateOp; value: string }
  | { kind: 'date'; op: 'between'; gte?: string; lte?: string }
  | { kind: 'fk'; op?: 'in' | 'isNil'; values: string[]; labels: string[] }
  // 多态 fk：一次只筛一个变体（variant 为判别枚举大写 token）；isNil 单独一档「仅看空值」
  | { kind: 'polyFk'; op: 'in'; variant: string; values: string[]; labels: string[] }
  | { kind: 'polyFk'; op: 'isNil' }

/** key 为列名（camelCase，即字段 apiName） */
export type FilterState = Record<string, ColumnFilter>

export interface SortState {
  column: string
  direction: 'ascending' | 'descending'
}

/** 列表查询请求体：POST /api/v1/{domain}/{resources}/query */
export interface ListQuery {
  limit: number
  offset: number
  search?: string
  sort?: SortState
  filter?: FilterState
}

/** 列表查询响应 */
export interface ListResult<Row> {
  count: number
  results: Row[]
}
