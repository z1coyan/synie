/**
 * Grid / Filter wire 类型：单一事实源为 @synie/shared。
 * 页面与组件继续从本文件 import，传输层与 server filterbuild 共用契约。
 */
export type {
  ColumnFilter,
  DateOp,
  FilterState,
  GridActionMeta,
  GridColumnMeta,
  GridColumnRef,
  GridColumnRefVariant,
  GridColumnType,
  GridEnumOption,
  GridMeta,
  NumberOp,
  SortState,
  TextOp,
} from '@synie/shared'

import type { GridColumnMeta } from '@synie/shared'

/** enum 胶囊配色(HeroUI Chip color),按枚举线上值(大写 token)配 */
export type EnumChipColor = 'default' | 'accent' | 'success' | 'warning' | 'danger'

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
