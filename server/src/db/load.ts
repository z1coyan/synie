/**
 * 授权单记录加载与写侧守卫（工单 04 的执行点 2 与 3）。
 *
 * 取代全库「loadX + 公司闸」组合：统一 `not_found`（不泄露存在性）、折叠 `FOR UPDATE`。
 * update/delete/工作流命令一律经此取行——「只能改本人/本部门单据」零模块代码。
 */
import { sql, type RawBuilder } from 'kysely'
import { compileRowFilter } from '~/db/authz-sql.ts'
import { ident } from '~/db/ident.ts'
import type { DbHandle } from '~/db/tx.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { AuthzTarget } from '~/platform/meta/resource-authz.ts'

export interface LoadAuthorizedOptions {
  db: DbHandle
  permit: Permit
  target: AuthzTarget
  /** 目标表名（meta.table） */
  table: string
  id: string
  /** 行锁：审核/作废等写路径按需（对齐 lockOrder/lockDraft 实践） */
  forUpdate?: boolean
  /** not_found 文案（默认「记录不存在」，不区分不存在与无权限） */
  notFoundMessage?: string
}

/**
 * 按 Permit 的行过滤取一行；不命中一律 `not_found`。
 * 返回原始行（服务层自行 map），避免平台层承担领域投影。
 */
export async function loadAuthorized(
  options: LoadAuthorizedOptions,
): Promise<Record<string, unknown>> {
  const row = await findAuthorized(options)
  if (!row) {
    throw new ApiError('not_found', options.notFoundMessage ?? '记录不存在')
  }
  return row
}

/** 同 loadAuthorized，但不命中返回 null（调用方自行决定语义） */
export async function findAuthorized(
  options: LoadAuthorizedOptions,
): Promise<Record<string, unknown> | null> {
  const table = ident(options.table)
  const where = compileRowFilter(options.permit, options.target, options.table)
  const lock = options.forUpdate ? sql` FOR UPDATE` : sql``
  const result = await sql<Record<string, unknown>>`
    SELECT ${table}.* FROM ${table}
    WHERE ${table}.id = ${options.id}::uuid AND ${where}${lock}
  `.execute(options.db)
  return result.rows[0] ?? null
}

export interface LoadProjectedOptions<T> {
  db: DbHandle
  permit: Permit
  target: AuthzTarget
  /** 目标行在 source 中的别名（子查询别名；`FROM x` 时即表名） */
  alias: string
  /** 不含 WHERE 的 FROM 子句（与列表共用同一份投影） */
  source: RawBuilder<unknown>
  select: RawBuilder<unknown>
  id: string
  mapRow: (row: Record<string, unknown>) => T
  notFoundMessage?: string
}

/**
 * 按 Permit 从**投影**（带 join 的 SOURCE 子查询）取一行：
 * 服务层的 `get` 与列表共用同一份 SQL 投影，无需为鉴权再查一次裸表。
 * 行锁请用 `loadAuthorized({ forUpdate: true })`（子查询不能加 FOR UPDATE）。
 */
export async function loadAuthorizedFrom<T>(options: LoadProjectedOptions<T>): Promise<T> {
  const row = await findAuthorizedFrom(options)
  if (row === null) {
    throw new ApiError('not_found', options.notFoundMessage ?? '记录不存在')
  }
  return row
}

/** 同 loadAuthorizedFrom，但不命中返回 null（本文件内消费；调用方需要时再 export） */
async function findAuthorizedFrom<T>(
  options: LoadProjectedOptions<T>,
): Promise<T | null> {
  const where = compileRowFilter(options.permit, options.target, options.alias)
  const result = await sql<Record<string, unknown>>`
    ${options.select}${options.source}
    WHERE ${ident(options.alias)}.id = ${options.id}::uuid AND ${where}
  `.execute(options.db)
  const row = result.rows[0]
  return row ? options.mapRow(row) : null
}

/**
 * 公司是否落在 Permit 的公司边界内。
 * 单公司聚合端点（库存余额等）按此判定：不命中即返回空结果，不泄露存在性。
 * 逐行列表一律走 `listAuthorized`，不用本函数手滚。
 */
export function companyInPermitScope(permit: Permit, companyId: string): boolean {
  const scope = permit.rowFilter.company
  if (scope === 'bypass') return true
  if (scope === 'none') return false
  return scope.ids.includes(companyId)
}

/**
 * create 写侧守卫：目标公司必须在 Permit 的公司边界内，不命中 `not_found`
 * （不泄露公司存在性，与错误语义唯一规则一致）。
 */
export function assertCompanyWritable(
  permit: Permit,
  companyId: string,
  message = '公司不存在',
): void {
  if (!companyInPermitScope(permit, companyId)) {
    throw new ApiError('not_found', message)
  }
}

/**
 * 创建时的归属盖章：`created_by_id`（既有）与 `owner_dept_id`（声明 stamped 才盖）。
 * assigned 形态是业务字段，不在此盖章、不受操作者部门约束。
 */
export function ownershipStamp(
  permit: Permit,
  target: AuthzTarget,
): Record<string, string | null> {
  const stamp: Record<string, string | null> = {}
  const binding = target.root
  if (binding.owner) stamp[binding.owner.column] = permit.actor.userId
  if (binding.dept?.mode === 'stamped') stamp[binding.dept.column] = permit.actor.deptId
  return stamp
}

/**
 * 把盖章列并入 insert values：模块侧不写盖章列名（列名归 meta 声明）。
 * 返回类型不变，故 kysely 的 InsertObject 类型检查照旧生效。
 */
export function withOwnershipStamp<T extends object>(
  values: T,
  permit: Permit,
  target: AuthzTarget,
): T {
  return { ...values, ...ownershipStamp(permit, target) } as T
}
