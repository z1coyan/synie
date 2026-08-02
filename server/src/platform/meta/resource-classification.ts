/**
 * Resource Catalog 呈现分类（工单 10）。
 * 每个服务端资源必须有明确归宿：basic / extension / none / reference-only。
 * dead/typo 仅用于前端历史拼写，不对应服务端资源。
 *
 * 本表在 register 时补齐 form.kind 与 lookup；不改变领域校验与写路径。
 */
import type { FormMeta } from '@synie/shared'
import type { ResourceLookupDef, ResourceMeta } from './types.ts'

/** 服务端资源呈现分类 */
export type PresentationClass = 'basic' | 'extension' | 'none' | 'reference-only'

export interface ResourceClassification {
  presentation: PresentationClass
  /**
   * 是否有独立交互表单/抽屉（Grid 行打开编辑或专用页）。
   * false：catalog-only / 列表子行 / 只读投影，无 ResourceBinding 写表单要求。
   */
  interactive: boolean
  /** 选择器 lookup 覆盖（员工/物料/分类/单位等） */
  lookup?: ResourceLookupDef
  note?: string
}

/**
 * 全量资源分类。新增资源时必须在此登记，否则 seal/基线报告失败。
 */
export const RESOURCE_CLASSIFICATION: Record<string, ResourceClassification> = {
  // —— 基础主数据 basic ——
  basCurrencies: { presentation: 'basic', interactive: true },
  basCompanies: { presentation: 'basic', interactive: true },
  basUnits: {
    presentation: 'basic',
    interactive: true,
    lookup: {
      labelField: 'name',
      searchFields: ['name', 'symbol'],
      subtitleFields: ['symbol'],
    },
  },
  basAccounts: {
    presentation: 'extension',
    interactive: true,
    note: '汇总科目 effects + role 动态可见 + 公司上下文 parent 筛选',
  },
  basMarketInstruments: { presentation: 'basic', interactive: true },
  basMarketPricePoints: {
    presentation: 'basic',
    interactive: true,
    note: 'create-only + void 命令；无 update',
  },

  // —— Party：供应商 basic；客户/员工 extension（附件）——
  purSuppliers: { presentation: 'basic', interactive: true },
  salCustomers: {
    presentation: 'extension',
    interactive: true,
    note: '附件面板 Presentation Extension',
  },
  hrEmployees: {
    presentation: 'extension',
    interactive: true,
    lookup: {
      labelField: 'name',
      searchFields: ['name', 'code', 'attendanceNo'],
      subtitleFields: ['code', 'attendanceNo'],
    },
    note: '身份证影像 extraContent',
  },

  // —— 库存主数据 ——
  invMaterialCategories: {
    presentation: 'basic',
    interactive: true,
    lookup: {
      labelField: 'name',
      searchFields: ['name', 'code'],
      subtitleFields: ['code'],
    },
  },
  invMaterials: {
    presentation: 'extension',
    interactive: true,
    lookup: {
      labelField: 'name',
      searchFields: ['name', 'code', 'spec'],
      subtitleFields: ['code', 'spec'],
    },
    note: '单位转换 tab + 客户料 effects + 图纸附件',
  },
  invMaterialUnits: {
    presentation: 'none',
    interactive: false,
    note: '嵌于物料 PE 子表，无独立抽屉',
  },
  invWarehouses: {
    presentation: 'extension',
    interactive: true,
    note: '协作方多态外键，Basic Form fail-closed',
  },

  // —— 库存单据 extension（行表/动作）——
  invStockDocs: { presentation: 'extension', interactive: true },
  invStockDocItems: { presentation: 'none', interactive: false },
  invStockTransfers: { presentation: 'extension', interactive: true },
  invStockTransferItems: { presentation: 'none', interactive: false },
  invStockCounts: { presentation: 'extension', interactive: true },
  invStockCountItems: { presentation: 'none', interactive: false },
  invStockEntries: {
    presentation: 'none',
    interactive: false,
    note: '只读库存分录',
  },

  // —— 制造 ——
  mfgOperations: { presentation: 'basic', interactive: true },
  mfgProcessTemplates: { presentation: 'extension', interactive: true },
  mfgProcessTemplateItems: { presentation: 'none', interactive: false },
  mfgBoms: { presentation: 'extension', interactive: true },
  mfgBomComponents: { presentation: 'none', interactive: false },
  mfgBomRoutes: { presentation: 'none', interactive: false },
  mfgBomByproducts: { presentation: 'none', interactive: false },
  mfgDemands: { presentation: 'extension', interactive: true },
  mfgDemandItems: { presentation: 'none', interactive: false },
  mfgWorkOrders: { presentation: 'extension', interactive: true },
  mfgWorkOrderComponents: {
    presentation: 'none',
    interactive: false,
    note: '工单 BOM 配料快照；打印循环区',
  },
  mfgWorkOrderRoutes: {
    presentation: 'none',
    interactive: false,
    note: '工单工艺路线快照；打印循环区',
  },
  mfgWorkOrderByproducts: {
    presentation: 'none',
    interactive: false,
    note: '工单副产品快照；打印循环区',
  },
  mfgOutputs: { presentation: 'extension', interactive: true },
  mfgOutputItems: { presentation: 'none', interactive: false },
  mfgSettings: {
    presentation: 'extension',
    interactive: true,
    note: 'update-only 单行设置卡片；含百分比显示转换',
  },

  // —— 贸易单据（动态对手类型 / 子表）——
  salOrders: { presentation: 'extension', interactive: true },
  salOrderItems: { presentation: 'none', interactive: false },
  salQuotations: { presentation: 'extension', interactive: true },
  salQuotationItems: { presentation: 'none', interactive: false },
  salQuotationTiers: { presentation: 'none', interactive: false },
  salDeliveries: {
    presentation: 'extension',
    interactive: true,
    note: 'AggregateDraftAdapter + 装箱',
  },
  salDeliveryItems: { presentation: 'none', interactive: false },
  salDeliveryPackBoxes: { presentation: 'none', interactive: false },
  salDeliveryPackLines: { presentation: 'none', interactive: false },
  salReconciliations: { presentation: 'extension', interactive: true },
  salReconciliationItems: { presentation: 'none', interactive: false },
  salSettings: {
    presentation: 'extension',
    interactive: true,
    note: 'update-only 单行设置卡片',
  },
  salCompanyAccountDefaults: {
    presentation: 'none',
    interactive: false,
    note: '公司科目默认只读投影 / 嵌入设置',
  },

  purOrders: { presentation: 'extension', interactive: true },
  purOrderItems: { presentation: 'none', interactive: false },
  purOrderItemMaterials: { presentation: 'none', interactive: false },
  purOrderItemByproducts: { presentation: 'none', interactive: false },
  purQuotations: { presentation: 'extension', interactive: true },
  purQuotationItems: { presentation: 'none', interactive: false },
  purQuotationTiers: { presentation: 'none', interactive: false },
  purReceipts: { presentation: 'extension', interactive: true },
  purReceiptItems: { presentation: 'none', interactive: false },
  purOutsourcedIssues: { presentation: 'extension', interactive: true },
  purOutsourcedIssueItems: { presentation: 'none', interactive: false },
  purOutsourcedReceipts: { presentation: 'extension', interactive: true },
  purOutsourcedReceiptItems: { presentation: 'none', interactive: false },
  purOutsourcedReceiptItemMaterials: { presentation: 'none', interactive: false },
  purOutsourcedReceiptItemByproducts: { presentation: 'none', interactive: false },
  purReconciliations: { presentation: 'extension', interactive: true },
  purReconciliationItems: { presentation: 'none', interactive: false },

  // —— 财务 ——
  accBankAccounts: { presentation: 'basic', interactive: true },
  accBankTransactions: {
    presentation: 'extension',
    interactive: true,
    note: '对账 reconcile 命令 + 导入',
  },
  accBankImportTemplates: { presentation: 'basic', interactive: true },
  accBankImports: { presentation: 'none', interactive: false },
  accBankImportItems: { presentation: 'none', interactive: false },
  accBankReconciliations: { presentation: 'none', interactive: false },
  accVatInvoices: {
    presentation: 'extension',
    interactive: true,
    note: 'OCR Presentation Extension',
  },
  accExpenseReports: { presentation: 'extension', interactive: true },
  accExpenseReportItems: { presentation: 'none', interactive: false },
  accBills: { presentation: 'extension', interactive: true, note: '票面影像附件' },
  accBillTransactions: { presentation: 'extension', interactive: true },
  accBillHoldings: {
    presentation: 'none',
    interactive: false,
    note: '只读持有投影',
  },
  accGlJournals: { presentation: 'extension', interactive: true },
  accGlJournalLines: { presentation: 'none', interactive: false },
  accGlEntries: { presentation: 'none', interactive: false, note: '只读总账分录' },
  accSettings: {
    presentation: 'extension',
    interactive: true,
    note: 'update-only 单行设置卡片；含 OCR 密钥只写交互',
  },

  // —— HR 业务 ——
  hrAttendancePunches: { presentation: 'none', interactive: false },
  hrAttendanceImports: { presentation: 'none', interactive: false },
  hrAttendanceDays: {
    presentation: 'none',
    interactive: false,
    note: '列表 + collection recalc，无表单',
  },
  hrAttendanceCorrections: { presentation: 'basic', interactive: true },
  hrPayrolls: { presentation: 'extension', interactive: true },
  hrPayrollPayments: { presentation: 'basic', interactive: true, note: 'create+delete，无 update' },
  hrEmployeeLoans: { presentation: 'basic', interactive: true },

  // —— 系统 / 平台 ——
  sysUsers: { presentation: 'basic', interactive: true },
  sysRoles: {
    presentation: 'extension',
    interactive: true,
    note: 'builtin 动态隐藏 + 权限矩阵',
  },
  sysRolePermissions: {
    presentation: 'none',
    interactive: false,
    note: 'catalog-only：嵌于角色 PE，无独立 Client/抽屉',
  },
  sysRoleMenus: {
    presentation: 'none',
    interactive: false,
    note: 'catalog-only：嵌于角色「配置菜单」Sheet，无独立 Client/抽屉',
  },
  sysFiles: {
    presentation: 'none',
    interactive: true,
    note: '上传创建、只读详情与删除；无普通 create/edit Form',
  },
  sysStorages: { presentation: 'basic', interactive: true, note: 'setDefault 命令' },
  sysPrintTemplates: { presentation: 'basic', interactive: true },
  sysNumberingRules: { presentation: 'basic', interactive: true },
  sysNumberingCounters: {
    presentation: 'none',
    interactive: false,
    note: '计数器只读投影',
  },
  sysSettings: {
    presentation: 'extension',
    interactive: true,
    note: 'update-only 单行设置卡片；含调度运行状态',
  },
  sysAuditLogs: { presentation: 'none', interactive: false, note: '只读审计' },

  // —— SCM ——
  scmOrderFlowItems: {
    presentation: 'none',
    interactive: false,
    note: '订单流只读投影',
  },
}

/** 前端历史 dead/typo（无服务端资源） */
export const FRONTEND_DEAD_TYPOS = [
  {
    key: 'mfgSetting',
    server: 'mfgSettings',
    note: 'drawer registry 历史拼写；工单 10 删除',
  },
] as const

export function getResourceClassification(name: string): ResourceClassification {
  const c = RESOURCE_CLASSIFICATION[name]
  if (!c) {
    throw new Error(`资源「${name}」未在 RESOURCE_CLASSIFICATION 中登记`)
  }
  return c
}

/**
 * 按分类补齐 form.kind 与 lookup；不覆盖模块已显式声明的 form.kind / lookup。
 */
export function applyResourceClassification(meta: ResourceMeta): ResourceMeta {
  const c = RESOURCE_CLASSIFICATION[meta.name]
  // Registry 也用于隔离的测试/插件资源；生产资源的全量覆盖由
  // registerAllResources 组合根统一断言，局部 Registry 不依赖产品清单。
  if (!c) return meta
  let form = meta.form
  const desiredKind =
    c.presentation === 'basic'
      ? 'basic'
      : c.presentation === 'extension'
        ? 'extension'
        : 'none'

  if (!form) {
    if (desiredKind !== 'none') {
      form = { kind: desiredKind }
    }
  } else if (!form.kind) {
    form = { ...form, kind: desiredKind as FormMeta['kind'] }
  } else if (
    (c.presentation === 'extension' || c.presentation === 'none') &&
    form.kind === 'basic'
  ) {
    // 分类优先：扩展/无表单不得保持 basic
    form = { ...form, kind: desiredKind as FormMeta['kind'] }
  } else if (c.presentation === 'basic' && form.kind === 'none') {
    // basic 分类一律投影 basic 布局（由 toForm 从可写字段生成 placements）
    form = { ...form, kind: 'basic' }
  }

  const lookup = meta.lookup ?? c.lookup

  return {
    ...meta,
    ...(form ? { form } : {}),
    ...(lookup ? { lookup } : {}),
  }
}

/** 校验 classification 覆盖 registry 全部资源名 */
export function assertClassificationCoverage(resourceNames: string[]): void {
  const missing = resourceNames.filter((n) => !RESOURCE_CLASSIFICATION[n])
  const extra = Object.keys(RESOURCE_CLASSIFICATION).filter((n) => !resourceNames.includes(n))
  if (missing.length || extra.length) {
    throw new Error(
      `分类表与 Registry 不一致: missing=[${missing.join(',')}] extra=[${extra.join(',')}]`,
    )
  }
}
