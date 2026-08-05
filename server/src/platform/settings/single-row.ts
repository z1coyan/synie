/**
 * 单行设置引擎：get + update + 审计 diff。
 * 业务域声明 table/map/merge/validate（约 20 行），platform 只留骨架与 sys_setting。
 *
 * 授权由平台承担：路由挂 `guard(资源, 动作)`，本引擎只收 Permit。
 * 跨域/调度的受信任读走 `load(systemPermit(...))`——主体显式为 system，
 * 取代「裸函数即受信任」的隐式约定（spec §4）。
 */
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { auditDiff, writeAudit } from '../audit/write.ts'
import type { Permit } from '../authz/core/index.ts'
import { ApiError } from '../http/errors.ts'

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/

export interface SingleRowSettingConfig<TView extends { id: string }, TUpdate> {
  /** 物理表名（须为合法标识符） */
  table: string
  /** 审计 resource 名（通常与 table 相同） */
  resource: string
  notFoundMessage: string
  mapRow: (row: Record<string, unknown>) => TView
  /**
   * 合并更新：返回 after 视图、写库 set 列、审计 snap 前后。
   * lockedRow 为 FOR UPDATE 原行（含 write-only 密钥列等）。
   */
  merge: (
    before: TView,
    input: TUpdate,
    lockedRow: Record<string, unknown>,
  ) => {
    after: TView
    set: Record<string, unknown>
    beforeSnap: Record<string, unknown>
    afterSnap: Record<string, unknown>
  }
  /** 审计字段白名单（snake_case，与 snap 键一致） */
  auditFields: readonly string[]
  sensitiveFields?: readonly string[]
}

export function createSingleRowSetting<TView extends { id: string }, TUpdate>(
  db: Kysely<Database>,
  config: SingleRowSettingConfig<TView, TUpdate>,
) {
  if (!IDENTIFIER_RE.test(config.table)) {
    throw new Error(`settings: 非法表名 ${config.table}`)
  }
  const tableSql = sql.raw(config.table)

  /**
   * 配置读：单行设置是全局资源（无公司列），Permit 只作主体标记不产生行过滤。
   * 调度/过账链路传 systemPermit(...)；HTTP 路径由 get 经 guard 的 Permit 进入。
   */
  async function load(permit: Permit): Promise<TView> {
    void permit
    const result = await sql<Record<string, unknown>>`
      SELECT * FROM ${tableSql} LIMIT 1
    `.execute(db)
    const row = result.rows[0]
    if (!row) throw new ApiError('not_found', config.notFoundMessage)
    return config.mapRow(row)
  }

  async function get(permit: Permit): Promise<TView> {
    return load(permit)
  }

  async function update(permit: Permit, input: TUpdate): Promise<TView> {
    return withTx(db, async (trx) => {
      const locked = await sql<Record<string, unknown>>`
        SELECT * FROM ${tableSql} FOR UPDATE LIMIT 1
      `.execute(trx)
      const row = locked.rows[0]
      if (!row) throw new ApiError('not_found', config.notFoundMessage)
      const before = config.mapRow(row)
      const { after, set, beforeSnap, afterSnap } = config.merge(before, input, row)
      const changes = auditDiff(beforeSnap, afterSnap, config.auditFields)
      if (Object.keys(changes).length === 0) return before

      const setParts = Object.entries(set).map(
        ([col, val]) => sql`${sql.raw(col)} = ${val as never}`,
      )
      setParts.push(sql`updated_at = (now() AT TIME ZONE 'utc')`)
      const updated = await sql<Record<string, unknown>>`
        UPDATE ${tableSql}
        SET ${sql.join(setParts, sql`, `)}
        WHERE id = ${after.id}::uuid
        RETURNING *
      `.execute(trx)
      const result = config.mapRow(updated.rows[0]!)
      await writeAudit(trx as DbHandle, permit.actor, {
        resource: config.resource,
        recordId: result.id,
        actionType: 'update',
        actionName: 'update',
        changes,
        sensitiveFields: config.sensitiveFields ? [...config.sensitiveFields] : undefined,
      })
      return result
    })
  }

  return { get, load, update }
}

export type SingleRowSettingService<TView extends { id: string }, TUpdate> = ReturnType<
  typeof createSingleRowSetting<TView, TUpdate>
>
