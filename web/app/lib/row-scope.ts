/**
 * 行级本地判定（工单 14）：与服务端 decide() 同一封闭代数的客户端求值。
 * 只用于 UI 显隐——服务端仍是权威（行级不命中的服务端语义是 not_found）。
 * fail-closed：行值 null / 缺列 / 缺维度一律 false（all 除外）。
 * 与 contracts/fixtures/authz/row_scope_cases.json 对拍。
 */
import type { DataScope, ResourceDocumentAuthz } from '@synie/shared'

export interface RowScopeMe {
  userId: string | null
  deptId: string | null
  deptSubtreeIds: readonly string[]
}

/**
 * 判定一行是否落在 scope 范围内：
 * - all → true
 * - self → 声明了 ownerId 维度且行值等于 me.userId
 * - dept → 声明了 deptId 维度、me.deptId 非空且行值与之相等
 * - deptTree → 行值落在 me.deptSubtreeIds 内
 */
export function rowInScope(
  scope: DataScope,
  row: Record<string, unknown>,
  dims: ResourceDocumentAuthz,
  me: RowScopeMe,
): boolean {
  if (scope === 'all') return true
  if (scope === 'self') {
    if (!dims.ownerId || !me.userId) return false
    const value = row[dims.ownerId]
    return typeof value === 'string' && value === me.userId
  }
  if (!dims.deptId) return false
  const value = row[dims.deptId]
  if (typeof value !== 'string' || value.length === 0) return false
  if (scope === 'dept') return me.deptId !== null && value === me.deptId
  return me.deptSubtreeIds.includes(value)
}
