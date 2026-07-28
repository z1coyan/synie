import { describe, expect, test } from 'bun:test'
import {
  canAccessCompany,
  companyFilter,
  hasPermission,
  requirePermission,
  type Actor,
} from '~/platform/authz/actor.ts'
import { candidates, matches } from '~/platform/authz/permission.ts'
import { ApiError } from '~/platform/http/errors.ts'

/**
 * 权限矩阵规格：通配 / 公司隔离 / fail-closed。
 * 与 server-go authz + IAM 公司授权语义对齐（工单 02）。
 */
describe('权限矩阵规格', () => {
  test('通配矩阵：精确 < 资源通配 < 域通配 < 全域', () => {
    const cases: Array<{ granted: string; code: string; ok: boolean }> = [
      { granted: 'sys.user:read', code: 'sys.user:read', ok: true },
      { granted: 'sys.user:read', code: 'sys.user:update', ok: false },
      { granted: 'sys.user:*', code: 'sys.user:create', ok: true },
      { granted: 'sys.user:*', code: 'sys.role:read', ok: false },
      { granted: 'sys.*', code: 'sys.role_permission:create', ok: true },
      { granted: 'sys.*', code: 'sales.order:read', ok: false },
      { granted: '*', code: 'anything:at:all', ok: true },
      { granted: 'sales.*', code: 'sales.order:audit', ok: true },
      { granted: 'sales.order:*', code: 'sales.order:delete', ok: true },
      { granted: 'sales.order:*', code: 'sales.delivery:read', ok: false },
    ]
    for (const item of cases) {
      expect(matches(new Set([item.granted]), item.code)).toBe(item.ok)
    }
  })

  test('Candidates 顺序稳定（用于文档与调试）', () => {
    expect(candidates('sys.user:update')).toEqual([
      'sys.user:update',
      'sys.user:*',
      'sys.*',
      '*',
    ])
  })

  test('公司隔离 fail-closed：无公司授权不可访问任何公司', () => {
    const empty: Actor = {
      userId: 'u-empty',
      username: 'empty',
      name: null,
      superAdmin: false,
      allCompanies: false,
      permissions: new Set(['sys.user:read']),
      companyIds: [],
    }
    expect(companyFilter(empty)).toEqual({ bypass: false, ids: [] })
    expect(canAccessCompany(empty, 'c1')).toBe(false)
    expect(canAccessCompany(null, 'c1')).toBe(false)
    expect(companyFilter(null)).toEqual({ bypass: false, ids: [] })
  })

  test('公司授权清单：仅命中授权公司', () => {
    const scoped: Actor = {
      userId: 'u-scoped',
      username: 'scoped',
      name: null,
      superAdmin: false,
      allCompanies: false,
      permissions: new Set(['sys.audit_log:read']),
      companyIds: ['c-a', 'c-b'],
    }
    expect(canAccessCompany(scoped, 'c-a')).toBe(true)
    expect(canAccessCompany(scoped, 'c-b')).toBe(true)
    expect(canAccessCompany(scoped, 'c-x')).toBe(false)
    expect(companyFilter(scoped)).toEqual({ bypass: false, ids: ['c-a', 'c-b'] })
  })

  test('全公司授权绕过数据范围但不绕过功能权限', () => {
    const allCompanies: Actor = {
      userId: 'u-all',
      username: 'all',
      name: null,
      superAdmin: false,
      allCompanies: true,
      permissions: new Set(['sys.user:read']),
      companyIds: [],
    }
    expect(companyFilter(allCompanies).bypass).toBe(true)
    expect(canAccessCompany(allCompanies, 'any')).toBe(true)
    expect(hasPermission(allCompanies, 'sys.user:read')).toBe(true)
    expect(hasPermission(allCompanies, 'sys.user:delete')).toBe(false)
  })

  test('超管绕过权限与公司范围', () => {
    const admin: Actor = {
      userId: 'u-admin',
      username: 'admin',
      name: null,
      superAdmin: true,
      allCompanies: false,
      permissions: new Set(),
      companyIds: [],
    }
    expect(hasPermission(admin, 'sys.role_permission:create')).toBe(true)
    expect(canAccessCompany(admin, 'x')).toBe(true)
    expect(companyFilter(admin).bypass).toBe(true)
  })

  test('requirePermission fail-closed 抛 403', () => {
    const actor: Actor = {
      userId: 'u1',
      username: 'u1',
      name: null,
      superAdmin: false,
      allCompanies: false,
      permissions: new Set(['sys.user:read']),
      companyIds: ['c1'],
    }
    expect(() => requirePermission(actor, 'sys.user:read')).not.toThrow()
    try {
      requirePermission(actor, 'sys.user:delete')
      throw new Error('应抛出 forbidden')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('forbidden')
      expect((err as ApiError).message).toBe('无权限执行该操作')
    }
    try {
      requirePermission(null, 'sys.user:read')
      throw new Error('null actor 应拒绝')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('forbidden')
    }
  })

  test('多权限并集：角色合并后按通配命中', () => {
    // 模拟 Actor 已由 auth store 合并多角色权限
    const merged = new Set(['sys.user:read', 'sys.role:*', 'sales.*'])
    expect(hasPermission({ ...baseActor(merged), companyIds: ['c1'] }, 'sys.role:update')).toBe(true)
    expect(hasPermission({ ...baseActor(merged), companyIds: ['c1'] }, 'sales.order:create')).toBe(true)
    expect(hasPermission({ ...baseActor(merged), companyIds: ['c1'] }, 'sys.user:delete')).toBe(false)
    expect(hasPermission({ ...baseActor(merged), companyIds: ['c1'] }, 'purchase.order:read')).toBe(false)
  })
})

function baseActor(permissions: ReadonlySet<string>): Actor {
  return {
    userId: 'u-merged',
    username: 'merged',
    name: null,
    superAdmin: false,
    allCompanies: false,
    permissions,
    companyIds: [],
  }
}
