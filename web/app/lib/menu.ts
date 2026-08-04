import type { ComponentType, SVGProps } from 'react'
import {
  IconDatabase,
  IconFactory,
  IconGrid,
  IconLandmark,
  IconPackage,
  IconShoppingCart,
  IconSliders,
  IconTruck,
  IconUsers,
} from '~/components/icons'

export interface MenuItem {
  /**
   * 稳定菜单码：角色菜单白名单的配置外键。
   * 约定 `menu.<模块 key>.<路径末段>`（'/' 取 home）；发布后不可改，改名 = 删旧 + 增新。
   */
  code: string
  label: string
  path: string
  /**
   * 关联权限资源前缀（呈现层导航索引，非模型事实）：
   * 「权限与菜单」抽屉里菜单项旁标注这些资源名、点击跳转权限矩阵对应行。
   * 多对多——一菜单可多资源（员工薪资→工资单/工资发放/员工借款）、资源可被复用
   * （应收应付→acc.gl_entry）；空数组 = 无专属权限（纯展示页/圈人页）。
   * 与权限目录双向覆盖由 menu-permission-contract.test.ts 对拍，新增资源/菜单漏注解即红。
   */
  relatedPermissions: string[]
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
    groups: [
      {
        items: [
          { code: 'menu.dashboard.home', label: '工作台', path: '/', relatedPermissions: [] },
          // 待办无独立权限门槛,按圈人(公司授权+发票创建)显示列表内容
          { code: 'menu.dashboard.todos', label: '待办', path: '/todos', relatedPermissions: [] },
        ],
      },
    ],
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
          {
            code: 'menu.hr.employees',
            label: '员工档案',
            path: '/hr/employees',
            relatedPermissions: ['hr.employee'],
          },
          // 考勤多视图(打卡记录/日考勤/导入记录)收敛为单入口,页内 tabs 分流(子路由);
          // 导入批次复用打卡记录权限(hr.attendance_punch:import),无独立资源
          {
            code: 'menu.hr.attendance',
            label: '考勤',
            path: '/hr/attendance',
            relatedPermissions: ['hr.attendance_punch', 'hr.attendance_day', 'hr.attendance_correction'],
          },
          // 薪资三视图(工资单/发放记录/借款台账)同法收敛为单入口
          {
            code: 'menu.hr.payroll',
            label: '员工薪资',
            path: '/hr/payroll',
            relatedPermissions: ['hr.payroll', 'hr.payroll_payment', 'hr.employee_loan'],
          },
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
        items: [
          {
            code: 'menu.finance.journals',
            label: '会计凭证',
            path: '/finance/journals',
            relatedPermissions: ['acc.gl_journal'],
          },
          {
            code: 'menu.finance.entries',
            label: '总账分录',
            path: '/finance/entries',
            relatedPermissions: ['acc.gl_entry'],
          },
          // 应收应付报表是纯 GL 时点余额视图,复用总账分录 read 权限码
          {
            code: 'menu.finance.ar-ap',
            label: '应收应付',
            path: '/finance/ar-ap',
            relatedPermissions: ['acc.gl_entry'],
          },
        ],
      },
      {
        label: '发票管理',
        items: [
          {
            code: 'menu.finance.invoices',
            label: '增值税发票',
            path: '/finance/invoices',
            relatedPermissions: ['acc.vat_invoice'],
          },
          {
            code: 'menu.finance.expense-reports',
            label: '报销单',
            path: '/finance/expense-reports',
            relatedPermissions: ['acc.expense_report'],
          },
        ],
      },
      {
        label: '资金',
        items: [
          {
            code: 'menu.finance.bank-accounts',
            label: '银行账户',
            path: '/finance/bank-accounts',
            relatedPermissions: ['acc.bank_account'],
          },
          {
            code: 'menu.finance.bank-transactions',
            label: '银行流水',
            path: '/finance/bank-transactions',
            relatedPermissions: ['acc.bank_transaction'],
          },
          {
            code: 'menu.finance.bank-import-templates',
            label: '流水导入模板',
            path: '/finance/bank-import-templates',
            relatedPermissions: ['acc.bank_import_template'],
          },
          // 承兑多视图(票据/交易/持有)收敛为单入口,页内 tabs 分流(子路由)
          {
            code: 'menu.finance.acceptance',
            label: '承兑汇票',
            path: '/finance/acceptance',
            relatedPermissions: ['acc.bill', 'acc.bill_transaction', 'acc.bill_holding'],
          },
        ],
      },
      {
        label: '设置',
        items: [
          {
            code: 'menu.finance.settings',
            label: '财务设置',
            path: '/finance/settings',
            relatedPermissions: ['acc.setting'],
          },
        ],
      },
    ],
  },
  {
    key: 'sales',
    label: '销售管理',
    description: '报价、订单、发货与对账',
    icon: IconShoppingCart,
    entry: '/sales/orders',
    groups: [
      {
        label: '交易',
        items: [
          {
            code: 'menu.sales.quotations',
            label: '销售报价',
            path: '/sales/quotations',
            relatedPermissions: ['sales.quotation'],
          },
          {
            code: 'menu.sales.orders',
            label: '销售订单',
            path: '/sales/orders',
            relatedPermissions: ['sales.order'],
          },
          {
            code: 'menu.sales.deliveries',
            label: '销售发货',
            path: '/sales/deliveries',
            relatedPermissions: ['sales.delivery'],
          },
          {
            code: 'menu.sales.reconciliations',
            label: '销售对账',
            path: '/sales/reconciliations',
            relatedPermissions: ['sales.reconciliation'],
          },
        ],
      },
      {
        label: '设置',
        // 销售设置独立页(原供应链设置页销售 Tab 拆出)
        items: [
          {
            code: 'menu.sales.settings',
            label: '销售设置',
            path: '/sales/settings',
            relatedPermissions: ['sales.setting'],
          },
        ],
      },
    ],
  },
  {
    key: 'purchase',
    label: '采购管理',
    description: '报价、订单、入库、委外与对账',
    icon: IconTruck,
    entry: '/purchase/orders',
    groups: [
      {
        label: '交易',
        items: [
          {
            code: 'menu.purchase.quotations',
            label: '采购报价',
            path: '/purchase/quotations',
            relatedPermissions: ['purchase.quotation'],
          },
          {
            code: 'menu.purchase.orders',
            label: '采购订单',
            path: '/purchase/orders',
            relatedPermissions: ['purchase.order'],
          },
          {
            code: 'menu.purchase.receipts',
            label: '采购入库',
            path: '/purchase/receipts',
            relatedPermissions: ['purchase.receipt'],
          },
          {
            code: 'menu.purchase.reconciliations',
            label: '采购对账',
            path: '/purchase/reconciliations',
            relatedPermissions: ['purchase.reconciliation'],
          },
        ],
      },
      {
        label: '委外',
        items: [
          {
            code: 'menu.purchase.outsourced-issues',
            label: '委外发料',
            path: '/purchase/outsourced-issues',
            relatedPermissions: ['purchase.outsourced_issue'],
          },
          {
            code: 'menu.purchase.outsourced-receipts',
            label: '委外入库',
            path: '/purchase/outsourced-receipts',
            relatedPermissions: ['purchase.outsourced_receipt'],
          },
        ],
      },
      {
        label: '设置',
        // 采购设置复用 sales.setting 资源(全局标量单行存 sal_setting)
        items: [
          {
            code: 'menu.purchase.settings',
            label: '采购设置',
            path: '/purchase/settings',
            relatedPermissions: ['sales.setting'],
          },
        ],
      },
    ],
  },
  {
    key: 'inv',
    label: '库存管理',
    description: '库存单据、余额与分录',
    icon: IconPackage,
    entry: '/inventory/balance',
    groups: [
      {
        items: [
          // 其他库存单页内三 tab:出入库/调拨/盘点(非领域实体入口,无独立资源)
          {
            code: 'menu.inv.other-stock',
            label: '其他库存单',
            path: '/inventory/other-stock',
            relatedPermissions: ['inv.stock_doc', 'inv.stock_transfer', 'inv.stock_count'],
          },
          // 库存余额是分录只读聚合视图,复用库存分录 read 权限码
          {
            code: 'menu.inv.balance',
            label: '库存余额',
            path: '/inventory/balance',
            relatedPermissions: ['inv.stock_entry'],
          },
          {
            code: 'menu.inv.stock-entries',
            label: '库存分录',
            path: '/inventory/stock-entries',
            relatedPermissions: ['inv.stock_entry'],
          },
        ],
      },
    ],
  },
  {
    key: 'mfg',
    label: '生产管理',
    description: '需求、BOM、工单与生产入库',
    icon: IconFactory,
    entry: '/mfg/work-orders',
    groups: [
      {
        label: '计划',
        items: [
          {
            code: 'menu.mfg.demands',
            label: '履约需求单',
            path: '/mfg/demands',
            relatedPermissions: ['mfg.demand'],
          },
          {
            code: 'menu.mfg.boms',
            label: 'BOM',
            path: '/mfg/boms',
            relatedPermissions: ['mfg.bom'],
          },
          {
            code: 'menu.mfg.operations',
            label: '工序',
            path: '/mfg/operations',
            relatedPermissions: ['mfg.operation'],
          },
          {
            code: 'menu.mfg.process-templates',
            label: '工艺模板',
            path: '/mfg/process-templates',
            relatedPermissions: ['mfg.route_template'],
          },
        ],
      },
      {
        label: '生产',
        items: [
          {
            code: 'menu.mfg.work-orders',
            label: '生产工单',
            path: '/mfg/work-orders',
            relatedPermissions: ['mfg.work_order'],
          },
          {
            code: 'menu.mfg.outputs',
            label: '生产入库',
            path: '/mfg/outputs',
            relatedPermissions: ['mfg.output'],
          },
          {
            code: 'menu.mfg.molds',
            label: '模具管理',
            path: '/mfg/molds',
            relatedPermissions: ['mfg.mold_design'],
          },
        ],
      },
      {
        label: '设置',
        items: [
          {
            code: 'menu.mfg.settings',
            label: '生产设置',
            path: '/mfg/settings',
            relatedPermissions: ['mfg.setting'],
          },
        ],
      },
    ],
  },
  {
    key: 'base',
    label: '基础数据',
    description: '公司、物料、往来单位与计量等主数据',
    icon: IconDatabase,
    entry: '/system/companies',
    groups: [
      {
        label: '财务组织',
        items: [
          {
            code: 'menu.base.companies',
            label: '公司管理',
            path: '/system/companies',
            relatedPermissions: ['base.company'],
          },
          {
            code: 'menu.base.accounts',
            label: '科目表',
            path: '/base/accounts',
            relatedPermissions: ['base.account'],
          },
          {
            code: 'menu.base.currencies',
            label: '货币管理',
            path: '/base/currencies',
            relatedPermissions: ['base.currency'],
          },
          {
            code: 'menu.base.units',
            label: '单位管理',
            path: '/base/units',
            relatedPermissions: ['base.unit'],
          },
        ],
      },
      {
        label: '供应链主数据',
        items: [
          {
            code: 'menu.base.materials',
            label: '物料管理',
            path: '/scm/materials',
            relatedPermissions: ['base.material'],
          },
          {
            code: 'menu.base.material-categories',
            label: '物料分类',
            path: '/scm/material-categories',
            relatedPermissions: ['base.material_category'],
          },
          {
            code: 'menu.base.warehouses',
            label: '仓库管理',
            path: '/scm/warehouses',
            relatedPermissions: ['base.warehouse'],
          },
          {
            code: 'menu.base.customers',
            label: '客户管理',
            path: '/scm/customers',
            // 地址在客户抽屉内维护,无独立菜单
            relatedPermissions: ['base.customer', 'base.party_address'],
          },
          {
            code: 'menu.base.suppliers',
            label: '供应商管理',
            path: '/scm/suppliers',
            relatedPermissions: ['base.supplier'],
          },
        ],
      },
      {
        label: '行情',
        // 行情页=图+品种/价点双 Tab,权限分两套按能力拼装(不并资源码)
        items: [
          {
            code: 'menu.base.market',
            label: '行情',
            path: '/base/market',
            relatedPermissions: ['base.market_instrument', 'base.market_price'],
          },
        ],
      },
      {
        label: '设置',
        // 多视图收敛为单入口,页内 tabs 分流(子路由,照考勤/薪资先例);行情拉取落 sys_setting
        items: [
          {
            code: 'menu.base.settings',
            label: '基础设置',
            path: '/base/settings',
            relatedPermissions: ['sys.setting'],
          },
        ],
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
          {
            code: 'menu.system.users',
            label: '用户管理',
            path: '/system/users',
            relatedPermissions: ['sys.user'],
          },
          // TODO(另案): 部门管理路由未落地(无 depts.tsx),死菜单项,去留待拍板
          {
            code: 'menu.system.depts',
            label: '部门管理',
            path: '/system/depts',
            relatedPermissions: [],
          },
          {
            code: 'menu.system.roles',
            label: '角色权限',
            path: '/system/roles',
            relatedPermissions: ['sys.role', 'sys.role_permission', 'sys.role_menu'],
          },
        ],
      },
      {
        label: '配置',
        items: [
          {
            code: 'menu.system.numbering',
            label: '编号规则',
            path: '/system/numbering',
            relatedPermissions: ['sys.numbering_rule'],
          },
          {
            code: 'menu.system.print-templates',
            label: '打印模板',
            path: '/system/print-templates',
            relatedPermissions: ['sys.print_template'],
          },
        ],
      },
      {
        label: '文件存储',
        items: [
          {
            code: 'menu.system.storages',
            label: '存储接入',
            path: '/system/storages',
            relatedPermissions: ['sys.storage'],
          },
          {
            code: 'menu.system.files',
            label: '文件管理',
            path: '/system/files',
            relatedPermissions: ['sys.file'],
          },
        ],
      },
      {
        label: '审计',
        items: [
          {
            code: 'menu.system.logs',
            label: '操作日志',
            path: '/system/logs',
            relatedPermissions: ['sys.audit_log'],
          },
        ],
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
