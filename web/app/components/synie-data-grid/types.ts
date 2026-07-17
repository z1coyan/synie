export type GridColumnType =
  | 'string'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'enumArray'
  | 'fk'

/** enum 胶囊配色(HeroUI Chip color),按枚举线上值(大写 token)配 */
export type EnumChipColor = 'default' | 'accent' | 'success' | 'warning' | 'danger'

export interface GridEnumOption {
  value: string
  label: string
}

export interface GridColumnRefVariant {
  value: string
  resource: string
  labelField: string
  /** 变体中文标签(判别枚举 description 或 poly_refs 显式标签),筛选器变体下拉与 Chip 摘要用 */
  label: string
}

export interface GridColumnRef {
  /** 普通 fk 三件套;多态 fk 时为 null,改走 discriminator/variants */
  resource: string | null
  relation: string | null
  labelField: string | null
  /** 多态 fk:同行判别列名(如 partyType)+ 按判别值选目标资源(枚举为大写 token,字符串原样) */
  discriminator?: string | null
  /** 判别列筛选字面量形态:enum 裸 token / string 带引号 */
  discriminatorType?: 'enum' | 'string' | null
  variants?: GridColumnRefVariant[] | null
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

/** 本地 meta:不经后端 GridMeta 反射的显式列定义(内嵌 json 子表等场景) */
export interface LocalGridMeta {
  columns: GridColumnMeta[]
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
  // 枚举数组:hasAny = 含任一勾选险种,notHas = 所有勾选险种都没有(空数组也命中)
  | { kind: 'enumArray'; op: 'hasAny' | 'notHas'; values: string[] }
  | { kind: 'number'; op: NumberOp; value: string }
  | { kind: 'number'; op: 'between'; gte?: string; lte?: string }
  | { kind: 'date'; op: DateOp; value: string }
  | { kind: 'date'; op: 'between'; gte?: string; lte?: string }
  | { kind: 'fk'; values: string[]; labels: string[] }
  // 多态 fk:一次只筛一个变体(variant 为判别枚举大写 token);isNil 单独一档「仅看空值」
  | { kind: 'polyFk'; op: 'in'; variant: string; values: string[]; labels: string[] }
  | { kind: 'polyFk'; op: 'isNil' }

/** key 为列名(camelCase) */
export type FilterState = Record<string, ColumnFilter>

export interface SortState {
  column: string
  direction: 'ascending' | 'descending'
}
