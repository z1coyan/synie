import type { DbHandle } from '~/db/tx.ts'
import type { Json } from '~/db/types.ts'
import type { Actor } from '../authz/actor.ts'

/**
 * 审计写钩子（files/settings/numbering 等域 create/update/delete 共用）。
 * 完整 audit 列表/查询面见工单 01 的 audit 分片；本文件只提供写路径。
 */

export const FILTERED_PLACEHOLDER = '[FILTERED]'

export type AuditChange = Record<string, unknown>

export interface AuditEntry {
  resource: string
  recordId: string
  recordLabel?: string | null
  actionType: string
  actionName: string
  companyId?: string | null
  changes: Record<string, AuditChange>
  /** Meta audit.sensitiveFields：写入前脱敏 */
  sensitiveFields?: readonly string[]
}

export function filterSensitive(
  changes: Record<string, AuditChange>,
  sensitiveFields: readonly string[] | undefined,
): Record<string, AuditChange> {
  if (!sensitiveFields || sensitiveFields.length === 0 || Object.keys(changes).length === 0) {
    return changes
  }
  const sensitive = new Set(sensitiveFields)
  const filtered: Record<string, AuditChange> = {}
  for (const [field, change] of Object.entries(changes)) {
    if (!sensitive.has(field)) {
      filtered[field] = change
      continue
    }
    const redacted: AuditChange = {}
    for (const key of Object.keys(change)) {
      redacted[key] = FILTERED_PLACEHOLDER
    }
    filtered[field] = redacted
  }
  return filtered
}

export function auditDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, AuditChange> {
  const changes: Record<string, AuditChange> = {}
  for (const field of allowed) {
    const from = before[field]
    const to = after[field]
    if (stableEqual(from, to)) continue
    changes[field] = { from, to }
  }
  return changes
}

export function auditCreated(
  after: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, AuditChange> {
  const changes: Record<string, AuditChange> = {}
  for (const field of allowed) {
    changes[field] = { to: after[field] }
  }
  return changes
}

export function auditDestroyed(
  before: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, AuditChange> {
  const changes: Record<string, AuditChange> = {}
  for (const field of allowed) {
    changes[field] = { from: before[field] }
  }
  return changes
}

export async function writeAudit(db: DbHandle, actor: Actor | null, entry: AuditEntry): Promise<void> {
  const changes = filterSensitive(entry.changes, entry.sensitiveFields)
  await db
    .insertInto('sys_audit_log')
    .values({
      resource: entry.resource,
      record_id: entry.recordId,
      record_label: entry.recordLabel?.trim() ? entry.recordLabel : null,
      action_type: entry.actionType,
      action_name: entry.actionName,
      actor_id: actor?.userId?.trim() ? actor.userId : null,
      actor_name: actor?.username ?? null,
      company_id: entry.companyId ?? null,
      changes: JSON.parse(JSON.stringify(changes)) as Json,
    })
    .execute()
}

function stableEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a == null || b == null) return a === b
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
