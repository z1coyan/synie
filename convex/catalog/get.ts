import { v } from 'convex/values'
import { authedQuery } from '../lib/auth'
import { requirePermission } from '../lib/permissions'
import { allResourceDocuments, projectResource } from './all'

const retiredResources = new Set(['sysStorages'])

export const get = authedQuery({
  args: { resource: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (retiredResources.has(args.resource)) {
      throw new Error(`Catalog 资源已退役: ${args.resource}`)
    }
    const document = allResourceDocuments[args.resource]
    if (!document) throw new Error(`未知的 Catalog 资源: ${args.resource}`)
    requirePermission(ctx.actor, `${document.permissionPrefix}:read`)
    return projectResource(args.resource, ctx.actor)
  },
})
