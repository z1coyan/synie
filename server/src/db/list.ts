import type { ListQuery } from '@synie/shared'
import { sql, type RawBuilder } from 'kysely'
import { buildListQuery } from '~/db/filterbuild.ts'
import type { DbHandle } from '~/db/tx.ts'
import { companyFilter, type Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { ResourceReadSpec } from '~/platform/meta/read-spec.ts'
import { toReadSpec } from '~/platform/meta/read-spec.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'

export function normalizeListQuery(query: Partial<ListQuery>): ListQuery {
  const limit = query.limit === undefined || query.limit === 0 ? 20 : query.limit
  const offset = query.offset ?? 0
  if (limit < 1 || limit > 200 || offset < 0) {
    throw ApiError.validation('分页参数不合法', { limit: ['必须在 1 到 200 之间'] })
  }
  return {
    limit,
    offset,
    search: query.search,
    sort: query.sort,
    filter: query.filter,
  }
}

/** 公司数据范围 WHERE 片段；empty 时调用方应直接返回空列表 / not_found */
export function companyScopeWhere(
  actor: Actor | null,
  column = 'company_id',
): { empty: boolean; where: RawBuilder<unknown> | null } {
  const scope = companyFilter(actor)
  if (scope.bypass) return { empty: false, where: null }
  if (scope.ids.length === 0) return { empty: true, where: sql`false` }
  return {
    empty: false,
    where: sql`${sql.raw(column)} = ANY(${[...scope.ids]}::uuid[])`,
  }
}

export interface ListFromSourceOptions<T> {
  db: DbHandle
  /**
   * 列表白名单：优先传 ResourceReadSpec；仍接受 ResourceMeta 时内部 toReadSpec。
   * SQL source/select/defaultOrder 由调用方显式拥有。
   */
  resource: ResourceMeta | ResourceReadSpec
  /** 不含 WHERE/ORDER/LIMIT 的 FROM 子句，如 `FROM bas_currency` 或 `FROM (SELECT ...) AS x` */
  source: RawBuilder<unknown>
  select: RawBuilder<unknown>
  defaultOrder: RawBuilder<unknown>
  query: Partial<ListQuery>
  /** 额外 AND 条件（公司隔离等） */
  extraWhere?: RawBuilder<unknown> | null
  mapRow: (row: Record<string, unknown>) => T
}

/**
 * 通用列表：filterbuild 白名单 + 参数化 source 子查询。
 * source 暴露的列名须与 ResourceReadSpec.dbColumn 一致（无表前缀）。
 */
export async function listFromSource<T>(
  options: ListFromSourceOptions<T>,
): Promise<{ count: number; results: T[] }> {
  const q = normalizeListQuery(options.query)
  const readSpec =
    'table' in options.resource
      ? toReadSpec(options.resource as ResourceMeta)
      : (options.resource as ResourceReadSpec)
  const built = buildListQuery(readSpec, q)
  const parts: RawBuilder<unknown>[] = []
  if (built.where) parts.push(built.where)
  if (options.extraWhere) parts.push(options.extraWhere)
  const whereSql =
    parts.length > 0 ? sql` WHERE ${sql.join(parts, sql` AND `)}` : sql``
  const orderSql = built.orderBy
    ? sql` ORDER BY ${built.orderBy}, id ASC`
    : sql` ORDER BY ${options.defaultOrder}`

  const countRow = await sql<{ count: string }>`
    SELECT count(*)::text AS count ${options.source}${whereSql}
  `.execute(options.db)
  const count = Number(countRow.rows[0]?.count ?? 0)

  const rows = await sql<Record<string, unknown>>`
    ${options.select}${options.source}${whereSql}${orderSql}
    LIMIT ${q.limit} OFFSET ${q.offset}
  `.execute(options.db)

  return { count, results: rows.rows.map(options.mapRow) }
}
