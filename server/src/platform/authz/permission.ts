/**
 * 权限码匹配（移植自 server-go platform/authz/permission.go，语义不变）：
 * 授权支持整资源/整域/全域通配；Candidates("sales.order:audit") =
 * ["sales.order:audit", "sales.order:*", "sales.*", "*"]
 */
export function candidates(code: string): string[] {
  const sep = code.indexOf(':')
  if (sep < 0) return [code, '*']
  const prefix = code.slice(0, sep)
  const result = [code, `${prefix}:*`]
  const dot = prefix.indexOf('.')
  if (dot >= 0) {
    result.push(`${prefix.slice(0, dot)}.*`)
  }
  result.push('*')
  return result
}

export function matches(permissions: ReadonlySet<string>, code: string): boolean {
  return candidates(code).some((candidate) => permissions.has(candidate))
}
