/**
 * PG 集成（角色授权三元组 (role, code, scope)，工单 13，spec §3）：
 * dept/self 范围落库回读、目录不支持的范围拒授、scope 变化触发审计 diff。
 * 需要完整目录（mfg.demand 声明 assigned 部门、sys.file 声明 owner），故用平台全量 Registry。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { buildTestApp, createPlatformRegistry, testDatabaseUrl } from '../../../test/helpers.ts'
import { ensureAdmin } from '../../../db/seed-admin.ts'
import { ROLE_RESOURCE } from './meta.ts'
import { createIamService } from './index.ts'
import type { PermissionGrant } from './service.ts'

const url = testDatabaseUrl()
const run = url ? describe : describe.skip

run('PG 集成（角色授权三元组）', () => {
  const db = createDb(url!)
  const registry = createPlatformRegistry()
  const authz = createAuthzEnforcer(registry)
  const iam = createIamService(db, registry)
  const adminActor: Actor = testActor({
    userId: crypto.randomUUID(),
    username: 'role-scope-test',
    name: null,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })
  /** superAdmin 凭证：sys.role 为 global，rowFilter 恒全集 */
  function permit(resource: string, action: string): Permit {
    const decision = authz.decideFor(adminActor, resource, action)
    if (decision.outcome !== 'permit') throw new Error(`夹具应当 permit：${resource}:${action}`)
    return decision.permit
  }
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const roleIds: string[] = []

  async function mkRole(code: string): Promise<string> {
    const row = await db
      .insertInto('sys_role')
      .values({ code: `${code}-${suffix}`, name: `${code}-${suffix}` })
      .returning('id')
      .executeTakeFirstOrThrow()
    roleIds.push(row.id)
    return row.id
  }

  const auditRows = async (roleId: string) =>
    db
      .selectFrom('sys_audit_log')
      .select(['changes', 'inserted_at'])
      .where('resource', '=', 'sys_role_permission')
      .where('record_id', '=', roleId)
      .orderBy('inserted_at')
      .execute()

  afterAll(async () => {
    for (const id of roleIds) {
      await db.deleteFrom('sys_role_permission').where('role_id', '=', id).execute()
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'sys_role_permission').where('record_id', '=', id).execute()
      await db.deleteFrom('sys_role').where('id', '=', id).execute()
    }
    await db.destroy()
  })

  test('目录前提：mfg.demand 支持 dept/deptTree，sys.file 支持 self，sys.role 仅 all', () => {
    const catalog = registry.permissionCatalog()
    const scopesOf = (prefix: string) => catalog.find((g) => g.prefix === prefix)?.supportedScopes
    expect(scopesOf('mfg.demand')).toEqual(['all', 'deptTree', 'dept'])
    expect(scopesOf('sys.file')).toEqual(['all', 'self'])
    expect(scopesOf('sys.role')).toEqual(['all'])
  })

  test('dept/self 范围落库并回读三元组；重复码先现者优先', async () => {
    const roleId = await mkRole('scope-roundtrip')
    const synced = await iam.syncRolePermissions(permit(ROLE_RESOURCE, 'update'), roleId, [
      { permission: 'mfg.demand:read', scope: 'dept' },
      // 重复码：先现者优先，后者（deptTree）被丢弃
      { permission: 'mfg.demand:read', scope: 'deptTree' },
      { permission: 'sys.file:read', scope: 'self' },
      { permission: 'sys.role:read', scope: 'all' },
    ])
    const expected: PermissionGrant[] = [
      { permission: 'mfg.demand:read', scope: 'dept' },
      { permission: 'sys.file:read', scope: 'self' },
      { permission: 'sys.role:read', scope: 'all' },
    ]
    expect(synced).toEqual(expected)

    // DB 列存 snake 值（dept_tree ↔ deptTree 的映射另测 UPDATE 路径）
    const raw = await db
      .selectFrom('sys_role_permission')
      .select(['permission', 'scope'])
      .where('role_id', '=', roleId)
      .orderBy('permission')
      .execute()
    expect(raw).toEqual([
      { permission: 'mfg.demand:read', scope: 'dept' },
      { permission: 'sys.file:read', scope: 'self' },
      { permission: 'sys.role:read', scope: 'all' },
    ])

    const readBack = await iam.rolePermissions(permit(ROLE_RESOURCE, 'read'), roleId)
    expect(readBack.map(({ permission, scope }) => ({ permission, scope }))).toEqual(expected)
    for (const row of readBack) expect(row.id).toBeTruthy()
  })

  test('目录不支持的范围拒授（validation），且不落任何行', async () => {
    const roleId = await mkRole('scope-reject')
    // global 资源授 dept
    const err1 = await iam
      .syncRolePermissions(permit(ROLE_RESOURCE, 'update'), roleId, [
        { permission: 'sys.role:read', scope: 'dept' },
      ])
      .catch((e) => e)
    expect(err1).toMatchObject({ code: 'validation' })
    expect(err1.fields.permissions.join(' ')).toContain('sys.role:read')
    // 有 dept 无 owner 的资源授 self
    await expect(
      iam.syncRolePermissions(permit(ROLE_RESOURCE, 'update'), roleId, [
        { permission: 'mfg.demand:read', scope: 'self' },
      ]),
    ).rejects.toMatchObject({ code: 'validation' })
    expect(await iam.rolePermissions(permit(ROLE_RESOURCE, 'read'), roleId)).toEqual([])
  })

  test('sync 语义：scope 变化走 UPDATE 且触发审计 diff；同态不再留痕', async () => {
    const roleId = await mkRole('scope-audit')
    await iam.syncRolePermissions(permit(ROLE_RESOURCE, 'update'), roleId, [
      { permission: 'mfg.demand:read', scope: 'all' },
      { permission: 'sys.role:read', scope: 'all' },
    ])
    expect((await auditRows(roleId)).length).toBe(1)

    // 幂等：同集合同范围不产生新审计
    await iam.syncRolePermissions(permit(ROLE_RESOURCE, 'update'), roleId, [
      { permission: 'sys.role:read', scope: 'all' },
      { permission: 'mfg.demand:read', scope: 'all' },
    ])
    expect((await auditRows(roleId)).length).toBe(1)

    // scope 变化：行保留（id 不变）、列值更新、审计 diff 含 scope
    const idBefore = (
      await db
        .selectFrom('sys_role_permission')
        .select('id')
        .where('role_id', '=', roleId)
        .where('permission', '=', 'mfg.demand:read')
        .executeTakeFirstOrThrow()
    ).id
    const synced = await iam.syncRolePermissions(permit(ROLE_RESOURCE, 'update'), roleId, [
      { permission: 'mfg.demand:read', scope: 'deptTree' },
      { permission: 'sys.role:read', scope: 'all' },
    ])
    expect(synced).toEqual([
      { permission: 'mfg.demand:read', scope: 'deptTree' },
      { permission: 'sys.role:read', scope: 'all' },
    ])
    const rowAfter = await db
      .selectFrom('sys_role_permission')
      .select(['id', 'scope'])
      .where('role_id', '=', roleId)
      .where('permission', '=', 'mfg.demand:read')
      .executeTakeFirstOrThrow()
    expect(rowAfter).toEqual({ id: idBefore, scope: 'dept_tree' })

    const audits = await auditRows(roleId)
    expect(audits.length).toBe(2)
    const diff = (audits[1]!.changes as { permissions: { from: unknown; to: unknown } }).permissions
    expect(diff.from).toEqual([
      { permission: 'mfg.demand:read', scope: 'all' },
      { permission: 'sys.role:read', scope: 'all' },
    ])
    expect(diff.to).toEqual([
      { permission: 'mfg.demand:read', scope: 'deptTree' },
      { permission: 'sys.role:read', scope: 'all' },
    ])
  })

  test('HTTP 端点：PUT 收三元组、回最终态；GET 回读含 scope', async () => {
    await ensureAdmin(db, { username: `it-scope-${suffix}`, password: 'it-scope-pass', name: '范围管理员' })
    const app = await buildTestApp(db)
    const login = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: `it-scope-${suffix}`, password: 'it-scope-pass' }),
    })
    const { token } = (await login.json()) as { token: string }
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

    const roleId = await mkRole('scope-http')
    const put = await app.request(`/api/v1/system/roles/${roleId}/permissions`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        permissions: [
          { permission: 'mfg.demand:read', scope: 'dept' },
          { permission: 'sys.role:read', scope: 'all' },
        ],
      }),
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({
      permissions: [
        { permission: 'mfg.demand:read', scope: 'dept' },
        { permission: 'sys.role:read', scope: 'all' },
      ],
    })

    const get = await app.request(`/api/v1/system/roles/${roleId}/permissions`, { headers })
    const body = (await get.json()) as { rows: { id: string; permission: string; scope: string }[] }
    expect(body.rows.map(({ permission, scope }) => ({ permission, scope }))).toEqual([
      { permission: 'mfg.demand:read', scope: 'dept' },
      { permission: 'sys.role:read', scope: 'all' },
    ])

    // 旧形态（纯字符串数组）被 schema 拒绝
    const legacy = await app.request(`/api/v1/system/roles/${roleId}/permissions`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ permissions: ['sys.role:read'] }),
    })
    expect(legacy.status).toBe(400)
    // granted 预留值第一期拒写
    const granted = await app.request(`/api/v1/system/roles/${roleId}/permissions`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ permissions: [{ permission: 'sys.role:read', scope: 'granted' }] }),
    })
    expect(granted.status).toBe(400)
  })
})
