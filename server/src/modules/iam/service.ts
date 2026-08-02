import type { ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import { hashPassword } from '~/platform/auth/password.ts'
import { requirePermission, type Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { isMenuCode } from '~/platform/menu/catalog.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { listFromSource } from '~/db/list.ts'
import { roleResourceMeta, userResourceMeta } from './meta.ts'

export interface IamUser {
  id: string
  username: string
  name: string | null
  preferredLanguage: string | null
  insertedAt: Date
  updatedAt: Date
}

export interface IamRole {
  id: string
  code: string
  name: string
  enabled: boolean
  builtin: boolean
  insertedAt: Date
  updatedAt: Date
}

export interface AccessItem {
  id: string
  name: string
}

export interface UserAccess {
  roles: AccessItem[]
  companies: AccessItem[]
}

const USER_AUDIT = ['username', 'name', 'preferred_language', 'role_ids', 'company_ids'] as const
const ROLE_AUDIT = ['code', 'name', 'enabled', 'builtin'] as const

export function createIamService(db: Kysely<Database>, registry: Registry) {
  async function getUser(actor: Actor, id: string): Promise<IamUser> {
    requirePermission(actor, 'sys.user:read')
    const row = await db.selectFrom('sys_user').selectAll().where('id', '=', id).executeTakeFirst()
    if (!row) throw new ApiError('not_found', '用户不存在')
    return mapUser(row)
  }

  async function listUsers(actor: Actor, query: Partial<ListQuery>) {
    requirePermission(actor, 'sys.user:read')
    return listFromSource({
      db,
      resource: userResourceMeta(),
      source: sql` FROM sys_user`,
      select: sql`SELECT id, username, name, preferred_language, inserted_at, updated_at`,
      defaultOrder: sql`"username" ASC, "id" ASC`,
      query,
      mapRow: (r) =>
        mapUser({
          id: String(r.id),
          username: String(r.username),
          name: r.name == null ? null : String(r.name),
          preferred_language: r.preferred_language == null ? null : String(r.preferred_language),
          inserted_at: r.inserted_at as Date,
          updated_at: r.updated_at as Date,
        }),
    })
  }

  async function createUser(
    actor: Actor,
    input: { username: string; name?: string | null; roleIds?: string[]; companyIds?: string[] },
  ): Promise<{ user: IamUser; password: string }> {
    requirePermission(actor, 'sys.user:create')
    const username = input.username.trim()
    let name = input.name === undefined || input.name === null ? null : input.name.trim()
    if (name === '') name = null
    if (!username || [...username].length > 64) {
      throw ApiError.validation('用户参数不合法', { username: ['必填且最多 64 个字符'] })
    }
    if (name && [...name].length > 64) {
      throw ApiError.validation('用户参数不合法', { name: ['最多 64 个字符'] })
    }
    const roleIds = uniqueIds(input.roleIds ?? [])
    const companyIds = uniqueIds(input.companyIds ?? [])
    const password = randomPassword()
    const hashed = await hashPassword(password)
    return withTx(db, async (trx) => {
      try {
        const row = await trx
          .insertInto('sys_user')
          .values({ username, name, hashed_password: hashed })
          .returningAll()
          .executeTakeFirstOrThrow()
        const user = mapUser(row)
        await replaceAccess(trx, user.id, roleIds, companyIds)
        await writeAudit(trx, actor, {
          resource: 'sys_user',
          recordId: user.id,
          recordLabel: user.username,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(userSnap(user, roleIds, companyIds), USER_AUDIT),
          sensitiveFields: ['hashed_password'],
        })
        return { user, password }
      } catch (err) {
        throw mapWriteError(err, '创建用户失败', [
          { code: '23505', message: '编码或关联已存在' },
          { code: '23503', message: '记录已被引用或关联目标不存在' },
        ])
      }
    })
  }

  async function updateUser(
    actor: Actor,
    id: string,
    input: {
      name?: string | null
      namePresent?: boolean
      roleIds?: string[]
      roleIdsPresent?: boolean
      companyIds?: string[]
      companyIdsPresent?: boolean
    },
  ): Promise<IamUser> {
    requirePermission(actor, 'sys.user:update')
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('sys_user')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '用户不存在')
      const before = mapUser(locked)
      const accessBefore = await loadAccess(trx, id)
      let name = before.name
      if (input.namePresent) {
        if (input.name === null || input.name === undefined || input.name.trim() === '') {
          name = null
        } else {
          name = input.name.trim()
          if ([...name].length > 64) {
            throw ApiError.validation('用户参数不合法', { name: ['最多 64 个字符'] })
          }
        }
      }
      const roleIds = input.roleIdsPresent
        ? uniqueIds(input.roleIds ?? [])
        : accessBefore.roles.map((r) => r.id)
      const companyIds = input.companyIdsPresent
        ? uniqueIds(input.companyIds ?? [])
        : accessBefore.companies.map((c) => c.id)
      try {
        const updated = await trx
          .updateTable('sys_user')
          .set({ name, updated_at: sql`(now() AT TIME ZONE 'utc')` })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const after = mapUser(updated)
        if (input.roleIdsPresent || input.companyIdsPresent) {
          await replaceAccess(trx, id, roleIds, companyIds)
        }
        const changes = auditDiff(
          userSnap(
            before,
            accessBefore.roles.map((r) => r.id),
            accessBefore.companies.map((c) => c.id),
          ),
          userSnap(after, roleIds, companyIds),
          USER_AUDIT,
        )
        if (Object.keys(changes).length > 0) {
          await writeAudit(trx, actor, {
            resource: 'sys_user',
            recordId: id,
            recordLabel: after.username,
            actionType: 'update',
            actionName: 'update',
            changes,
            sensitiveFields: ['hashed_password'],
          })
        }
        return after
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '更新用户失败', [
          { code: '23505', message: '编码或关联已存在' },
          { code: '23503', message: '记录已被引用或关联目标不存在' },
        ])
      }
    })
  }

  async function userAccess(actor: Actor, id: string): Promise<UserAccess> {
    requirePermission(actor, 'sys.user:read')
    const row = await db.selectFrom('sys_user').select('id').where('id', '=', id).executeTakeFirst()
    if (!row) throw new ApiError('not_found', '用户不存在')
    return loadAccess(db, id)
  }

  async function resetPassword(actor: Actor, id: string): Promise<string> {
    requirePermission(actor, 'sys.user:update')
    const password = randomPassword()
    const hashed = await hashPassword(password)
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('sys_user')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '用户不存在')
      await trx
        .updateTable('sys_user')
        .set({ hashed_password: hashed, updated_at: sql`(now() AT TIME ZONE 'utc')` })
        .where('id', '=', id)
        .execute()
      await writeAudit(trx, actor, {
        resource: 'sys_user',
        recordId: id,
        recordLabel: locked.username,
        actionType: 'update',
        actionName: 'reset_password',
        changes: {},
        sensitiveFields: ['hashed_password'],
      })
      return password
    })
  }

  async function deleteUser(actor: Actor, id: string): Promise<void> {
    requirePermission(actor, 'sys.user:delete')
    await withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('sys_user')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '用户不存在')
      const item = mapUser(locked)
      try {
        await trx.deleteFrom('sys_user_role').where('user_id', '=', id).execute()
        await trx.deleteFrom('sys_user_company').where('user_id', '=', id).execute()
        await trx.deleteFrom('sys_user').where('id', '=', id).execute()
      } catch (err) {
        throw mapWriteError(err, '删除用户失败', [
          { code: '23503', message: '记录已被引用或关联目标不存在' },
        ])
      }
      await writeAudit(trx, actor, {
        resource: 'sys_user',
        recordId: id,
        recordLabel: item.username,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(
          { username: item.username, name: item.name, preferred_language: item.preferredLanguage },
          ['username', 'name', 'preferred_language'],
        ),
      })
    })
  }

  async function getRole(actor: Actor, id: string): Promise<IamRole> {
    requirePermission(actor, 'sys.role:read')
    const row = await db.selectFrom('sys_role').selectAll().where('id', '=', id).executeTakeFirst()
    if (!row) throw new ApiError('not_found', '角色不存在')
    return mapRole(row)
  }

  async function listRoles(actor: Actor, query: Partial<ListQuery>) {
    requirePermission(actor, 'sys.role:read')
    return listFromSource({
      db,
      resource: roleResourceMeta(),
      source: sql` FROM sys_role`,
      select: sql`SELECT id, code, name, enabled, builtin, inserted_at, updated_at`,
      defaultOrder: sql`"code" ASC, "id" ASC`,
      query,
      mapRow: (r) =>
        mapRole({
          id: String(r.id),
          code: String(r.code),
          name: String(r.name),
          enabled: Boolean(r.enabled),
          builtin: Boolean(r.builtin),
          inserted_at: r.inserted_at as Date,
          updated_at: r.updated_at as Date,
        }),
    })
  }

  async function createRole(
    actor: Actor,
    input: { code: string; name: string; enabled?: boolean },
  ): Promise<IamRole> {
    requirePermission(actor, 'sys.role:create')
    const code = input.code.trim()
    const name = input.name.trim()
    if (!code || [...code].length > 64) {
      throw ApiError.validation('角色参数不合法', { code: ['必填且最多 64 个字符'] })
    }
    if (!name || [...name].length > 64) {
      throw ApiError.validation('角色参数不合法', { name: ['必填且最多 64 个字符'] })
    }
    const enabled = input.enabled ?? true
    return withTx(db, async (trx) => {
      try {
        const row = await trx
          .insertInto('sys_role')
          .values({ code, name, enabled })
          .returningAll()
          .executeTakeFirstOrThrow()
        const role = mapRole(row)
        await writeAudit(trx, actor, {
          resource: 'sys_role',
          recordId: role.id,
          recordLabel: role.name,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(roleSnap(role), ROLE_AUDIT),
        })
        return role
      } catch (err) {
        throw mapWriteError(err, '创建角色失败', [
          { code: '23505', message: '编码或关联已存在' },
        ])
      }
    })
  }

  async function updateRole(
    actor: Actor,
    id: string,
    input: { name?: string; enabled?: boolean },
  ): Promise<IamRole> {
    requirePermission(actor, 'sys.role:update')
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('sys_role')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '角色不存在')
      const before = mapRole(locked)
      if (before.builtin) throw new ApiError('conflict', '内置角色不可修改或删除')
      let name = before.name
      if (input.name !== undefined) {
        name = input.name.trim()
        if (!name || [...name].length > 64) {
          throw ApiError.validation('角色参数不合法', { name: ['必填且最多 64 个字符'] })
        }
      }
      const enabled = input.enabled ?? before.enabled
      const updated = await trx
        .updateTable('sys_role')
        .set({ name, enabled, updated_at: sql`(now() AT TIME ZONE 'utc')` })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
      const after = mapRole(updated)
      const changes = auditDiff(roleSnap(before), roleSnap(after), ROLE_AUDIT)
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, actor, {
          resource: 'sys_role',
          recordId: id,
          recordLabel: after.name,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
      }
      return after
    })
  }

  async function deleteRole(actor: Actor, id: string): Promise<void> {
    requirePermission(actor, 'sys.role:delete')
    await withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('sys_role')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '角色不存在')
      const item = mapRole(locked)
      if (item.builtin) throw new ApiError('conflict', '内置角色不可修改或删除')
      try {
        await trx.deleteFrom('sys_role_permission').where('role_id', '=', id).execute()
        await trx.deleteFrom('sys_role_menu').where('role_id', '=', id).execute()
        await trx.deleteFrom('sys_user_role').where('role_id', '=', id).execute()
        await trx.deleteFrom('sys_role').where('id', '=', id).execute()
      } catch (err) {
        throw mapWriteError(err, '删除角色失败', [
          { code: '23503', message: '记录已被引用或关联目标不存在' },
        ])
      }
      await writeAudit(trx, actor, {
        resource: 'sys_role',
        recordId: id,
        recordLabel: item.name,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(roleSnap(item), ROLE_AUDIT),
      })
    })
  }

  async function rolePermissions(
    actor: Actor,
    roleId: string,
  ): Promise<{ id: string; permission: string }[]> {
    requirePermission(actor, 'sys.role:read')
    const role = await db
      .selectFrom('sys_role')
      .select('id')
      .where('id', '=', roleId)
      .executeTakeFirst()
    if (!role) throw new ApiError('not_found', '角色不存在')
    const rows = await db
      .selectFrom('sys_role_permission')
      .select(['id', 'permission'])
      .where('role_id', '=', roleId)
      .orderBy('permission')
      .orderBy('id')
      .execute()
    return rows
  }

  async function syncRolePermissions(
    actor: Actor,
    roleId: string,
    desired: string[],
  ): Promise<string[]> {
    requirePermission(actor, 'sys.role:update')
    const catalog = new Set<string>()
    for (const group of registry.permissionCatalog()) {
      for (const action of group.actions) {
        catalog.add(`${group.prefix}:${action}`)
      }
    }
    const wanted = uniqueStrings(desired)
    for (const code of wanted) {
      if (!catalog.has(code)) {
        throw ApiError.validation('权限码不合法', {
          permissions: [`包含目录外权限码: ${code}`],
        })
      }
    }
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('sys_role')
        .selectAll()
        .where('id', '=', roleId)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '角色不存在')
      if (locked.builtin) throw new ApiError('conflict', '内置角色的授权不可增删')
      const existing = await trx
        .selectFrom('sys_role_permission')
        .select(['id', 'permission'])
        .where('role_id', '=', roleId)
        .execute()
      const before = existing.map((r) => r.permission).sort()
      const wantedSet = new Set(wanted)
      const remove = existing
        .filter((r) => catalog.has(r.permission) && !wantedSet.has(r.permission))
        .map((r) => r.permission)
      if (remove.length > 0) {
        await trx
          .deleteFrom('sys_role_permission')
          .where('role_id', '=', roleId)
          .where('permission', 'in', remove)
          .execute()
      }
      for (const permission of wanted) {
        await trx
          .insertInto('sys_role_permission')
          .values({ role_id: roleId, permission })
          .onConflict((oc) => oc.columns(['role_id', 'permission']).doNothing())
          .execute()
      }
      const finalRows = await trx
        .selectFrom('sys_role_permission')
        .select('permission')
        .where('role_id', '=', roleId)
        .execute()
      const final = finalRows.map((r) => r.permission).sort()
      if (before.join('\0') !== final.join('\0')) {
        await writeAudit(trx, actor, {
          resource: 'sys_role_permission',
          recordId: roleId,
          recordLabel: locked.name,
          actionType: 'update',
          actionName: 'sync',
          changes: { permissions: { from: before, to: final } },
        })
      }
      return final
    })
  }

  async function roleMenus(actor: Actor, roleId: string): Promise<string[]> {
    requirePermission(actor, 'sys.role_menu:read')
    const role = await db
      .selectFrom('sys_role')
      .select('id')
      .where('id', '=', roleId)
      .executeTakeFirst()
    if (!role) throw new ApiError('not_found', '角色不存在')
    const rows = await db
      .selectFrom('sys_role_menu')
      .select('menu_code')
      .where('role_id', '=', roleId)
      .orderBy('menu_code')
      .execute()
    return rows.map((r) => r.menu_code)
  }

  async function syncRoleMenus(actor: Actor, roleId: string, desired: string[]): Promise<string[]> {
    requirePermission(actor, 'sys.role_menu:update')
    const wanted = uniqueStrings(desired)
    const unknown = wanted.filter((code) => !isMenuCode(code))
    if (unknown.length > 0) {
      throw ApiError.validation('菜单码不合法', {
        menuCodes: unknown.map((code) => `目录外菜单码: ${code}`),
      })
    }
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('sys_role')
        .selectAll()
        .where('id', '=', roleId)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '角色不存在')
      if (locked.builtin) throw new ApiError('conflict', '内置角色的菜单授权不可增删')
      const existing = await trx
        .selectFrom('sys_role_menu')
        .select('menu_code')
        .where('role_id', '=', roleId)
        .execute()
      const before = existing.map((r) => r.menu_code).sort()
      const wantedSet = new Set(wanted)
      const remove = existing.filter((r) => !wantedSet.has(r.menu_code)).map((r) => r.menu_code)
      if (remove.length > 0) {
        await trx
          .deleteFrom('sys_role_menu')
          .where('role_id', '=', roleId)
          .where('menu_code', 'in', remove)
          .execute()
      }
      for (const menuCode of wanted) {
        await trx
          .insertInto('sys_role_menu')
          .values({ role_id: roleId, menu_code: menuCode })
          .onConflict((oc) => oc.columns(['role_id', 'menu_code']).doNothing())
          .execute()
      }
      const finalRows = await trx
        .selectFrom('sys_role_menu')
        .select('menu_code')
        .where('role_id', '=', roleId)
        .execute()
      const final = finalRows.map((r) => r.menu_code).sort()
      if (before.join('\0') !== final.join('\0')) {
        await writeAudit(trx, actor, {
          resource: 'sys_role_menu',
          recordId: roleId,
          recordLabel: locked.name,
          actionType: 'update',
          actionName: 'sync',
          changes: { menu_codes: { from: before, to: final } },
        })
      }
      return final
    })
  }

  return {
    getUser,
    listUsers,
    createUser,
    updateUser,
    userAccess,
    resetPassword,
    deleteUser,
    getRole,
    listRoles,
    createRole,
    updateRole,
    deleteRole,
    rolePermissions,
    syncRolePermissions,
    roleMenus,
    syncRoleMenus,
  }
}

export type IamService = ReturnType<typeof createIamService>

async function replaceAccess(
  trx: DbHandle,
  userId: string,
  roleIds: string[],
  companyIds: string[],
): Promise<void> {
  await trx.deleteFrom('sys_user_role').where('user_id', '=', userId).execute()
  if (roleIds.length > 0) {
    await trx
      .insertInto('sys_user_role')
      .values(roleIds.map((role_id) => ({ user_id: userId, role_id })))
      .execute()
  }
  await trx.deleteFrom('sys_user_company').where('user_id', '=', userId).execute()
  if (companyIds.length > 0) {
    await trx
      .insertInto('sys_user_company')
      .values(companyIds.map((company_id) => ({ user_id: userId, company_id })))
      .execute()
  }
}

async function loadAccess(handle: DbHandle, userId: string): Promise<UserAccess> {
  const roles = await handle
    .selectFrom('sys_user_role as ur')
    .innerJoin('sys_role as role', 'role.id', 'ur.role_id')
    .select(['ur.role_id as id', 'role.name as name'])
    .where('ur.user_id', '=', userId)
    .orderBy('role.name')
    .orderBy('ur.role_id')
    .execute()
  const companies = await handle
    .selectFrom('sys_user_company as uc')
    .innerJoin('bas_company as company', 'company.id', 'uc.company_id')
    .select(['uc.company_id as id', 'company.name as name'])
    .where('uc.user_id', '=', userId)
    .orderBy('company.name')
    .orderBy('uc.company_id')
    .execute()
  return {
    roles: roles.map((r) => ({ id: r.id, name: r.name })),
    companies: companies.map((c) => ({ id: c.id, name: c.name })),
  }
}

function mapUser(row: {
  id: string
  username: string
  name: string | null
  preferred_language: string | null
  inserted_at: Date | string
  updated_at: Date | string
}): IamUser {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    preferredLanguage: row.preferred_language,
    insertedAt: toDate(row.inserted_at),
    updatedAt: toDate(row.updated_at),
  }
}

function mapRole(row: {
  id: string
  code: string
  name: string
  enabled: boolean
  builtin: boolean
  inserted_at: Date | string
  updated_at: Date | string
}): IamRole {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    enabled: row.enabled,
    builtin: row.builtin,
    insertedAt: toDate(row.inserted_at),
    updatedAt: toDate(row.updated_at),
  }
}

function userSnap(u: IamUser, roles: string[], companies: string[]): Record<string, unknown> {
  return {
    username: u.username,
    name: u.name,
    preferred_language: u.preferredLanguage,
    role_ids: roles,
    company_ids: companies,
  }
}

function roleSnap(r: IamRole): Record<string, unknown> {
  return { code: r.code, name: r.name, enabled: r.enabled, builtin: r.builtin }
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))].sort()
}

function uniqueStrings(values: string[]): string[] {
  const set = new Set<string>()
  for (const v of values) {
    const t = v.trim()
    if (t) set.add(t)
  }
  return [...set].sort()
}

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v)
}
