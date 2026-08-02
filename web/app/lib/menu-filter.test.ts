import { describe, expect, test } from 'bun:test'
import { menuModules } from './menu.ts'
import { filterMenuModules } from './menu-filter.ts'

describe('菜单白名单过滤派生', () => {
  test('空集合 = 不限制：原样返回（同引用，零行为变化）', () => {
    expect(filterMenuModules(menuModules, [])).toBe(menuModules)
  })

  test('白名单留叶子：未命中项消失，命中项保留', () => {
    const visible = filterMenuModules(menuModules, ['menu.dashboard.todos'])
    const dashboard = visible.find((m) => m.key === 'dashboard')
    expect(dashboard?.groups.flatMap((g) => g.items.map((it) => it.code))).toEqual([
      'menu.dashboard.todos',
    ])
  })

  test('整组勾光则组消失，整模块勾光则模块消失', () => {
    // 只留「员工档案」：hr 其余项消失；无其他模块命中 → 只剩 hr
    const visible = filterMenuModules(menuModules, ['menu.hr.employees'])
    expect(visible.map((m) => m.key)).toEqual(['hr'])
    expect(visible[0]!.groups.flatMap((g) => g.items.map((it) => it.code))).toEqual([
      'menu.hr.employees',
    ])
    // 组标签保留（组织人事组仍有可见项）
    expect(visible[0]!.groups[0]!.label).toBe('组织人事')
  })

  test('组内部分可见时组与模块保留，其它组消失', () => {
    const visible = filterMenuModules(menuModules, [
      'menu.finance.journals', // 账务组
      'menu.finance.settings', // 设置组
    ])
    const finance = visible.find((m) => m.key === 'finance')
    expect(finance?.groups.map((g) => g.label)).toEqual(['账务', '设置'])
  })

  test('模块默认跳转页重算为首个可见项', () => {
    // scm 原 entry = /scm/purchase（采购订单）；只留销售订单 → entry 重算
    const visible = filterMenuModules(menuModules, ['menu.scm.sales-orders'])
    const scm = visible.find((m) => m.key === 'scm')
    expect(scm?.entry).toBe('/scm/sales-orders')
  })

  test('未命中任何 code 时整树为空', () => {
    expect(filterMenuModules(menuModules, ['menu.nope.x'])).toEqual([])
  })

  test('不改动入参（不可变派生）', () => {
    const before = JSON.stringify(menuModules)
    filterMenuModules(menuModules, ['menu.hr.payroll'])
    expect(JSON.stringify(menuModules)).toBe(before)
  })
})
