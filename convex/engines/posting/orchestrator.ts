import type { Actor } from '../../lib/actor'
import { assertMutationBudget, postingBudget } from '../../lib/budget'
import { synieError } from '../../lib/errors'
import type { DomainMutationCtx } from '../../lib/mutationContext'
import { writeAudit, type AuditEvent } from '../../platform/audit/write'
import { postGlInMutation } from '../gl/engine'
import type { GlLine, GlVoucher } from '../gl/model'
import { postInventoryInMutation } from '../inventory/engine'
import type { StockLine, StockVoucher } from '../inventory/model'

export type PostingStage =
  | 'after_validate'
  | 'after_controlled_projection'
  | 'after_inventory'
  | 'after_gl'
  | 'after_head'
  | 'after_audit'

export type PostingPlan = {
  actor: Actor
  stock?: { voucher: StockVoucher; lines: readonly StockLine[] }
  gl?: { voucher: GlVoucher; lines: readonly GlLine[] }
  validate: (ctx: DomainMutationCtx) => Promise<void>
  applyControlledProjections?: (ctx: DomainMutationCtx) => Promise<void>
  updateHead: (ctx: DomainMutationCtx) => Promise<void>
  audit: AuditEvent
  faultAfter?: PostingStage
}

function failAt(plan: PostingPlan, stage: PostingStage): void {
  if (plan.faultAfter === stage) throw synieError('internal', `posting fault probe: ${stage}`)
}

/**
 * Deterministic one-mutation chain. Every callback only receives the branded
 * database context, so an action context cannot cross this interface.
 */
export async function postDocumentInMutation(ctx: DomainMutationCtx, plan: PostingPlan): Promise<void> {
  const stockLines = plan.stock?.lines.length ?? 0
  const stockKeys = new Set(plan.stock?.lines.map((line) => `${line.warehouseId}/${line.materialId}`)).size
  const glLines = plan.gl?.lines.length ?? 0
  const partyLines = plan.gl?.lines.filter((line) => line.partyId).length ?? 0
  assertMutationBudget(postingBudget(stockLines + glLines, stockKeys, partyLines))

  await plan.validate(ctx)
  failAt(plan, 'after_validate')
  await plan.applyControlledProjections?.(ctx)
  failAt(plan, 'after_controlled_projection')
  if (plan.stock) await postInventoryInMutation(ctx, plan.stock.voucher, plan.stock.lines)
  failAt(plan, 'after_inventory')
  if (plan.gl) await postGlInMutation(ctx, plan.gl.voucher, plan.gl.lines)
  failAt(plan, 'after_gl')
  await plan.updateHead(ctx)
  failAt(plan, 'after_head')
  await writeAudit(ctx, plan.actor, plan.audit)
  failAt(plan, 'after_audit')
}
