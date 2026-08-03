import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { allMenuCodes } from '~/platform/menu/catalog.ts'
import { ensureAdmin } from '../../../db/seed-admin.ts'
import { buildTestApp, testDatabaseUrl } from '../../../test/helpers.ts'
import { createIamService, registerIamResources } from './index.ts'
import { createRegistry } from '~/platform/meta/registry.ts'
import { registerBaseResources } from '../base/index.ts'
import { registerSettingResources } from '~/platform/settings/index.ts'

const url = testDatabaseUrl()
const run = url ? describe : describe.skip

run('PG 集成（角色菜单白名单）', () => {
  const db = createDb(url!)
  const registry = createRegistry()
  registerSettingResources(registry)
  registerBaseResources(registry)
  registerIamResources(registry)
  const iam = createIamService(db, registry)
  const adminActor: Actor = {
    userId: crypto.randomUUID(),
    username: 'role-menu-test',
    name: null,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  }
  /** 无任何权限的普通操作者（fail-closed 门控断言用） */
  const plainActor: Actor = { ...adminActor, userId: crypto.randomUUID(), superAdmin: false }
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const roleIds: string[] = []
  const userIds: string[] = []

  const catalogCodes = allMenuCodes()
  const menuA = catalogCodes[0]!
  const menuB = catalogCodes[1]!
  const menuC = catalogCodes[2]!

  async function mkRole(code: string, builtin = false): Promise<string> {
    const row = await db
      .insertInto('sys_role')
      .values({ code: `${code}-${suffix}`, name: `${code}-${suffix}`, builtin })
      .returning('id')
      .executeTakeFirstOrThrow()
    roleIds.push(row.id)
    return row.id
  }

  afterAll(async () => {
    for (const id of userIds) {
      await db.deleteFrom('sys_user_role').where('user_id', '=', id).execute()
      await db.deleteFrom('sys_user_company').where('user_id', '=', id).execute()
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'sys_user').where('record_id', '=', id).execute()
      await db.deleteFrom('sys_user').where('id', '=', id).execute()
    }
    for (const id of roleIds) {
      await db.deleteFrom('sys_role_permission').where('role_id', '=', id).execute()
      await db.deleteFrom('sys_role_menu').where('role_id', '=', id).execute()
      await db.deleteFrom('sys_user_role').where('role_id', '=', id).execute()
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'sys_role').where('record_id', '=', id).execute()
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'sys_role_menu').where('record_id', '=', id).execute()
      await db.deleteFrom('sys_role').where('id', '=', id).execute()
    }
    await db.destroy()
  })

  test('白名单读/sync 往返、幂等与审计留痕', async () => {
    const roleId = await mkRole('menus-roundtrip')

    expect(await iam.roleMenus(adminActor, roleId)).toEqual([])

    const synced = await iam.syncRoleMenus(adminActor, roleId, [menuB, menuA, menuA])
    expect(synced).toEqual([menuA, menuB].sort())
    expect(await iam.roleMenus(adminActor, roleId)).toEqual([menuA, menuB].sort())

    const auditCount = async () =>
      Number(
        (
          await db
            .selectFrom('sys_audit_log')
            .select(({ fn }) => fn.countAll().as('n'))
            .where('resource', '=', 'sys_role_menu')
            .where('record_id', '=', roleId)
            .executeTakeFirstOrThrow()
        ).n,
      )
    const afterFirst = await auditCount()
    expect(afterFirst).toBe(1)

    // 幂等：同集合同步不产生新审计
    await iam.syncRoleMenus(adminActor, roleId, [menuA, menuB])
    expect(await auditCount()).toBe(afterFirst)

    // 差量收缩：只留一个
    const shrunk = await iam.syncRoleMenus(adminActor, roleId, [menuB])
    expect(shrunk).toEqual([menuB])
    expect(await auditCount()).toBe(afterFirst + 1)

    // 清空 = 恢复不限制
    expect(await iam.syncRoleMenus(adminActor, roleId, [])).toEqual([])
  })

  test('目录外菜单码拒绝且逐个点名', async () => {
    const roleId = await mkRole('menus-unknown')
    const err = await iam
      .syncRoleMenus(adminActor, roleId, [menuA, 'menu.sales.no-such-page', 'menu.bogus.x'])
      .catch((e) => e)
    expect(err).toMatchObject({ code: 'validation' })
    expect(err.fields.menuCodes.join(' ')).toContain('menu.sales.no-such-page')
    // 校验失败不落任何行
    expect(await iam.roleMenus(adminActor, roleId)).toEqual([])
  })

  test('内置角色 sync 抛冲突；删角色级联清白名单行', async () => {
    const builtinId = await mkRole('menus-builtin', true)
    await expect(iam.syncRoleMenus(adminActor, builtinId, [menuA])).rejects.toMatchObject({
      code: 'conflict',
    })

    const roleId = await mkRole('menus-cascade')
    await iam.syncRoleMenus(adminActor, roleId, [menuA, menuC])
    await iam.deleteRole(adminActor, roleId)
    const left = await db
      .selectFrom('sys_role_menu')
      .select('menu_code')
      .where('role_id', '=', roleId)
      .execute()
    expect(left).toEqual([])
  })

  test('权限门控：无 sys.role_menu 码读/写均被拒', async () => {
    const roleId = await mkRole('menus-forbidden')
    await expect(iam.roleMenus(plainActor, roleId)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(iam.syncRoleMenus(plainActor, roleId, [menuA])).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  test('端点与 /auth/me：并集、停用排除、超管恒空、目录含 sys.role_menu', async () => {
    await ensureAdmin(db, { username: `it-admin-${suffix}`, password: 'it-admin-pass', name: '集成管理员' })
    const app = await buildTestApp(db)
    const login = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: `it-admin-${suffix}`, password: 'it-admin-pass' }),
    })
    const { token } = (await login.json()) as { token: string }
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

    // 权限目录含 sys.role_menu 的 read/update
    const catalogRes = await app.request('/api/v1/meta/permission-catalog', { headers })
    const catalog = (await catalogRes.json()) as { groups: { prefix: string; actions: string[] }[] }
    const group = catalog.groups.find((g) => g.prefix === 'sys.role_menu')
    expect(group?.actions.sort()).toEqual(['read', 'update'])

    // 两个角色各配白名单，用户同时挂两个角色 → /me 返回并集去重
    const roleA = await mkRole('me-a')
    const roleB = await mkRole('me-b')
    await iam.syncRoleMenus(adminActor, roleA, [menuA, menuB])
    await iam.syncRoleMenus(adminActor, roleB, [menuB, menuC])
    const created = await iam.createUser(adminActor, {
      username: `menuu${suffix}`,
      name: '菜单并集',
      roleIds: [roleA, roleB],
      companyIds: [],
    })
    userIds.push(created.user.id)

    const userLogin = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: `menuu${suffix}`, password: created.password }),
    })
    expect(userLogin.status).toBe(200)
    const userToken = ((await userLogin.json()) as { token: string }).token
    const meRes = await app.request('/api/v1/auth/me', {
      headers: { authorization: `Bearer ${userToken}` },
    })
    const me = (await meRes.json()) as { menuCodes: string[]; superAdmin: boolean }
    expect(me.superAdmin).toBe(false)
    expect(me.menuCodes).toEqual([menuA, menuB, menuC].sort())

    // 停用 roleB → 其独有码退出并集
    await db.updateTable('sys_role').set({ enabled: false }).where('id', '=', roleB).execute()
    const me2 = (await (
      await app.request('/api/v1/auth/me', { headers: { authorization: `Bearer ${userToken}` } })
    ).json()) as { menuCodes: string[] }
    expect(me2.menuCodes).toEqual([menuA, menuB].sort())

    // 超管 /me 恒空（= 不限制）
    const adminMe = (await (
      await app.request('/api/v1/auth/me', { headers })
    ).json()) as { menuCodes: string[]; superAdmin: boolean }
    expect(adminMe.superAdmin).toBe(true)
    expect(adminMe.menuCodes).toEqual([])

    // 端点往返（超管 token 直连）
    const put = await app.request(`/api/v1/system/roles/${roleA}/menus`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ menuCodes: [menuC] }),
    })
    expect(put.status).toBe(200)
    const get = await app.request(`/api/v1/system/roles/${roleA}/menus`, { headers })
    expect(((await get.json()) as { menuCodes: string[] }).menuCodes).toEqual([menuC])
  })
})
