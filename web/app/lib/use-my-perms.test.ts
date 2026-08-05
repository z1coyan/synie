import { describe, expect, test } from 'bun:test'
import type { MeResponse } from '~/lib/api/session'
import { myPermissionsOf } from './use-my-perms'

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user: { id: 'u1', username: 'u1', name: null },
    superAdmin: false,
    allCompanies: true,
    grants: [
      { code: 'sys.user:update', scope: 'all' },
      { code: 'mfg.demand:create', scope: 'dept' },
    ],
    companyIds: [],
    departmentId: 'd1',
    departmentSubtreeIds: ['d1', 'd1a'],
    menuCodes: [],
    ...overrides,
  }
}

describe('myPermissionsOf', () => {
  test('精确码命中：has/scopeOf 来自 grants（无通配展开）', () => {
    const p = myPermissionsOf(me())
    expect(p.pending).toBe(false)
    expect(p.has('sys.user:update')).toBe(true)
    expect(p.has('sys.user:delete')).toBe(false)
    // 通配残留语义不再存在：域码不推 prefix
    expect(p.has('sys.user:*')).toBe(false)
    expect(p.scopeOf('sys.user:update')).toBe('all')
    expect(p.scopeOf('mfg.demand:create')).toBe('dept')
    expect(p.scopeOf('sys.user:delete')).toBeUndefined()
  })

  test('部门维度透传', () => {
    const p = myPermissionsOf(me())
    expect(p.userId).toBe('u1')
    expect(p.deptId).toBe('d1')
    expect(p.deptSubtreeIds).toEqual(['d1', 'd1a'])
  })

  test('超管：has 恒 true、scopeOf 恒 all', () => {
    const p = myPermissionsOf(me({ superAdmin: true, grants: [] }))
    expect(p.isSuperAdmin).toBe(true)
    expect(p.has('any.code:atall')).toBe(true)
    expect(p.scopeOf('any.code:atall')).toBe('all')
  })

  test('me 缺失（pending/错误）：fail-closed', () => {
    const p = myPermissionsOf(undefined)
    expect(p.pending).toBe(true)
    expect(p.isSuperAdmin).toBe(false)
    expect(p.userId).toBeNull()
    expect(p.has('sys.user:update')).toBe(false)
    expect(p.scopeOf('sys.user:update')).toBeUndefined()
  })
})
