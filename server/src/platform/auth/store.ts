import { sql, type Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'

export interface UserCredentials {
  id: string
  username: string
  name: string | null
  hashedPassword: string
}

/**
 * 认证存储：凭据、better-auth 反查与菜单白名单。
 * Actor 装配已迁入 platform/authz（授权存储与装配同属一环）。
 */
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

  /** better-auth 会话的 auth_user id → sys_user id（未关联返回 null） */
  async function userIdByAuthUserId(authUserId: string): Promise<string | null> {
    const row = await db
      .selectFrom('sys_user')
      .select('id')
      .where('auth_user_id', '=', authUserId)
      .executeTakeFirst()
    return row?.id ?? null
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

  return { credentialsByUsername, userIdByAuthUserId, menuCodesByUserId }
}

export type AuthStore = ReturnType<typeof createAuthStore>
