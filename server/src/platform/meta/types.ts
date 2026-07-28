import type { FormMeta, GridColumnRef, GridEnumOption } from '@synie/shared'

/**
 * 权威 Meta 模型（服务端内部，宽于 wire；wire DTO 类型在 @synie/shared）。
 * 业务模块以代码注册 ResourceMeta；Registry 投影出 Grid/Form/权限目录。
 */

export type FieldType =
  | 'string'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'enumArray'
  | 'uuid'
  | 'json'
  | 'fk'

export interface FieldMeta {
  /** 内部名（snake_case 属性名） */
  name: string
  /** wire 名（camelCase） */
  apiName: string
  /** 物理列名（snake_case，经 Registry 校验合法性后进 SQL 标识符） */
  dbColumn: string
  type: FieldType
  label: string
  required?: boolean
  readonly?: boolean
  createOnly?: boolean
  sensitive?: boolean
  enumOptions?: GridEnumOption[]
  ref?: GridColumnRef
  filterable?: boolean
  sortable?: boolean
  decimalScale?: number
  /** 计算/投影字段（非物理列）：打印字段目录一层关联展开时跳过 */
  calculated?: boolean
  /** 仅打印字段目录可见：不进 Grid 文档，不参与筛选/排序 */
  printOnly?: boolean
  /** 多态外键在打印目录中只暴露原始 ID 列，不做 party.name 式展开 */
  printRawId?: boolean
}

export interface ActionMeta {
  key: string
  label: string
  scope: 'row' | 'bulk' | 'both'
  /** 缺省取 key */
  permissionAction?: string
  mutation?: string
  isDanger?: boolean
  http?: { method: string; path: string }
  confirmKind?: 'none' | 'generic' | 'audit_doc'
}

/** 打印循环区声明：占位符 {name.field} 逐行展开目标资源 */
export interface PrintLoopMeta {
  name: string
  resource: string
}

export interface ResourceMeta {
  /** 资源名，对齐旧 GridMeta 键（如 basCurrencies） */
  name: string
  permissionPrefix: string
  permissionLabel: string
  /** 无独立权限点的只读投影视图：持任一完整权限码即可读，且不进权限目录 */
  readPermissionsAny?: string[]
  table: string
  fields: FieldMeta[]
  actions: ActionMeta[]
  form?: FormMeta
  print?: boolean
  printHead?: boolean
  printLoops?: PrintLoopMeta[]
  audit?: { enabled: boolean; sensitiveFields?: string[] }
  destroyMutation?: string
}

/** 标准十件套（permission catalog 与 capabilities 的基准） */
export const STANDARD_ACTIONS = [
  'create',
  'read',
  'update',
  'delete',
  'print',
  'import',
  'export',
  'batch_delete',
  'batch_update',
  'batch_print',
] as const
