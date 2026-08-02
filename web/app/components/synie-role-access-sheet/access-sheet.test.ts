import { describe, expect, test } from 'bun:test'
import { domainOfPrefix, permRowId, savePlan, setsEqual } from './access-sheet'

describe('setsEqual', () => {
  test('同内容集合相等，与插入顺序无关', () => {
    expect(setsEqual(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true)
  })
  test('大小不等即不等', () => {
    expect(setsEqual(new Set(['a']), new Set(['a', 'b']))).toBe(false)
  })
  test('同大小不同元不等', () => {
    expect(setsEqual(new Set(['a', 'c']), new Set(['a', 'b']))).toBe(false)
  })
  test('双空集相等', () => {
    expect(setsEqual(new Set(), new Set())).toBe(true)
  })
})

describe('savePlan', () => {
  test('两区均 dirty 且可写：菜单在前权限在后', () => {
    expect(
      savePlan({ menusDirty: true, menusWritable: true, permsDirty: true, permsWritable: true }),
    ).toEqual(['menus', 'permissions'])
  })
  test('只读区不入计划（不可写即跳过，即使 dirty）', () => {
    expect(
      savePlan({ menusDirty: true, menusWritable: false, permsDirty: true, permsWritable: true }),
    ).toEqual(['permissions'])
  })
  test('未改动区不入计划', () => {
    expect(
      savePlan({ menusDirty: false, menusWritable: true, permsDirty: true, permsWritable: true }),
    ).toEqual(['permissions'])
  })
  test('全不 dirty 或全不可写：空计划（保存钮禁用）', () => {
    expect(
      savePlan({ menusDirty: false, menusWritable: true, permsDirty: false, permsWritable: true }),
    ).toEqual([])
    expect(
      savePlan({ menusDirty: true, menusWritable: false, permsDirty: true, permsWritable: false }),
    ).toEqual([])
  })
})

describe('domainOfPrefix', () => {
  test('取 prefix 首段为域 key（与权限矩阵 groupByDomain 一致）', () => {
    expect(domainOfPrefix('hr.payroll')).toBe('hr')
    expect(domainOfPrefix('sys.role_menu')).toBe('sys')
    expect(domainOfPrefix('acc.gl_entry')).toBe('acc')
  })
})

describe('permRowId', () => {
  test('锚点 id 稳定且含 prefix', () => {
    expect(permRowId('hr.payroll')).toBe('perm-row-hr.payroll')
  })
})
