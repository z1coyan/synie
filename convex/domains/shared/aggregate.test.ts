import { describe, expect, test } from 'bun:test'
import type { Actor } from '../../lib/actor'
import { aggregateChildPermissionAction, requireHeadPermission } from './aggregate'

describe('聚合 replace 子行权限策略', () => {
  test('默认仍按子行动作复用父级 create/update/delete 权限', () => {
    const policy = {}
    expect(aggregateChildPermissionAction(policy, 'replace', 'create')).toBe('create')
    expect(aggregateChildPermissionAction(policy, 'replace', 'update')).toBe('update')
    expect(aggregateChildPermissionAction(policy, 'replace', 'delete')).toBe('delete')
  })

  test('制造维护型聚合在 replace 时将全部子行变化视为 update', () => {
    const policy = { replaceChildPermission: 'update' as const }
    expect(aggregateChildPermissionAction(policy, 'replace', 'create')).toBe('update')
    expect(aggregateChildPermissionAction(policy, 'replace', 'update')).toBe('update')
    expect(aggregateChildPermissionAction(policy, 'replace', 'delete')).toBe('update')
    expect(aggregateChildPermissionAction(policy, 'create', 'create')).toBe('create')
  })
})

describe('聚合头权限前置检查', () => {
  test('可在来源读取前检查封闭资源的头动作权限', () => {
    const base = {
      userId: 'user-1' as Actor['userId'], username: 'tester',
      superAdmin: false, allCompanies: false, companyIds: [],
    }
    expect(() => requireHeadPermission({
      ...base,
      permissions: new Set(['mfg.bom:read']),
    }, 'mfgWorkOrders', 'create')).toThrow('无权限执行该操作')
    expect(() => requireHeadPermission({
      ...base,
      permissions: new Set(['mfg.work_order:create']),
    }, 'mfgWorkOrders', 'create')).not.toThrow()
  })
})
