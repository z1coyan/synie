/**
 * 审计日志查询（可空公司列）。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit。
 * 「全局事件（company_id IS NULL）所有人可见」由 meta 的 `nullable: true` 声明给出，
 * 编译形态即 `(col IS NULL OR col = ANY($ids))`——手滚 NULL-admitting 变体收编。
 */
import type { ListQuery } from '@synie/shared'
import { sql, type Expression, type Kysely, type SqlBool } from 'kysely'
import { buildListQuery } from '~/db/filterbuild.ts'
import { toReadSpec } from '~/platform/meta/read-spec.ts'
import type { DB as Database } from '~/db/types.ts'
import { compileRowFilter } from '~/db/authz-sql.ts'
import { loadAuthorized } from '~/db/load.ts'
import type { Permit } from '../authz/core/index.ts'
import { ApiError } from '../http/errors.ts'
import type { Registry } from '../meta/registry.ts'
import { AUDIT_LOG_RESOURCE_NAME, auditLogResourceMeta } from './meta.ts'

export interface AuditLog {
  id: string
  resource: string
  recordId: string
  recordLabel: string | null
  actionType: string
  actionName: string
  actorId: string | null
  actorName: string | null
  companyId: string | null
  changes: unknown
  insertedAt: Date
}

export function createAuditService(db: Kysely<Database>, registry: Registry) {
  const target = registry.authzTarget(AUDIT_LOG_RESOURCE_NAME)

  async function get(permit: Permit, id: string): Promise<AuditLog> {
    const row = await loadAuthorized({
      db,
      permit,
      target,
      table: 'sys_audit_log',
      id,
      notFoundMessage: '审计日志不存在',
    })
    return mapLog(row as never)
  }

  async function list(
    permit: Permit,
    query: Partial<ListQuery>,
  ): Promise<{ count: number; results: AuditLog[] }> {
    // 对齐 server-go systemops：Audit 默认 limit=50
    const limit = query.limit === undefined || query.limit === 0 ? 50 : query.limit
    const offset = query.offset ?? 0
    if (limit < 1 || limit > 200 || offset < 0) {
      throw ApiError.validation('分页参数不合法', { limit: ['必须在 1 到 200 之间'] })
    }
    const built = buildListQuery(toReadSpec(auditLogResourceMeta()), {
      limit,
      offset,
      search: query.search,
      sort: query.sort,
      filter: query.filter,
    })

    const scopeClause = compileRowFilter(permit, target, 'sys_audit_log')

    let countQ = db.selectFrom('sys_audit_log').select(db.fn.countAll<string>().as('count'))
    if (built.where) countQ = countQ.where(built.where as Expression<SqlBool>)
    countQ = countQ.where(scopeClause as Expression<SqlBool>)
    const count = Number((await countQ.executeTakeFirstOrThrow()).count)

    let rowsQ = db.selectFrom('sys_audit_log').selectAll()
    if (built.where) rowsQ = rowsQ.where(built.where as Expression<SqlBool>)
    rowsQ = rowsQ.where(scopeClause as Expression<SqlBool>)
    if (built.orderBy) rowsQ = rowsQ.orderBy(built.orderBy as never).orderBy('id')
    else rowsQ = rowsQ.orderBy('inserted_at', 'desc').orderBy('id')
    const rows = await rowsQ.limit(limit).offset(offset).execute()
    return { count, results: rows.map(mapLog) }
  }

  return { get, list }
}

export type AuditService = ReturnType<typeof createAuditService>

function mapLog(row: {
  id: string
  resource: string
  record_id: string
  record_label: string | null
  action_type: string
  action_name: string
  actor_id: string | null
  actor_name: string | null
  company_id: string | null
  changes: unknown
  inserted_at: Date | string
}): AuditLog {
  return {
    id: row.id,
    resource: row.resource,
    recordId: row.record_id,
    recordLabel: row.record_label,
    actionType: row.action_type,
    actionName: row.action_name,
    actorId: row.actor_id,
    actorName: row.actor_name,
    companyId: row.company_id,
    changes: row.changes,
    insertedAt: row.inserted_at instanceof Date ? row.inserted_at : new Date(row.inserted_at),
  }
}
