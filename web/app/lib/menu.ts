import type { ComponentType, SVGProps } from 'react'
import {
  IconDatabase,
  IconGrid,
  IconLandmark,
  IconPackage,
  IconSliders,
  IconUsers,
} from '~/components/icons'

export interface MenuItem {
  label: string
  path: string
}

export interface MenuGroup {
  label?: string
  items: MenuItem[]
}

export interface MenuModule {
  key: string
  label: string
  description: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  /** 点击一级模块图标时跳转的默认页面 */
  entry: string
  groups: MenuGroup[]
}

export const menuModules: MenuModule[] = [
  {
    key: 'dashboard',
    label: '工作台',
    description: '总览与快捷入口',
    icon: IconGrid,
    entry: '/',
    groups: [{ items: [{ label: '工作台', path: '/' }] }],
  },
  {
    key: 'hr',
    label: '人事',
    description: '组织与员工管理',
    icon: IconUsers,
    entry: '/hr/employees',
    groups: [
      {
        label: '组织人事',
        // 组织架构留待后续任务实现,路由未落地前不注册(注册了会点进 404)
        items: [
          { label: '员工档案', path: '/hr/employees' },
          // 考勤两视图(打卡记录/导入记录)收敛为单入口,页内 tabs 分流(子路由)
          { label: '考勤', path: '/hr/attendance' },
          // 薪资三视图(工资单/发放记录/借款台账)同法收敛为单入口
          { label: '员工薪资', path: '/hr/payroll' },
        ],
      },
    ],
  },
  {
    key: 'finance',
    label: '财务',
    description: '账务与费用管理',
    icon: IconLandmark,
    entry: '/finance/journals',
    groups: [
      {
        label: '账务',
        // 应收/应付/费用报销留待后续任务实现,路由未落地前不注册(注册了会点进 404)
        items: [
          { label: '会计凭证', path: '/finance/journals' },
          { label: '总账分录', path: '/finance/entries' },
          { label: '应收应付', path: '/finance/ar-ap' },
        ],
      },
      {
        label: '发票管理',
        items: [{ label: '增值税发票', path: '/finance/invoices' }],
      },
      {
        label: '资金',
        items: [
          { label: '银行账户', path: '/finance/bank-accounts' },
          { label: '银行流水', path: '/finance/bank-transactions' },
          { label: '流水导入模板', path: '/finance/bank-import-templates' },
          // 承兑两视图(交易/持有)收敛为单入口,页内 tabs 分流(子路由)
          { label: '承兑汇票', path: '/finance/acceptance' },
        ],
      },
    ],
  },
  {
    key: 'scm',
    label: '供应链',
    description: '采购、销售与库存',
    icon: IconPackage,
    entry: '/scm/purchase',
    groups: [
      {
        label: '交易',
        items: [
          { label: '采购订单', path: '/scm/purchase' },
          { label: '销售报价', path: '/scm/quotations' },
          { label: '销售订单', path: '/scm/sales-orders' },
          { label: '销售发货', path: '/scm/sales-deliveries' },
        ],
      },
      {
        label: '仓储',
        items: [
          { label: '物料管理', path: '/scm/materials' },
          { label: '物料分类', path: '/scm/material-categories' },
          { label: '仓库管理', path: '/scm/warehouses' },
        ],
      },
      {
        label: '库存',
        items: [
          { label: '其他库存单', path: '/scm/other-stock' },
          { label: '库存余额', path: '/scm/inventory' },
          { label: '库存分录', path: '/scm/stock-entries' },
        ],
      },
      {
        label: '往来单位',
        items: [
          { label: '客户管理', path: '/scm/customers' },
          { label: '供应商管理', path: '/scm/suppliers' },
        ],
      },
    ],
  },
  {
    key: 'base',
    label: '基础数据',
    description: '公司、货币、计量单位与市场行情等主数据',
    icon: IconDatabase,
    entry: '/system/companies',
    groups: [
      {
        label: '主数据',
        items: [
          { label: '公司管理', path: '/system/companies' },
          { label: '科目表', path: '/base/accounts' },
          { label: '货币管理', path: '/base/currencies' },
          { label: '单位管理', path: '/base/units' },
        ],
      },
      {
        label: '行情',
        items: [
          { label: '行情品种', path: '/base/market-instruments' },
          { label: '行情价点', path: '/base/market-prices' },
        ],
      },
      {
        label: '设置',
        // 多视图收敛为单入口,页内 tabs 分流(子路由,照考勤/薪资先例)
        items: [{ label: '基础设置', path: '/base/settings' }],
      },
    ],
  },
  {
    key: 'system',
    label: '系统管理',
    description: '用户、权限与审计',
    icon: IconSliders,
    entry: '/system/users',
    groups: [
      {
        label: '组织权限',
        items: [
          { label: '用户管理', path: '/system/users' },
          { label: '部门管理', path: '/system/depts' },
          { label: '角色权限', path: '/system/roles' },
        ],
      },
      {
        label: '配置',
        items: [
          { label: '编号规则', path: '/system/numbering' },
          { label: '财务设置', path: '/system/finance' },
          { label: '销售设置', path: '/system/sales' },
        ],
      },
      {
        label: '文件存储',
        items: [
          { label: '存储接入', path: '/system/storages' },
          { label: '文件管理', path: '/system/files' },
        ],
      },
      {
        label: '审计',
        items: [{ label: '操作日志', path: '/system/logs' }],
      },
    ],
  },
]

export function isPathActive(pathname: string, itemPath: string): boolean {
  if (itemPath === '/') return pathname === '/'
  return pathname === itemPath || pathname.startsWith(`${itemPath}/`)
}

export function moduleForPath(pathname: string): MenuModule | undefined {
  return menuModules.find((m) =>
    m.groups.some((g) => g.items.some((it) => isPathActive(pathname, it.path)))
  )
}

export function itemForPath(pathname: string): MenuItem | undefined {
  for (const m of menuModules)
    for (const g of m.groups)
      for (const it of g.items)
        if (isPathActive(pathname, it.path)) return it
  return undefined
}
