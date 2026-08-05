/**
 * 内核 ↔ SQL 编译集成测试（工单 04）。
 * 覆盖：公司边界（含空集/可空列）、dept/deptTree/self 范围、无部门用户、via 链、
 * loadAuthorized 的 not_found 语义、create 写侧守卫与归属盖章。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { listAuthorized } from '~/db/list.ts'
import {
  assertCompanyWritable,
  findAuthorized,
  loadAuthorized,
  ownershipStamp,
} from '~/db/load.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { testActor } from '~/platform/authz/testing.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'
import { resolveAuthzTarget } from '~/platform/meta/resource-authz.ts'
import { testDatabaseUrl } from './helpers.ts'

const url = testDatabaseUrl()
const run = url ? describe : describe.skip

run('authz 执行面（PG 集成）', () => {
  const db = createDb(url!)
  const registry = createSealedResourceRegistry()
  const authz = createAuthzEnforcer(registry)

  const companyA = crypto.randomUUID()
  const companyB = crypto.randomUUID()
  const currency = crypto.randomUUID()
  const deptRoot = crypto.randomUUID()
  const deptChild = crypto.randomUUID()
  const deptOther = crypto.randomUUID()
  const userAlice = crypto.randomUUID()
  const userBob = crypto.randomUUID()

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency (id, name, iso_code, symbol, active)
      VALUES (${currency}::uuid, ${'测试币' + currency.slice(0, 4)}, ${'T' + currency.slice(0, 2).toUpperCase()}, 'T', true)
    `.execute(db)
    for (const [id, code] of [
      [companyA, 'AZ'],
      [companyB, 'BZ'],
    ] as const) {
      await sql`
        INSERT INTO bas_company (id, code, name, short_name, base_currency_id)
        VALUES (${id}::uuid, ${code + id.slice(0, 6)}, ${'公司' + code}, ${code}, ${currency}::uuid)
      `.execute(db)
    }
    // 部门树：root → child（公司 A），另建公司 A 的旁支
    await sql`
      INSERT INTO sys_department (id, company_id, parent_id, code, name, path)
      VALUES
        (${deptRoot}::uuid, ${companyA}::uuid, NULL, ${'R' + deptRoot.slice(0, 4)}, '总部', ${'/' + deptRoot + '/'}),
        (${deptChild}::uuid, ${companyA}::uuid, ${deptRoot}::uuid, ${'C' + deptChild.slice(0, 4)}, '冲压车间', ${'/' + deptRoot + '/' + deptChild + '/'}),
        (${deptOther}::uuid, ${companyA}::uuid, NULL, ${'O' + deptOther.slice(0, 4)}, '装配车间', ${'/' + deptOther + '/'})
    `.execute(db)
    for (const [id, name] of [
      [userAlice, 'alice'],
      [userBob, 'bob'],
    ] as const) {
      await sql`
        INSERT INTO sys_user (id, username, name, hashed_password)
        VALUES (${id}::uuid, ${name + id.slice(0, 6)}, ${name}, 'x')
      `.execute(db)
    }
    // 审计日志：公司 A / 公司 B / 全局（company_id 为空）三行
    await sql`
      INSERT INTO sys_audit_log (resource, record_id, action_type, action_name, actor_id, company_id, changes)
      VALUES
        ('t_scope', ${crypto.randomUUID()}::uuid, 'create', 'create', ${userAlice}::uuid, ${companyA}::uuid, '{}'),
        ('t_scope', ${crypto.randomUUID()}::uuid, 'create', 'create', ${userBob}::uuid, ${companyB}::uuid, '{}'),
        ('t_scope', ${crypto.randomUUID()}::uuid, 'create', 'create', ${userAlice}::uuid, NULL, '{}')
    `.execute(db)
  })

  afterAll(async () => {
    await sql`DELETE FROM sys_audit_log WHERE resource = 't_scope'`.execute(db)
    await sql`DELETE FROM sys_user WHERE id = ANY(${[userAlice, userBob]}::uuid[])`.execute(db)
    await sql`DELETE FROM sys_department WHERE company_id = ${companyA}::uuid`.execute(db)
    await sql`DELETE FROM bas_company WHERE id = ANY(${[companyA, companyB]}::uuid[])`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id = ${currency}::uuid`.execute(db)
    await db.destroy()
  })

  function permit(
    resource: string,
    action: string,
    actorInput: Parameters<typeof testActor>[0],
  ): Permit {
    const decision = authz.decideFor(testActor(actorInput), resource, action)
    if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
    return decision.permit
  }

  /** 审计日志按公司范围计数（nullable 公司列） */
  async function auditCount(p: Permit): Promise<number> {
    const target = authz.targetOf('sysAuditLogs')
    const result = await listAuthorized({
      db,
      permit: p,
      target,
      resource: registry.get('sysAuditLogs')!,
      alias: 'sys_audit_log',
      source: sql` FROM sys_audit_log`,
      select: sql`SELECT sys_audit_log.id`,
      defaultOrder: sql`sys_audit_log.id`,
      query: { limit: 200, offset: 0, filter: { resource: { kind: 'text', op: 'eq', value: 't_scope' } } },
      mapRow: (row) => row.id as string,
    })
    return result.count
  }

  test('公司边界：可空公司列声明 → 命中授权公司 ∪ NULL 行', async () => {
    const count = await auditCount(
      permit('sysAuditLogs', 'read', {
        companyIds: [companyA],
        permissions: ['sys.audit_log:read'],
      }),
    )
    expect(count).toBe(2) // 公司 A 一行 + 全局 NULL 一行
  })

  test('公司边界：另一家公司只看到自己 + NULL', async () => {
    const count = await auditCount(
      permit('sysAuditLogs', 'read', {
        companyIds: [companyB],
        permissions: ['sys.audit_log:read'],
      }),
    )
    expect(count).toBe(2)
  })

  test('零公司授权：编译为 false，列表空集（不是报错）', async () => {
    const count = await auditCount(
      permit('sysAuditLogs', 'read', { companyIds: [], permissions: ['sys.audit_log:read'] }),
    )
    expect(count).toBe(0)
  })

  test('全公司授权 / 超管：bypass 看到全部三行', async () => {
    expect(
      await auditCount(
        permit('sysAuditLogs', 'read', {
          allCompanies: true,
          permissions: ['sys.audit_log:read'],
        }),
      ),
    ).toBe(3)
    expect(
      await auditCount(permit('sysAuditLogs', 'read', { superAdmin: true, allCompanies: false })),
    ).toBe(3)
  })

  describe('行级范围（部门 / 本人）', () => {
    // 在 sys_audit_log 上临时挂 owner/dept 绑定：actor_id 作属主列，无部门列
    function ownerBoundTarget() {
      const base = registry.get('sysAuditLogs')!
      const meta: ResourceMeta = {
        ...base,
        authz: { kind: 'company', nullable: true, owner: { column: 'actor_id' } },
      }
      return resolveAuthzTarget('sysAuditLogs', () => meta)
    }

    async function countWith(p: Permit): Promise<number> {
      const result = await listAuthorized({
        db,
        permit: p,
        target: ownerBoundTarget(),
        resource: registry.get('sysAuditLogs')!,
        alias: 'sys_audit_log',
        source: sql` FROM sys_audit_log`,
        select: sql`SELECT sys_audit_log.id`,
        defaultOrder: sql`sys_audit_log.id`,
        query: { limit: 200, offset: 0, filter: { resource: { kind: 'text', op: 'eq', value: 't_scope' } } },
        mapRow: (row) => row.id as string,
      })
      return result.count
    }

    test('self 范围：只看到本人创建的行', async () => {
      const p = permit('sysAuditLogs', 'read', {
        userId: userAlice,
        allCompanies: true,
        scopes: { 'sys.audit_log:read': ['self'] },
      })
      expect(await countWith(p)).toBe(2) // alice 两行
      const bob = permit('sysAuditLogs', 'read', {
        userId: userBob,
        allCompanies: true,
        scopes: { 'sys.audit_log:read': ['self'] },
      })
      expect(await countWith(bob)).toBe(1)
    })

    test('self 范围 + 公司边界同时生效（交集）', async () => {
      const p = permit('sysAuditLogs', 'read', {
        userId: userAlice,
        companyIds: [companyB],
        scopes: { 'sys.audit_log:read': ['self'] },
      })
      // alice 的行里落在（公司 B ∪ NULL）内的只有 NULL 那行
      expect(await countWith(p)).toBe(1)
    })

    test('all 范围覆盖 self（格上最大）', async () => {
      const p = permit('sysAuditLogs', 'read', {
        userId: userBob,
        allCompanies: true,
        scopes: { 'sys.audit_log:read': ['self', 'all'] },
      })
      expect(await countWith(p)).toBe(3)
    })

    test('资源未声明 dept 绑定时 dept 范围编译为空集（fail-closed）', async () => {
      const p = permit('sysAuditLogs', 'read', {
        userId: userAlice,
        allCompanies: true,
        deptId: deptChild,
        deptSubtreeIds: [deptChild],
        scopes: { 'sys.audit_log:read': ['dept'] },
      })
      expect(await countWith(p)).toBe(0)
    })

    test('无部门用户 + deptTree 范围编译为空集', async () => {
      const p = permit('sysAuditLogs', 'read', {
        userId: userAlice,
        allCompanies: true,
        deptId: null,
        deptSubtreeIds: [],
        scopes: { 'sys.audit_log:read': ['deptTree'] },
      })
      expect(await countWith(p)).toBe(0)
    })
  })

  describe('部门列绑定（真实列，深度对拍）', () => {
    // 用 sys_user.department_id 当部门列，sys_user 是 global 资源
    function deptBoundTarget() {
      const base = registry.get('sysUsers')!
      const meta: ResourceMeta = {
        ...base,
        authz: { kind: 'global', dept: { column: 'department_id', mode: 'assigned' } },
      }
      return resolveAuthzTarget('sysUsers', () => meta)
    }

    async function userIds(p: Permit): Promise<string[]> {
      const result = await listAuthorized({
        db,
        permit: p,
        target: deptBoundTarget(),
        resource: registry.get('sysUsers')!,
        alias: 'sys_user',
        source: sql` FROM sys_user`,
        select: sql`SELECT sys_user.id`,
        defaultOrder: sql`sys_user.id`,
        query: { limit: 200, offset: 0 },
        mapRow: (row) => row.id as string,
      })
      return result.results.filter((id: string) => id === userAlice || id === userBob).sort()
    }

    beforeAll(async () => {
      await sql`UPDATE sys_user SET department_id = ${deptChild}::uuid WHERE id = ${userAlice}::uuid`.execute(db)
      await sql`UPDATE sys_user SET department_id = ${deptOther}::uuid WHERE id = ${userBob}::uuid`.execute(db)
    })

    test('dept 范围：只命中本部门', async () => {
      const p = permit('sysUsers', 'read', {
        allCompanies: true,
        deptId: deptChild,
        deptSubtreeIds: [deptChild],
        scopes: { 'sys.user:read': ['dept'] },
      })
      expect(await userIds(p)).toEqual([userAlice])
    })

    test('deptTree 范围：命中子树（含本部门），不含旁支', async () => {
      const p = permit('sysUsers', 'read', {
        allCompanies: true,
        deptId: deptRoot,
        deptSubtreeIds: [deptRoot, deptChild],
        scopes: { 'sys.user:read': ['deptTree'] },
      })
      expect(await userIds(p)).toEqual([userAlice])
    })

    test('deptTree 覆盖 dept（多角色并集取格上最大）', async () => {
      const p = permit('sysUsers', 'read', {
        allCompanies: true,
        deptId: deptOther,
        deptSubtreeIds: [deptOther],
        scopes: { 'sys.user:read': ['dept', 'deptTree'] },
      })
      expect(await userIds(p)).toEqual([userBob])
    })
  })

  describe('全局资源不受公司边界约束（spec §5：只有码级判定）', () => {
    async function globalUserCount(p: Permit): Promise<number> {
      const result = await listAuthorized({
        db,
        permit: p,
        target: authz.targetOf('sysUsers'),
        alias: 'sys_user',
        resource: registry.get('sysUsers')!,
        source: sql` FROM sys_user`,
        select: sql`SELECT sys_user.id`,
        defaultOrder: sql`sys_user.id`,
        query: { limit: 200, offset: 0 },
        mapRow: (row) => row.id as string,
      })
      return result.count
    }

    test('零公司授权的用户照样能读全局主数据（回归：曾被公司边界清空）', async () => {
      const p = permit('sysUsers', 'read', { companyIds: [], permissions: ['sys.user:read'] })
      expect(p.rowFilter.company).toBe('none')
      expect(await globalUserCount(p)).toBeGreaterThanOrEqual(2)
    })

    test('同一 actor 读公司域资源仍为空集（边界只对声明了公司列的资源生效）', async () => {
      expect(
        await auditCount(
          permit('sysAuditLogs', 'read', { companyIds: [], permissions: ['sys.audit_log:read'] }),
        ),
      ).toBe(0)
    })

    test('单条加载同理：全局资源零公司授权可命中', async () => {
      const row = await loadAuthorized({
        db,
        permit: permit('sysUsers', 'read', { companyIds: [], permissions: ['sys.user:read'] }),
        target: authz.targetOf('sysUsers'),
        table: 'sys_user',
        id: userAlice,
      })
      expect(row.id).toBe(userAlice)
    })
  })

  describe('loadAuthorized', () => {
    test('命中返回行；不命中一律 not_found', async () => {
      const row = await sql<{ id: string; company_id: string | null }>`
        SELECT id, company_id FROM sys_audit_log
        WHERE resource = 't_scope' AND company_id = ${companyA}::uuid LIMIT 1
      `.execute(db)
      const id = row.rows[0]!.id
      const target = authz.targetOf('sysAuditLogs')
      const meta = registry.get('sysAuditLogs')!

      const ok = await loadAuthorized({
        db,
        permit: permit('sysAuditLogs', 'read', {
          companyIds: [companyA],
          permissions: ['sys.audit_log:read'],
        }),
        target,
        table: meta.table,
        id,
      })
      expect(ok.id).toBe(id)

      const denied = permit('sysAuditLogs', 'read', {
        companyIds: [companyB],
        permissions: ['sys.audit_log:read'],
      })
      expect(await findAuthorized({ db, permit: denied, target, table: meta.table, id })).toBeNull()
      let err: unknown
      try {
        await loadAuthorized({ db, permit: denied, target, table: meta.table, id })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('not_found')
    })

    test('forUpdate 折叠行锁', async () => {
      const row = await sql<{ id: string }>`
        SELECT id FROM sys_audit_log WHERE resource = 't_scope' LIMIT 1
      `.execute(db)
      const loaded = await loadAuthorized({
        db,
        permit: permit('sysAuditLogs', 'read', { superAdmin: true }),
        target: authz.targetOf('sysAuditLogs'),
        table: 'sys_audit_log',
        id: row.rows[0]!.id,
        forUpdate: true,
      })
      expect(loaded.id).toBe(row.rows[0]!.id)
    })
  })

  describe('via 链', () => {
    test('子行资源解析出宿主与 join 链', () => {
      expect(authz.targetOf('salOrderItems')).toMatchObject({
        rootResource: 'salOrders',
        prefix: 'sales.order',
        chain: [{ childTable: 'sal_order_item', fk: 'order_id', parentTable: 'sal_order' }],
      })
    })

    test('两级链（价格档 → 报价条目 → 报价单）', () => {
      const target = authz.targetOf('salQuotationTiers')
      expect(target.rootResource).toBe('salQuotations')
      expect(target.chain.map((l) => l.parentTable)).toEqual(['sal_quotation_item', 'sal_quotation'])
    })

    test('via 判定用宿主权限码：持宿主 read 即可读子行', () => {
      const actor = testActor({ companyIds: [companyA], permissions: ['sales.order:read'] })
      expect(authz.decideFor(actor, 'salOrderItems', 'read').outcome).toBe('permit')
      const noRead = testActor({ companyIds: [companyA], permissions: ['sales.delivery:read'] })
      expect(authz.decideFor(noRead, 'salOrderItems', 'read').outcome).toBe('deny')
    })

    test('EXISTS 编译可执行（空库亦合法 SQL）', async () => {
      const result = await listAuthorized({
        db,
        permit: permit('salOrderItems', 'read', {
          companyIds: [companyA],
          permissions: ['sales.order:read'],
        }),
        target: authz.targetOf('salOrderItems'),
        alias: 'sal_order_item',
        resource: registry.get('salOrderItems')!,
        source: sql` FROM sal_order_item`,
        select: sql`SELECT sal_order_item.id`,
        defaultOrder: sql`sal_order_item.id`,
        query: { limit: 5, offset: 0 },
        mapRow: (row) => row.id as string,
      })
      expect(result.count).toBe(0)
    })
  })

  describe('写侧守卫与盖章', () => {
    test('create 公司校验：不在边界内 → not_found（不泄露存在性）', () => {
      const p = permit('salOrders', 'create', {
        companyIds: [companyA],
        permissions: ['sales.order:create'],
      })
      expect(() => assertCompanyWritable(p, companyA)).not.toThrow()
      let err: unknown
      try {
        assertCompanyWritable(p, companyB)
      } catch (e) {
        err = e
      }
      expect((err as ApiError).code).toBe('not_found')
    })

    test('bypass 主体不受 create 公司校验', () => {
      const p = permit('salOrders', 'create', { superAdmin: true })
      expect(() => assertCompanyWritable(p, companyB)).not.toThrow()
    })

    test('零公司授权写入一律 not_found', () => {
      const p = permit('salOrders', 'create', {
        companyIds: [],
        permissions: ['sales.order:create'],
      })
      expect(() => assertCompanyWritable(p, companyA)).toThrow(ApiError)
    })

    test('盖章：未声明绑定则不盖；声明 owner/stamped dept 才盖', () => {
      const p = permit('salOrders', 'create', {
        userId: userAlice,
        deptId: deptChild,
        companyIds: [companyA],
        permissions: ['sales.order:create'],
      })
      expect(ownershipStamp(p, authz.targetOf('salOrders'))).toEqual({})

      const base = registry.get('salOrders')!
      const withBindings = resolveAuthzTarget('salOrders', () => ({
        ...base,
        authz: { kind: 'company', owner: {}, dept: { mode: 'stamped' } },
      }))
      expect(ownershipStamp(p, withBindings)).toEqual({
        created_by_id: userAlice,
        owner_dept_id: deptChild,
      })
    })

    test('assigned 部门形态不盖章（业务字段，不受操作者部门约束）', () => {
      const base = registry.get('salOrders')!
      const assigned = resolveAuthzTarget('salOrders', () => ({
        ...base,
        authz: { kind: 'company', dept: { column: 'company_id', mode: 'assigned' } },
      }))
      const p = permit('salOrders', 'create', {
        userId: userAlice,
        deptId: deptChild,
        companyIds: [companyA],
        permissions: ['sales.order:create'],
      })
      expect(ownershipStamp(p, assigned)).toEqual({})
    })
  })

  describe('guard 契约', () => {
    test('未声明的动作即抛（动作码唯一事实源是 meta）', () => {
      expect(() =>
        authz.decideFor(testActor({ superAdmin: true }), 'salOrders', 'no_such_action'),
      ).toThrow(/未声明动作/)
    })

    test('码不满足 → deny(code)，语义 forbidden', () => {
      const decision = authz.decideFor(
        testActor({ companyIds: [companyA], permissions: ['sales.order:read'] }),
        'salOrders',
        'audit',
      )
      expect(decision).toMatchObject({ outcome: 'deny', reason: 'code' })
    })

    test('anyOf 覆盖：import 码也能读（import-as-read 重载）', () => {
      const actor = testActor({ allCompanies: true, permissions: ['hr.attendance_punch:import'] })
      expect(
        authz.decideFor(actor, 'hrAttendancePunches', 'read', {
          anyOf: ['hr.attendance_punch:read', 'hr.attendance_punch:import'],
        }).outcome,
      ).toBe('permit')
      expect(authz.decideFor(actor, 'hrAttendancePunches', 'read').outcome).toBe('deny')
    })

    test('meta 声明的 readAnyOf 真正执行（批次资源持 import 即可读）', () => {
      const actor = testActor({ allCompanies: true, permissions: ['hr.attendance_punch:import'] })
      expect(authz.decideFor(actor, 'hrAttendanceImports', 'read').outcome).toBe('permit')
    })

    test('allOf 跨资源门控：缺任一码即 deny', () => {
      const actor = testActor({ allCompanies: true, permissions: ['sales.reconciliation:create'] })
      expect(
        authz.decideFor(actor, 'salReconciliations', 'create', {
          allOf: ['sales.delivery:read'],
        }),
      ).toMatchObject({ outcome: 'deny', missing: ['sales.delivery:read'] })
    })
  })
})
