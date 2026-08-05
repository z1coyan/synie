import { describe, expect, test } from 'bun:test'
import {
  canAccessCompany,
  companyFilter,
  hasPermission,
  type Actor,
} from '~/platform/authz/actor.ts'
import { testActor } from '~/platform/authz/testing.ts'

/**
 * 扫荡期过渡层（platform/authz/actor.ts）在 Actor v2 之上的行为契约。
 * 判定内核本体的穷举单测在 src/platform/authz/core/decide.test.ts。
 */
describe('过渡层：码级判定', () => {
  test('精确码命中，无通配展开', () => {
    const actor = testActor({ permissions: ['sales.order:read'], companyIds: ['c1'] })
    expect(hasPermission(actor, 'sales.order:read')).toBe(true)
    expect(hasPermission(actor, 'sales.order:audit')).toBe(false)
    expect(hasPermission(testActor({ permissions: ['sales.order:*'] }), 'sales.order:audit')).toBe(
      false,
    )
  })
})

describe('过渡层：Actor', () => {
  const base: Actor = testActor({
    userId: 'u1',
    username: 'zhang',
    permissions: ['sales.order:read'],
    companyIds: ['c1', 'c2'],
  })

  test('超管绕过一切检查', () => {
    const admin = testActor({ superAdmin: true })
    expect(hasPermission(admin, 'whatever:code')).toBe(true)
    expect(companyFilter(admin).bypass).toBe(true)
    expect(canAccessCompany(admin, 'cX')).toBe(true)
  })

  test('全公司授权绕过公司过滤但不绕过功能权限', () => {
    const all = testActor({ allCompanies: true, permissions: ['sales.order:read'] })
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
