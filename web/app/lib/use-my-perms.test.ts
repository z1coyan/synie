import { describe, expect, test } from 'bun:test'
import { myPermsStateOf } from './use-my-perms'

describe('myPermsStateOf', () => {
  test('权限数组转 Set,superAdmin 透传', () => {
    const s = myPermsStateOf({ permissions: ['sys.user:update', 'sys.role_permission:read'], superAdmin: false })
    expect(s.myPerms).toEqual(new Set(['sys.user:update', 'sys.role_permission:read']))
    expect(s.isSuperAdmin).toBe(false)
    expect(s.myPerms.has('sys.user:update')).toBe(true)
    expect(s.myPerms.has('sys.user:delete')).toBe(false)
  })

  test('超管', () => {
    const s = myPermsStateOf({ permissions: [], superAdmin: true })
    expect(s.isSuperAdmin).toBe(true)
    expect(s.myPerms.size).toBe(0)
  })

  test('空权限数组 → 空集合(fail-closed 初始态同款)', () => {
    const s = myPermsStateOf({ permissions: [], superAdmin: false })
    expect(s.myPerms.size).toBe(0)
    expect(s.isSuperAdmin).toBe(false)
  })
})
