import { v } from 'convex/values'
import { internalMutation, internalQuery } from '../../_generated/server'
import { authedMutation, authedQuery } from '../../lib/auth'
import { actorForAppUser, requireActor } from '../../lib/actor'
import { asDomainMutationCtx } from '../../lib/mutationContext'
import { paginationOptions, resourcePage } from '../../lib/pagination'
import { hasPermission, requirePermission } from '../../lib/permissions'
import { synieError, validationError } from '../../lib/errors'
import { changedFields } from '../audit/model'
import { writeAudit } from '../audit/write'
import { fieldCatalog, printableResources } from './catalog'
import { buildDocuments, printResourceLabel, selectedDocumentCompanyIds } from './builders'
import { MAX_RENDER_BATCH } from './types'

const printResource = v.union(v.literal('sales.order'), v.literal('mfg.work_order'))

function templatePresent(row: {
  _id: string; name: string; resource: string; isDefault: boolean; remarks: string | null
  fileId: string; insertedAt: number; updatedAt: number
}) {
  return {
    id: row._id,
    name: row.name,
    resource: row.resource,
    isDefault: row.isDefault,
    remarks: row.remarks,
    fileId: row.fileId,
    insertedAt: new Date(row.insertedAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  }
}

function templateSnapshot(row: ReturnType<typeof templatePresent>): Record<string, unknown> {
  return {
    name: row.name,
    resource: row.resource,
    isDefault: row.isDefault,
    remarks: row.remarks,
    fileId: row.fileId,
  }
}

function canUseTemplates(actor: Parameters<typeof hasPermission>[0], resource: string): boolean {
  return hasPermission(actor, 'sys.print_template:read') ||
    ['print', 'export', 'batch_print'].some((action) => hasPermission(actor, `${resource}:${action}`))
}

function cleanName(name: string): string {
  const value = name.trim()
  if (!value) throw validationError('模板名称不能为空', { name: ['不能为空'] })
  if ([...value].length > 64) throw validationError('模板名称最多 64 个字符', { name: ['最多 64 个字符'] })
  return value
}

export const list = authedQuery({
  args: {
    numItems: v.number(), cursor: v.optional(v.union(v.string(), v.null())),
    search: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'sys.print_template:read')
    const page = args.search?.trim()
      ? await ctx.db.query('printTemplates').withSearchIndex('search_name', (q) =>
          q.search('name', args.search!.trim()),
        ).paginate(paginationOptions(args))
      : await ctx.db.query('printTemplates').withIndex('by_updated').order('desc').paginate(paginationOptions(args))
    return resourcePage({ ...page, page: page.page.map(templatePresent) })
  },
})

export const get = authedQuery({
  args: { id: v.id('printTemplates') }, returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'sys.print_template:read')
    const row = await ctx.db.get(args.id)
    return row ? templatePresent(row) : null
  },
})

export const resources = authedQuery({
  args: {}, returns: v.any(),
  handler: async () => ({ resources: printableResources() }),
})

export const catalog = authedQuery({
  args: { resource: v.string() }, returns: v.any(),
  handler: async (ctx, args) => {
    if (!canUseTemplates(ctx.actor, args.resource)) throw synieError('forbidden', '无权查看打印字段目录')
    const result = fieldCatalog(args.resource)
    if (!result) throw validationError('不支持的资源类型', { resource: ['不在打印字段目录中'] })
    return result
  },
})

export const usable = authedQuery({
  args: { resource: printResource }, returns: v.any(),
  handler: async (ctx, args) => {
    if (!canUseTemplates(ctx.actor, args.resource)) throw synieError('forbidden', '无权使用该资源的打印模板')
    const rows = await ctx.db.query('printTemplates').withIndex('by_resource_default_name', (q) =>
      q.eq('resource', args.resource),
    ).collect()
    rows.sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name))
    return rows.map(templatePresent)
  },
})

export const prepareCreate = internalQuery({
  args: { name: v.string(), resource: printResource, fileId: v.id('files'), remarks: v.optional(v.union(v.string(), v.null())) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await requireActor(ctx)
    requirePermission(actor, 'sys.print_template:create')
    const file = await ctx.db.get(args.fileId)
    if (!file || file.status !== 'ready') throw validationError('模板文件不存在', { fileId: ['模板文件不存在'] })
    return {
      actorUserId: actor.userId,
      name: cleanName(args.name), resource: args.resource, fileId: file._id,
      remarks: args.remarks?.trim() || null,
      file: { objectKey: file.objectKey, filename: file.filename, size: file.size, sha256: file.sha256 },
    }
  },
})

export const prepareUpdate = internalQuery({
  args: {
    id: v.id('printTemplates'), name: v.optional(v.string()), fileId: v.optional(v.id('files')),
    remarks: v.optional(v.union(v.string(), v.null())), remarksPresent: v.boolean(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await requireActor(ctx)
    requirePermission(actor, 'sys.print_template:update')
    const row = await ctx.db.get(args.id)
    if (!row) throw synieError('not_found', '打印模板不存在')
    const fileId = args.fileId ?? row.fileId
    const file = await ctx.db.get(fileId)
    if (!file || file.status !== 'ready') throw validationError('模板文件不存在', { fileId: ['模板文件不存在'] })
    return {
      actorUserId: actor.userId, id: row._id,
      name: args.name === undefined ? row.name : cleanName(args.name), resource: row.resource,
      fileId, remarks: args.remarksPresent ? args.remarks?.trim() || null : row.remarks,
      file: { objectKey: file.objectKey, filename: file.filename, size: file.size, sha256: file.sha256 },
    }
  },
})

async function replaceAttachment(ctx: Parameters<typeof actorForAppUser>[0] & { db: any }, templateId: string, fileId: string) {
  const previous = await ctx.db.query('attachments').withIndex('by_owner', (q: any) =>
    q.eq('ownerType', 'sys_print_template').eq('ownerId', templateId),
  ).collect()
  for (const attachment of previous) await ctx.db.delete(attachment._id)
  await ctx.db.insert('attachments', {
    fileId, ownerType: 'sys_print_template', ownerId: templateId,
    category: 'template', companyId: null, insertedAt: Date.now(),
  })
}

export const commitCreate = internalMutation({
  args: {
    actorUserId: v.id('appUsers'), name: v.string(), resource: printResource,
    fileId: v.id('files'), remarks: v.union(v.string(), v.null()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await actorForAppUser(ctx, args.actorUserId)
    requirePermission(actor, 'sys.print_template:create')
    const file = await ctx.db.get(args.fileId)
    if (!file || file.status !== 'ready') throw validationError('模板文件不存在', { fileId: ['模板文件不存在'] })
    const now = Date.now()
    const id = await ctx.db.insert('printTemplates', {
      name: cleanName(args.name), resource: args.resource, isDefault: false,
      remarks: args.remarks, fileId: args.fileId, insertedAt: now, updatedAt: now,
    })
    await replaceAttachment(ctx as never, id, args.fileId)
    const result = templatePresent((await ctx.db.get(id))!)
    await writeAudit(asDomainMutationCtx(ctx), actor, {
      resource: 'sysPrintTemplates', recordId: id, recordLabel: result.name,
      action: 'create', changes: changedFields({}, templateSnapshot(result)),
    })
    return result
  },
})

export const commitUpdate = internalMutation({
  args: {
    actorUserId: v.id('appUsers'), id: v.id('printTemplates'), name: v.string(),
    fileId: v.id('files'), remarks: v.union(v.string(), v.null()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await actorForAppUser(ctx, args.actorUserId)
    requirePermission(actor, 'sys.print_template:update')
    const [row, file] = await Promise.all([ctx.db.get(args.id), ctx.db.get(args.fileId)])
    if (!row) throw synieError('not_found', '打印模板不存在')
    if (!file || file.status !== 'ready') throw validationError('模板文件不存在', { fileId: ['模板文件不存在'] })
    const before = templatePresent(row)
    await ctx.db.patch(row._id, {
      name: cleanName(args.name), fileId: args.fileId, remarks: args.remarks, updatedAt: Date.now(),
    })
    if (row.fileId !== args.fileId) await replaceAttachment(ctx as never, row._id, args.fileId)
    const result = templatePresent((await ctx.db.get(row._id))!)
    const changes = changedFields(templateSnapshot(before), templateSnapshot(result))
    if (Object.keys(changes).length) await writeAudit(asDomainMutationCtx(ctx), actor, {
      resource: 'sysPrintTemplates', recordId: row._id, recordLabel: result.name,
      action: 'update', changes,
    })
    return result
  },
})

export const setDefault = authedMutation({
  args: { id: v.id('printTemplates'), value: v.boolean() }, returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'sys.print_template:update')
    const target = await ctx.db.get(args.id)
    if (!target) throw synieError('not_found', '打印模板不存在')
    if (args.value) {
      const rows = await ctx.db.query('printTemplates').withIndex('by_resource_default_name', (q) =>
        q.eq('resource', target.resource).eq('isDefault', true),
      ).collect()
      for (const row of rows) if (row._id !== target._id) await ctx.db.patch(row._id, { isDefault: false, updatedAt: Date.now() })
    }
    const before = templatePresent(target)
    await ctx.db.patch(target._id, { isDefault: args.value, updatedAt: Date.now() })
    const result = templatePresent((await ctx.db.get(target._id))!)
    const changes = changedFields(templateSnapshot(before), templateSnapshot(result))
    if (Object.keys(changes).length) await writeAudit(asDomainMutationCtx(ctx), ctx.actor, {
      resource: 'sysPrintTemplates', recordId: target._id, recordLabel: target.name,
      action: args.value ? 'set_default' : 'unset_default', changes,
    })
    return result
  },
})

export const remove = authedMutation({
  args: { id: v.id('printTemplates') }, returns: v.null(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'sys.print_template:delete')
    const row = await ctx.db.get(args.id)
    if (!row) return null
    const value = templatePresent(row)
    const attachments = await ctx.db.query('attachments').withIndex('by_owner', (q) =>
      q.eq('ownerType', 'sys_print_template').eq('ownerId', row._id),
    ).collect()
    for (const attachment of attachments) await ctx.db.delete(attachment._id)
    await ctx.db.delete(row._id)
    await writeAudit(asDomainMutationCtx(ctx), ctx.actor, {
      resource: 'sysPrintTemplates', recordId: row._id, recordLabel: row.name,
      action: 'destroy', changes: changedFields(templateSnapshot(value), {}),
    })
    return null
  },
})

export const prepareRender = internalQuery({
  args: {
    resource: printResource, mode: v.union(v.literal('print'), v.literal('export')),
    templateId: v.id('printTemplates'), ids: v.array(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await requireActor(ctx)
    if (args.ids.length < 1) throw validationError('请至少选择一条单据', { ids: ['请至少选择一条单据'] })
    if (args.ids.length > MAX_RENDER_BATCH) throw validationError('单次最多处理 100 条', { ids: ['单次最多处理 100 条'] })
    if (new Set(args.ids).size !== args.ids.length) throw validationError('单据不能重复', { ids: ['单据不能重复'] })
    const action = args.mode === 'export' ? 'export' : args.ids.length > 1 ? 'batch_print' : 'print'
    requirePermission(actor, `${args.resource}:${action}`)
    const template = await ctx.db.get(args.templateId)
    if (!template) throw synieError('not_found', '打印模板不存在')
    if (template.resource !== args.resource) throw validationError('模板与单据资源类型不匹配', { templateId: ['模板与单据资源类型不匹配'] })
    const file = await ctx.db.get(template.fileId)
    if (!file || file.status !== 'ready') throw validationError('无法读取模板文件', { templateId: ['无法读取模板文件'] })
    const [docs, companyIds] = await Promise.all([
      buildDocuments(ctx, actor, args.resource, args.ids),
      selectedDocumentCompanyIds(ctx, actor, args.resource, args.ids),
    ])
    const date = new Date()
    const suffix = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    const extension = args.mode === 'print' ? '.pdf' : '.xlsx'
    const filename = docs.length === 1 && docs[0]?.sheetName
      ? `${docs[0].sheetName}${extension}`
      : `${printResourceLabel(args.resource)}-批量-${suffix}${extension}`
    return {
      actorUserId: actor.userId,
      companyIds,
      template: { objectKey: file.objectKey, size: file.size, sha256: file.sha256 },
      docs,
      filename,
    }
  },
})
