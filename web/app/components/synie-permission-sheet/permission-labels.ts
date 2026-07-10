// 权限矩阵中文标签;漏码原样显示英文(同 logs.tsx 模式),新域/新资源/新动作接入时在此补
export const DOMAIN_LABELS: Record<string, string> = {
  sys: '系统',
  base: '基础资料',
  sales: '销售',
  purchase: '采购',
  acc: '财务',
}

export const RESOURCE_LABELS: Record<string, string> = {
  'sys.user': '用户',
  'sys.role': '角色',
  'sys.role_permission': '角色权限',
  'sys.audit_log': '操作日志',
  'sys.numbering_rule': '编号规则',
  'base.company': '公司',
  'base.unit': '计量单位',
  'base.currency': '币种',
  'base.account': '会计科目',
  'sales.customer': '客户',
  'purchase.supplier': '供应商',
  'sys.file': '附件',
  'acc.gl_entry': '总账分录',
  'acc.gl_journal': '会计凭证',
}

export const ACTION_LABELS: Record<string, string> = {
  create: '新增',
  read: '查看',
  update: '编辑',
  delete: '删除',
  print: '打印',
  import: '导入',
  export: '导出',
  batch_delete: '批量删除',
  batch_update: '批量更新',
  batch_print: '批量打印',
  audit: '审核',
  cancel: '取消',
}

export const domainLabel = (d: string) => DOMAIN_LABELS[d] ?? d
export const resourceLabel = (p: string) => RESOURCE_LABELS[p] ?? p
export const actionLabel = (a: string) => ACTION_LABELS[a] ?? a
