/**
 * 已迁移语义 command：未授权直接调用领域服务仍 fail-closed（forbidden）。
 * 权限码与 ResourceDefinition / CommandDocument.requiredCapability 同源常量。
 */
import { describe, expect, test } from 'bun:test'
import type { Actor } from '../authz/actor.ts'
import { ApiError } from '../http/errors.ts'
import { SYS_STORAGE } from '../files/permissions.ts'
import { HR_ATTENDANCE_DAY } from '~/modules/hr/permissions.ts'
import { ACC_BANK_TRANSACTION } from '~/modules/finance/permissions.ts'
import { requirePermission } from '../authz/actor.ts'
import { createSealedResourceRegistry } from './register-all.ts'
import { testActor } from '~/platform/authz/testing.ts'

function actor(permissions: string[]): Actor {
  return testActor({
    userId: 'u-no-cmd',
    username: 'no-cmd',
    name: null,
    superAdmin: false,
    allCompanies: true,
    permissions: new Set(permissions),
    companyIds: [],
  })
}

describe('语义 command 鉴权与 Catalog 对齐', () => {
  test('setDefault：key 与 requiredCapability 分离；无 update 则 forbidden', () => {
    const registry = createSealedResourceRegistry()
    const cmd = registry
      .buildDocument('sysStorages', {
        ...actor([SYS_STORAGE.read, SYS_STORAGE.update]),
        superAdmin: true,
      })
      .commands.find((c) => c.key === 'setDefault')!
    expect(cmd.key).toBe('setDefault')
    expect(cmd.requiredCapability).toBe('update')
    expect(`${registry.get('sysStorages')!.permissionPrefix}:${cmd.requiredCapability}`).toBe(
      SYS_STORAGE.update,
    )

    const denied = actor([SYS_STORAGE.read])
    expect(() => requirePermission(denied, SYS_STORAGE.update)).toThrow(ApiError)
    try {
      requirePermission(denied, SYS_STORAGE.update)
    } catch (e) {
      expect(e).toMatchObject({ code: 'forbidden' })
    }
  })

  test('recalc：collection command；无 update 则 forbidden', () => {
    const registry = createSealedResourceRegistry()
    const cmd = registry
      .buildDocument('hrAttendanceDays', {
        ...actor([HR_ATTENDANCE_DAY.read, HR_ATTENDANCE_DAY.recalc]),
        superAdmin: true,
      })
      .commands.find((c) => c.key === 'recalc')!
    expect(cmd).toMatchObject({ key: 'recalc', target: 'collection', requiredCapability: 'update' })
    expect(
      `${registry.get('hrAttendanceDays')!.permissionPrefix}:${cmd.requiredCapability}`,
    ).toBe(HR_ATTENDANCE_DAY.recalc)

    const denied = actor([HR_ATTENDANCE_DAY.read])
    expect(() => requirePermission(denied, HR_ATTENDANCE_DAY.recalc)).toThrow()
    try {
      requirePermission(denied, HR_ATTENDANCE_DAY.recalc)
    } catch (e) {
      expect(e).toMatchObject({ code: 'forbidden' })
    }
  })

  test('reconcile：语义 key 非 export；无 update 则 forbidden', () => {
    const registry = createSealedResourceRegistry()
    const cmd = registry
      .buildDocument('accBankTransactions', {
        ...actor([ACC_BANK_TRANSACTION.read, ACC_BANK_TRANSACTION.reconcile]),
        superAdmin: true,
      })
      .commands.find((c) => c.key === 'reconcile')!
    expect(cmd).toMatchObject({ key: 'reconcile', target: 'row', requiredCapability: 'update' })
    expect(cmd.key).not.toBe('export')
    expect(
      `${registry.get('accBankTransactions')!.permissionPrefix}:${cmd.requiredCapability}`,
    ).toBe(ACC_BANK_TRANSACTION.reconcile)

    const denied = actor([ACC_BANK_TRANSACTION.read])
    expect(() => requirePermission(denied, ACC_BANK_TRANSACTION.reconcile)).toThrow()
    try {
      requirePermission(denied, ACC_BANK_TRANSACTION.reconcile)
    } catch (e) {
      expect(e).toMatchObject({ code: 'forbidden' })
    }
  })

  test('标准 CRUD 不进入 commands', () => {
    const registry = createSealedResourceRegistry()
    const storage = registry.buildDocument('sysStorages', {
      ...actor([]),
      superAdmin: true,
    })
    expect(storage.commands.every((c) => !['create', 'update', 'delete', 'read'].includes(c.key))).toBe(
      true,
    )
  })
})
