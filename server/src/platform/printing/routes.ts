import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '../auth/middleware.ts'
import type { AuthService } from '../auth/service.ts'
import type { AppEnv } from '../http/context.ts'
import { ApiError } from '../http/errors.ts'
import { validationHook } from '../http/zod.ts'
import { canUseTemplates, type PrintingService } from './service.ts'
import type { Template } from './types.ts'

const UUID = z.string().uuid()

const listQuerySchema = z
  .object({
    limit: z.number().int().min(0).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    search: z.string().optional(),
    sort: z
      .object({
        column: z.string(),
        direction: z.enum(['ascending', 'descending']),
      })
      .optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const createSchema = z
  .object({
    name: z.string().min(1),
    resource: z.string().min(1),
    fileId: UUID,
    remarks: z.string().nullable().optional(),
  })
  .strict()

const updateSchema = z
  .object({
    name: z.string().min(1).optional(),
    fileId: UUID.optional(),
    remarks: z.string().nullable().optional(),
  })
  .strict()

const renderSchema = z
  .object({
    resource: z.string().min(1),
    mode: z.enum(['print', 'export']),
    templateId: UUID,
    ids: z.array(UUID).min(1),
  })
  .strict()

const idParam = z.object({ id: UUID })

function templateDto(value: Template) {
  return {
    id: value.id,
    name: value.name,
    resource: value.resource,
    isDefault: value.isDefault,
    remarks: value.remarks,
    fileId: value.fileId,
    insertedAt: value.insertedAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  }
}

export interface PrintingRoutesDeps {
  auth: AuthService
  printing: PrintingService
}

/** 挂载于 /system/printing：模板 CRUD + 默认切换 */
export function systemPrintingRoutes(deps: PrintingRoutesDeps) {
  const { auth, printing } = deps

  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/templates/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const body = c.req.valid('json')
      const result = await printing.list(c.get('actor'), toListQuery(body))
      return c.json({
        count: result.count,
        results: result.results.map(templateDto),
      })
    })
    .get('/templates/:id', zValidator('param', idParam, validationHook), async (c) => {
      const value = await printing.get(c.get('actor'), c.req.valid('param').id)
      return c.json(templateDto(value))
    })
    .post('/templates', zValidator('json', createSchema, validationHook), async (c) => {
      const body = c.req.valid('json')
      const value = await printing.create(c.get('actor'), {
        name: body.name,
        resource: body.resource,
        fileId: body.fileId,
        remarks: body.remarks,
      })
      return c.json(templateDto(value), 201)
    })
    .patch(
      '/templates/:id',
      zValidator('param', idParam, validationHook),
      zValidator('json', updateSchema, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const value = await printing.update(c.get('actor'), c.req.valid('param').id, {
          name: body.name,
          fileId: body.fileId,
          remarks: body.remarks,
          remarksPresent: Object.prototype.hasOwnProperty.call(raw, 'remarks'),
        })
        return c.json(templateDto(value))
      },
    )
    .delete('/templates/:id', zValidator('param', idParam, validationHook), async (c) => {
      await printing.delete(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })
    .post('/templates/:id/set-default', zValidator('param', idParam, validationHook), async (c) => {
      const value = await printing.setDefault(c.get('actor'), c.req.valid('param').id)
      return c.json(templateDto(value))
    })
    .post(
      '/templates/:id/unset-default',
      zValidator('param', idParam, validationHook),
      async (c) => {
        const value = await printing.unsetDefault(c.get('actor'), c.req.valid('param').id)
        return c.json(templateDto(value))
      },
    )
}

/** 挂载于 /printing：字段目录 / 可用模板 / 渲染 */
export function printingRoutes(deps: PrintingRoutesDeps) {
  const { auth, printing } = deps

  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .get('/resources', async (c) => {
      if (!c.get('actor')) throw new ApiError('unauthorized', '未登录或登录状态已失效')
      return c.json({ resources: printing.getCatalog().resources() })
    })
    .get(
      '/field-catalog',
      zValidator(
        'query',
        z.object({ resource: z.string().min(1) }).strict(),
        validationHook,
      ),
      async (c) => {
        const actor = c.get('actor')
        const resource = c.req.valid('query').resource
        if (!canUseTemplates(actor, resource)) {
          throw new ApiError('forbidden', '无权查看该资源的打印字段目录')
        }
        const value = printing.getCatalog().get(resource)
        if (!value) {
          throw ApiError.validation(`不支持的资源类型 ${resource}`, {
            resource: ['不在打印字段目录中'],
          })
        }
        return c.json({
          resource: value.resource,
          fields: value.fields,
          loops: value.loops.map((loop) => ({
            name: loop.name,
            label: loop.label,
            fields: loop.fields,
          })),
        })
      },
    )
    .get(
      '/templates',
      zValidator(
        'query',
        z.object({ resource: z.string().min(1) }).strict(),
        validationHook,
      ),
      async (c) => {
        const actor = c.get('actor')
        const resource = c.req.valid('query').resource
        const results = await printing.listUsable(actor, resource)
        return c.json({
          count: results.length,
          results: results.map(templateDto),
        })
      },
    )
    .post('/render', zValidator('json', renderSchema, validationHook), async (c) => {
      const actor = c.get('actor')
      const body = c.req.valid('json')
      const output = await printing.render(actor, {
        resource: body.resource.trim(),
        mode: body.mode,
        templateId: body.templateId,
        ids: body.ids,
      })
      return new Response(Buffer.from(output.binary), {
        status: 200,
        headers: {
          'Content-Type': output.contentType,
          'Content-Disposition': `attachment; filename="${encodePrintFilename(output.filename)}"`,
        },
      })
    })
}

function toListQuery(body: z.infer<typeof listQuerySchema>): ListQuery {
  return {
    limit: body.limit ?? 0,
    offset: body.offset ?? 0,
    search: body.search,
    sort: body.sort,
    filter: body.filter as ListQuery['filter'],
  }
}

/** 非 ASCII 文件名按 URL 编码（对齐 Go encodePrintFilename） */
export function encodePrintFilename(name: string): string {
  let ascii = true
  for (const r of name) {
    const code = r.codePointAt(0) ?? 0
    if (code < 0x20 || code > 0x7e) {
      ascii = false
      break
    }
  }
  if (ascii) return name
  return encodeURIComponent(name)
}
