/**
 * Meta wire DTO（Grid 本地类型 / 权限目录）。
 * ResourceDocument v2 是 Meta 资源响应的唯一 envelope（见 resource-document.ts）。
 * Grid 列/动作本地类型仍由此文件导出，供前端从 ResourceDocument 派生。
 */
import type { FilterState } from './filter.ts'
import type {
  BasicFormSection,
  BasicFormTab,
  ResourceDocument,
} from './resource-document.ts'

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
 * requiredCapability 与 key 分离（如 setDefault → update）；target 决定 execute 入参形状。
 */
export interface GridActionMeta {
  key: string
  label: string
  scope: 'row' | 'bulk' | 'both'
  /** 鉴权门控用的 capability，可与 key 不同 */
  requiredCapability: string
  /** 命令 target：驱动 { id } / { ids } / collection 入参 */
  target: 'collection' | 'row' | 'bulk' | 'rowOrBulk'
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

/** 服务端 FormMeta 的字段呈现提示；字段事实仍以 FieldMeta 为唯一来源。 */
export interface FormFieldMeta {
  /** 创建时静态初值；不得用于依赖运行时上下文的默认值。 */
  initial?: unknown
  /** @deprecated 使用 initial；仅保留迁移兼容。 */
  defaultValue?: unknown
  placeholder?: string
  /** 1–12 栅格跨度。 */
  span?: number
  /** @deprecated 使用 span；仅保留迁移兼容。 */
  cols?: number
  /** 扁平 basic 布局中的排序权重；缺省沿 fields 顺序。 */
  order?: number
  picker?: 'default' | 'dialog'
  filterState?: FilterState
  remote?: {
    filterState?: FilterState
  }
  /**
   * @deprecated 字段是否必填是 FieldMeta.required 的事实。
   * 仅用于存量 extension 声明；basic form 在 seal 时拒绝此项。
   */
  required?: boolean
  /**
   * @deprecated 字段可写性是 FieldMeta.readonly/createOnly 的事实。
   * 仅用于存量 extension 声明；basic form 在 seal 时拒绝此项。
   */
  edit?: 'readOnly' | 'createOnly'
  /**
   * @deprecated 字段标签是 FieldMeta.label 的事实。
   * 仅用于存量 extension 声明；basic form 在 seal 时拒绝此项。
   */
  label?: string
}

/**
 * 服务端定义期 Form Meta。wire 只使用 ResourceDocument.form。
 * 不携带校验函数、事务、命令、脚本或组件引用。
 */
export interface FormMeta {
  kind?: 'basic' | 'extension' | 'none'
  exclude?: string[]
  fields?: Record<string, FormFieldMeta>
  sections?: BasicFormSection[]
  tabs?: BasicFormTab[]
}

/**
 * Convex Catalog 查询返回的完整 ResourceDocument v2。
 * 别名保留便于渐进替换 import。
 */
export type ResourceMetaDocument = ResourceDocument

/** Convex Catalog 资源列表项。 */
export interface ResourceSummary {
  name: string
  permissionPrefix: string
  permissionLabel: string
}

/** 权限目录分组：前缀 + 中文标签 + 动作集。 */
export interface PermissionGroup {
  prefix: string
  label: string
  actions: string[]
}
