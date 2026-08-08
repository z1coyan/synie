/**
 * 开发库复位到「仅 migrate、未 setup」状态：
 * - 清空全部业务表（保留 synie_schema_migration 与四张设置单行）
 * - setup_completed_at = NULL
 * - 不写管理员、不写示例数据
 *
 * 仅允许本地 / 开发环境；生产 DSN 或 NODE_ENV=production 直接拒绝。
 *
 * 用法（仓库根或 server/）：
 *   DATABASE_URL=postgres://synie:synie@localhost:5441/synie?sslmode=disable bun run db:reset
 */
import { sql, type Kysely, type Transaction } from 'kysely'
import { createDb } from '../src/db/index.ts'
import type { DB as Database } from '../src/db/types.ts'
import { extractUpSection } from './migrate.ts'

const KEEP_TABLES = new Set([
  'synie_schema_migration',
  'sys_setting',
  'sal_setting',
  'mfg_setting',
  'acc_setting',
])

/**
 * migrate 后幂等种子文件（truncate 后需重放，对齐「仅 migrate 完成」的库状态）。
 * 仅限纯种子迁移（幂等 INSERT、无 DDL）；混有 DDL 的迁移不可重放，
 * 其种子须以纯种子副本另存（如 00024 之于 00022）。
 */
const RESEED_MIGRATIONS = [
  '00002_seed_settings_singletons.sql',
  '00003_seed_market_catalog.sql',
  '00024_seed_numbering_rules.sql',
]

/** 在事务内重放 migrate 幂等种子（导出供集成测试复用，避免规则种子出现第三处副本） */
export async function reseedIdempotentSeeds(
  trx: Kysely<Database> | Transaction<Database>,
  files: readonly string[] = RESEED_MIGRATIONS,
): Promise<void> {
  const migrationsDir = new URL('./migrations/', import.meta.url).pathname
  for (const file of files) {
    const content = extractUpSection(await Bun.file(`${migrationsDir}${file}`).text(), file)
    await sql.raw(content).execute(trx)
  }
}

function isDevDatabaseUrl(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    // postgres://user:pass@host:port/db 形式
    const m = /@([^/:?]+)/.exec(url)
    host = (m?.[1] ?? '').toLowerCase()
  }
  if (!host) return false
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === 'postgres' || // compose 服务名
    host === 'host.docker.internal' ||
    host.endsWith('.local')
  )
}

function assertDevOnly(databaseUrl: string): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:reset 拒绝在 NODE_ENV=production 下执行')
  }
  if (process.env.SYNIE_ENV === 'production' || process.env.APP_ENV === 'production') {
    throw new Error('db:reset 拒绝在 production 环境标识下执行')
  }
  if (!isDevDatabaseUrl(databaseUrl)) {
    throw new Error(
      `db:reset 仅允许本地/开发库（localhost、127.0.0.1、compose postgres 等），当前 DATABASE_URL 主机不安全`,
    )
  }
  // 显式双保险：测试库名 synie_test 与开发库 synie 均允许；其它库名需 SYNIE_ALLOW_DB_RESET=1
  let dbName = ''
  try {
    dbName = new URL(databaseUrl).pathname.replace(/^\//, '').split('?')[0] ?? ''
  } catch {
    const m = /\/([^/?]+)(?:\?|$)/.exec(databaseUrl)
    dbName = m?.[1] ?? ''
  }
  const allowedNames = new Set(['synie', 'synie_test', 'synie_dev'])
  if (!allowedNames.has(dbName) && process.env.SYNIE_ALLOW_DB_RESET !== '1') {
    throw new Error(
      `db:reset 默认仅允许库名 synie / synie_test / synie_dev（当前=${dbName || '?'}）；若确认是开发库请设置 SYNIE_ALLOW_DB_RESET=1`,
    )
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('必须设置 DATABASE_URL')
    process.exit(1)
  }

  try {
    assertDevOnly(databaseUrl)
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }

  const db = createDb(databaseUrl)
  try {
    const tables = await sql<{ tablename: string }>`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `.execute(db)

    const toTruncate = tables.rows
      .map((r) => r.tablename)
      .filter((name) => !KEEP_TABLES.has(name))

    await db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('synie-db-reset'))`.execute(trx)
      await sql`SET LOCAL lock_timeout = '30s'`.execute(trx)
      await sql`SET LOCAL statement_timeout = '120s'`.execute(trx)

      if (toTruncate.length > 0) {
        // 标识符来自 pg_tables，非用户输入；逐表 quote
        const list = toTruncate.map((t) => `"${t.replaceAll('"', '""')}"`).join(', ')
        await sql.raw(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`).execute(trx)
      }

      // 四张设置单行：保证存在，并清除初始化旗标
      await sql`
        INSERT INTO sal_setting (id, inserted_at, updated_at)
        SELECT gen_random_uuid(), now() AT TIME ZONE 'utc', now() AT TIME ZONE 'utc'
        WHERE NOT EXISTS (SELECT 1 FROM sal_setting)
      `.execute(trx)
      await sql`
        INSERT INTO mfg_setting (id, inserted_at, updated_at)
        SELECT gen_random_uuid(), now() AT TIME ZONE 'utc', now() AT TIME ZONE 'utc'
        WHERE NOT EXISTS (SELECT 1 FROM mfg_setting)
      `.execute(trx)
      await sql`
        INSERT INTO acc_setting (id, inserted_at, updated_at)
        SELECT gen_random_uuid(), now() AT TIME ZONE 'utc', now() AT TIME ZONE 'utc'
        WHERE NOT EXISTS (SELECT 1 FROM acc_setting)
      `.execute(trx)
      await sql`
        INSERT INTO sys_setting (id, inserted_at, updated_at)
        SELECT gen_random_uuid(), now() AT TIME ZONE 'utc', now() AT TIME ZONE 'utc'
        WHERE NOT EXISTS (SELECT 1 FROM sys_setting)
      `.execute(trx)

      await sql`
        UPDATE sys_setting SET
          setup_completed_at = NULL,
          market_fetch_last_run_at = NULL,
          market_fetch_last_summary = NULL,
          updated_at = now() AT TIME ZONE 'utc'
      `.execute(trx)

      // 重放 migrate 幂等种子，等价于「刚跑完 migrate」而非完全空 schema
      await reseedIdempotentSeeds(trx)
    })

    const status = await sql<{ initialized: boolean; has_users: boolean }>`
      SELECT
        EXISTS (SELECT 1 FROM sys_setting WHERE setup_completed_at IS NOT NULL) AS initialized,
        EXISTS (SELECT 1 FROM sys_user) AS has_users
    `.execute(db)

    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'db:reset 完成（未 setup 状态）',
        truncated: toTruncate.length,
        reseeded: RESEED_MIGRATIONS,
        initialized: Boolean(status.rows[0]?.initialized),
        hasUsers: Boolean(status.rows[0]?.has_users),
      }),
    )
  } finally {
    await db.destroy()
  }
}

// import.meta.main 门控：集成测试 import reseedIdempotentSeeds 时不触发复位
if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
