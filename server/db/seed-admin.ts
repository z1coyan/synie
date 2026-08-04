import type { Kysely } from 'kysely'
import { withTx } from '../src/db/tx.ts'
import { syncUserCredential } from '../src/platform/auth/credentials.ts'
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
  const hashed = await hashPassword(input.password)
  await withTx(db, async (trx) => {
    await trx
      .insertInto('sys_user')
      .values({
        id,
        username: input.username,
        name: input.name,
        hashed_password: hashed,
        super_admin: true,
        all_companies: true,
      })
      .execute()
    // 同事务补建 better-auth 账号
    await syncUserCredential(trx, { userId: id, hashedPassword: hashed })
  })
  return { id, created: true }
}
