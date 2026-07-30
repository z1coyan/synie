import { describe, expect, test } from 'bun:test'
import {
  hasPermission,
  permissionCandidates,
  permissionSetFromMe,
} from './permissions'

describe('前端权限匹配', () => {
  test('候选顺序与服务端一致', () => {
    expect(permissionCandidates('mfg.demand:create')).toEqual([
      'mfg.demand:create',
      'mfg.demand:*',
      'mfg.*',
      '*',
    ])
  })

  test('支持精确、资源、业务域和全域通配', () => {
    expect(
      hasPermission(new Set(['mfg.demand:create']), 'mfg.demand:create'),
    ).toBe(true)
    expect(hasPermission(new Set(['mfg.demand:*']), 'mfg.demand:create')).toBe(
      true,
    )
    expect(hasPermission(new Set(['mfg.*']), 'mfg.demand:create')).toBe(true)
    expect(hasPermission(new Set(['*']), 'mfg.demand:create')).toBe(true)
    expect(hasPermission(new Set(['sales.*']), 'mfg.demand:create')).toBe(
      false,
    )
  })

  test('超级管理员投影为全域通配', () => {
    expect(
      permissionSetFromMe({ permissions: [], superAdmin: true }).has('*'),
    ).toBe(true)
    expect(
      permissionSetFromMe({
        permissions: ['mfg.demand:read'],
        superAdmin: false,
      }).has('*'),
    ).toBe(false)
  })
})
