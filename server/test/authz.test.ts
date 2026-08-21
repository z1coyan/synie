import { describe, expect, test } from 'bun:test'
import { hasPermission, type Actor } from '~/platform/authz/core/index.ts'
import { testActor } from '~/platform/authz/testing.ts'

/**
 * core `hasPermission`（呈现投影用的码持有查询）行为契约。
 * 判定内核本体的穷举单测在 src/platform/authz/core/decide.test.ts；
 * 公司边界语义由 decide 的 RowFilter.company 承载（见 test/iam-authz-matrix.test.ts）。
 */
describe('hasPermission：码级判定', () => {
  test('精确码命中，无通配展开', () => {
    const actor = testActor({ permissions: ['sales.order:read'], companyIds: ['c1'] })
    expect(hasPermission(actor, 'sales.order:read')).toBe(true)
    expect(hasPermission(actor, 'sales.order:audit')).toBe(false)
    expect(hasPermission(testActor({ permissions: ['sales.order:*'] }), 'sales.order:audit')).toBe(
      false,
    )
  })
})

describe('hasPermission：主体旁路', () => {
  test('超管与 system 恒真', () => {
    const admin = testActor({ superAdmin: true })
    expect(hasPermission(admin, 'whatever:code')).toBe(true)
    const system = testActor({ kind: 'system' })
    expect(hasPermission(system, 'whatever:code')).toBe(true)
  })

  test('普通用户按权限码判定；全公司授权不放大功能权限', () => {
    const base: Actor = testActor({
      userId: 'u1',
      username: 'zhang',
      permissions: ['sales.order:read'],
      companyIds: ['c1', 'c2'],
    })
    expect(hasPermission(base, 'sales.order:read')).toBe(true)
    expect(hasPermission(base, 'sales.order:update')).toBe(false)
    const all = testActor({ allCompanies: true, permissions: ['sales.order:read'] })
    expect(hasPermission(all, 'sales.order:audit')).toBe(false)
  })

  test('null actor fail-closed', () => {
    expect(hasPermission(null, 'x')).toBe(false)
  })
})
