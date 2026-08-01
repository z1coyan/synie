import { describe, expect, test } from 'bun:test'
import { canAccessCompany, companyFilter, hasPermission, type Actor } from '~/platform/authz/actor.ts'
import { candidates, matches } from '~/platform/authz/permission.ts'

describe('权限码匹配', () => {
  test('Candidates 逐级通配', () => {
    expect(candidates('sales.order:audit')).toEqual([
      'sales.order:audit',
      'sales.order:*',
      'sales.*',
      '*',
    ])
    expect(candidates('sys.setting:read')).toEqual(['sys.setting:read', 'sys.setting:*', 'sys.*', '*'])
    expect(candidates('noColon')).toEqual(['noColon', '*'])
  })

  test('matches 按候选命中', () => {
    const perms = new Set(['sales.*'])
    expect(matches(perms, 'sales.order:audit')).toBe(true)
    expect(matches(perms, 'sales.delivery:read')).toBe(true)
    expect(matches(perms, 'purchase.order:read')).toBe(false)
    expect(matches(new Set(['*']), 'anything:at:all')).toBe(true)
    expect(matches(new Set(['sales.order:*']), 'sales.order:audit')).toBe(true)
    expect(matches(new Set(['sales.order:audit']), 'sales.order:read')).toBe(false)
    expect(matches(new Set(), 'sales.order:read')).toBe(false)
  })
})

describe('Actor', () => {
  const base: Actor = {
    userId: 'u1',
    username: 'zhang',
    name: null,
    superAdmin: false,
    allCompanies: false,
    permissions: new Set(['sales.order:read']),
    companyIds: ['c1', 'c2'],
  }

  test('超管绕过一切检查', () => {
    const admin = { ...base, superAdmin: true, permissions: new Set<string>() }
    expect(hasPermission(admin, 'whatever:code')).toBe(true)
    expect(companyFilter(admin).bypass).toBe(true)
    expect(canAccessCompany(admin, 'cX')).toBe(true)
  })

  test('全公司授权绕过公司过滤但不绕过功能权限', () => {
    const all = { ...base, allCompanies: true }
    expect(companyFilter(all).bypass).toBe(true)
    expect(canAccessCompany(all, 'cX')).toBe(true)
    expect(hasPermission(all, 'sales.order:audit')).toBe(false)
  })

  test('普通用户按权限码与公司清单判定', () => {
    expect(hasPermission(base, 'sales.order:read')).toBe(true)
    expect(hasPermission(base, 'sales.order:update')).toBe(false)
    expect(companyFilter(base)).toEqual({ bypass: false, ids: ['c1', 'c2'] })
    expect(canAccessCompany(base, 'c1')).toBe(true)
    expect(canAccessCompany(base, 'c3')).toBe(false)
  })

  test('null actor fail-closed', () => {
    expect(hasPermission(null, 'x')).toBe(false)
    expect(canAccessCompany(null, 'c1')).toBe(false)
    expect(companyFilter(null)).toEqual({ bypass: false, ids: [] })
  })
})
