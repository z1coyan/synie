import { v } from 'convex/values'
import { authedMutation, authedQuery } from '../../lib/auth'
import { synieError } from '../../lib/errors'
import {
  createDomainRecord,
  getDomainRecord,
  listDomainRecords,
  removeDomainRecord,
  updateDomainRecord,
} from './records'

/**
 * Builds one sealed resource plane per transaction closure. The allow-list is
 * source code, not a client-selected table mapping; aggregates and semantic
 * commands deliberately live outside this helper.
 */
export function defineClosureRecordApi(resources: readonly string[]) {
  const allowed = new Set(resources)
  const resource = (value: string): string => {
    if (!allowed.has(value)) throw synieError('validation', `资源 ${value} 不属于该事务闭包`)
    return value
  }
  return {
    get: authedQuery({
      args: { resource: v.string(), id: v.string() },
      returns: v.any(),
      handler: (ctx, args) => getDomainRecord(ctx, ctx.actor, resource(args.resource), args.id),
    }),
    list: authedQuery({
      args: {
        resource: v.string(),
        numItems: v.number(),
        cursor: v.optional(v.union(v.string(), v.null())),
        search: v.optional(v.string()),
        queryArgs: v.optional(v.any()),
      },
      returns: v.any(),
      handler: (ctx, args) => listDomainRecords(ctx, ctx.actor, resource(args.resource), {
        numItems: args.numItems,
        cursor: args.cursor,
        search: args.search,
        args: args.queryArgs,
      }),
    }),
    create: authedMutation({
      args: { resource: v.string(), input: v.any() },
      returns: v.any(),
      handler: (ctx, args) => createDomainRecord(ctx, ctx.actor, resource(args.resource), args.input),
    }),
    update: authedMutation({
      args: { resource: v.string(), id: v.string(), input: v.any() },
      returns: v.any(),
      handler: (ctx, args) => updateDomainRecord(ctx, ctx.actor, resource(args.resource), args.id, args.input),
    }),
    remove: authedMutation({
      args: { resource: v.string(), id: v.string() },
      returns: v.null(),
      handler: async (ctx, args) => {
        await removeDomainRecord(ctx, ctx.actor, resource(args.resource), args.id)
        return null
      },
    }),
  }
}
