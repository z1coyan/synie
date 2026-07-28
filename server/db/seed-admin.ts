import type { Kysely } from 'kysely'
import { hashPassword } from '../src/platform/auth/password.ts'
import type { DB as Database } from '../src/db/types.ts'

/**
 * 幂等种子管理员（初始化向导上线前的开发通道，工单 16 落地后由其取代）：
 * 按 username 查重，存在则原样返回；不存在则创建 super_admin + all_companies 用户。
 */
export async function ensureAdmin(
  db: Kysely<Database>,
  input: { username: string; password: string; name: string },
): Promise<{ id: string; created: boolean }> {
  const existing = await db
    .selectFrom('sys_user')
    .select('id')
    .where('username', '=', input.username)
    .executeTakeFirst()
  if (existing) return { id: existing.id, created: false }

  const id = crypto.randomUUID()
  await db
    .insertInto('sys_user')
    .values({
      id,
      username: input.username,
      name: input.name,
      hashed_password: await hashPassword(input.password),
      super_admin: true,
      all_companies: true,
    })
    .execute()
  return { id, created: true }
}
