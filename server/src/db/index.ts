import { Kysely } from 'kysely'
import { PostgresJSDialect } from 'kysely-postgres-js'
import postgres from 'postgres'
import type { DB as Database } from './types.ts'

/**
 * Kysely + postgres.js（方言包 kysely-postgres-js；postgres.js 是纯 JS 驱动，
 * Bun 原生可跑，无 Node 原生模块）。若将来要换 Bun.sql，仅需替换此文件的方言构造。
 */
export function createDb(databaseUrl: string): Kysely<Database> {
  const client = postgres(databaseUrl, { max: 10 })
  return new Kysely<Database>({ dialect: new PostgresJSDialect({ postgres: client }) })
}

export type { DB as Database } from './types.ts'
