/**
 * 简道云一次性迁移 CLI 的共享 bootstrap。
 *
 * env → DSN → db → sealed registry → numbering catalog → gl 的装配只在这里
 * 写一次；各 CLI 的 main 接收装配好的依赖，不再各自手工重建世界。装配全部
 * 走 server/src 的真实工厂（与 server/src/composition.ts 同源），不另造平行世界。
 */
import type { Kysely } from 'kysely'
import { createDb } from '../../server/src/db/index.ts'
import type { DB as Database } from '../../server/src/db/types.ts'
import { createGlEngine } from '../../server/src/engines/gl/index.ts'
import { createJournalService } from '../../server/src/modules/accounting/journal-service.ts'
import { isJournalLinkedToBankRecon } from '../../server/src/modules/finance/banking-recon.ts'
import { systemPermit } from '../../server/src/platform/authz/core/index.ts'
import { createSealedResourceRegistry } from '../../server/src/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '../../server/src/platform/numbering/index.ts'

/** 简道云迁移写库的审计/日记账 actor（迁移专用系统用户） */
export const MIGRATION_ACTOR_ID = '99e3e4f6-e208-4bb9-904c-72299808a8e7'

export interface MigrationWorld {
  db: Kysely<Database>
  registry: ReturnType<typeof createSealedResourceRegistry>
  numbering: ReturnType<typeof createNumberingService>
  gl: ReturnType<typeof createGlEngine>
}

/** sealed registry → numbering catalog → gl（db 已存在时的装配，backfill 复用） */
export function createServiceAssembly(db: Kysely<Database>) {
  const registry = createSealedResourceRegistry()
  const numbering = createNumberingService(db, buildNumberingCatalog(registry), registry)
  const gl = createGlEngine()
  return { registry, numbering, gl }
}

/** env → db → sealed registry → numbering catalog → gl，一次性装配 */
export function createMigrationWorld(databaseUrl: string): MigrationWorld {
  const db = createDb(databaseUrl)
  return { db, ...createServiceAssembly(db) }
}

export async function destroyMigrationWorld(world: MigrationWorld): Promise<void> {
  await world.db.destroy()
}

/** journals.cancel 装配（w4-1121-nail / w4-1121-yhdz 共用） */
export function createMigrationJournalService(
  world: MigrationWorld,
): ReturnType<typeof createJournalService> {
  return createJournalService(world.db, world.numbering, world.gl, world.registry, {
    isJournalLinkedToBankRecon,
  })
}

/** 迁移 CLI 用到的 systemPermit；资源/动作字面量只在这里出现一次 */
export const migrationPermits = {
  journalCancel: () => systemPermit('accGlJournals', 'cancel'),
  billAudit: () => systemPermit('accBillTransactions', 'audit'),
  vatInvoiceAudit: () => systemPermit('accVatInvoices', 'audit'),
  deliveryAudit: () => systemPermit('salDeliveries', 'audit'),
} as const

/** DATABASE_URL 优先；否则由 PG* 拼 DSN（本地/dev 库，sslmode=disable） */
export function resolveBackfillDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL
  if (!env.PGDATABASE) {
    throw new Error('必须设置 DATABASE_URL 或 PGDATABASE')
  }
  const user = env.PGUSER ?? 'postgres'
  const auth = env.PGPASSWORD
    ? `${encodeURIComponent(user)}:${encodeURIComponent(env.PGPASSWORD)}`
    : encodeURIComponent(user)
  const host = env.PGHOST ?? 'localhost'
  const port = env.PGPORT ?? '5432'
  return `postgres://${auth}@${host}:${port}/${env.PGDATABASE}?sslmode=disable`
}

export function dsnHost(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname}:${u.port}${u.pathname}`
  } catch {
    return '(unparseable)'
  }
}

/** 彩排库（synie_replay_check:5441）默认放行；生产必须显式 --allow-prod */
export function assertReplayUrl(url: string, allowProd: boolean): void {
  const isReplay = url.includes('synie_replay_check') && url.includes(':5441')
  const isProd = /100\.82\.52\.74|:26002/.test(url) && /\/synie(\?|$)/.test(url)
  if (allowProd) {
    if (!isProd) throw new Error(`--allow-prod 只允许生产 DSN，当前 ${dsnHost(url)}`)
    return
  }
  if (!isReplay) throw new Error(`禁止非彩排库：${dsnHost(url)}（生产请加 --allow-prod）`)
}
