import type { Kysely, Transaction } from 'kysely'
import type { DB as Database } from './types.ts'

/**
 * 事务约定（对齐 server-go 的 pgx.Tx 显式传递惯例）：
 * - 查询/服务函数一律接 DbHandle，不感知自己是否身处事务
 * - 过账链路（审核/作废等）由入口用 withTx 包裹，把 trx 显式传到底层与引擎
 * - 禁止在引擎/深模块内部自行起事务（事务边界归调用方，见迁移规划 KD19/KD26）
 */
export type DbHandle = Kysely<Database> | Transaction<Database>

export function withTx<T>(db: Kysely<Database>, run: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  return db.transaction().execute(run)
}
