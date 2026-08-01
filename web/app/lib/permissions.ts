export interface PermissionActor {
  permissions: readonly string[]
  superAdmin: boolean
}

/**
 * 前端权限匹配与服务端 authz/permission 保持同一口径：
 * 精确动作 → 资源通配 → 业务域通配 → 全域通配。
 */
export function permissionCandidates(code: string): string[] {
  const separator = code.indexOf(':')
  if (separator < 0) return [code, '*']

  const prefix = code.slice(0, separator)
  const candidates = [code, `${prefix}:*`]
  const domainSeparator = prefix.indexOf('.')
  if (domainSeparator >= 0) {
    candidates.push(`${prefix.slice(0, domainSeparator)}.*`)
  }
  candidates.push('*')
  return candidates
}

export function hasPermission(
  permissions: ReadonlySet<string> | null | undefined,
  code: string,
): boolean {
  if (!permissions) return false
  return permissionCandidates(code).some((candidate) =>
    permissions.has(candidate),
  )
}

export function permissionSetFromMe(
  me: PermissionActor,
): ReadonlySet<string> {
  const permissions = new Set(me.permissions)
  // 超级管理员由服务端布尔位旁路鉴权；放入全域通配使前端入口保持一致。
  if (me.superAdmin) permissions.add('*')
  return permissions
}
