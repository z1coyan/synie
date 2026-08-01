import {
  customCtx,
  customMutation,
  customQuery,
} from 'convex-helpers/server/customFunctions'
import { mutation, query } from '../_generated/server'
import { requireActor } from './actor'
import { requirePermission } from './permissions'

export const authedQuery = customQuery(
  query,
  customCtx(async (ctx) => ({ actor: await requireActor(ctx) })),
)

export const authedMutation = customMutation(
  mutation,
  customCtx(async (ctx) => ({ actor: await requireActor(ctx) })),
)

export function permissionedQuery(permission: string) {
  return customQuery(
    query,
    customCtx(async (ctx) => {
      const actor = await requireActor(ctx)
      requirePermission(actor, permission)
      return { actor }
    }),
  )
}

export function permissionedMutation(permission: string) {
  return customMutation(
    mutation,
    customCtx(async (ctx) => {
      const actor = await requireActor(ctx)
      requirePermission(actor, permission)
      return { actor }
    }),
  )
}
