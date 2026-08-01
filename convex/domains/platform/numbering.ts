import { v } from 'convex/values'
import type { Doc } from '../../_generated/dataModel'
import { permissionedMutation, permissionedQuery } from '../../lib/auth'
import { asDomainMutationCtx } from '../../lib/mutationContext'
import { synieError, validationError } from '../../lib/errors'
import { paginationOptions, resourcePage } from '../../lib/pagination'
import { changedFields } from '../../platform/audit/model'
import { writeAudit } from '../../platform/audit/write'
import { numberingResource, NUMBERING_CATALOG } from '../../platform/numbering/catalog'
import { createNumberingRuleInMutation } from '../../platform/numbering/service'
import { validateSegments, type NumberingSegment } from '../../platform/numbering/model'

type WireSegment = { type: 'text' | 'field' | 'seq'; value?: string; field?: string; label?: string; format?: string; padding?: number }

function normalizeSegments(raw: unknown): { stored: NumberingSegment[]; wire: WireSegment[] } {
  if (!Array.isArray(raw)) throw validationError('编号规则参数不合法', { segments: ['必须是数组'] })
  const stored: NumberingSegment[] = []
  const wire: WireSegment[] = []
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== 'object') throw validationError('编号规则参数不合法', { segments: ['包含非法编号段'] })
    const item = candidate as Record<string, unknown>
    const type = item.type ?? item.kind
    if (type === 'text') {
      const value = String(item.value ?? '')
      stored.push({ kind: 'text', value }); wire.push({ type: 'text', value })
    } else if (type === 'seq' || type === 'sequence') {
      const padding = Number(item.padding ?? 4)
      stored.push({ kind: 'sequence', padding }); wire.push({ type: 'seq', padding })
    } else if (type === 'field') {
      const field = String(item.field ?? '')
      const format = typeof item.format === 'string' && item.format ? item.format : undefined
      stored.push({ kind: 'field', field, ...(format ? { format } : {}) })
      wire.push({ type: 'field', field, ...(typeof item.label === 'string' ? { label: item.label } : {}), ...(format ? { format } : {}) })
    } else throw validationError('编号规则参数不合法', { segments: ['包含未知编号段'] })
  }
  return { stored, wire }
}

function wireSegments(segments: readonly NumberingSegment[]): WireSegment[] {
  return segments.map((segment) => segment.kind === 'text'
    ? { type: 'text', value: segment.value }
    : segment.kind === 'sequence'
      ? { type: 'seq', padding: segment.padding }
      : { type: 'field', field: segment.field, ...(segment.format ? { format: segment.format } : {}) })
}

function ruleRow(row: Doc<'numberingRules'>) {
  return { id: row._id, resource: row.resource, name: row.name, segments: wireSegments(row.segments), perCompany: row.perCompany, enabled: row.enabled, insertedAt: row.insertedAt, updatedAt: row.updatedAt }
}
function counterRow(row: Doc<'numberingCounters'>) {
  return { id: row._id, ruleId: row.ruleId, scopeKey: row.scopeKey, value: Number(row.value), insertedAt: row.insertedAt ?? row._creationTime, updatedAt: row.updatedAt }
}

export const listRules = permissionedQuery('sys.numbering_rule:read')({ args: { numItems: v.number(), cursor: v.optional(v.union(v.string(), v.null())) }, returns: v.any(), handler: async (ctx, args) => {
  const page = await ctx.db.query('numberingRules').withIndex('by_resource_name').paginate(paginationOptions(args)); return resourcePage({ ...page, page: page.page.map(ruleRow) })
} })
export const getRule = permissionedQuery('sys.numbering_rule:read')({ args: { id: v.id('numberingRules') }, returns: v.any(), handler: async (ctx, args) => { const row = await ctx.db.get(args.id); return row ? ruleRow(row) : null } })
export const createRule = permissionedMutation('sys.numbering_rule:create')({ args: { resource: v.string(), name: v.string(), segments: v.any(), perCompany: v.optional(v.boolean()), enabled: v.optional(v.boolean()) }, returns: v.any(), handler: async (ctx, args) => {
  const normalized = normalizeSegments(args.segments); const id = await createNumberingRuleInMutation(asDomainMutationCtx(ctx), { resource: args.resource.trim(), name: args.name, segments: normalized.stored, perCompany: args.perCompany, enabled: args.enabled }); const row = (await ctx.db.get(id))!
  await writeAudit(asDomainMutationCtx(ctx), ctx.actor, { resource: 'sysNumberingRules', recordId: id, recordLabel: row.name, action: 'create', changes: ruleRow(row) }); return ruleRow(row)
} })
export const updateRule = permissionedMutation('sys.numbering_rule:update')({ args: { id: v.id('numberingRules'), name: v.optional(v.string()), segments: v.optional(v.any()), perCompany: v.optional(v.boolean()), enabled: v.optional(v.boolean()) }, returns: v.any(), handler: async (ctx, args) => {
  const row = await ctx.db.get(args.id); if (!row) throw synieError('not_found', '编号规则不存在'); const before = ruleRow(row); const name = args.name?.trim() ?? row.name
  if (!name || [...name].length > 64) throw validationError('编号规则参数不合法', { name: ['必填且最多 64 个字符'] })
  const segments = args.segments === undefined ? row.segments : normalizeSegments(args.segments).stored; const resource = numberingResource(row.resource); if (!resource) throw synieError('validation', '未知的绑定资源'); validateSegments(segments, resource.fields)
  const enabled = args.enabled ?? row.enabled
  if (enabled) { const duplicate = await ctx.db.query('numberingRules').withIndex('by_resource_enabled', (q) => q.eq('resource', row.resource).eq('enabled', true)).unique(); if (duplicate && duplicate._id !== row._id) throw synieError('conflict', '该资源已有启用的编号规则,同一资源只能启用一条') }
  await ctx.db.patch(row._id, { name, segments, perCompany: args.perCompany ?? row.perCompany, enabled, updatedAt: Date.now() }); const after = ruleRow((await ctx.db.get(row._id))!); const changes = changedFields(before, after); if (Object.keys(changes).length) await writeAudit(asDomainMutationCtx(ctx), ctx.actor, { resource: 'sysNumberingRules', recordId: row._id, recordLabel: after.name, action: 'update', changes }); return after
} })
export const removeRule = permissionedMutation('sys.numbering_rule:delete')({ args: { id: v.id('numberingRules') }, returns: v.null(), handler: async (ctx, args) => {
  const row = await ctx.db.get(args.id); if (!row) throw synieError('not_found', '编号规则不存在'); const counters = await ctx.db.query('numberingCounters').withIndex('by_rule_scope', (q) => q.eq('ruleId', row._id)).collect(); for (const counter of counters) await ctx.db.delete(counter._id); await ctx.db.delete(row._id); await writeAudit(asDomainMutationCtx(ctx), ctx.actor, { resource: 'sysNumberingRules', recordId: row._id, recordLabel: row.name, action: 'destroy', changes: ruleRow(row) }); return null
} })

export const listCounters = permissionedQuery('sys.numbering_rule:read')({ args: { numItems: v.number(), cursor: v.optional(v.union(v.string(), v.null())), ruleId: v.optional(v.id('numberingRules')) }, returns: v.any(), handler: async (ctx, args) => {
  const page = args.ruleId
    ? await ctx.db.query('numberingCounters').withIndex('by_rule_scope', (q) => q.eq('ruleId', args.ruleId!)).paginate(paginationOptions(args))
    : await ctx.db.query('numberingCounters').withIndex('by_rule_scope').paginate(paginationOptions(args)); return resourcePage({ ...page, page: page.page.map(counterRow) })
} })
export const getCounter = permissionedQuery('sys.numbering_rule:read')({ args: { id: v.id('numberingCounters') }, returns: v.any(), handler: async (ctx, args) => { const row = await ctx.db.get(args.id); return row ? counterRow(row) : null } })
export const updateCounter = permissionedMutation('sys.numbering_rule:update')({ args: { id: v.id('numberingCounters'), value: v.number() }, returns: v.any(), handler: async (ctx, args) => {
  if (!Number.isSafeInteger(args.value) || args.value < 0) throw validationError('编号计数器参数不合法', { value: ['须为非负安全整数'] }); const row = await ctx.db.get(args.id); if (!row) throw synieError('not_found', '编号计数器不存在'); const before = counterRow(row); await ctx.db.patch(row._id, { value: BigInt(args.value), updatedAt: Date.now() }); const after = counterRow((await ctx.db.get(row._id))!); const changes = changedFields(before, after); if (Object.keys(changes).length) await writeAudit(asDomainMutationCtx(ctx), ctx.actor, { resource: 'sysNumberingCounters', recordId: row._id, recordLabel: row.scopeKey, action: 'update', changes }); return after
} })

export const listNumberableResources = permissionedQuery('sys.numbering_rule:read')({ args: {}, returns: v.any(), handler: async () => ({ resources: Object.entries(NUMBERING_CATALOG).map(([prefix, resource]) => ({ prefix, grid: prefix, fields: Object.entries(resource.fields).map(([path, field]) => ({ path, label: path, type: field.type })) })) }) })
