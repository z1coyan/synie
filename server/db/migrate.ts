/**
 * SQL 迁移执行器。
 *
 * 行为：
 * - db/migrations/*.sql（纯 SQL，无注解）按文件名字典序执行，每文件一个事务
 * - 不支持回滚；系统未上线，需要变更历史时压平重建 baseline
 * - 已应用版本记录在 synie_schema_migration（运行时自建，不属于 baseline）
 * - pg_advisory_lock 串行化并发启动（compose 多容器同时 migrate 安全）
 *
 * 用法：DATABASE_URL=... bun run db:migrate
 */
import { Glob } from 'bun'
import postgres from 'postgres'

const LOCK_KEY = 727_272
const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url).pathname

async function acquireLock(sql: postgres.Sql): Promise<void> {
  for (;;) {
    const rows = await sql`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS acquired`
    if (rows[0]?.acquired) return
    await Bun.sleep(200)
  }
}

async function listMigrationFiles(): Promise<string[]> {
  const files: string[] = []
  for await (const file of new Glob('*.sql').scan({ cwd: MIGRATIONS_DIR })) {
    files.push(file)
  }
  return files.sort()
}

async function run(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('必须设置 DATABASE_URL')
    process.exit(1)
  }

  const sql = postgres(databaseUrl, { max: 1 })
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS public.synie_schema_migration (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `
    await acquireLock(sql)
    try {
      const appliedRows = await sql`SELECT version FROM public.synie_schema_migration`
      const applied = new Set(appliedRows.map((row) => row.version))

      const files = await listMigrationFiles()
      let count = 0
      for (const file of files) {
        if (applied.has(file)) continue
        const content = await Bun.file(`${MIGRATIONS_DIR}${file}`).text()
        await sql.begin(async (tx) => {
          await tx.unsafe(content)
          await tx`INSERT INTO public.synie_schema_migration (version) VALUES (${file})`
        })
        count += 1
        console.log(JSON.stringify({ level: 'info', msg: 'migration applied', version: file }))
      }
      console.log(JSON.stringify({ level: 'info', msg: 'migrate done', applied: count, total: files.length }))
    } finally {
      await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`
    }
  } finally {
    await sql.end()
  }
}

if (import.meta.main) {
  try {
    await run()
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'migrate failed', err: String(err) }))
    process.exit(1)
  }
}
