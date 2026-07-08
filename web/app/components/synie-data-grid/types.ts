export type GridColumnType = 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'datetime' | 'enum' | 'fk'

export interface GridEnumOption {
  value: string
  label: string
}

export interface GridColumnRef {
  resource: string
  relation: string
  labelField: string
}

export interface GridColumnMeta {
  name: string
  type: GridColumnType
  label: string
  sortable: boolean
  filterable: boolean
  enumOptions: GridEnumOption[] | null
  ref: GridColumnRef | null
}

export interface GridActionMeta {
  key: string
  label: string
  scope: 'row' | 'bulk' | 'both'
  mutation: string
  isDanger: boolean
}

export interface GridMeta {
  columns: GridColumnMeta[]
  capabilities: string[]
  extendedActions: GridActionMeta[]
  destroyMutation: string | null
}

/** 行数据是运行时拼查询取回的,类型边界即 unknown(spec「类型边界」节) */
export type Row = Record<string, unknown> & { id: string }

export interface ActionContext {
  refetch: () => void
}

interface ActionBase {
  key: string
  label: string
  isDanger?: boolean
  /** 填了则按 capabilities 门控;不填总是显示 */
  capability?: string
}

export interface RowAction extends ActionBase {
  onAction: (row: Row, ctx: ActionContext) => void
}

export interface BulkAction extends ActionBase {
  onAction: (rows: Row[], ctx: ActionContext) => void
}

export type TextOp = 'contains' | 'notContains' | 'eq' | 'notEq'
export type NumberOp = 'eq' | 'gt' | 'lt' | 'gte' | 'lte'
export type DateOp = 'eq' | 'before' | 'after'

/** number/date 的区间取 gte/lte,单值操作符取 value;日期值一律 YYYY-MM-DD,datetime 列的日界换算在 query.ts */
export type ColumnFilter =
  | { kind: 'text'; op: TextOp; value: string }
  | { kind: 'bool'; eq: boolean }
  | { kind: 'enum'; values: string[] }
  | { kind: 'number'; op: NumberOp; value: string }
  | { kind: 'number'; op: 'between'; gte?: string; lte?: string }
  | { kind: 'date'; op: DateOp; value: string }
  | { kind: 'date'; op: 'between'; gte?: string; lte?: string }
  | { kind: 'fk'; values: string[]; labels: string[] }

/** key 为列名(camelCase) */
export type FilterState = Record<string, ColumnFilter>

export interface SortState {
  column: string
  direction: 'ascending' | 'descending'
}
