/**
 * Meta wire DTO（GridMetaDTO / FormMetaDTO / 权限目录），对齐
 * web/app/components/synie-data-grid/types.ts 与 server-go platform/meta 的 JSON 形状。
 * 服务端 Registry 投影产出、前端 Resource Client 消费；本文件是两侧共用契约。
 */

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

export interface GridActionMeta {
  key: string
  label: string
  scope: 'row' | 'bulk' | 'both'
  mutation: string
  isDanger: boolean
  http?: { method: string; path: string }
  confirmKind?: 'none' | 'generic' | 'audit_doc'
}

export interface GridMeta {
  columns: GridColumnMeta[]
  capabilities: string[]
  extendedActions: GridActionMeta[]
  destroyMutation: string | null
}

export interface FormMeta {
  exclude?: string[]
  fields?: Record<string, Record<string, unknown>>
  sections?: Record<string, unknown>[]
  tabs?: Record<string, unknown>[]
}

/** GET /api/v1/meta/resources/{name} 的响应 */
export interface ResourceMetaDocument {
  name: string
  grid: GridMeta
  form?: FormMeta
}

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
