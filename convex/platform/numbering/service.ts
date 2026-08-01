import type { Id } from '../../_generated/dataModel'
import type { DomainMutationCtx } from '../../lib/mutationContext'
import { synieError } from '../../lib/errors'
import { numberingResource } from './catalog'
import { renderDate, renderNumber, validateSegments, type NumberingSegment } from './model'

export async function createNumberingRuleInMutation(
  ctx: Pick<DomainMutationCtx, 'db'>,
  input: {
    resource: string
    name: string
    segments: NumberingSegment[]
    perCompany?: boolean
    enabled?: boolean
  },
): Promise<Id<'numberingRules'>> {
  const resource = numberingResource(input.resource)
  if (!resource) throw synieError('validation', '未知的绑定资源')
  validateSegments(input.segments, resource.fields)
  if (!input.name.trim() || [...input.name.trim()].length > 64) {
    throw synieError('validation', '规则名称必填且最多 64 个字符')
  }
  const enabled = input.enabled ?? true
  if (enabled) {
    const existing = await ctx.db
      .query('numberingRules')
      .withIndex('by_resource_enabled', (query) => query.eq('resource', input.resource).eq('enabled', true))
      .unique()
    if (existing) throw synieError('conflict', '该资源已有启用的编号规则,同一资源只能启用一条')
  }
  const now = Date.now()
  return ctx.db.insert('numberingRules', {
    resource: input.resource,
    name: input.name.trim(),
    enabled,
    perCompany: input.perCompany ?? true,
    segments: input.segments,
    insertedAt: now,
    updatedAt: now,
  })
}

export async function nextInMutation(
  ctx: Pick<DomainMutationCtx, 'db'>,
  resourceName: string,
  values: Record<string, unknown> = {},
): Promise<string> {
  const resource = numberingResource(resourceName)
  if (!resource) throw synieError('validation', '未知的绑定资源')
  const rule = await ctx.db
    .query('numberingRules')
    .withIndex('by_resource_enabled', (query) => query.eq('resource', resourceName).eq('enabled', true))
    .unique()
  if (!rule) throw synieError('conflict', '未配置启用的编号规则')
  validateSegments(rule.segments, resource.fields)

  const parts: ({ text: string } | { sequence: true; padding: number })[] = []
  for (const segment of rule.segments) {
    if (segment.kind === 'text') parts.push({ text: segment.value })
    if (segment.kind === 'sequence') parts.push({ sequence: true, padding: segment.padding })
    if (segment.kind === 'field') {
      const definition = resource.fields[segment.field]!
      let value = values[definition.sourceField]
      if (definition.lookup === 'companyCode' && typeof value === 'string') {
        const id = ctx.db.normalizeId('companies', value)
        value = id ? (await ctx.db.get(id))?.code : undefined
      } else if (definition.lookup === 'materialCategoryCode' && typeof value === 'string') {
        const id = ctx.db.normalizeId('materialCategories', value)
        value = id ? (await ctx.db.get(id))?.code : undefined
      } else if (definition.lookup === 'customerCode' && typeof value === 'string') {
        const id = ctx.db.normalizeId('customers', value)
        value = id ? (await ctx.db.get(id))?.code : undefined
      }
      if (value === null || value === undefined || String(value) === '') continue
      parts.push({
        text:
          definition.type === 'date' || definition.type === 'datetime'
            ? renderDate(value, segment.format!)
            : String(value),
      })
    }
  }
  const scopeText = parts.filter((part): part is { text: string } => 'text' in part).map((part) => part.text).join('')
  let scopeKey = scopeText
  if (rule.perCompany) {
    const companyId = values.company_id
    const normalized = typeof companyId === 'string' ? ctx.db.normalizeId('companies', companyId) : null
    const company = normalized ? await ctx.db.get(normalized) : null
    if (!company?.code) throw synieError('validation', '规则按公司计数,单据缺少公司或公司无编码')
    scopeKey = `${company.code}|${scopeText}`
  }
  const counter = await ctx.db
    .query('numberingCounters')
    .withIndex('by_rule_scope', (query) => query.eq('ruleId', rule._id).eq('scopeKey', scopeKey))
    .unique()
  const next = (counter?.value ?? 0n) + 1n
  if (next < 1n) throw synieError('validation', '编号超出范围')
  if (counter) await ctx.db.patch(counter._id, { value: next, updatedAt: Date.now() })
  else {
    const now = Date.now()
    await ctx.db.insert('numberingCounters', { ruleId: rule._id, scopeKey, value: next, insertedAt: now, updatedAt: now })
  }
  return renderNumber(parts, next)
}
