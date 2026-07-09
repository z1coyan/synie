// 权限矩阵中文标签;漏码原样显示英文(同 logs.tsx 模式),新域/新资源/新动作接入时在此补
export const DOMAIN_LABELS: Record<string, string> = {
  sys: '系统',
  base: '基础资料',
}

export const RESOURCE_LABELS: Record<string, string> = {
  'sys.role': '角色',
  'sys.user_role': '用户角色',
  'sys.role_permission': '角色权限',
  'sys.user_company': '用户公司',
  'sys.audit_log': '操作日志',
  'base.company': '公司',
  'base.unit': '计量单位',
  'base.currency': '币种',
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
}

export const domainLabel = (d: string) => DOMAIN_LABELS[d] ?? d
export const resourceLabel = (p: string) => RESOURCE_LABELS[p] ?? p
export const actionLabel = (a: string) => ACTION_LABELS[a] ?? a
