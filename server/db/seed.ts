/**
 * 开发种子：创建首个管理员（幂等）。用法：
 *   DATABASE_URL=... bun run db:seed
 * 账号由 SEED_ADMIN_USERNAME / SEED_ADMIN_PASSWORD / SEED_ADMIN_NAME 控制（默认 admin/admin123）。
 */
import { createDb } from '../src/db/index.ts'
import { ensureAdmin } from './seed-admin.ts'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('必须设置 DATABASE_URL')
  process.exit(1)
}

const db = createDb(databaseUrl)
const result = await ensureAdmin(db, {
  username: process.env.SEED_ADMIN_USERNAME ?? 'admin',
  password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123',
  name: process.env.SEED_ADMIN_NAME ?? '系统管理员',
})
await db.destroy()

console.log(JSON.stringify({ level: 'info', msg: result.created ? '管理员已创建' : '管理员已存在，跳过', username: process.env.SEED_ADMIN_USERNAME ?? 'admin' }))
