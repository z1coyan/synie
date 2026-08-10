import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import { createRegistry } from '~/platform/meta/registry.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { ROLE_MENU_RESOURCE, ROLE_RESOURCE, USER_RESOURCE } from './meta.ts'
import { registerBaseResources } from '../base/index.ts'
import { createIamService, registerIamResources } from './index.ts'
import { registerSettingResources } from '~/platform/settings/index.ts'
import { testActor } from '~/platform/authz/testing.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（IAM）', () => {
  const db = createDb(url!)
  const registry = createRegistry()
  registerSettingResources(registry)
  registerBaseResources(registry)
  registerIamResources(registry)
  registry.seal()
  const authz = createAuthzEnforcer(registry)
  const iam = createIamService(db, registry)
  const actor: Actor = testActor({
    userId: crypto.randomUUID(),
    username: 'iam-test',
    name: null,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })
  /** superAdmin 凭证：iam 三资源均为 global，rowFilter 恒全集 */
  function permit(resource: string, action: string): Permit {
    const decision = authz.decideFor(actor, resource, action)
    if (decision.outcome !== 'permit') throw new Error(`夹具应当 permit：${resource}:${action}`)
    return decision.permit
  }
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const roleIds: string[] = []
  const userIds: string[] = []

  afterAll(async () => {
    for (const id of userIds) {
      await db.deleteFrom('sys_user_role').where('user_id', '=', id).execute()
      await db.deleteFrom('sys_user_company').where('user_id', '=', id).execute()
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'sys_user').where('record_id', '=', id).execute()
      await db.deleteFrom('sys_user').where('id', '=', id).execute()
    }
    for (const id of roleIds) {
      await db.deleteFrom('sys_role_permission').where('role_id', '=', id).execute()
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'sys_role').where('record_id', '=', id).execute()
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'sys_role_permission').where('record_id', '=', id).execute()
      await db.deleteFrom('sys_role').where('id', '=', id).execute()
    }
    await db.destroy()
  })

  test('角色 CRUD + 权限同步 + 内置保护', async () => {
    const role = await iam.createRole(permit(ROLE_RESOURCE, 'create'), {
      code: `r${suffix}`,
      name: `角色-${suffix}`,
    })
    roleIds.push(role.id)
    expect(role.builtin).toBe(false)

    const perms = await iam.syncRolePermissions(permit(ROLE_RESOURCE, 'update'), role.id, [
      { permission: 'sys.user:read', scope: 'all' },
      { permission: 'sys.role:read', scope: 'all' },
      { permission: 'base.company:read', scope: 'all' },
    ])
    expect(perms.map((p) => p.permission)).toContain('sys.user:read')
    expect(perms.length).toBe(3)

    await expect(
      iam.syncRolePermissions(permit(ROLE_RESOURCE, 'update'), role.id, [
        { permission: 'not.a.real:perm', scope: 'all' },
      ]),
    ).rejects.toMatchObject({ code: 'validation' })

    const created = await iam.createUser(permit(USER_RESOURCE, 'create'), {
      username: `u${suffix}`,
      name: '验收用户',
      roleIds: [role.id],
      companyIds: [],
    })
    userIds.push(created.user.id)
    expect(created.password.length).toBeGreaterThan(8)
    const access = await iam.userAccess(permit(USER_RESOURCE, 'read'), created.user.id)
    expect(access.roles.map((r) => r.id)).toContain(role.id)

    // 预置（builtin 非 admin）角色：编辑/授权/删除与普通角色同权（ADR 2026-08-10）
    const preset = await iam.createRole(permit(ROLE_RESOURCE, 'create'), {
      code: `bi${suffix}`,
      name: `预置-${suffix}`,
    })
    await db.updateTable('sys_role').set({ builtin: true }).where('id', '=', preset.id).execute()
    const renamed = await iam.updateRole(permit(ROLE_RESOURCE, 'update'), preset.id, {
      name: `预置改-${suffix}`,
    })
    expect(renamed.name).toBe(`预置改-${suffix}`)
    await iam.syncRolePermissions(permit(ROLE_RESOURCE, 'update'), preset.id, [
      { permission: 'sys.user:read', scope: 'all' },
    ])
    await iam.deleteRole(permit(ROLE_RESOURCE, 'delete'), preset.id)

    // 系统保护角色（admin）：不可改/删、授权只读
    const adminRow = await db
      .selectFrom('sys_role')
      .select('id')
      .where('code', '=', 'admin')
      .executeTakeFirst()
    let adminId = adminRow?.id
    let adminOwnedByTest = false
    if (!adminId) {
      const inserted = await db
        .insertInto('sys_role')
        .values({ code: 'admin', name: '系统管理员', builtin: true })
        .returning('id')
        .executeTakeFirstOrThrow()
      adminId = inserted.id
      adminOwnedByTest = true
    }
    await expect(
      iam.updateRole(permit(ROLE_RESOURCE, 'update'), adminId!, { name: 'hack' }),
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(iam.deleteRole(permit(ROLE_RESOURCE, 'delete'), adminId!)).rejects.toMatchObject({
      code: 'conflict',
    })
    await expect(
      iam.syncRolePermissions(permit(ROLE_RESOURCE, 'update'), adminId!, []),
    ).rejects.toMatchObject({ code: 'conflict' })
    if (adminOwnedByTest) {
      await db.deleteFrom('sys_role').where('id', '=', adminId!).execute()
    }

    await iam.deleteUser(permit(USER_RESOURCE, 'delete'), created.user.id)
    userIds.splice(userIds.indexOf(created.user.id), 1)
    await iam.deleteRole(permit(ROLE_RESOURCE, 'delete'), role.id)
    roleIds.splice(roleIds.indexOf(role.id), 1)
  })

  test('用户邮箱 CRUD + 唯一性 + 同步 auth_user', async () => {
    const email = `u${suffix}@example.com`
    const created = await iam.createUser(permit(USER_RESOURCE, 'create'), {
      username: `em${suffix}`,
      name: '邮箱用户',
      email,
    })
    userIds.push(created.user.id)
    expect(created.user.email).toBe(email)

    const got = await iam.getUser(permit(USER_RESOURCE, 'read'), created.user.id)
    expect(got.email).toBe(email)

    // create 后已建 auth_user，邮箱应写入真实值供 Logto accountLinking
    const authLinked = await db
      .selectFrom('sys_user')
      .select(['auth_user_id', 'email'])
      .where('id', '=', created.user.id)
      .executeTakeFirstOrThrow()
    expect(authLinked.auth_user_id).toBeTruthy()
    const authUser = await db
      .selectFrom('auth_user')
      .select('email')
      .where('id', '=', authLinked.auth_user_id!)
      .executeTakeFirstOrThrow()
    expect(authUser.email).toBe(email)

    const updated = await iam.updateUser(permit(USER_RESOURCE, 'update'), created.user.id, {
      email: `U${suffix}@Example.COM`,
      emailPresent: true,
    })
    expect(updated.email).toBe(`u${suffix}@example.com`) // 归一化 lower

    // 重复邮箱拒绝
    const other = await iam.createUser(permit(USER_RESOURCE, 'create'), {
      username: `em2${suffix}`,
      email: `other-${suffix}@example.com`,
    })
    userIds.push(other.user.id)
    await expect(
      iam.updateUser(permit(USER_RESOURCE, 'update'), other.user.id, {
        email,
        emailPresent: true,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })

    // 清空邮箱 → 回落占位
    const cleared = await iam.updateUser(permit(USER_RESOURCE, 'update'), created.user.id, {
      email: null,
      emailPresent: true,
    })
    expect(cleared.email).toBeNull()
    const authAfter = await db
      .selectFrom('auth_user')
      .select('email')
      .where('id', '=', authLinked.auth_user_id!)
      .executeTakeFirstOrThrow()
    expect(authAfter.email).toBe(`em${suffix.toLowerCase()}@users.synie.invalid`)

    await iam.deleteUser(permit(USER_RESOURCE, 'delete'), other.user.id)
    userIds.splice(userIds.indexOf(other.user.id), 1)
    await iam.deleteUser(permit(USER_RESOURCE, 'delete'), created.user.id)
    userIds.splice(userIds.indexOf(created.user.id), 1)
  })
})
