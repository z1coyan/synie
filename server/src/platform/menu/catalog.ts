/**
 * 后端菜单目录：菜单白名单 sync 的校验基准与「已失效项」判定基准。
 *
 * 事实源仍是前端静态菜单声明（web/app/lib/menu.ts，含图标/路径/渲染结构）；
 * 本目录只镜像「模块 → 组 → 菜单项」的 code 与中文标签，不参与渲染、不下发树结构。
 * 两侧由契约测试（web/app/lib/menu-catalog-contract.test.ts）对拍防漂移。
 *
 * 纪律：菜单 code 发布后不可改，改名 = 删旧 code + 增新 code。
 */

export interface MenuCatalogItem {
  code: string
  label: string
}

export interface MenuCatalogGroup {
  label?: string
  items: MenuCatalogItem[]
}

export interface MenuCatalogModule {
  key: string
  label: string
  groups: MenuCatalogGroup[]
}

export const MENU_CODE_PATTERN = /^menu\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/

export const menuCatalog: MenuCatalogModule[] = [
  {
    key: 'dashboard',
    label: '工作台',
    groups: [
      {
        items: [
          { code: 'menu.dashboard.home', label: '工作台' },
          { code: 'menu.dashboard.todos', label: '待办' },
        ],
      },
    ],
  },
  {
    key: 'hr',
    label: '人事',
    groups: [
      {
        label: '组织人事',
        items: [
          { code: 'menu.hr.employees', label: '员工档案' },
          { code: 'menu.hr.attendance', label: '考勤' },
          { code: 'menu.hr.payroll', label: '员工薪资' },
        ],
      },
    ],
  },
  {
    key: 'finance',
    label: '财务',
    groups: [
      {
        label: '账务',
        items: [
          { code: 'menu.finance.journals', label: '会计凭证' },
          { code: 'menu.finance.entries', label: '总账分录' },
          { code: 'menu.finance.ar-ap', label: '应收应付' },
        ],
      },
      {
        label: '发票管理',
        items: [
          { code: 'menu.finance.invoices', label: '增值税发票' },
          { code: 'menu.finance.expense-reports', label: '报销单' },
        ],
      },
      {
        label: '资金',
        items: [
          { code: 'menu.finance.bank-accounts', label: '银行账户' },
          { code: 'menu.finance.bank-transactions', label: '银行流水' },
          { code: 'menu.finance.bank-import-templates', label: '流水导入模板' },
          { code: 'menu.finance.acceptance', label: '承兑汇票' },
        ],
      },
      {
        label: '设置',
        items: [{ code: 'menu.finance.settings', label: '财务设置' }],
      },
    ],
  },
  {
    key: 'sales',
    label: '销售管理',
    groups: [
      {
        label: '交易',
        items: [
          { code: 'menu.sales.quotations', label: '销售报价' },
          { code: 'menu.sales.orders', label: '销售订单' },
          { code: 'menu.sales.deliveries', label: '销售发货' },
          { code: 'menu.sales.returns', label: '销售退货' },
          { code: 'menu.sales.reconciliations', label: '销售对账' },
        ],
      },
      {
        label: '设置',
        items: [{ code: 'menu.sales.settings', label: '销售设置' }],
      },
    ],
  },
  {
    key: 'purchase',
    label: '采购管理',
    groups: [
      {
        label: '交易',
        items: [
          { code: 'menu.purchase.quotations', label: '采购报价' },
          { code: 'menu.purchase.orders', label: '采购订单' },
          { code: 'menu.purchase.receipts', label: '采购入库' },
          { code: 'menu.purchase.reconciliations', label: '采购对账' },
        ],
      },
      {
        label: '委外',
        items: [
          { code: 'menu.purchase.outsourced-issues', label: '委外发料' },
          { code: 'menu.purchase.outsourced-receipts', label: '委外入库' },
        ],
      },
      {
        label: '设置',
        items: [{ code: 'menu.purchase.settings', label: '采购设置' }],
      },
    ],
  },
  {
    key: 'inv',
    label: '库存管理',
    groups: [
      {
        items: [
          { code: 'menu.inv.other-stock', label: '其他库存单' },
          { code: 'menu.inv.balance', label: '库存余额' },
          { code: 'menu.inv.stock-entries', label: '库存分录' },
        ],
      },
    ],
  },
  {
    key: 'mfg',
    label: '生产管理',
    groups: [
      {
        label: '计划',
        items: [
          { code: 'menu.mfg.demands', label: '履约需求单' },
          { code: 'menu.mfg.boms', label: 'BOM' },
          { code: 'menu.mfg.operations', label: '工序' },
          { code: 'menu.mfg.process-templates', label: '工艺模板' },
        ],
      },
      {
        label: '生产',
        items: [
          { code: 'menu.mfg.work-orders', label: '生产工单' },
          { code: 'menu.mfg.outputs', label: '生产入库' },
          { code: 'menu.mfg.molds', label: '模具管理' },
        ],
      },
      {
        label: '设置',
        items: [{ code: 'menu.mfg.settings', label: '生产设置' }],
      },
    ],
  },
  {
    key: 'base',
    label: '基础数据',
    groups: [
      {
        label: '财务组织',
        items: [
          { code: 'menu.base.companies', label: '公司管理' },
          { code: 'menu.base.accounts', label: '科目表' },
          { code: 'menu.base.currencies', label: '货币管理' },
          { code: 'menu.base.units', label: '单位管理' },
        ],
      },
      {
        label: '供应链主数据',
        items: [
          { code: 'menu.base.materials', label: '物料管理' },
          { code: 'menu.base.material-categories', label: '物料分类' },
          { code: 'menu.base.warehouses', label: '仓库管理' },
          { code: 'menu.base.customers', label: '客户管理' },
          { code: 'menu.base.suppliers', label: '供应商管理' },
        ],
      },
      {
        label: '行情',
        items: [{ code: 'menu.base.market', label: '行情' }],
      },
      {
        label: '设置',
        items: [{ code: 'menu.base.settings', label: '基础设置' }],
      },
    ],
  },
  {
    key: 'system',
    label: '系统管理',
    groups: [
      {
        label: '组织权限',
        items: [
          { code: 'menu.system.users', label: '用户管理' },
          { code: 'menu.system.depts', label: '部门管理' },
          { code: 'menu.system.roles', label: '角色权限' },
        ],
      },
      {
        label: '配置',
        items: [
          { code: 'menu.system.numbering', label: '编号规则' },
          { code: 'menu.system.print-templates', label: '打印模板' },
        ],
      },
      {
        label: '文件存储',
        items: [
          { code: 'menu.system.storages', label: '存储接入' },
          { code: 'menu.system.files', label: '文件管理' },
        ],
      },
      {
        label: '审计',
        items: [{ code: 'menu.system.logs', label: '操作日志' }],
      },
    ],
  },
]

const menuCodeSet: ReadonlySet<string> = new Set(
  menuCatalog.flatMap((m) => m.groups.flatMap((g) => g.items.map((it) => it.code))),
)

/** 全部合法菜单 code（去重后按字典序），供 sync 校验与测试对拍。 */
export function allMenuCodes(): string[] {
  return [...menuCodeSet].sort()
}

/** 是否合法（目录内）菜单 code。 */
export function isMenuCode(code: string): boolean {
  return menuCodeSet.has(code)
}

/** 按 code 取菜单标签（报错点名用），未知 code 返回 undefined。 */
export function menuLabelOf(code: string): string | undefined {
  for (const m of menuCatalog)
    for (const g of m.groups)
      for (const it of g.items) if (it.code === code) return it.label
  return undefined
}
