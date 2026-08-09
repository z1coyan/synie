import { describe, expect, test } from 'bun:test'
import { menuModules } from '~/lib/menu'
import { triState } from '../synie-permission-sheet/matrix'
import {
  allLeafCodes,
  effectiveCount,
  groupLeafCodes,
  moduleLeafCodes,
  orphanCodes,
  serializeChecked,
  withoutOrphans,
} from './menu-tree.ts'

describe('菜单 Sheet 纯逻辑', () => {
  test('叶子码收集：组/模块/全树', () => {
    const dashboard = menuModules.find((m) => m.key === 'dashboard')!
    expect(groupLeafCodes(dashboard.groups[0]!)).toEqual([
      'menu.dashboard.home',
      'menu.dashboard.todos',
    ])
    expect(moduleLeafCodes(dashboard)).toHaveLength(2)
    // 全树 59 项（契约测试保唯一性，这里只锚定规模防手滑）
    expect(allLeafCodes(menuModules)).toHaveLength(59)
  })

  test('已失效项识别：勾选集有而目录无的 code，字典序', () => {
    const checked = new Set(['menu.hr.payroll', 'menu.gone.a', 'menu.gone.b'])
    expect(orphanCodes(checked, menuModules)).toEqual(['menu.gone.a', 'menu.gone.b'])
    expect(orphanCodes(new Set(['menu.hr.payroll']), menuModules)).toEqual([])
  })

  test('有效勾选数只计命中菜单树的 code', () => {
    const checked = new Set(['menu.hr.payroll', 'menu.gone.a'])
    expect(effectiveCount(checked, menuModules)).toBe(1)
    expect(effectiveCount(new Set(), menuModules)).toBe(0)
  })

  test('提交序列化：原样排序（失效项未清理时仍随提交，由后端校验兜底）', () => {
    const checked = new Set(['menu.hr.payroll', 'menu.gone.a', 'menu.hr.employees'])
    expect(serializeChecked(checked)).toEqual(['menu.gone.a', 'menu.hr.employees', 'menu.hr.payroll'])
  })

  test('一键清理：剔除失效项、保留有效项，不改原集合', () => {
    const checked = new Set(['menu.hr.payroll', 'menu.gone.a'])
    const cleaned = withoutOrphans(checked, menuModules)
    expect([...cleaned]).toEqual(['menu.hr.payroll'])
    expect(checked.has('menu.gone.a')).toBe(true)
  })

  test('组/模块三态由叶子推导（父级复选框仅快捷）', () => {
    const hr = menuModules.find((m) => m.key === 'hr')!
    const hrCodes = moduleLeafCodes(hr)
    expect(triState(hrCodes, new Set())).toBe('none')
    expect(triState(hrCodes, new Set(['menu.hr.payroll']))).toBe('some')
    expect(triState(hrCodes, new Set(hrCodes))).toBe('all')
  })
})
