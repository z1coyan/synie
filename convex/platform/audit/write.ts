import type { Actor } from '../../lib/actor'
import type { DomainMutationCtx } from '../../lib/mutationContext'
import { boundedAuditChanges } from './model'

export type AuditEvent = {
  resource: string
  recordId: string
  recordLabel: string
  companyId?: string | null
  action: string
  changes: unknown
}

export async function writeAudit(
  ctx: DomainMutationCtx,
  actor: Actor,
  event: AuditEvent,
): Promise<void> {
  const bounded = boundedAuditChanges(event.changes)
  await ctx.db.insert('auditLogs', {
    resource: event.resource,
    recordId: event.recordId,
    recordLabel: event.recordLabel,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    companyId: event.companyId ?? null,
    action: event.action,
    changes: bounded.changes,
    truncated: bounded.truncated,
    occurredAt: Date.now(),
  })
}
