import type { SynieRecordDrawerProps } from './SynieRecordDrawer'

/**
 * 资源级抽屉配置:每个资源一份可全局引用的 SynieRecordDrawer 定制。
 * fk 速览(FkPreviewProvider)按 resource 取用;页面用 {...drawerConfig('资源名')}
 * 引用同一份,页面级差异(onSubmit、动态 fields)在 JSX 上继续覆盖。
 */
export type ResourceDrawerConfig = Pick<
  SynieRecordDrawerProps,
  'exclude' | 'fields' | 'contentClassName' | 'extraContent'
> & { label: string }

const registry: Record<string, ResourceDrawerConfig> = {
  sysUsers: { label: '用户' },
  sysRoles: {
    label: '角色',
    fields: {
      code: { required: true, edit: 'createOnly', placeholder: '如 purchaser' },
      name: { required: true, placeholder: '如 采购管理员' },
      enabled: { defaultValue: true },
    },
  },
  basCompanies: { label: '公司' },
  basCurrencies: { label: '货币' },
  basUnits: { label: '单位' },
  basAccounts: { label: '科目' },
  salCustomers: { label: '客户' },
  purSuppliers: { label: '供应商' },
  sysAuditLogs: { label: '操作日志' },
  sysNumberingRules: { label: '编号规则' },
  sysNumberingCounters: { label: '计数器' },
  accGlJournals: { label: '凭证' },
  accGlJournalLines: { label: '分录行' },
  accGlEntries: { label: '分录' },
  accBankAccounts: { label: '银行账户' },
  accBankTransactions: { label: '银行流水' },
  accBankImportTemplates: { label: '流水导入模板' },
  accBankImports: { label: '流水导入' },
  accBankImportItems: { label: '导入行' },
  accVatInvoices: { label: '增值税发票' },
  accBankReconciliations: { label: '对账记录' },
  // 文件速览:存储配置/对象键是实现细节,不进详情
  sysFiles: { label: '文件', exclude: ['storage', 'key'] },
}

/** 取资源抽屉配置;extra 覆盖时 fields 按字段名深合一层,其余浅覆盖 */
export function drawerConfig(resource: string, extra?: Partial<ResourceDrawerConfig>): ResourceDrawerConfig {
  const base = registry[resource] ?? { label: resource }
  if (!extra) return base
  return { ...base, ...extra, fields: { ...base.fields, ...extra.fields } }
}
