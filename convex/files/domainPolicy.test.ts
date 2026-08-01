import { describe, expect, test } from 'bun:test'
import type { Actor } from '../lib/actor'
import { actorCanManageFrozenAttachment } from './domain'

function actor(input: Partial<Actor> = {}): Actor {
  return {
    userId: 'user-1' as Actor['userId'],
    username: 'tester',
    superAdmin: false,
    allCompanies: false,
    companyIds: [],
    permissions: new Set(['sys.file:delete', 'mfg.work_order:read', 'inv.material:read']),
    ...input,
  }
}

describe('失效宿主附件清理授权', () => {
  test('使用挂接固化的公司范围，不依赖宿主存活', () => {
    expect(actorCanManageFrozenAttachment(
      actor({ companyIds: ['company-1'] }),
      { ownerType: 'mfg_work_order', companyId: 'company-1' },
    )).toBe(true)
    expect(actorCanManageFrozenAttachment(
      actor({ companyIds: ['company-2'] }),
      { ownerType: 'mfg_work_order', companyId: 'company-1' },
    )).toBe(false)
    expect(actorCanManageFrozenAttachment(
      actor(),
      { ownerType: 'inv_material', companyId: null },
    )).toBe(true)
  })

  test('损坏的未知宿主不会被清理权限绕过', () => {
    expect(() => actorCanManageFrozenAttachment(
      actor({ superAdmin: true }),
      { ownerType: 'unknown', companyId: null },
    )).toThrow('未知的宿主类型')
  })

  test('公司型宿主缺公司或缺宿主读取权限时 fail-closed', () => {
    expect(actorCanManageFrozenAttachment(
      actor(),
      { ownerType: 'mfg_work_order', companyId: null },
    )).toBe(false)
    expect(actorCanManageFrozenAttachment(
      actor({
        companyIds: ['company-1'],
        permissions: new Set(['sys.file:delete']),
      }),
      { ownerType: 'mfg_work_order', companyId: 'company-1' },
    )).toBe(false)
  })
})
