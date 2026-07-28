import type { Kysely, Transaction } from 'kysely'
import type { DB as Database } from './types.ts'

/**
 * 事务约定（对齐 server-go 的 pgx.Tx 显式传递惯例）：
 * - 查询/读路径函数接 DbHandle，不感知自己是否身处事务
 * - 写路径（过账链路：审核/作废等）由 service 入口用 withTx 包裹
 * - withTx 是全系统唯一产生 TrxHandle 的地方；事实引擎的写方法
 *   （gl.post/cancel/reverse、inventory.post/cancel）只收 TrxHandle——
 *   裸 db 传入即编译错误，「过账必须单事务」由类型系统强制而非靠评审
 * - 禁止在引擎/深模块内部自行起事务（事务边界归调用方，见迁移规划 KD19/KD26）
 */
export type DbHandle = Kysely<Database> | Transaction<Database>

declare const trxBrand: unique symbol

/**
 * 事务内句柄。仅 withTx 可产生（brand 不可伪造）；
 * 引擎写方法以此把「必须身处事务」从约定变成机制。
 */
export type TrxHandle = Transaction<Database> & { readonly [trxBrand]: true }

export function withTx<T>(db: Kysely<Database>, run: (trx: TrxHandle) => Promise<T>): Promise<T> {
  return db.transaction().execute((trx) => run(trx as TrxHandle))
}
