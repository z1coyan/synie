import { v } from 'convex/values'
import { permissionedQuery } from '../lib/auth'

/** A narrow integration-test seam proving that live Actor grants are enforced. */
export const permission = permissionedQuery('test.actor:read')({
  args: {},
  returns: v.literal(true),
  handler: async () => true as const,
})
