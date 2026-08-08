/**
 * 启动迁移版本校验：磁盘 db/migrations/*.sql 与 public.synie_schema_migration 比对，
 * 落后即拒绝启动（compose 路径由 migrate service 门住，此校验兜住非 compose 裸跑路径）。
 * migrate.ts 自身不引用本模块（迁移执行器当然不校验）。
 */
import { Glob } from 'bun'
import { sql, type Kysely } from 'kysely'
import type { DB as Database } from '../src/db/types.ts'

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url).pathname

/** 磁盘迁移文件清单（按文件名字典序，与 migrate.ts 同一约定） */
export async function listMigrationFiles(): Promise<string[]> {
  const files: string[] = []
  for await (const file of new Glob('*.sql').scan({ cwd: MIGRATIONS_DIR })) {
    files.push(file)
  }
  return files.sort()
}

/** 已应用版本；追踪表不存在（42P01，从未跑过迁移）按「全部缺失」返回空表 */
export async function appliedMigrationVersions(db: Kysely<Database>): Promise<string[]> {
  try {
    const rows = await sql<{ version: string }>`SELECT version FROM public.synie_schema_migration`.execute(db)
    return rows.rows.map((row) => row.version)
  } catch (err) {
    if ((err as { code?: string })?.code === '42P01') return []
    throw err
  }
}

/** 比对磁盘迁移与已应用版本，返回缺失清单（纯函数） */
export function missingMigrations(files: string[], applied: string[]): string[] {
  const appliedSet = new Set(applied)
  return files.filter((file) => !appliedSet.has(file))
}

/** 迁移落后时抛出中文错误（调用方 catch 后拒绝启动） */
export async function assertMigrationsCurrent(db: Kysely<Database>): Promise<void> {
  const missing = missingMigrations(await listMigrationFiles(), await appliedMigrationVersions(db))
  if (missing.length > 0) {
    throw new Error(
      `数据库迁移落后于代码：缺失 ${missing.length} 个迁移（${missing.join('、')}）。` +
        '请先执行迁移：bun run db:migrate',
    )
  }
}
