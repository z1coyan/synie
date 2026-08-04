import { sql } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'
import { canAccessCompany, hasPermission, type Actor } from '../authz/actor.ts'
import { ApiError } from '../http/errors.ts'
import type { ResourceMeta } from '../meta/types.ts'
import type { OwnerSpec } from './types.ts'

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/

/**
 * 附件宿主白名单：fail-closed，仅注册过的 ownerType 可挂接。
 * 领域包声明 spec，启动期 register；files 层不硬编码业务表名。
 */
export function createOwnerRegistry() {
  const owners = new Map<string, OwnerSpec>()

  function register(ownerType: string, spec: OwnerSpec): void {
    if (!ownerType || !spec.table || !spec.permissionPrefix) {
      throw new Error(`files: 附件宿主注册不完整 (ownerType=${JSON.stringify(ownerType)})`)
    }
    if (!IDENTIFIER_RE.test(spec.table)) {
      throw new Error(`files: 宿主表名非法: ${spec.table}`)
    }
    if (owners.has(ownerType)) {
      throw new Error(`重复附件宿主注册: ${ownerType}`)
    }
    owners.set(ownerType, { ...spec })
  }

  function lookup(ownerType: string): OwnerSpec | undefined {
    return owners.get(ownerType)
  }

  function snapshot(): ReadonlyMap<string, OwnerSpec> {
    return new Map(owners)
  }

  return { register, lookup, snapshot }
}

export type OwnerRegistry = ReturnType<typeof createOwnerRegistry>

/**
 * 从 Meta Registry 派生附件宿主注册表：声明了 attachments 的资源即宿主。
 * 声明与注册互为镜像（派生即注册，杜绝「声明了却忘注册」的运行时 400）；
 * companyScoped=true 时启动期校验宿主表确有 company_id 字段。
 */
export function buildOwnerRegistryFromMeta(resources: ResourceMeta[]): OwnerRegistry {
  const owners = createOwnerRegistry()
  for (const meta of resources) {
    if (!meta.attachments) continue
    const ownerType = meta.attachments.ownerType ?? meta.table
    const companyScoped = meta.attachments.companyScoped ?? false
    if (companyScoped && !meta.fields.some((f) => f.dbColumn === 'company_id')) {
      throw new Error(
        `files: 附件宿主 ${meta.name} 声明 companyScoped 但 meta 无 company_id 字段`,
      )
    }
    owners.register(ownerType, {
      table: meta.table,
      permissionPrefix: meta.permissionPrefix,
      companyScoped,
    })
  }
  if (owners.snapshot().size === 0) {
    throw new Error('files: 附件宿主注册表为空（Meta Registry 未声明任何 attachments）')
  }
  return owners
}

/** 校验宿主存在、读权限与公司范围；返回固化到挂接上的 company_id（非公司隔离则为 null） */
export async function resolveOwner(
  db: DbHandle,
  registry: OwnerRegistry,
  actor: Actor,
  ownerType: string,
  ownerId: string,
): Promise<string | null> {
  const spec = registry.lookup(ownerType)
  if (!spec) {
    throw ApiError.validation('未知的宿主类型', { ownerType: ['不在允许的附件宿主白名单'] })
  }
  if (!hasPermission(actor, `${spec.permissionPrefix}:read`)) {
    throw new ApiError('forbidden', '无权访问该宿主记录')
  }

  if (!spec.companyScoped) {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS(SELECT 1 FROM ${sql.raw(spec.table)} WHERE id = ${ownerId}::uuid) AS exists
    `.execute(db)
    if (!result.rows[0]?.exists) {
      throw new ApiError('forbidden', '无权访问该宿主记录')
    }
    return null
  }

  const result = await sql<{ company_id: string }>`
    SELECT company_id FROM ${sql.raw(spec.table)} WHERE id = ${ownerId}::uuid
  `.execute(db)
  const row = result.rows[0]
  if (!row || !canAccessCompany(actor, row.company_id)) {
    throw new ApiError('forbidden', '无权访问该宿主记录')
  }
  return row.company_id
}
