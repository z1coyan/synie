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

/** 服务端资源呈现分类 */
export type PresentationClass = 'basic' | 'extension' | 'none' | 'reference-only'

/**
 * 呈现分类声明：每个注册进 Catalog 的资源必须有明确归宿（注册期强制）。
 * Registry 据此补齐 form.kind（规范化逻辑见 resource-classification.ts）。
 */
export interface ResourceClassification {
  presentation: PresentationClass
  /**
   * 是否有独立交互表单/抽屉（Grid 行打开编辑或专用页）。
   * false：catalog-only / 列表子行 / 只读投影，无 ResourceBinding 写表单要求。
   */
  interactive: boolean
  note?: string
}

/**
 * 附件宿主声明：composition 由此派生 files OwnerRegistry（声明与注册互为镜像）。
 * ownerType 缺省取 table；companyScoped=true 时宿主表必须有 company_id 字段。
 */
export interface AttachmentsMeta {
  /** sys_attachment.owner_type 取值；缺省取 table（员工历史取 hr_employee 单数） */
  ownerType?: string
  /** 附件挂接固化 company_id 并按公司范围鉴权；缺省 false（全局宿主） */
  companyScoped?: boolean
}

/**
 * 行级维度绑定（公司/全局资源可声明；派生资源判定递归宿主故不适用）。
 * 声明即启用对应范围原子——无 owner 声明则该资源不支持 self，无 dept 声明则不支持 dept/deptTree。
 */
export interface AuthzRowBindings {
  /** 属主列绑定，缺省 `created_by_id`（创建人即初始属主）；声明即启用 self 范围 */
  owner?: { column?: string }
  /**
   * 部门列绑定（每资源恰一列，两形态）：
   * - stamped：归属部门，创建时按创建人部门盖章、不可手填，缺省列 `owner_dept_id`
   * - assigned：指派部门，业务字段（如需求单下发车间），填写不受操作者部门约束
   */
  dept?: { column?: string; mode: 'stamped' | 'assigned' }
  /** 记录级授权（预留）：第一期声明即注册期报错，见 spec §9 */
  recordGrants?: boolean
}

/**
 * 授权声明（注册期强制，对齐 classification 先例）。见 ADR 2026-08-04 封闭谓词代数 §5。
 *
 * - `company`：公司域资源，公司边界恒定生效、不可授出
 * - `global`：全局资源，只有码级判定（无公司列）
 * - `via`：派生/子行/只读投影，行级判定递归到宿主资源自己的 decide()
 */
export type ResourceAuthz =
  | (AuthzRowBindings & {
      kind: 'company'
      /** 公司列，缺省 `company_id` */
      companyColumn?: string
      /** 公司列可空（附件/审计等全局宿主行）：编译为 `(col IS NULL OR col = ANY(...))` */
      nullable?: boolean
      /** read 动作的码级组合子：任一命中即可读（取代 readPermissionsAny，声明即执行） */
      readAnyOf?: readonly string[]
    })
  | (AuthzRowBindings & { kind: 'global'; readAnyOf?: readonly string[] })
  | {
      kind: 'via'
      /** 宿主资源名（须在目录内） */
      parent: string
      /** 指向宿主的外键列 */
      fk: string
      readAnyOf?: readonly string[]
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
   * 呈现分类（注册期强制）：register 时缺失即抛错。
   * 类型上可选仅为豁免内部投影 meta（todo 查询 meta 等不进 Catalog 的构造）。
   */
  classification?: ResourceClassification
  /**
   * 独立显示标签（列表/表单/选择器）。缺省取 permissionLabel。
   * 例：币种权限组为「币种」，界面显示「货币」。
   */
  label?: string
  /**
   * 授权声明（注册期强制）：公司域 / 全局 / 派生三形态 + 行级维度绑定。
   * 类型上可选仅为豁免内部投影 meta（todo 查询 meta 等不进 Catalog 的构造）。
   */
  authz?: ResourceAuthz
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
   * prefix 恒等于 permissionPrefix，字段自 fields 派生（含 fk 一层展开），见 numbering/catalog.ts。
   */
  numbering?: boolean
  /**
   * 附件宿主声明（唯一事实源）：声明后本资源可挂 sys_attachment，
   * composition 由 Registry 派生 OwnerRegistry，见 files/owner-registry.ts。
   */
  attachments?: AttachmentsMeta
  /**
   * 待办源声明：本资源开出的待办 source_type（如 sales.reconciliation）。
   * 权限/草稿关联 spec 由消费域 registerSource 注册；
   * composition 断言声明与注册互为镜像，见 todo/source-registry.ts。
   */
  todoSource?: string
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
