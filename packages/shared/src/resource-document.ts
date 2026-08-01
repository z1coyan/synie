/**
 * ResourceDocument v2 — 类型安全 Resource Catalog 的唯一 wire 契约。
 *
 * 服务端按 Actor 投影完整文档；Grid 与基础 Form 都从本契约派生。
 * contract 后 GET /meta/resources/{name} 直接返回本文档（无 v1 grid/form sibling）。
 */
import type { FilterState, SortState } from './filter.ts'
import type { GridEnumOption } from './meta.ts'

/** 当前支持的 ResourceDocument schema 版本 */
export const RESOURCE_DOCUMENT_SCHEMA_VERSION = 2 as const

export type ResourceDocumentSchemaVersion = typeof RESOURCE_DOCUMENT_SCHEMA_VERSION

/** 字段值可见性：write-only 描述可进表单，值永不进 list/read/view/print */
export type FieldValueVisibility = 'readable' | 'writeOnly'

/** 创建时输入策略 */
export type CreateInputPolicy = 'required' | 'optional' | 'forbidden'

/** 更新时输入策略 */
export type UpdateInputPolicy = 'allowed' | 'forbidden'

/**
 * 字段输入策略：required / readonly / create-only / clearable / 静态初值的唯一事实源。
 * Form 布局不得扩张本策略（update-forbidden 可展示为禁用，但不得提交）。
 */
export interface FieldInputPolicy {
  create: CreateInputPolicy
  update: UpdateInputPolicy
  /** 更新时是否允许清空为 null/空（仅 update=allowed 时有意义） */
  clearable?: boolean
  /** 新建时的静态初值（可序列化 JSON） */
  initial?: unknown
}

export type ScalarFieldType =
  | 'string'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'

interface FieldDocumentBase {
  /** wire 名（camelCase，即 apiName） */
  name: string
  label: string
  visibility: FieldValueVisibility
  input: FieldInputPolicy
  /** 查询能力直接复用 Filter DSL，不另起操作符 */
  filterable: boolean
  sortable: boolean
  /** 自由搜索仅使用 searchable 字符串字段 */
  searchable?: boolean
}

export interface ScalarFieldDocument extends FieldDocumentBase {
  kind: 'scalar'
  scalarType: ScalarFieldType
  decimalScale?: number
}

export interface UuidFieldDocument extends FieldDocumentBase {
  kind: 'uuid'
}

export interface JsonFieldDocument extends FieldDocumentBase {
  kind: 'json'
}

export interface EnumFieldDocument extends FieldDocumentBase {
  kind: 'enum'
  options: GridEnumOption[]
}

export interface EnumArrayFieldDocument extends FieldDocumentBase {
  kind: 'enumArray'
  options: GridEnumOption[]
}

/**
 * 普通外键：目标 lookup 归目标资源；本字段只保留 picker、静态 FilterState
 * 与必要的场景覆盖（labelField/relation）。
 */
export interface ReferenceFieldDocument extends FieldDocumentBase {
  kind: 'reference'
  targetResource: string
  relation?: string
  /** 覆盖目标 lookup.labelField 时使用 */
  labelField?: string
  picker?: 'default' | 'dialog'
  /** 固定筛选，形状与 Filter DSL 一致 */
  filterState?: FilterState
  /**
   * Actor 无目标读取权时为 true：Grid 可展示原始 ID；
   * Basic Form 不得产生可编辑 ID 输入。
   */
  targetUnavailable?: boolean
}

export interface PolymorphicReferenceVariant {
  value: string
  resource: string
  labelField: string
  label: string
}

export interface PolymorphicReferenceFieldDocument extends FieldDocumentBase {
  kind: 'polymorphicReference'
  discriminator: string
  discriminatorType: 'enum' | 'string'
  variants: PolymorphicReferenceVariant[]
  /** 全部变体均不可读时 true */
  targetUnavailable?: boolean
}

export type FieldDocument =
  | ScalarFieldDocument
  | UuidFieldDocument
  | JsonFieldDocument
  | EnumFieldDocument
  | EnumArrayFieldDocument
  | ReferenceFieldDocument
  | PolymorphicReferenceFieldDocument

export type FieldKind = FieldDocument['kind']

/** 目标资源拥有的规范 lookup（label/search/subtitle/default sort） */
export interface ResourceLookupMeta {
  labelField: string
  searchFields: string[]
  subtitleFields?: string[]
  defaultSort?: SortState
}

/** 列表布局：仅字段引用顺序；列类型/标签从 fields 派生 */
export interface ListLayoutMeta {
  columns: string[]
}

export type FormShowIn = 'create' | 'edit' | 'view'

/** Basic Form 字段摆放：不重复 required/edit 等字段事实 */
export interface BasicFormFieldPlacement {
  field: string
  span?: number
  placeholder?: string
  showIn?: FormShowIn[]
}

export interface BasicFormSection {
  key: string
  label: string
  fields: BasicFormFieldPlacement[]
}

export interface BasicFormTab {
  key: string
  label: string
  sections?: BasicFormSection[]
  fields?: BasicFormFieldPlacement[]
}

export interface BasicFormLayout {
  /** 无分区时的扁平字段表 */
  fields?: BasicFormFieldPlacement[]
  sections?: BasicFormSection[]
  tabs?: BasicFormTab[]
}

export type FormDocument =
  | { kind: 'none' }
  | { kind: 'extension' }
  | { kind: 'basic'; layout: BasicFormLayout }

export type FormKind = FormDocument['kind']

/** 命令 target：collection 不需要记录 ID；row 恰好一个；bulk 非空集合 */
export type CommandTarget = 'collection' | 'row' | 'bulk' | 'rowOrBulk'

/**
 * v2 命令文档：语义 key + 权限能力 + target。
 * 不含 HTTP path/method/mutation；transport 只存在于前端 Adapter。
 */
export interface CommandDocument {
  key: string
  label: string
  target: CommandTarget
  requiredCapability: string
  isDanger?: boolean
  confirmKind?: 'none' | 'generic' | 'audit_doc'
}

/**
 * Actor 投影后的完整资源文档。
 * 标准 CRUD 只贡献 capabilities，不重复进入 commands。
 */
export interface ResourceDocument {
  schemaVersion: ResourceDocumentSchemaVersion
  name: string
  /** 独立显示标签（可与 permissionLabel 不同，如「货币」vs 权限组「币种」） */
  label: string
  permissionPrefix: string
  /** 当前 Actor 有效能力码（不含 read） */
  capabilities: string[]
  fields: FieldDocument[]
  lookup: ResourceLookupMeta
  list: ListLayoutMeta
  form: FormDocument
  commands: CommandDocument[]
}


