/**
 * 文件 / 挂接可达性的**单实现**（spec §10 的 S6 + S7 收敛点）。
 *
 * 原先同一个谓词有三份实现三种语义（owner-registry.resolveOwner、files 下载闸、
 * finance 的 requireAccessibleFile）。此处收敛为一条规则，读写两侧共用：
 *
 *   挂接可达 = 业务宿主行可达（宿主 read 码 + 宿主自己的行级范围）
 *   文件可达 = 孤儿（未挂任何宿主）∧ 文件自身行过滤命中
 *            ∨ 任一挂接可达
 *
 * 「文件自身行过滤」= sys_file 的 authz 声明（owner=上传者列）编译出的谓词：
 * 授 scope=self 即「只有上传者能碰自己的孤儿文件」，superAdmin/system 由 decide 给出
 * all 范围自然放开——原先散落的 `actor.superAdmin || uploaded_by === me` 裸旗标读消失。
 * 文件一旦挂到业务宿主上，可达性即由宿主接管（跨公司宿主不可达，与直接读宿主一致）。
 *
 * 为什么宿主判定是动态的：`sys_attachment` 的宿主是多态的（owner_type/owner_id 跨资源），
 * 而 meta 的 `via` 只能声明静态单 parent。分工因此是：
 * - 静态 `via(sysFiles, file_id)` 供**码级**判定与外键闭包（挂接与文件同码 `sys.file:*`，
 *   不设独立权限点；supportedScopes 归文件所有）；
 * - **行级**判定按 owner_type 逐个取宿主 read 凭证、用宿主自己的 authz 声明编译谓词。
 * 两侧的判定逻辑都只有内核 decide 一份，此处不含任何主体/公司的手写分支。
 *
 * 错误语义（spec §1.4）：码不满足 → forbidden；行级不命中 → not_found。
 */
import { sql, type RawBuilder } from 'kysely'
import { compileRowFilter, conjunction, rowFilterParts } from '~/db/authz-sql.ts'
import { ident } from '~/db/ident.ts'
import { findAuthorized } from '~/db/load.ts'
import type { DbHandle } from '~/db/tx.ts'
import type { Actor, Permit } from '~/platform/authz/core/index.ts'
import type { AuthzEnforcer } from '~/platform/authz/enforce.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { AuthzBinding } from '~/platform/meta/resource-authz.ts'
import type { OwnerRegistry } from './owner-registry.ts'

/** 宿主判定所需的两件事：宿主白名单 + 判定入口（decide/归宿解析） */
export interface ReachabilityDeps {
  owners: OwnerRegistry
  authz: Pick<AuthzEnforcer, 'decideFor' | 'targetOf'>
}

const FALSE = sql`false`
/** 宿主行别名：每个 EXISTS 子查询各自作用域，固定名不冲突 */
const OWNER_ALIAS = 'authz_owner'

function disjunction(parts: RawBuilder<unknown>[]): RawBuilder<unknown> {
  if (parts.length === 0) return FALSE
  if (parts.length === 1) return parts[0]!
  return sql`(${sql.join(parts, sql` OR `)})`
}

/**
 * 挂接行的业务宿主可达谓词（alias = sys_attachment 别名）。
 * 每个宿主类型一个析取项；宿主 read 码不满足的类型直接不进 SQL（等价于该类型不可达）。
 *
 * @param ownerType 只编译该宿主类型（调用方已按 owner_type 过滤时省掉其余 EXISTS）
 */
export function ownerReachableWhere(
  deps: ReachabilityDeps,
  actor: Actor,
  alias: string,
  ownerType?: string,
): RawBuilder<unknown> {
  const parts: RawBuilder<unknown>[] = []
  for (const [type, spec] of deps.owners.snapshot()) {
    if (ownerType !== undefined && type !== ownerType) continue
    const decision = deps.authz.decideFor(actor, spec.resource, 'read')
    if (decision.outcome === 'deny') continue
    const where = compileRowFilter(decision.permit, deps.authz.targetOf(spec.resource), OWNER_ALIAS)
    parts.push(
      sql`(${ident(alias)}.owner_type = ${type} AND EXISTS (
        SELECT 1 FROM ${ident(spec.table)} AS ${ident(OWNER_ALIAS)}
        WHERE ${ident(OWNER_ALIAS)}.id = ${ident(alias)}.owner_id AND ${where}
      ))`,
    )
  }
  return disjunction(parts)
}

/**
 * 文件行可达谓词（alias = sys_file 别名）：孤儿走文件自身行过滤，已挂接走宿主。
 * @param binding 判定归宿的 root 绑定（sys_file 的 authz：无公司列 + owner=uploaded_by_id）
 */
export function fileReachableWhere(
  deps: ReachabilityDeps,
  permit: Permit,
  binding: AuthzBinding,
  alias: string,
): RawBuilder<unknown> {
  const attachments = sql`SELECT 1 FROM sys_attachment AS authz_att WHERE authz_att.file_id = ${ident(
    alias,
  )}.id`
  const orphan = conjunction([
    sql`NOT EXISTS (${attachments})`,
    conjunction(rowFilterParts(permit, binding, alias)),
  ])
  const throughOwner = sql`EXISTS (${attachments} AND ${ownerReachableWhere(
    deps,
    permit.actor,
    'authz_att',
  )})`
  return disjunction([orphan, throughOwner])
}

/** 按可达性取一行文件；不命中一律 not_found（不泄露存在性） */
export async function loadReachableFile(
  db: DbHandle,
  deps: ReachabilityDeps,
  permit: Permit,
  binding: AuthzBinding,
  id: string,
  options?: { forUpdate?: boolean },
): Promise<Record<string, unknown>> {
  const where = fileReachableWhere(deps, permit, binding, 'sys_file')
  const lock = options?.forUpdate ? sql` FOR UPDATE` : sql``
  const result = await sql<Record<string, unknown>>`
    SELECT sys_file.* FROM sys_file
    WHERE sys_file.id = ${id}::uuid AND ${where}${lock}
  `.execute(db)
  const row = result.rows[0]
  if (!row) throw new ApiError('not_found', '文件不存在')
  return row
}

/**
 * 挂接写侧：校验业务宿主可达并返回固化到挂接上的 company_id
 * （宿主为 company 形态时取宿主公司，global 形态为 null）。
 */
export async function resolveOwner(
  db: DbHandle,
  deps: ReachabilityDeps,
  actor: Actor,
  ownerType: string,
  ownerId: string,
): Promise<string | null> {
  const spec = deps.owners.lookup(ownerType)
  if (!spec) {
    throw ApiError.validation('未知的宿主类型', { ownerType: ['不在允许的附件宿主白名单'] })
  }
  const decision = deps.authz.decideFor(actor, spec.resource, 'read')
  if (decision.outcome === 'deny') {
    throw new ApiError('forbidden', '无权访问该宿主记录')
  }
  const target = deps.authz.targetOf(spec.resource)
  const row = await findAuthorized({
    db,
    permit: decision.permit,
    target,
    table: spec.table,
    id: ownerId,
  })
  if (!row) throw new ApiError('not_found', '宿主记录不存在')
  // 公司列在宿主自己表上才可取（via 宿主的公司列在其更上层，挂接不固化公司）
  const column = target.chain.length === 0 ? target.root.company?.column : undefined
  if (!column) return null
  const value = row[column]
  return value == null ? null : String(value)
}
