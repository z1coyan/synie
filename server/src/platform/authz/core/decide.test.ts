/**
 * 谓词代数内核穷举单测（工单 01）。
 * 覆盖：范围格并集、无部门用户、grants_all 展开语义、码级组合子、错误语义分类。
 */
import { describe, expect, test } from 'bun:test'
import {
  allOf,
  anyOf,
  decide,
  one,
  scopeSetOf,
  SCOPE_ALL,
  SCOPE_DEPT,
  SCOPE_DEPT_TREE,
  SCOPE_SELF,
  systemPermit,
  type Actor,
  type ScopeSet,
} from './index.ts'

function actor(
  grants: Record<string, ScopeSet>,
  overrides: Partial<Actor> = {},
): Actor {
  return {
    kind: 'user',
    userId: 'u1',
    username: 'zhang',
    name: null,
    superAdmin: false,
    companies: { all: false, ids: ['c1', 'c2'] },
    deptId: 'd1',
    deptSubtreeIds: ['d1', 'd1a'],
    grants: new Map(Object.entries(grants)),
    ...overrides,
  }
}

const REQ = { resource: 'salesOrders', action: 'read' }

describe('decide：主体种类', () => {
  test('超管恒 permit + 公司 bypass + all 范围', () => {
    const decision = decide(actor({}, { superAdmin: true }), {
      ...REQ,
      requirement: one('sales.order:read'),
    })
    expect(decision).toMatchObject({
      outcome: 'permit',
      permit: { rowFilter: { company: 'bypass', atoms: ['all'] } },
    })
  })

  test('system 主体恒 permit + 公司 bypass + all 范围', () => {
    const decision = decide(actor({}, { kind: 'system' }), {
      ...REQ,
      requirement: one('sales.order:read'),
    })
    expect(decision).toMatchObject({
      outcome: 'permit',
      permit: { rowFilter: { company: 'bypass', atoms: ['all'] } },
    })
  })

  test('普通用户码不命中 → deny(code)，携带缺失码', () => {
    const decision = decide(actor({ 'sales.order:read': SCOPE_ALL }), {
      ...REQ,
      action: 'audit',
      requirement: one('sales.order:audit'),
    })
    expect(decision).toEqual({ outcome: 'deny', reason: 'code', missing: ['sales.order:audit'] })
  })
})

describe('decide：公司边界', () => {
  test('全公司授权 → bypass', () => {
    const decision = decide(
      actor({ 'sales.order:read': SCOPE_ALL }, { companies: { all: true, ids: [] } }),
      { ...REQ, requirement: one('sales.order:read') },
    )
    expect(decision).toMatchObject({ outcome: 'permit', permit: { rowFilter: { company: 'bypass' } } })
  })

  test('有授权公司 → ids 边界', () => {
    const decision = decide(actor({ 'sales.order:read': SCOPE_ALL }), {
      ...REQ,
      requirement: one('sales.order:read'),
    })
    expect(decision).toMatchObject({
      outcome: 'permit',
      permit: { rowFilter: { company: { ids: ['c1', 'c2'] } } },
    })
  })

  test('零公司授权 → company:none（permit 但行集空，语义 not_found 不是 forbidden）', () => {
    const decision = decide(
      actor({ 'sales.order:read': SCOPE_ALL }, { companies: { all: false, ids: [] } }),
      { ...REQ, requirement: one('sales.order:read') },
    )
    expect(decision).toMatchObject({
      outcome: 'permit',
      permit: { rowFilter: { company: 'none', atoms: ['all'] } },
    })
  })
})

describe('decide：范围格', () => {
  const cases: { granted: ScopeSet; atoms: string[]; note: string }[] = [
    { granted: SCOPE_ALL, atoms: ['all'], note: 'all' },
    { granted: SCOPE_DEPT_TREE, atoms: ['deptTree'], note: 'deptTree' },
    { granted: SCOPE_DEPT, atoms: ['dept'], note: 'dept' },
    { granted: SCOPE_SELF, atoms: ['self'], note: 'self' },
    {
      granted: scopeSetOf('dept', 'self'),
      atoms: ['dept'],
      note: 'self ⊆ dept 取格上最大',
    },
    {
      granted: scopeSetOf('all', 'self', 'dept', 'deptTree'),
      atoms: ['all'],
      note: '四原子并集折叠为 all',
    },
    {
      granted: scopeSetOf('deptTree', 'dept'),
      atoms: ['deptTree'],
      note: 'dept ⊆ deptTree',
    },
  ]

  for (const c of cases) {
    test(`多角色并集：${c.note}`, () => {
      const decision = decide(actor({ 'sales.order:read': c.granted }), {
        ...REQ,
        requirement: one('sales.order:read'),
      })
      expect(decision).toMatchObject({ outcome: 'permit', permit: { rowFilter: { atoms: c.atoms } } })
    })
  }

  test('空范围位集 → permit 但 atoms 空（fail-closed，编译为 false）', () => {
    const decision = decide(actor({ 'sales.order:read': 0 as ScopeSet }), {
      ...REQ,
      requirement: one('sales.order:read'),
    })
    expect(decision).toMatchObject({ outcome: 'permit', permit: { rowFilter: { atoms: [] } } })
  })
})

describe('decide：无部门用户', () => {
  test('dept 范围但用户无部门 → atoms 保留 dept（编译期为空集，不是 forbidden）', () => {
    const decision = decide(
      actor({ 'sales.order:read': SCOPE_DEPT }, { deptId: null, deptSubtreeIds: [] }),
      { ...REQ, requirement: one('sales.order:read') },
    )
    expect(decision).toMatchObject({ outcome: 'permit', permit: { rowFilter: { atoms: ['dept'] } } })
  })
})

describe('decide：码级组合子', () => {
  test('anyOf 任一命中即 permit，范围取命中者格上最大', () => {
    const a = actor({ 'sales.order:read': SCOPE_DEPT, 'sales.delivery:read': SCOPE_ALL })
    expect(
      decide(a, { ...REQ, requirement: anyOf(['sales.order:read', 'sales.delivery:read']) }),
    ).toMatchObject({ outcome: 'permit', permit: { rowFilter: { atoms: ['all'] } } })
  })

  test('anyOf 全部不命中 → deny，missing 列全部候选', () => {
    expect(
      decide(actor({}), { ...REQ, requirement: anyOf(['a:read', 'b:read']) }),
    ).toEqual({ outcome: 'deny', reason: 'code', missing: ['a:read', 'b:read'] })
  })

  test('allOf 全部命中 → permit，范围取格上最小（保守）', () => {
    const a = actor({ 'sales.reconciliation:create': SCOPE_ALL, 'sales.delivery:read': SCOPE_DEPT })
    expect(
      decide(a, {
        ...REQ,
        requirement: allOf(['sales.reconciliation:create', 'sales.delivery:read']),
      }),
    ).toMatchObject({ outcome: 'permit', permit: { rowFilter: { atoms: ['dept'] } } })
  })

  test('allOf 缺一即 deny，missing 只列缺失项', () => {
    const a = actor({ 'sales.reconciliation:create': SCOPE_ALL })
    expect(
      decide(a, {
        ...REQ,
        requirement: allOf(['sales.reconciliation:create', 'sales.delivery:read']),
      }),
    ).toEqual({ outcome: 'deny', reason: 'code', missing: ['sales.delivery:read'] })
  })

  test('组合子不接受空码列表（构造期即拒）', () => {
    expect(() => anyOf([])).toThrow()
    expect(() => allOf([])).toThrow()
  })
})

describe('decide：granted 预留', () => {
  test('scopeSetOf 接受 granted 但 decide 永不产出 granted 原子', () => {
    const decision = decide(actor({ 'sales.order:read': scopeSetOf('self', 'granted') }), {
      ...REQ,
      requirement: one('sales.order:read'),
    })
    // 第一期不实现：装配层拒写 granted，内核侧兜底剥离
    expect(decision).toMatchObject({ outcome: 'permit', permit: { rowFilter: { atoms: ['self'] } } })
  })
})

describe('Permit', () => {
  test('permit 携带 actor / resource / action / rowFilter', () => {
    const a = actor({ 'sales.order:read': SCOPE_DEPT })
    const decision = decide(a, { ...REQ, requirement: one('sales.order:read') })
    if (decision.outcome !== 'permit') throw new Error('应当 permit')
    const permit = decision.permit
    expect(permit.actor).toBe(a)
    expect(permit.resource).toBe('salesOrders')
    expect(permit.action).toBe('read')
    expect(permit.rowFilter).toEqual({ company: { ids: ['c1', 'c2'] }, atoms: ['dept'] })
  })

  test('systemPermit 恒 bypass + all，主体 kind=system', () => {
    const permit = systemPermit('salesOrders', 'read')
    expect(permit.actor.kind).toBe('system')
    expect(permit.actor.superAdmin).toBe(false)
    expect(permit.rowFilter).toEqual({ company: 'bypass', atoms: ['all'] })
  })
})
