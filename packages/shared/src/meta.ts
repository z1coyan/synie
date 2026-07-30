/**
 * Meta wire DTO（Grid 本地类型 / 权限目录）。
 * ResourceDocument v2 是 Meta 资源响应的唯一 envelope（见 resource-document.ts）。
 * Grid 列/动作本地类型仍由此文件导出，供前端从 ResourceDocument 派生。
 */
import type { ResourceDocument } from './resource-document.ts'

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

export interface GridEnumOption {
  value: string
  label: string
}

export interface GridColumnRefVariant {
  value: string
  resource: string
  labelField: string
  /** 变体中文标签（筛选器变体下拉与 Chip 摘要用） */
  label: string
}

export interface GridColumnRef {
  /** 普通 fk 三件套；多态 fk 时为 null，改走 discriminator/variants */
  resource: string | null
  relation: string | null
  labelField: string | null
  /** 多态 fk：同行判别列名（如 partyType）+ 按判别值选目标资源 */
  discriminator?: string | null
  /** 多态资源判别列的数据类型 */
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

/**
 * Grid 扩展动作本地视图（由 ResourceDocument.commands 派生）。
 * 不再携带 mutation/http 等 v1 transport。
 */
export interface GridActionMeta {
  key: string
  label: string
  scope: 'row' | 'bulk' | 'both'
  isDanger: boolean
  confirmKind?: 'none' | 'generic' | 'audit_doc'
}

export interface GridMeta {
  columns: GridColumnMeta[]
  capabilities: string[]
  extendedActions: GridActionMeta[]
  /** 是否可删除（由 capabilities 与 binding writer 共同决定；兼容字段） */
  canDelete: boolean
}

/**
 * @deprecated 服务端 form 声明仅用于定义期；wire 使用 ResourceDocument.form。
 * 保留类型供服务端 ResourceMeta.form 使用。
 */
export interface FormMeta {
  kind?: 'basic' | 'extension' | 'none'
  exclude?: string[]
  fields?: Record<string, Record<string, unknown>>
  sections?: Record<string, unknown>[]
  tabs?: Record<string, unknown>[]
}

/**
 * GET /api/v1/meta/resources/{name} 的 wire 响应：完整 ResourceDocument v2。
 * 别名保留便于渐进替换 import。
 */
export type ResourceMetaDocument = ResourceDocument

/** GET /api/v1/meta/resources 的列表项 */
export interface ResourceSummary {
  name: string
  permissionPrefix: string
  permissionLabel: string
}

/** 权限目录分组：前缀 + 中文标签 + 动作集（GET /api/v1/meta/permission-catalog） */
export interface PermissionGroup {
  prefix: string
  label: string
  actions: string[]
}
