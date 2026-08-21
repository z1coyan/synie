import { describe, expect, test } from 'bun:test'
import { decide, hasPermission, one, type Actor } from '~/platform/authz/core/index.ts'
import { actorFromFacts } from '~/platform/authz/index.ts'
import { testActor } from '~/platform/authz/testing.ts'

/**
 * 授权矩阵规格（换代版）：精确码匹配（无通配）/ 公司隔离 fail-closed /
 * grants_all 旗标 / 多角色范围并集。见 ADR 2026-08-04 封闭谓词代数。
 */
describe('授权矩阵规格', () => {
  test('精确码匹配：通配一律不再命中', () => {
    const cases: Array<{ granted: string; code: string; ok: boolean }> = [
      { granted: 'sys.user:read', code: 'sys.user:read', ok: true },
      { granted: 'sys.user:read', code: 'sys.user:update', ok: false },
      // 通配语义已取消：授权行里写通配也不匹配任何具体码
      { granted: 'sys.user:*', code: 'sys.user:create', ok: false },
      { granted: 'sys.*', code: 'sys.role_permission:create', ok: false },
      { granted: '*', code: 'sales.order:read', ok: false },
      { granted: 'sales.order:*', code: 'sales.order:delete', ok: false },
    ]
    for (const item of cases) {
      const actor = testActor({ permissions: [item.granted], companyIds: ['c1'] })
      expect(hasPermission(actor, item.code)).toBe(item.ok)
    }
  })

  test('公司边界由 decide 编译（穷举见 core/decide.test.ts）：零授权公司 → none，授权清单 → ids', () => {
    const empty = testActor({ permissions: ['sys.user:read'] })
    const denied = decide(empty, {
      resource: 'sysUsers',
      action: 'read',
      requirement: one('sys.user:read'),
    })
    expect(denied.outcome).toBe('permit')
    if (denied.outcome === 'permit') {
      expect(denied.permit.rowFilter.company).toBe('none')
    }
    const scoped = testActor({
      permissions: ['sys.audit_log:read'],
      companyIds: ['c-a', 'c-b'],
    })
    const permitted = decide(scoped, {
      resource: 'sysAuditLogs',
      action: 'read',
      requirement: one('sys.audit_log:read'),
    })
    expect(permitted.outcome).toBe('permit')
    if (permitted.outcome === 'permit') {
      expect(permitted.permit.rowFilter.company).toEqual({ ids: ['c-a', 'c-b'] })
    }
    expect(hasPermission(null, 'sys.user:read')).toBe(false)
  })

  test('全公司授权绕过数据范围但不绕过功能权限', () => {
    const all = testActor({ allCompanies: true, permissions: ['sys.user:read'] })
    const decision = decide(all, {
      resource: 'sysUsers',
      action: 'read',
      requirement: one('sys.user:read'),
    })
    expect(decision.outcome).toBe('permit')
    if (decision.outcome === 'permit') {
      expect(decision.permit.rowFilter.company).toBe('bypass')
    }
    expect(hasPermission(all, 'sys.user:read')).toBe(true)
    expect(hasPermission(all, 'sys.user:delete')).toBe(false)
  })

  test('超管绕过权限与公司范围', () => {
    const admin = testActor({ superAdmin: true })
    expect(hasPermission(admin, 'sys.role_permission:create')).toBe(true)
    const decision = decide(admin, {
      resource: 'sysRolePermissions',
      action: 'create',
      requirement: one('sys.role_permission:create'),
    })
    expect(decision.outcome).toBe('permit')
    if (decision.outcome === 'permit') {
      expect(decision.permit.rowFilter).toEqual({ company: 'bypass', atoms: ['all'] })
    }
  })

  test('system 主体绕过权限与公司范围', () => {
    const system = testActor({ kind: 'system', allCompanies: true })
    expect(hasPermission(system, 'sys.role_permission:create')).toBe(true)
    const decision = decide(system, {
      resource: 'sysRolePermissions',
      action: 'create',
      requirement: one('sys.role_permission:create'),
    })
    expect(decision.outcome).toBe('permit')
    if (decision.outcome === 'permit') {
      expect(decision.permit.rowFilter).toEqual({ company: 'bypass', atoms: ['all'] })
    }
  })

  test('判定 fail-closed：码不满足一律 deny（HTTP 层由 guard 映射 forbidden）', () => {
    const actor: Actor = testActor({ permissions: ['sys.user:read'], companyIds: ['c1'] })
    expect(
      decide(actor, {
        resource: 'sysUsers',
        action: 'read',
        requirement: one('sys.user:read'),
      }).outcome,
    ).toBe('permit')
    expect(
      decide(actor, {
        resource: 'sysUsers',
        action: 'delete',
        requirement: one('sys.user:delete'),
      }),
    ).toEqual({ outcome: 'deny', reason: 'code', missing: ['sys.user:delete'] })
  })

  test('多角色并集：同码不同范围取格上最大，不同码各自累积', () => {
    const actor = actorFromFacts(
      {
        userId: 'u-merged',
        username: 'merged',
        name: null,
        superAdmin: false,
        allCompanies: false,
        grantsAll: false,
        grants: [
          { permission: 'mfg.demand:read', scope: 'self' },
          { permission: 'mfg.demand:read', scope: 'dept_tree' },
          { permission: 'sys.user:read', scope: 'all' },
        ],
        companyIds: ['c1'],
        deptId: 'd1',
        deptSubtreeIds: ['d1'],
      },
      [],
    )
    expect(hasPermission(actor, 'mfg.demand:read')).toBe(true)
    expect(hasPermission(actor, 'sys.user:read')).toBe(true)
    expect(hasPermission(actor, 'purchase.order:read')).toBe(false)
    // self ∪ deptTree = deptTree（格上最大）
    expect(actor.grants.get('mfg.demand:read')).toBe(2 | 8)
  })

  test('grants_all 旗标：装配期展开为全目录 all 范围（新权限码自动覆盖）', () => {
    const catalog = ['sys.user:read', 'sales.order:audit', 'brand.new:action']
    const actor = actorFromFacts(
      {
        userId: 'u-admin-role',
        username: 'admin-role',
        name: null,
        superAdmin: false,
        allCompanies: true,
        grantsAll: true,
        grants: [],
        companyIds: [],
        deptId: null,
        deptSubtreeIds: [],
      },
      catalog,
    )
    for (const code of catalog) {
      expect(hasPermission(actor, code)).toBe(true)
    }
    expect(hasPermission(actor, 'not.in:catalog')).toBe(false)
  })

  test('旧动作码装配后授权折叠后的行为，不是删除用例', () => {
    const actor = testActor({
      permissions: [
        'sales.order:close',
        'acc.vat_invoice:reverse',
        'acc.gl_journal:cancel',
        'inv.stock_transfer:ship',
        'mfg.demand:dispatch',
        'mfg.work_order:generate_material_demand',
      ],
    })
    expect(hasPermission(actor, 'sales.order:audit')).toBe(true)
    expect(hasPermission(actor, 'acc.vat_invoice:create')).toBe(true)
    expect(hasPermission(actor, 'acc.vat_invoice:void')).toBe(false)
    expect(hasPermission(actor, 'acc.gl_journal:void')).toBe(true)
    expect(hasPermission(actor, 'inv.stock_transfer:audit')).toBe(true)
    expect(hasPermission(actor, 'mfg.demand:update')).toBe(true)
    expect(hasPermission(actor, 'mfg.work_order:create')).toBe(false)
    expect(hasPermission(actor, 'sales.return:generate_replenishment')).toBe(false)
  })

  test('仅作废不能红冲：void 不折进 create', () => {
    const actor = testActor({ permissions: ['acc.vat_invoice:void'] })
    expect(hasPermission(actor, 'acc.vat_invoice:void')).toBe(true)
    expect(hasPermission(actor, 'acc.vat_invoice:create')).toBe(false)
  })

  test('self 范围不能审他人的单：行过滤器只含 self', () => {
    const actor = testActor({
      userId: 'u-self',
      allCompanies: true,
      scopes: { 'sales.order:audit': ['self'] },
    })
    expect(hasPermission(actor, 'sales.order:audit')).toBe(true)
    const decision = decide(actor, {
      resource: 'salOrders',
      action: 'audit',
      requirement: one('sales.order:audit'),
    })
    expect(decision.outcome).toBe('permit')
    if (decision.outcome === 'permit') {
      expect(decision.permit.rowFilter.atoms).toEqual(['self'])
    }
  })

  test('granted 范围：装配层丢弃（第一期不实现）', () => {
    const actor = actorFromFacts(
      {
        userId: 'u-granted',
        username: 'granted',
        name: null,
        superAdmin: false,
        allCompanies: true,
        grantsAll: false,
        grants: [{ permission: 'sales.order:read', scope: 'granted' }],
        companyIds: [],
        deptId: null,
        deptSubtreeIds: [],
      },
      [],
    )
    expect(hasPermission(actor, 'sales.order:read')).toBe(false)
  })
})
