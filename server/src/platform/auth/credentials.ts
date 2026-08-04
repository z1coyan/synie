/**
 * 密码写路径统一收口：同事务内写 sys_user.hashed_password 与 auth_account.password
 * （better-auth credential 账号），两侧永不漂移。
 * sys_user 尚无 auth_user 时一并创建并回链（email 占位规则与迁移 00016 回填一致）。
 * 有真实 email 时写入 auth_user.email，供 Logto 同邮箱 accountLinking。
 */
import { sql } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'

/** 占位邮箱域（.invalid 保留 TLD，永不可达） */
export const PLACEHOLDER_EMAIL_DOMAIN = 'users.synie.invalid'

/** auth_user.email 非空：有真实邮箱用真实值，否则 username@占位域 */
export function authEmailForUser(username: string, email: string | null | undefined): string {
  const real = email?.trim().toLowerCase()
  if (real) return real
  return `${username.toLowerCase()}@${PLACEHOLDER_EMAIL_DOMAIN}`
}

/**
 * 把 sys_user.email（可空）同步到已关联的 auth_user.email。
 * 清空时回落占位邮箱，避免占住真实邮箱唯一索引、也避免 Logto 误关联。
 */
export async function syncAuthUserEmail(
  trx: DbHandle,
  input: { authUserId: string; username: string; email: string | null },
): Promise<void> {
  await trx
    .updateTable('auth_user')
    .set({
      email: authEmailForUser(input.username, input.email),
      updated_at: sql`now()`,
    })
    .where('id', '=', input.authUserId)
    .execute()
}

export async function syncUserCredential(
  trx: DbHandle,
  input: { userId: string; hashedPassword: string },
): Promise<void> {
  const user = await trx
    .selectFrom('sys_user')
    .select(['id', 'name', 'auth_user_id', 'email'])
    .select(sql<string>`username::text`.as('username'))
    .where('id', '=', input.userId)
    .executeTakeFirst()
  if (!user) {
    throw new Error(`同步登录凭证失败：用户 ${input.userId} 不存在`)
  }

  let authUserId = user.auth_user_id
  if (!authUserId) {
    const username = user.username.toLowerCase()
    const email = authEmailForUser(user.username, user.email)
    // 同名孤儿 auth_user（sys_user 被直删/截断后遗留）：收养并重置，避免撞唯一索引
    const orphan = await trx
      .selectFrom('auth_user')
      .select('id')
      .where('username', '=', username)
      .executeTakeFirst()
    if (orphan) {
      const linked = await trx
        .selectFrom('sys_user')
        .select('id')
        .where('auth_user_id', '=', orphan.id)
        .executeTakeFirst()
      if (linked) {
        // sys_user.username citext 唯一，正常不可达；防御性拒绝
        throw new Error(`同步登录凭证失败：登录名 ${username} 已被其他账号占用`)
      }
      authUserId = orphan.id
      // 清掉旧会话与第三方账号（防止前任同名用户的 Logto 关联被继承）
      await trx.deleteFrom('auth_session').where('user_id', '=', authUserId).execute()
      await trx.deleteFrom('auth_account').where('user_id', '=', authUserId).execute()
      await trx
        .updateTable('auth_user')
        .set({
          name: user.name ?? user.username,
          email,
          email_verified: false,
          display_username: user.username,
          updated_at: sql`now()`,
        })
        .where('id', '=', authUserId)
        .execute()
    } else {
      authUserId = crypto.randomUUID()
      await trx
        .insertInto('auth_user')
        .values({
          id: authUserId,
          name: user.name ?? user.username,
          email,
          email_verified: false,
          username,
          display_username: user.username,
        })
        .execute()
    }
    await trx
      .updateTable('sys_user')
      .set({ auth_user_id: authUserId })
      .where('id', '=', user.id)
      .execute()
  }

  await trx
    .updateTable('sys_user')
    .set({ hashed_password: input.hashedPassword, updated_at: sql`(now() AT TIME ZONE 'utc')` })
    .where('id', '=', user.id)
    .execute()

  const updated = await trx
    .updateTable('auth_account')
    .set({ password: input.hashedPassword, updated_at: sql`now()` })
    .where('user_id', '=', authUserId)
    .where('provider_id', '=', 'credential')
    .executeTakeFirst()
  if (Number(updated.numUpdatedRows ?? 0) === 0) {
    await trx
      .insertInto('auth_account')
      .values({
        id: crypto.randomUUID(),
        user_id: authUserId,
        provider_id: 'credential',
        account_id: authUserId,
        password: input.hashedPassword,
      })
      .execute()
  }
}
