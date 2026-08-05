/**
 * 用户 / 角色（全局资源，无公司列 → global 形态）。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit——
 * 列表 `listAuthorized`、单条/写前取行 `loadAuthorized`。
 * 本文件是权限系统**自身的写侧**：授权目录闭包与 scope 合法性、内置角色冻结、
 * 部门与公司授权一致性都是 IAM 写侧校验（spec §1.3），留在这里，不属判定内核。
 */
import type { DataScope, ListQuery } from '@synie/shared'
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
import { auditFieldsOf, auditSpecOf } from '~/platform/audit/spec.ts'
import { syncAuthUserEmail, syncUserCredential } from '~/platform/auth/credentials.ts'
import { hashPassword } from '~/platform/auth/password.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import {
  SCOPE_COLUMN_VALUES,
  type ScopeColumnValue,
} from '~/platform/authz/core/scope.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { isMenuCode } from '~/platform/menu/catalog.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { listAuthorized } from '~/db/list.ts'
import { loadAuthorized } from '~/db/load.ts'
import { ROLE_RESOURCE, USER_RESOURCE, roleResourceMeta, userResourceMeta } from './meta.ts'

export interface IamUser {
  id: string
  username: string
  name: string | null
  /** Logto 首登匹配键；可空，非空时库内 lower(email) 唯一 */
  email: string | null
  /** 所属部门（至多一个）；部门所在公司必须在该用户公司授权集内 */
  departmentId: string | null
  /** 部门名（fk 展示用；无部门为 null） */
  department: { id: string; name: string } | null
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

const USER_AUDIT_SPEC = auditSpecOf(userResourceMeta())
const USER_AUDIT = USER_AUDIT_SPEC.fields
const ROLE_AUDIT = auditFieldsOf(roleResourceMeta())

/** (role, code, scope) 三元组授权的 wire 形态（scope 为 DataScope 名；DB 列存 snake 值） */
export interface PermissionGrant {
  permission: string
  scope: DataScope
}

/** wire DataScope 名 → DB 列值（SCOPE_COLUMN_VALUES 的反查；deptTree ↔ dept_tree） */
const SCOPE_WIRE_TO_COLUMN = Object.fromEntries(
  Object.entries(SCOPE_COLUMN_VALUES).map(([column, atom]) => [atom, column]),
) as Record<DataScope, ScopeColumnValue>

/** DB 列值 → wire DataScope 名；granted 预留值与未知值即数据损坏——抛错（fail-closed，不得回落放大约为 all） */
function scopeWireOf(column: string): DataScope {
  const atom = SCOPE_COLUMN_VALUES[column as ScopeColumnValue]
  if (!atom || atom === 'granted') {
    throw new Error(`sys_role_permission.scope 含非法值: ${column}`)
  }
  return atom
}

/** 邮箱规范化：trim + lower；空串视为 null；格式校验 */
function normalizeEmail(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null
  const t = raw.trim().toLowerCase()
  if (t === '') return null
  // 与常见邮箱形态对齐；长度上限 RFC 5321
  if (t.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) {
    throw ApiError.validation('用户参数不合法', { email: ['请输入有效的邮箱地址'] })
  }
  return t
}

export function createIamService(db: Kysely<Database>, registry: Registry) {
  const userTarget = registry.authzTarget(USER_RESOURCE)
  const roleTarget = registry.authzTarget(ROLE_RESOURCE)

  async function getUser(permit: Permit, id: string): Promise<IamUser> {
    // 授权闸走裸表（global：只有码级判定），部门名单独补一次（无 join 的行锁语义）
    await loadAuthorized({
      db,
      permit,
      target: userTarget,
      table: 'sys_user',
      id,
      notFoundMessage: '用户不存在',
    })
    const row = await db
      .selectFrom('sys_user as u')
      .leftJoin('sys_department as d', 'd.id', 'u.department_id')
      .selectAll('u')
      .select('d.name as department_name')
      .where('u.id', '=', id)
      .executeTakeFirst()
    if (!row) throw new ApiError('not_found', '用户不存在')
    return mapUser(row)
  }

  async function listUsers(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
      db,
      permit,
      target: userTarget,
      // 别名必须与 source 的 `) sys_user` 逐字一致
      alias: 'sys_user',
      resource: userResourceMeta(),
      // 子查询暴露部门名：fk 列靠 row.department 显示名称，否则前端只能印 uuid 前缀
      source: sql`
        FROM (
          SELECT u.id, u.username, u.name, u.email, u.department_id,
                 u.preferred_language, u.inserted_at, u.updated_at,
                 d.name AS department_name
          FROM sys_user u
          LEFT JOIN sys_department d ON d.id = u.department_id
        ) sys_user
      `,
      select: sql`SELECT id, username, name, email, department_id, department_name, preferred_language, inserted_at, updated_at`,
      defaultOrder: sql`"username" ASC, "id" ASC`,
      query,
      mapRow: (r) =>
        mapUser({
          id: String(r.id),
          username: String(r.username),
          name: r.name == null ? null : String(r.name),
          email: r.email == null ? null : String(r.email),
          department_id: r.department_id == null ? null : String(r.department_id),
          department_name: r.department_name == null ? null : String(r.department_name),
          preferred_language: r.preferred_language == null ? null : String(r.preferred_language),
          inserted_at: r.inserted_at as Date,
          updated_at: r.updated_at as Date,
        }),
    })
  }

  async function createUser(
    permit: Permit,
    input: {
      username: string
      name?: string | null
      email?: string | null
      departmentId?: string | null
      roleIds?: string[]
      companyIds?: string[]
    },
  ): Promise<{ user: IamUser; password: string }> {
    const username = input.username.trim()
    let name = input.name === undefined || input.name === null ? null : input.name.trim()
    if (name === '') name = null
    const email = normalizeEmail(input.email)
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
        const departmentId = input.departmentId ?? null
        // 新建用户 all_companies 恒 false（该旗标仅初始化向导设置）
        const department = await resolveUserDepartment(trx, {
          departmentId,
          companyIds,
          allCompanies: false,
          attaching: true,
        })
        const row = await trx
          .insertInto('sys_user')
          .values({ username, name, email, department_id: departmentId, hashed_password: hashed })
          .returningAll()
          .executeTakeFirstOrThrow()
        const user = mapUser({ ...row, department_name: department?.name ?? null })
        // 同事务补建 better-auth 账号（auth_user + credential auth_account；有 email 则写入真实邮箱）
        await syncUserCredential(trx, { userId: user.id, hashedPassword: hashed })
        await replaceAccess(trx, user.id, roleIds, companyIds)
        await writeAudit(trx, permit.actor, {
          resource: 'sys_user',
          recordId: user.id,
          recordLabel: user.username,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(userSnap(user, roleIds, companyIds), USER_AUDIT),
          sensitiveFields: USER_AUDIT_SPEC.sensitiveFields,
        })
        return { user, password }
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '创建用户失败', [
          { code: '23505', message: '编码或关联已存在' },
          { code: '23503', message: '记录已被引用或关联目标不存在' },
        ])
      }
    })
  }

  async function updateUser(
    permit: Permit,
    id: string,
    input: {
      name?: string | null
      namePresent?: boolean
      email?: string | null
      emailPresent?: boolean
      departmentId?: string | null
      departmentIdPresent?: boolean
      roleIds?: string[]
      roleIdsPresent?: boolean
      companyIds?: string[]
      companyIdsPresent?: boolean
    },
  ): Promise<IamUser> {
    return withTx(db, async (trx) => {
      const locked = lockedUser(
        await loadAuthorized({
          db: trx,
          permit,
          target: userTarget,
          table: 'sys_user',
          id,
          forUpdate: true,
          notFoundMessage: '用户不存在',
        }),
      )
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
      let email = before.email
      if (input.emailPresent) {
        email = normalizeEmail(input.email)
      }
      const roleIds = input.roleIdsPresent
        ? uniqueIds(input.roleIds ?? [])
        : accessBefore.roles.map((r) => r.id)
      const companyIds = input.companyIdsPresent
        ? uniqueIds(input.companyIds ?? [])
        : accessBefore.companies.map((c) => c.id)
      const departmentId = input.departmentIdPresent
        ? (input.departmentId ?? null)
        : before.departmentId
      // 一条不变量覆盖两个方向：设部门须持该公司授权，回收公司授权时部门冲突即拦
      const department = await resolveUserDepartment(trx, {
        departmentId,
        companyIds,
        allCompanies: locked.all_companies,
        attaching: departmentId !== before.departmentId,
      })
      try {
        const updated = await trx
          .updateTable('sys_user')
          .set({ name, email, department_id: departmentId, updated_at: sql`(now() AT TIME ZONE 'utc')` })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        // Logto / accountLinking 读 auth_user.email：有关联账号时与 sys_user 同步
        if (input.emailPresent && locked.auth_user_id) {
          await syncAuthUserEmail(trx, {
            authUserId: locked.auth_user_id,
            username: locked.username,
            email,
          })
        }
        const after = mapUser({ ...updated, department_name: department?.name ?? null })
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
          await writeAudit(trx, permit.actor, {
            resource: 'sys_user',
            recordId: id,
            recordLabel: after.username,
            actionType: 'update',
            actionName: 'update',
            changes,
            sensitiveFields: USER_AUDIT_SPEC.sensitiveFields,
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

  async function userAccess(permit: Permit, id: string): Promise<UserAccess> {
    await loadAuthorized({
      db,
      permit,
      target: userTarget,
      table: 'sys_user',
      id,
      notFoundMessage: '用户不存在',
    })
    return loadAccess(db, id)
  }

  async function resetPassword(permit: Permit, id: string): Promise<string> {
    const password = randomPassword()
    const hashed = await hashPassword(password)
    return withTx(db, async (trx) => {
      const locked = lockedUser(
        await loadAuthorized({
          db: trx,
          permit,
          target: userTarget,
          table: 'sys_user',
          id,
          forUpdate: true,
          notFoundMessage: '用户不存在',
        }),
      )
      // 双写 sys_user.hashed_password 与 auth_account.password（收口见 credentials.ts）
      await syncUserCredential(trx, { userId: id, hashedPassword: hashed })
      await writeAudit(trx, permit.actor, {
        resource: 'sys_user',
        recordId: id,
        recordLabel: locked.username,
        actionType: 'update',
        actionName: 'reset_password',
        changes: {},
        sensitiveFields: USER_AUDIT_SPEC.sensitiveFields,
      })
      return password
    })
  }

  async function deleteUser(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const locked = lockedUser(
        await loadAuthorized({
          db: trx,
          permit,
          target: userTarget,
          table: 'sys_user',
          id,
          forUpdate: true,
          notFoundMessage: '用户不存在',
        }),
      )
      const item = mapUser(locked)
      try {
        await trx.deleteFrom('sys_user_role').where('user_id', '=', id).execute()
        await trx.deleteFrom('sys_user_company').where('user_id', '=', id).execute()
        await trx.deleteFrom('sys_user').where('id', '=', id).execute()
        // 同事务清 better-auth 账号（级联删 session/account，登录态随删即失效）
        if (locked.auth_user_id) {
          await trx.deleteFrom('auth_user').where('id', '=', locked.auth_user_id).execute()
        }
      } catch (err) {
        throw mapWriteError(err, '删除用户失败', [
          { code: '23503', message: '记录已被引用或关联目标不存在' },
        ])
      }
      await writeAudit(trx, permit.actor, {
        resource: 'sys_user',
        recordId: id,
        recordLabel: item.username,
        actionType: 'destroy',
        actionName: 'destroy',
        // destroy 只审物理字段（角色/公司关联已随删，不再进 changes）
        changes: auditDestroyed(
          {
            username: item.username,
            name: item.name,
            email: item.email,
            preferred_language: item.preferredLanguage,
          },
          USER_AUDIT_SPEC.metaFields,
        ),
      })
    })
  }

  async function getRole(permit: Permit, id: string): Promise<IamRole> {
    const row = await loadAuthorized({
      db,
      permit,
      target: roleTarget,
      table: 'sys_role',
      id,
      notFoundMessage: '角色不存在',
    })
    return mapRole(row as never)
  }

  async function listRoles(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
      db,
      permit,
      target: roleTarget,
      alias: 'sys_role',
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
    permit: Permit,
    input: { code: string; name: string; enabled?: boolean },
  ): Promise<IamRole> {
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
        await writeAudit(trx, permit.actor, {
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
    permit: Permit,
    id: string,
    input: { name?: string; enabled?: boolean },
  ): Promise<IamRole> {
    return withTx(db, async (trx) => {
      const locked = await loadAuthorized({
        db: trx,
        permit,
        target: roleTarget,
        table: 'sys_role',
        id,
        forUpdate: true,
        notFoundMessage: '角色不存在',
      })
      const before = mapRole(locked as never)
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
        await writeAudit(trx, permit.actor, {
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

  async function deleteRole(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const locked = await loadAuthorized({
        db: trx,
        permit,
        target: roleTarget,
        table: 'sys_role',
        id,
        forUpdate: true,
        notFoundMessage: '角色不存在',
      })
      const item = mapRole(locked as never)
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
      await writeAudit(trx, permit.actor, {
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
    permit: Permit,
    roleId: string,
  ): Promise<{ id: string; permission: string; scope: DataScope }[]> {
    await loadAuthorized({
      db,
      permit,
      target: roleTarget,
      table: 'sys_role',
      id: roleId,
      notFoundMessage: '角色不存在',
    })
    const rows = await db
      .selectFrom('sys_role_permission')
      .select(['id', 'permission', 'scope'])
      .where('role_id', '=', roleId)
      .orderBy('permission')
      .orderBy('id')
      .execute()
    return rows.map((r) => ({ id: r.id, permission: r.permission, scope: scopeWireOf(r.scope) }))
  }

  /**
   * 授权目录闭包 + scope 合法性（spec §3，IAM 写侧）：
   * 码必须在目录内，且授出的数据范围必须在该前缀的 supportedScopes 内——
   * 资源不支持的维度拒授，不留「配了但永远编译为空集」的幽灵授权。
   */
  function assertGrantable(code: string, scope: string): void {
    const prefix = code.slice(0, code.lastIndexOf(':'))
    const group = registry.permissionCatalog().find((g) => g.prefix === prefix)
    if (!group || !group.actions.includes(code.slice(code.lastIndexOf(':') + 1))) {
      throw ApiError.validation('权限码不合法', {
        permissions: [`包含目录外权限码: ${code}`],
      })
    }
    if (!(group.supportedScopes as readonly string[]).includes(scope)) {
      throw ApiError.validation('数据范围不合法', {
        permissions: [`权限码 ${code} 不支持数据范围 ${scope}`],
      })
    }
  }

  /**
   * 覆盖式同步角色授权（(role, code, scope) 三元组，spec §3）：
   * 按 permission 去重（先现者优先）；删除目录内不在 desired 的码；
   * 码仍在但 scope 变了的行 UPDATE scope；新码 INSERT 带 scope。
   * unique 约束 (role_id, permission) 保证一码一行；目录外存量行保留不动。
   */
  async function syncRolePermissions(
    permit: Permit,
    roleId: string,
    desired: PermissionGrant[],
  ): Promise<PermissionGrant[]> {
    const catalog = new Set(registry.allPermissionCodes())
    const wanted = new Map<string, DataScope>()
    for (const item of desired) {
      const code = item.permission.trim()
      if (!code || wanted.has(code)) continue
      wanted.set(code, item.scope)
    }
    for (const [code, scope] of wanted) {
      assertGrantable(code, scope)
    }
    return withTx(db, async (trx) => {
      const locked = lockedRole(
        await loadAuthorized({
          db: trx,
          permit,
          target: roleTarget,
          table: 'sys_role',
          id: roleId,
          forUpdate: true,
          notFoundMessage: '角色不存在',
        }),
      )
      if (locked.builtin) throw new ApiError('conflict', '内置角色的授权不可增删')
      const existing = await trx
        .selectFrom('sys_role_permission')
        .select(['id', 'permission', 'scope'])
        .where('role_id', '=', roleId)
        .execute()
      // 审计快照：按 permission 排序的 { permission, scope }[]（wire scope 名）
      const snap = (rows: readonly { permission: string; scope: string }[]): PermissionGrant[] =>
        rows
          .map((r) => ({ permission: r.permission, scope: scopeWireOf(r.scope) }))
          .sort((a, b) => a.permission.localeCompare(b.permission))
      const before = snap(existing)
      const remove = existing
        .filter((r) => catalog.has(r.permission) && !wanted.has(r.permission))
        .map((r) => r.permission)
      if (remove.length > 0) {
        await trx
          .deleteFrom('sys_role_permission')
          .where('role_id', '=', roleId)
          .where('permission', 'in', remove)
          .execute()
      }
      const existingByCode = new Map(existing.map((r) => [r.permission, r.scope]))
      for (const [permission, scope] of wanted) {
        const column = SCOPE_WIRE_TO_COLUMN[scope]
        const current = existingByCode.get(permission)
        if (current === undefined) {
          await trx
            .insertInto('sys_role_permission')
            .values({ role_id: roleId, permission, scope: column })
            .execute()
        } else if (current !== column) {
          await trx
            .updateTable('sys_role_permission')
            .set({ scope: column })
            .where('role_id', '=', roleId)
            .where('permission', '=', permission)
            .execute()
        }
      }
      const finalRows = await trx
        .selectFrom('sys_role_permission')
        .select(['permission', 'scope'])
        .where('role_id', '=', roleId)
        .execute()
      const final = snap(finalRows)
      if (JSON.stringify(before) !== JSON.stringify(final)) {
        await writeAudit(trx, permit.actor, {
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

  async function roleMenus(permit: Permit, roleId: string): Promise<string[]> {
    await loadAuthorized({
      db,
      permit,
      target: roleTarget,
      table: 'sys_role',
      id: roleId,
      notFoundMessage: '角色不存在',
    })
    const rows = await db
      .selectFrom('sys_role_menu')
      .select('menu_code')
      .where('role_id', '=', roleId)
      .orderBy('menu_code')
      .execute()
    return rows.map((r) => r.menu_code)
  }

  async function syncRoleMenus(permit: Permit, roleId: string, desired: string[]): Promise<string[]> {
    const wanted = uniqueStrings(desired)
    const unknown = wanted.filter((code) => !isMenuCode(code))
    if (unknown.length > 0) {
      throw ApiError.validation('菜单码不合法', {
        menuCodes: unknown.map((code) => `目录外菜单码: ${code}`),
      })
    }
    return withTx(db, async (trx) => {
      const locked = lockedRole(
        await loadAuthorized({
          db: trx,
          permit,
          target: roleTarget,
          table: 'sys_role',
          id: roleId,
          forUpdate: true,
          notFoundMessage: '角色不存在',
        }),
      )
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
        await writeAudit(trx, permit.actor, {
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

/** loadAuthorized 返回裸行（平台层不承担领域投影）；写路径按需收窄列类型 */
function lockedUser(row: Record<string, unknown>): {
  id: string
  username: string
  name: string | null
  email: string | null
  department_id: string | null
  preferred_language: string | null
  all_companies: boolean
  auth_user_id: string | null
  inserted_at: Date | string
  updated_at: Date | string
} {
  return row as never
}

function lockedRole(row: Record<string, unknown>): {
  id: string
  code: string
  name: string
  enabled: boolean
  builtin: boolean
  inserted_at: Date | string
  updated_at: Date | string
} {
  return row as never
}

/**
 * 部门与公司授权的一致性硬校验（spec §2）：
 * 设置部门时该部门所在公司必须已在用户公司授权集内；回收公司授权时若用户部门
 * 属该公司则拦截。不留「配了但永远编译为空集」的幽灵配置。
 */
async function resolveUserDepartment(
  trx: DbHandle,
  input: {
    departmentId: string | null
    companyIds: readonly string[]
    allCompanies: boolean
    /** 部门挂接发生变化时为 true：停用部门只拦新挂接，存量挂接保留（工单 05） */
    attaching: boolean
  },
): Promise<{ id: string; name: string } | null> {
  if (input.departmentId === null) return null
  const dept = await trx
    .selectFrom('sys_department')
    .select(['id', 'company_id', 'name', 'enabled'])
    .where('id', '=', input.departmentId)
    .executeTakeFirst()
  if (!dept) {
    throw ApiError.validation('用户参数不合法', { departmentId: ['部门不存在'] })
  }
  if (input.attaching && !dept.enabled) {
    throw ApiError.validation('用户参数不合法', {
      departmentId: [`部门「${dept.name}」已停用，不能再挂用户：请先启用该部门或另选部门`],
    })
  }
  if (!input.allCompanies && !input.companyIds.includes(dept.company_id)) {
    throw ApiError.validation('用户参数不合法', {
      departmentId: [
        `部门「${dept.name}」所属公司不在该用户的公司授权范围内：请先授权该公司，或先移除部门`,
      ],
    })
  }
  return { id: dept.id, name: dept.name }
}

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
  email?: string | null
  department_id?: string | null
  department_name?: string | null
  preferred_language: string | null
  inserted_at: Date | string
  updated_at: Date | string
}): IamUser {
  const departmentId = row.department_id ?? null
  const departmentName = row.department_name ?? null
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    email: row.email ?? null,
    departmentId,
    department: departmentId && departmentName ? { id: departmentId, name: departmentName } : null,
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
    email: u.email,
    department_id: u.departmentId,
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
