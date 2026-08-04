import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import { createRegistry } from '~/platform/meta/registry.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { registerBaseResources } from '../base/index.ts'
import { createIamService, registerIamResources } from './index.ts'
import { registerSettingResources } from '~/platform/settings/index.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（IAM）', () => {
  const db = createDb(url!)
  const registry = createRegistry()
  registerSettingResources(registry)
  registerBaseResources(registry)
  registerIamResources(registry)
  const iam = createIamService(db, registry)
  const actor: Actor = {
    userId: crypto.randomUUID(),
    username: 'iam-test',
    name: null,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
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
    const role = await iam.createRole(actor, {
      code: `r${suffix}`,
      name: `角色-${suffix}`,
    })
    roleIds.push(role.id)
    expect(role.builtin).toBe(false)

    const perms = await iam.syncRolePermissions(actor, role.id, [
      'sys.user:read',
      'sys.role:read',
      'base.company:read',
    ])
    expect(perms).toContain('sys.user:read')
    expect(perms.length).toBe(3)

    await expect(
      iam.syncRolePermissions(actor, role.id, ['not.a.real:perm']),
    ).rejects.toMatchObject({ code: 'validation' })

    const created = await iam.createUser(actor, {
      username: `u${suffix}`,
      name: '验收用户',
      roleIds: [role.id],
      companyIds: [],
    })
    userIds.push(created.user.id)
    expect(created.password.length).toBeGreaterThan(8)
    const access = await iam.userAccess(actor, created.user.id)
    expect(access.roles.map((r) => r.id)).toContain(role.id)

    // 内置角色
    const builtin = (
      await iam.listRoles(actor, {
        limit: 50,
        offset: 0,
        filter: { builtin: { kind: 'bool', eq: true } },
      })
    ).results[0]
    if (builtin) {
      await expect(iam.updateRole(actor, builtin.id, { name: 'hack' })).rejects.toMatchObject({
        code: 'conflict',
      })
      await expect(iam.deleteRole(actor, builtin.id)).rejects.toMatchObject({ code: 'conflict' })
    }

    await iam.deleteUser(actor, created.user.id)
    userIds.splice(userIds.indexOf(created.user.id), 1)
    await iam.deleteRole(actor, role.id)
    roleIds.splice(roleIds.indexOf(role.id), 1)
  })

  test('用户邮箱 CRUD + 唯一性 + 同步 auth_user', async () => {
    const email = `u${suffix}@example.com`
    const created = await iam.createUser(actor, {
      username: `em${suffix}`,
      name: '邮箱用户',
      email,
    })
    userIds.push(created.user.id)
    expect(created.user.email).toBe(email)

    const got = await iam.getUser(actor, created.user.id)
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

    const updated = await iam.updateUser(actor, created.user.id, {
      email: `U${suffix}@Example.COM`,
      emailPresent: true,
    })
    expect(updated.email).toBe(`u${suffix}@example.com`) // 归一化 lower

    // 重复邮箱拒绝
    const other = await iam.createUser(actor, {
      username: `em2${suffix}`,
      email: `other-${suffix}@example.com`,
    })
    userIds.push(other.user.id)
    await expect(
      iam.updateUser(actor, other.user.id, {
        email,
        emailPresent: true,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })

    // 清空邮箱 → 回落占位
    const cleared = await iam.updateUser(actor, created.user.id, {
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

    await iam.deleteUser(actor, other.user.id)
    userIds.splice(userIds.indexOf(other.user.id), 1)
    await iam.deleteUser(actor, created.user.id)
    userIds.splice(userIds.indexOf(created.user.id), 1)
  })
})
