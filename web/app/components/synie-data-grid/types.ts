export type GridColumnType = 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'datetime' | 'enum'

export interface GridEnumOption {
  value: string
  label: string
}

export interface GridColumnMeta {
  name: string
  type: GridColumnType
  label: string
  sortable: boolean
  filterable: boolean
  enumOptions: GridEnumOption[] | null
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

export type ColumnFilter =
  | { kind: 'text'; contains: string }
  | { kind: 'bool'; eq: boolean }
  | { kind: 'enum'; values: string[] }
  | { kind: 'range'; gte?: string; lte?: string }

/** key 为列名(camelCase) */
export type FilterState = Record<string, ColumnFilter>

export interface SortState {
  column: string
  direction: 'ascending' | 'descending'
}
