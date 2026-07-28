import { ApiError } from '../http/errors.ts'
import { matches } from './permission.ts'

/** 请求主体（移植自 server-go platform/authz/actor.go） */
export interface Actor {
  userId: string
  username: string
  name: string | null
  superAdmin: boolean
  allCompanies: boolean
  permissions: ReadonlySet<string>
  companyIds: readonly string[]
}

export function hasPermission(actor: Actor | null, code: string): boolean {
  if (!actor) return false
  if (actor.superAdmin) return true
  return matches(actor.permissions, code)
}

/** 公司数据范围：bypass=true 表示不做公司过滤（超管/全公司授权） */
export function companyFilter(actor: Actor | null): { bypass: boolean; ids: readonly string[] } {
  if (!actor) return { bypass: false, ids: [] }
  if (actor.superAdmin || actor.allCompanies) return { bypass: true, ids: [] }
  return { bypass: false, ids: actor.companyIds }
}

export function canAccessCompany(actor: Actor | null, companyId: string): boolean {
  if (!actor) return false
  if (actor.superAdmin || actor.allCompanies) return true
  return actor.companyIds.includes(companyId)
}

/** 无权限时抛出 403（供 handler/中间件使用）；保持 fail-closed */
export function requirePermission(actor: Actor | null, code: string): asserts actor is Actor {
  if (!hasPermission(actor, code)) {
    throw new ApiError('forbidden', '无权限执行该操作')
  }
}
