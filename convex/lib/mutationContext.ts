import type { GenericMutationCtx } from 'convex/server'
import type { DataModel } from '../_generated/dataModel'

declare const domainMutationBrand: unique symbol

/**
 * Capability type proving that a helper participates in its caller's one
 * database transaction. It intentionally exposes no runMutation/scheduler API.
 */
export type DomainMutationCtx = GenericMutationCtx<DataModel> & {
  readonly [domainMutationBrand]: true
}

/** Call only at a Convex mutation boundary, never inside an action. */
export function asDomainMutationCtx(ctx: GenericMutationCtx<DataModel>): DomainMutationCtx {
  return ctx as DomainMutationCtx
}
