import { synieError } from './errors'

export function permissionCandidates(code: string): string[] {
  const separator = code.indexOf(':')
  if (separator < 0) return [code, '*']
  const prefix = code.slice(0, separator)
  const candidates = [code, `${prefix}:*`]
  const domainSeparator = prefix.indexOf('.')
  if (domainSeparator >= 0) candidates.push(`${prefix.slice(0, domainSeparator)}.*`)
  candidates.push('*')
  return candidates
}

export function matchesPermission(permissions: ReadonlySet<string>, code: string): boolean {
  return permissionCandidates(code).some((candidate) => permissions.has(candidate))
}

export function hasPermission(
  actor: { superAdmin: boolean; permissions: ReadonlySet<string> } | null,
  code: string,
): boolean {
  return Boolean(actor && (actor.superAdmin || matchesPermission(actor.permissions, code)))
}

export function requirePermission(
  actor: { superAdmin: boolean; permissions: ReadonlySet<string> } | null,
  code: string,
): void {
  if (!hasPermission(actor, code)) throw synieError('forbidden', '无权限执行该操作')
}
