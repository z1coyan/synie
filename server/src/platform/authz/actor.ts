/**
 * 旧授权原语的过渡层（扫荡期存在，工单 09-12 逐批清零）。
 *
 * Actor 已换代为 v2（`platform/authz/core`）：精确码 + 范围位集 + 公司/部门维度。
 * 本文件只保留把 v2 Actor 喂给存量调用点的薄适配；**新代码一律走 Permit**
 * （`guard(resource, action)` → `listFromSource` / `loadAuthorized`），
 * 见 ADR 2026-08-04 Permit 凭证式鉴权。
 */
import { ApiError } from '../http/errors.ts'
import type { Actor } from './core/index.ts'

export type { Actor }

/** @deprecated 扫荡期过渡：改用 guard(resource, action) 取 Permit */
export function hasPermission(actor: Actor | null, code: string): boolean {
  if (!actor) return false
  if (actor.superAdmin || actor.kind === 'system') return true
  return actor.grants.has(code)
}

/**
 * 公司数据范围：bypass=true 表示不做公司过滤（超管/全公司授权/system）。
 * @deprecated 扫荡期过渡：改用 Permit.rowFilter.company
 */
export function companyFilter(actor: Actor | null): { bypass: boolean; ids: readonly string[] } {
  if (!actor) return { bypass: false, ids: [] }
  if (actor.superAdmin || actor.kind === 'system' || actor.companies.all) {
    return { bypass: true, ids: [] }
  }
  return { bypass: false, ids: actor.companies.ids }
}

/** @deprecated 扫荡期过渡：改用 loadAuthorized / create 写侧守卫 */
export function canAccessCompany(actor: Actor | null, companyId: string): boolean {
  const scope = companyFilter(actor)
  return scope.bypass || scope.ids.includes(companyId)
}

/**
 * 无权限时抛出 403（fail-closed）。
 * @deprecated 扫荡期过渡：改用 guard(resource, action)
 */
export function requirePermission(
  actor: Actor | null,
  code: string,
  message = '无权限执行该操作',
): asserts actor is Actor {
  if (!hasPermission(actor, code)) {
    throw new ApiError('forbidden', message)
  }
}

/**
 * 公司数据权限闸门：不命中一律 not_found（不泄露存在性，与新体系错误语义一致）。
 * @deprecated 扫荡期过渡：改用 loadAuthorized
 */
export function requireCompanyAccess(actor: Actor | null, companyId: string, message = '公司不存在'): void {
  if (!canAccessCompany(actor, companyId)) {
    throw new ApiError('not_found', message)
  }
}
