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
  /**
   * command target 覆盖；缺省从 scope 推导（row/bulk/both→rowOrBulk）。
   * collection：集合命令，不需要记录 ID（如按区间重算）。
   */
  commandTarget?: 'collection' | 'row' | 'bulk' | 'rowOrBulk'
  /** 缺省取 key */
  permissionAction?: string
  isDanger?: boolean
  confirmKind?: 'none' | 'generic' | 'audit_doc'
}

/** 打印循环区声明：占位符 {name.field} 逐行展开目标资源 */
export interface PrintLoopMeta {
  name: string
  resource: string
}

/**
 * 目标资源规范 lookup（label/search/subtitle/default sort）。
 * 引用字段不得重复声明这些事实；缺省时由字段推导。
 */
export interface ResourceLookupDef {
  labelField?: string
  searchFields?: string[]
  subtitleFields?: string[]
  /** 与 Filter SortState 一致：ascending / descending */
  defaultSort?: { column: string; direction: 'ascending' | 'descending' }
}

export interface ResourceMeta {
  /** 资源名，对齐旧 GridMeta 键（如 basCurrencies） */
  name: string
  permissionPrefix: string
  permissionLabel: string
  /**
   * 独立显示标签（列表/表单/选择器）。缺省取 permissionLabel。
   * 例：币种权限组为「币种」，界面显示「货币」。
   */
  label?: string
  /** 无独立权限点的只读投影视图：持任一完整权限码即可读，且不进权限目录 */
  readPermissionsAny?: string[]
  table: string
  fields: FieldMeta[]
  actions: ActionMeta[]
  form?: FormMeta
  /**
   * 选择器 lookup。缺省由字段名推导 name/code 等；
   * 员工/物料/分类/单位等需多字段搜索时显式声明。
   */
  lookup?: ResourceLookupDef
  print?: boolean
  printHead?: boolean
  printLoops?: PrintLoopMeta[]
  /**
   * 编号字段目录：单据头资源声明可绑定自动编号规则。
   * prefix 缺省取 permissionPrefix，字段自 fields 派生（含 fk 一层展开），见 numbering/catalog.ts。
   * DB 编号规则/计数器按 prefix 串存量绑定：权限码改名而规则未迁移时，
   * 用对象形态显式钉住旧 prefix（当前唯一破例：invMaterials 钉 inv.material）。
   */
  numbering?: boolean | { prefix?: string }
  /**
   * 审计声明（唯一事实源）：service 经 platform/audit/spec.ts 派生审计字段白名单，
   * 派生规则 = 非 calculated 物理字段 − id/inserted_at/updated_at − exclude + extra。
   */
  audit?: {
    enabled: boolean
    /** 写审计前脱敏为 [FILTERED] 的键（可为非 meta 字段的写专列，如 hashed_password） */
    sensitiveFields?: string[]
    /** 显式排除出审计白名单的物理字段（派生/投影/密钥列等，保留历史审计面） */
    exclude?: string[]
    /** 附加进审计白名单的非物理字段（如 join 数组 role_ids、写专列 ocr_access_key_secret） */
    extra?: string[]
  }
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
