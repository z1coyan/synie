import { Kysely } from 'kysely'
import { PostgresJSDialect } from 'kysely-postgres-js'
import postgres from 'postgres'
import type { DB as Database } from './types.ts'

/** 连接池配置（env PG_POOL_* 注入；缺省对齐 postgres.js 内置默认） */
export interface PgPoolOptions {
  /** 最大连接数（默认 10） */
  max?: number
  /** 空闲回收秒数；0/缺省 = 不主动回收 */
  idleTimeoutSeconds?: number
  /** 建立连接超时秒数（默认 30） */
  connectTimeoutSeconds?: number
}

/**
 * Kysely + postgres.js（方言包 kysely-postgres-js；postgres.js 是纯 JS 驱动，
 * Bun 原生可跑，无 Node 原生模块）。若将来要换 Bun.sql，仅需替换此文件的方言构造。
 */
export function createDb(databaseUrl: string, pool: PgPoolOptions = {}): Kysely<Database> {
  const client = postgres(databaseUrl, {
    max: pool.max ?? 10,
    idle_timeout: pool.idleTimeoutSeconds && pool.idleTimeoutSeconds > 0 ? pool.idleTimeoutSeconds : undefined,
    connect_timeout: pool.connectTimeoutSeconds ?? 30,
  })
  return new Kysely<Database>({ dialect: new PostgresJSDialect({ postgres: client }) })
}

export type { DB as Database } from './types.ts'
