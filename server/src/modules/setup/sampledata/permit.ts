/**
 * 种子对已迁 Permit 的服务现取凭证：不绕过判定，也不用 systemPermit——
 * 单据 created_by_id 有 sys_user 外键，须落在真实种子用户上。
 */
import type { Actor } from '~/platform/authz/core/index.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { SampleDataDeps } from './types.ts'

export function permitFor(
  deps: SampleDataDeps,
  actor: Actor,
  resource: string,
  action: string,
): Permit {
  const decision = deps.authz.decideFor(actor, resource, action)
  if (decision.outcome !== 'permit') {
    throw new ApiError('forbidden', `示例数据种子缺少权限：${resource}:${action}`)
  }
  return decision.permit
}
