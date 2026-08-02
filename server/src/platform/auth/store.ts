import { sql, type Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import type { Actor } from '../authz/actor.ts'

export interface UserCredentials {
  id: string
  username: string
  name: string | null
  hashedPassword: string
}

/** 认证存储：sys_user / 角色权限 / 公司授权三表的读取面 */
export function createAuthStore(db: Kysely<Database>) {
  async function credentialsByUsername(username: string): Promise<UserCredentials | null> {
    const row = await db
      .selectFrom('sys_user')
      .select(['id', 'name', 'hashed_password as hashedPassword'])
      .select(sql<string>`username::text`.as('username'))
      .where('username', '=', username)
      .executeTakeFirst()
    return row ?? null
  }

  async function actorByUserId(userId: string): Promise<Actor | null> {
    const base = await db
      .selectFrom('sys_user')
      .select(['id', 'name', 'super_admin as superAdmin', 'all_companies as allCompanies'])
      .select(sql<string>`username::text`.as('username'))
      .where('id', '=', userId)
      .executeTakeFirst()
    if (!base) return null

    const [permissionRows, companyRows] = await Promise.all([
      db
        .selectFrom('sys_user_role as ur')
        .innerJoin('sys_role as r', (join) =>
          join.onRef('r.id', '=', 'ur.role_id').on('r.enabled', '=', true),
        )
        .innerJoin('sys_role_permission as rp', 'rp.role_id', 'r.id')
        .select('rp.permission')
        .where('ur.user_id', '=', userId)
        .distinct()
        .orderBy('rp.permission')
        .execute(),
      db
        .selectFrom('sys_user_company')
        .select('company_id as companyId')
        .where('user_id', '=', userId)
        .orderBy('company_id')
        .execute(),
    ])

    return {
      userId: base.id,
      username: base.username,
      name: base.name,
      superAdmin: base.superAdmin,
      allCompanies: base.allCompanies,
      permissions: new Set(permissionRows.map((row) => row.permission)),
      companyIds: companyRows.map((row) => row.companyId),
    }
  }

  /**
   * 当前用户的有效菜单码集合：所有启用角色菜单白名单的去重并集（字典序）。
   * 空数组 = 所有角色均未配置 = 不限制（全可见）。
   */
  async function menuCodesByUserId(userId: string): Promise<string[]> {
    const rows = await db
      .selectFrom('sys_user_role as ur')
      .innerJoin('sys_role as r', (join) =>
        join.onRef('r.id', '=', 'ur.role_id').on('r.enabled', '=', true),
      )
      .innerJoin('sys_role_menu as rm', 'rm.role_id', 'r.id')
      .select('rm.menu_code')
      .where('ur.user_id', '=', userId)
      .distinct()
      .orderBy('rm.menu_code')
      .execute()
    return rows.map((row) => row.menu_code)
  }

  return { credentialsByUsername, actorByUserId, menuCodesByUserId }
}

export type AuthStore = ReturnType<typeof createAuthStore>
