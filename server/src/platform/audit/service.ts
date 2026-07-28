import type { ListQuery } from '@synie/shared'
import { sql, type Expression, type Kysely, type SqlBool } from 'kysely'
import { buildListQuery } from '~/db/filterbuild.ts'
import type { DB as Database } from '~/db/types.ts'
import type { Actor } from '../authz/actor.ts'
import { companyFilter, hasPermission } from '../authz/actor.ts'
import { ApiError } from '../http/errors.ts'
import { auditLogResourceMeta } from './meta.ts'

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

export function createAuditService(db: Kysely<Database>) {
  async function get(actor: Actor, id: string): Promise<AuditLog> {
    requireRead(actor)
    const row = await db.selectFrom('sys_audit_log').selectAll().where('id', '=', id).executeTakeFirst()
    if (!row) throw new ApiError('not_found', '审计日志不存在')
    const value = mapLog(row)
    assertCompanyAccess(actor, value.companyId)
    return value
  }

  async function list(
    actor: Actor,
    query: Partial<ListQuery>,
  ): Promise<{ count: number; results: AuditLog[] }> {
    requireRead(actor)
    // 对齐 server-go systemops：Audit 默认 limit=50
    const limit = query.limit === undefined || query.limit === 0 ? 50 : query.limit
    const offset = query.offset ?? 0
    if (limit < 1 || limit > 200 || offset < 0) {
      throw ApiError.validation('分页参数不合法', { limit: ['必须在 1 到 200 之间'] })
    }
    const built = buildListQuery(auditLogResourceMeta(), {
      limit,
      offset,
      search: query.search,
      sort: query.sort,
      filter: query.filter,
    })

    const scope = companyFilter(actor)
    const scopeClause = scope.bypass
      ? null
      : sql`(company_id IS NULL OR company_id = ANY(${[...scope.ids]}::uuid[]))`

    let countQ = db.selectFrom('sys_audit_log').select(db.fn.countAll<string>().as('count'))
    if (built.where) countQ = countQ.where(built.where as Expression<SqlBool>)
    if (scopeClause) countQ = countQ.where(scopeClause as Expression<SqlBool>)
    const count = Number((await countQ.executeTakeFirstOrThrow()).count)

    let rowsQ = db.selectFrom('sys_audit_log').selectAll()
    if (built.where) rowsQ = rowsQ.where(built.where as Expression<SqlBool>)
    if (scopeClause) rowsQ = rowsQ.where(scopeClause as Expression<SqlBool>)
    if (built.orderBy) rowsQ = rowsQ.orderBy(built.orderBy as never).orderBy('id')
    else rowsQ = rowsQ.orderBy('inserted_at', 'desc').orderBy('id')
    const rows = await rowsQ.limit(limit).offset(offset).execute()
    return { count, results: rows.map(mapLog) }
  }

  return { get, list }
}

export type AuditService = ReturnType<typeof createAuditService>

function requireRead(actor: Actor): void {
  if (!hasPermission(actor, 'sys.audit_log:read')) {
    throw new ApiError('forbidden', '无权限执行该操作')
  }
}

function assertCompanyAccess(actor: Actor, companyId: string | null): void {
  if (companyId === null) return
  const scope = companyFilter(actor)
  if (scope.bypass) return
  // 公司隔离 fail-closed：无权当「不存在」，对齐 server-go systemops
  if (!scope.ids.includes(companyId)) {
    throw new ApiError('not_found', '审计日志不存在')
  }
}

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
