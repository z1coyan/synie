/**
 * 打印模板主数据 + 渲染门面。
 * 对齐 server-go platform/printing/service.go + render.go。
 */
import { sql, type Kysely } from 'kysely'
import { listFromSource } from '~/modules/base/list.ts'
import { mapWriteError } from '~/modules/base/dberr.ts'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '../audit/write.ts'
import { hasPermission, type Actor } from '../authz/actor.ts'
import { ApiError } from '../http/errors.ts'
import type { FieldCatalog } from './catalog.ts'
import type { DocBuilder } from './docbuilder.ts'
import { createSalesOrderDocBuilder } from './docbuilder-sales-order.ts'
import {
  ConvertFailedError,
  createSofficeConverterFromEnv,
  ERR_SOFFICE_NO_OUTPUT,
  ERR_SOFFICE_NOT_FOUND,
  ERR_SOFFICE_TIMEOUT,
  type PDFConverter,
} from './pdf.ts'
import { ERR_EMPTY_DOCS, renderPages, renderSheets } from './renderer.ts'
import { printTemplateResourceMeta, PERMISSION_PREFIX } from './meta.ts'
import {
  MAX_RENDER_BATCH,
  PDF_CONTENT_TYPE,
  RENDER_MODE_EXPORT,
  RENDER_MODE_PRINT,
  XLSX_CONTENT_TYPE,
  type CreateInput,
  type RenderInput,
  type RenderOutput,
  type StoredFileReader,
  type Template,
  type TemplateList,
  type TemplateListQuery,
  type UpdateInput,
} from './types.ts'
import { extractPlaceholders } from './xlsx.ts'

const TEMPLATE_AUDIT_FIELDS = [
  'name',
  'resource',
  'is_default',
  'remarks',
  'file_id',
] as const

export interface PrintingServiceDeps {
  db: Kysely<Database>
  files: StoredFileReader
  catalog: FieldCatalog
  converter?: PDFConverter
}

export function createPrintingService(deps: PrintingServiceDeps) {
  const { db, files, catalog } = deps
  const builders = new Map<string, DocBuilder>()
  builders.set('sales.order', createSalesOrderDocBuilder(db))
  let converter: PDFConverter = deps.converter ?? createSofficeConverterFromEnv()

  function registerDocBuilder(resource: string, builder: DocBuilder): void {
    builders.set(resource, builder)
  }

  function setPDFConverter(next: PDFConverter): void {
    converter = next
  }

  function getCatalog(): FieldCatalog {
    return catalog
  }

  async function get(id: string): Promise<Template> {
    const row = await db
      .selectFrom('sys_print_template')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) throw new ApiError('not_found', '打印模板不存在')
    return mapTemplate(row)
  }

  async function list(query: TemplateListQuery): Promise<TemplateList> {
    return listFromSource({
      db,
      resource: printTemplateResourceMeta(),
      source: sql`FROM sys_print_template`,
      select: sql`
        SELECT id, name, resource, is_default, remarks, file_id, inserted_at, updated_at
      `,
      defaultOrder: sql`inserted_at DESC`,
      query,
      mapRow: (row) =>
        mapTemplate({
          id: String(row.id),
          name: String(row.name),
          resource: String(row.resource),
          is_default: Boolean(row.is_default),
          remarks: (row.remarks as string | null) ?? null,
          file_id: String(row.file_id),
          inserted_at: row.inserted_at as Date,
          updated_at: row.updated_at as Date,
        }),
    })
  }

  async function listUsable(actor: Actor, resource: string): Promise<Template[]> {
    if (!catalog.get(resource)) {
      throw ApiError.validation(`不支持的资源类型 ${resource}`, {
        resource: ['不在打印字段目录中'],
      })
    }
    if (!canUseTemplates(actor, resource)) {
      throw new ApiError('forbidden', '无权使用该资源的打印模板')
    }
    const rows = await db
      .selectFrom('sys_print_template')
      .selectAll()
      .where('resource', '=', resource)
      .orderBy('is_default', 'desc')
      .orderBy('name')
      .orderBy('id')
      .execute()
    return rows.map(mapTemplate)
  }

  async function create(actor: Actor, input: CreateInput): Promise<Template> {
    const name = input.name.trim()
    await validateTemplateFile(name, input.resource, input.fileId)
    try {
      return await withTx(db, async (tx) => {
        const row = await tx
          .insertInto('sys_print_template')
          .values({
            name,
            resource: input.resource,
            file_id: input.fileId,
            remarks: input.remarks ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const value = mapTemplate(row)
        await syncAttachment(tx, value.id, value.fileId)
        await writeTemplateAudit(
          tx,
          actor,
          value,
          'create',
          'create',
          auditCreated(templateSnapshot(value), TEMPLATE_AUDIT_FIELDS),
        )
        return value
      })
    } catch (err) {
      throw templateWriteError('创建打印模板失败', err)
    }
  }

  async function update(actor: Actor, id: string, input: UpdateInput): Promise<Template> {
    return withTx(db, async (tx) => {
      const before = await lockTemplate(tx, id)
      const after = { ...before }
      if (input.name !== undefined) after.name = input.name.trim()
      if (input.fileId !== undefined) after.fileId = input.fileId
      if (input.remarksPresent) {
        after.remarks = input.remarks ?? null
      }
      await validateTemplateFile(after.name, after.resource, after.fileId)
      const changes = auditDiff(
        templateSnapshot(before),
        templateSnapshot(after),
        TEMPLATE_AUDIT_FIELDS,
      )
      if (Object.keys(changes).length === 0) return before
      try {
        const row = await tx
          .updateTable('sys_print_template')
          .set({
            name: after.name,
            file_id: after.fileId,
            remarks: after.remarks,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const value = mapTemplate(row)
        if (before.fileId !== value.fileId) {
          await syncAttachment(tx, value.id, value.fileId)
        }
        await writeTemplateAudit(tx, actor, value, 'update', 'update', changes)
        return value
      } catch (err) {
        throw templateWriteError('更新打印模板失败', err)
      }
    })
  }

  async function setDefault(actor: Actor, id: string): Promise<Template> {
    return withTx(db, async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('sys_print_template_default'))`.execute(tx)
      const target = await lockTemplate(tx, id)
      const previous = await tx
        .selectFrom('sys_print_template')
        .selectAll()
        .where('resource', '=', target.resource)
        .where('is_default', '=', true)
        .where('id', '<>', target.id)
        .forUpdate()
        .execute()
      for (const row of previous) {
        const value = mapTemplate(row)
        await tx
          .updateTable('sys_print_template')
          .set({
            is_default: false,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', value.id)
          .execute()
        const after = { ...value, isDefault: false }
        await writeTemplateAudit(
          tx,
          actor,
          after,
          'update',
          'unset_default',
          auditDiff(templateSnapshot(value), templateSnapshot(after), TEMPLATE_AUDIT_FIELDS),
        )
      }
      if (!target.isDefault) {
        const before = target
        try {
          const row = await tx
            .updateTable('sys_print_template')
            .set({
              is_default: true,
              updated_at: sql`(now() AT TIME ZONE 'utc')`,
            })
            .where('id', '=', target.id)
            .returningAll()
            .executeTakeFirstOrThrow()
          const value = mapTemplate(row)
          await writeTemplateAudit(
            tx,
            actor,
            value,
            'update',
            'set_default',
            auditDiff(templateSnapshot(before), templateSnapshot(value), TEMPLATE_AUDIT_FIELDS),
          )
          return value
        } catch (err) {
          throw templateWriteError('设置默认模板失败', err)
        }
      }
      return target
    })
  }

  async function unsetDefault(actor: Actor, id: string): Promise<Template> {
    return withTx(db, async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('sys_print_template_default'))`.execute(tx)
      const before = await lockTemplate(tx, id)
      if (!before.isDefault) return before
      try {
        const row = await tx
          .updateTable('sys_print_template')
          .set({
            is_default: false,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const after = mapTemplate(row)
        await writeTemplateAudit(
          tx,
          actor,
          after,
          'update',
          'unset_default',
          auditDiff(templateSnapshot(before), templateSnapshot(after), TEMPLATE_AUDIT_FIELDS),
        )
        return after
      } catch (err) {
        throw templateWriteError('取消默认模板失败', err)
      }
    })
  }

  async function remove(actor: Actor, id: string): Promise<void> {
    await withTx(db, async (tx) => {
      const value = await lockTemplate(tx, id)
      await tx
        .deleteFrom('sys_attachment')
        .where('owner_type', '=', 'sys_print_template')
        .where('owner_id', '=', id)
        .execute()
      try {
        await tx.deleteFrom('sys_print_template').where('id', '=', id).execute()
      } catch (err) {
        throw templateWriteError('删除打印模板失败', err)
      }
      await writeTemplateAudit(
        tx,
        actor,
        value,
        'destroy',
        'destroy',
        auditDestroyed(templateSnapshot(value), TEMPLATE_AUDIT_FIELDS),
      )
    })
  }

  async function render(actor: Actor, input: RenderInput): Promise<RenderOutput> {
    if (input.mode !== RENDER_MODE_PRINT && input.mode !== RENDER_MODE_EXPORT) {
      throw ApiError.validation('mode 须为 print 或 export', {
        mode: ['须为 print 或 export'],
      })
    }
    if (!catalog.get(input.resource)) {
      throw ApiError.validation(`不支持的资源类型 ${input.resource}`, {
        resource: ['不在打印字段目录中'],
      })
    }
    if (input.ids.length < 1) {
      throw ApiError.validation('请至少选择一条单据', { ids: ['请至少选择一条单据'] })
    }
    if (input.ids.length > MAX_RENDER_BATCH) {
      throw ApiError.validation('单次最多处理 100 条', { ids: ['单次最多处理 100 条'] })
    }
    let action = 'export'
    if (input.mode === RENDER_MODE_PRINT) {
      action = input.ids.length > 1 ? 'batch_print' : 'print'
    }
    if (!hasPermission(actor, `${input.resource}:${action}`)) {
      throw new ApiError('forbidden', '无权限执行该操作')
    }
    const builder = builders.get(input.resource)
    if (!builder) {
      throw new ApiError('not_implemented', `资源 ${input.resource} 的模板打印暂未接入`)
    }
    const template = await get(input.templateId)
    if (template.resource !== input.resource) {
      throw ApiError.validation('模板与单据资源类型不匹配', {
        templateId: ['模板与单据资源类型不匹配'],
      })
    }
    let raw: Uint8Array
    try {
      ;({ content: raw } = await files.readStoredFile(template.fileId))
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_found') {
        throw ApiError.validation('无法读取模板文件', {
          templateId: ['无法读取模板文件'],
        })
      }
      throw ApiError.validation('无法读取模板文件', {
        templateId: ['无法读取模板文件'],
      })
    }
    return renderWithTemplate(actor, builder, raw, input)
  }

  async function renderWithTemplate(
    actor: Actor,
    builder: DocBuilder,
    templateRaw: Uint8Array,
    input: RenderInput,
  ): Promise<RenderOutput> {
    const docs = await builder.buildDocs(actor, input.ids)
    const filename = renderFilename(builder.label(), docs, input.mode, input.ids.length)
    try {
      if (input.mode === RENDER_MODE_EXPORT) {
        const named = docs.map((d) => ({ name: d.sheetName, doc: d.doc }))
        const xlsx = renderSheets(templateRaw, named)
        return { binary: xlsx, contentType: XLSX_CONTENT_TYPE, filename }
      }
      const printDocs = docs.map((d) => d.doc)
      const xlsx = renderPages(templateRaw, printDocs)
      try {
        const pdf = await converter.convertXlsxToPdf(xlsx)
        return { binary: pdf, contentType: PDF_CONTENT_TYPE, filename }
      } catch (err) {
        throw convertError(err)
      }
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw renderError(err)
    }
  }

  async function validateTemplateFile(
    name: string,
    resource: string,
    fileId: string,
  ): Promise<void> {
    if (!name) {
      throw ApiError.validation('模板名称不能为空', { name: ['不能为空'] })
    }
    if ([...name].length > 64) {
      throw ApiError.validation('模板名称最多 64 个字符', { name: ['最多 64 个字符'] })
    }
    if (!catalog.get(resource)) {
      throw ApiError.validation(`不支持的资源类型 ${resource}`, {
        resource: ['不在打印字段目录中'],
      })
    }
    if (!fileId) {
      throw ApiError.validation('请上传模板文件', { fileId: ['不能为空'] })
    }
    let file: { filename: string }
    let raw: Uint8Array
    try {
      ;({ file, content: raw } = await files.readStoredFile(fileId))
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_found') {
        throw ApiError.validation('模板文件不存在', { fileId: ['模板文件不存在'] })
      }
      throw ApiError.validation('无法读取模板文件', { fileId: ['无法读取模板文件'] })
    }
    if (!file.filename.toLowerCase().endsWith('.xlsx')) {
      throw ApiError.validation('只接受 .xlsx 模板文件', {
        fileId: ['只接受 .xlsx 模板文件'],
      })
    }
    let placeholders
    try {
      placeholders = extractPlaceholders(raw)
    } catch (err) {
      const message = err instanceof Error ? err.message : '无法解析模板'
      throw ApiError.validation(message, { fileId: [message] })
    }
    catalog.validatePlaceholders(resource, placeholders)
  }

  return {
    getCatalog,
    get,
    list,
    listUsable,
    create,
    update,
    setDefault,
    unsetDefault,
    delete: remove,
    render,
    registerDocBuilder,
    setPDFConverter,
  }
}

export type PrintingService = ReturnType<typeof createPrintingService>

export function canUseTemplates(actor: Actor | null, resource: string): boolean {
  if (!actor) return false
  if (hasPermission(actor, `${PERMISSION_PREFIX}:read`)) return true
  for (const action of ['print', 'export', 'batch_print'] as const) {
    if (hasPermission(actor, `${resource}:${action}`)) return true
  }
  return false
}

function mapTemplate(row: {
  id: string
  name: string
  resource: string
  is_default: boolean
  remarks: string | null
  file_id: string
  inserted_at: Date
  updated_at: Date
}): Template {
  return {
    id: row.id,
    name: row.name,
    resource: row.resource,
    isDefault: row.is_default,
    remarks: row.remarks,
    fileId: row.file_id,
    insertedAt: row.inserted_at instanceof Date ? row.inserted_at : new Date(row.inserted_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  }
}

async function lockTemplate(tx: DbHandle, id: string): Promise<Template> {
  const row = await tx
    .selectFrom('sys_print_template')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw new ApiError('not_found', '打印模板不存在')
  return mapTemplate(row)
}

async function syncAttachment(tx: DbHandle, templateId: string, fileId: string): Promise<void> {
  await tx
    .deleteFrom('sys_attachment')
    .where('owner_type', '=', 'sys_print_template')
    .where('owner_id', '=', templateId)
    .execute()
  await tx
    .insertInto('sys_attachment')
    .values({
      file_id: fileId,
      owner_type: 'sys_print_template',
      owner_id: templateId,
      category: 'template',
      company_id: null,
    })
    .execute()
}

function templateSnapshot(value: Template): Record<string, unknown> {
  return {
    name: value.name,
    resource: value.resource,
    is_default: value.isDefault,
    remarks: value.remarks,
    file_id: value.fileId,
  }
}

async function writeTemplateAudit(
  tx: DbHandle,
  actor: Actor,
  value: Template,
  actionType: string,
  actionName: string,
  changes: Record<string, Record<string, unknown>>,
): Promise<void> {
  if (Object.keys(changes).length === 0) return
  await writeAudit(tx, actor, {
    resource: 'sys_print_template',
    recordId: value.id,
    recordLabel: value.name,
    actionType,
    actionName,
    changes,
  })
}

function templateWriteError(message: string, err: unknown): ApiError {
  if (err instanceof ApiError) return err
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: string }).code
    if (code === '23503') {
      return ApiError.validation('模板文件不存在', { fileId: ['模板文件不存在'] })
    }
    if (code === '23505') {
      return new ApiError('conflict', '同一资源只能有一个默认模板')
    }
  }
  return mapWriteError(err, message, [])
}

function renderFilename(
  label: string,
  docs: Array<{ sheetName: string }>,
  mode: string,
  count: number,
): string {
  const ext = mode === RENDER_MODE_EXPORT ? '.xlsx' : '.pdf'
  if (count === 1 && docs.length === 1 && docs[0]?.sheetName) {
    return docs[0].sheetName + ext
  }
  const date = new Date()
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${label}-批量-${y}-${m}-${d}${ext}`
}

function renderError(err: unknown): ApiError {
  if (err === ERR_EMPTY_DOCS || (err instanceof Error && err.message === 'empty docs')) {
    return ApiError.validation('请至少选择一条单据', { ids: ['请至少选择一条单据'] })
  }
  const message = err instanceof Error ? err.message : '渲染失败'
  return ApiError.validation(message, { templateId: [message] })
}

function convertError(err: unknown): ApiError {
  if (err === ERR_SOFFICE_NOT_FOUND || (err instanceof Error && err.message === 'soffice_not_found')) {
    return new ApiError(
      'internal',
      'PDF 转换服务不可用（未找到 LibreOffice），请使用导出 Excel 或联系管理员',
    )
  }
  if (err === ERR_SOFFICE_TIMEOUT || (err instanceof Error && err.message === 'timeout')) {
    return new ApiError('internal', 'PDF 转换超时，请减少批量条数或稍后重试')
  }
  if (err === ERR_SOFFICE_NO_OUTPUT || (err instanceof Error && err.message === 'no_output')) {
    return new ApiError('internal', 'PDF 转换未生成文件')
  }
  if (err instanceof ConvertFailedError && err.detail) {
    return new ApiError('internal', `PDF 转换失败: ${err.detail}`)
  }
  return new ApiError('internal', 'PDF 转换失败')
}
