import { describe, expect, test } from 'bun:test'
import {
  CANONICAL_ACTIONS,
  FOLDED_ACTIONS,
  foldAction,
  foldPermissionCode,
} from './action-compat.ts'

describe('权限动作兼容映射', () => {
  test('八动作原样保留', () => {
    for (const action of CANONICAL_ACTIONS) {
      expect(foldAction(action)).toBe(action)
    }
  })

  test('产品锁定的折叠：旧码 → 八动作', () => {
    const expected: Record<string, string> = {
      close: 'audit',
      cancel: 'void',
      approve: 'audit',
      activate: 'update',
      deactivate: 'update',
      setDefault: 'update',
      unsetDefault: 'update',
      batch_update: 'update',
      batch_delete: 'delete',
      batch_print: 'print',
      confirm: 'audit',
      unconfirm: 'update',
      import: 'create',
      reverse: 'create',
      ship: 'audit',
      receive: 'audit',
      dispatch: 'update',
    }
    expect(expected).toEqual(
      Object.fromEntries(
        Object.entries(FOLDED_ACTIONS).filter(([k]) => k !== 'recalc' && k !== 'reconcile'),
      ),
    )
    for (const [from, to] of Object.entries(expected)) {
      expect(foldAction(from)).toBe(to)
    }
  })

  test('generate_* 已移除：不折进任何动作', () => {
    expect(foldAction('generate_replenishment')).toBeNull()
    expect(foldAction('generate_material_demand')).toBeNull()
    expect(foldPermissionCode('sales.return:generate_replenishment')).toBeNull()
    expect(foldPermissionCode('mfg.work_order:generate_material_demand')).toBeNull()
  })

  test('完整码按动作段折叠，前缀不动', () => {
    expect(foldPermissionCode('sales.order:close')).toBe('sales.order:audit')
    expect(foldPermissionCode('inv.stock_transfer:ship')).toBe('inv.stock_transfer:audit')
    expect(foldPermissionCode('inv.stock_transfer:receive')).toBe('inv.stock_transfer:audit')
    expect(foldPermissionCode('acc.vat_invoice:reverse')).toBe('acc.vat_invoice:create')
    expect(foldPermissionCode('mfg.demand:dispatch')).toBe('mfg.demand:update')
    expect(foldPermissionCode('sales.order:audit')).toBe('sales.order:audit')
  })

  test('未知旧码不授权（不发明第九动作）', () => {
    expect(foldAction('ninth')).toBeNull()
    expect(foldPermissionCode('sales.order:ninth')).toBeNull()
    expect(foldPermissionCode('not-a-code')).toBeNull()
  })
})
