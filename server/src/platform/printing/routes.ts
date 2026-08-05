/**
 * 打印 REST：模板 CRUD（/system/printing）+ 字段目录 / 可用模板 / 渲染（/printing）。
 *
 * S9「请求形态派生动作码」在此落地：客户端给的是**打印前缀**（如 sales.order），
 * 路由先经字段目录把它解析成 sealed registry 的资源名（杜绝任意 prefix），
 * 再按 mode + arity 派生 print / batch_print / export，最后走 permitFor 取凭证。
 * 资源未声明该打印动作时无权限点，按主体种类 fail-closed（只有 superAdmin/system 放行），
 * 与迁移前「码不在目录内故不可授」的结果逐字一致。
 */
import { zValidator } from '@hono/zod-validator'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '../auth/middleware.ts'
import type { AuthService } from '../auth/service.ts'
import type { AuthzEnforcer } from '../authz/enforce.ts'
import { permitOf } from '../authz/enforce.ts'
import type { Permit } from '../authz/core/index.ts'
import type { AppEnv } from '../http/context.ts'
import { ApiError } from '../http/errors.ts'
import { listQuerySchema, validationHook } from '../http/zod.ts'
import { PERMISSION_PREFIX, RESOURCE_NAME } from './meta.ts'
import { type PrintingService } from './service.ts'
import { RENDER_MODE_PRINT } from './types.ts'
import type { Template } from './types.ts'

const UUID = z.string().uuid()

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
  authz: AuthzEnforcer
  printing: PrintingService
}

/** 挂载于 /system/printing：模板 CRUD + 默认切换 */
export function systemPrintingRoutes(deps: PrintingRoutesDeps) {
  const { auth, authz, printing } = deps
  // 设置/取消默认未声明独立动作，沿用最接近的已声明动作 update
  const guard = (action: string) => authz.guard(RESOURCE_NAME, action)

  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/templates/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const body = c.req.valid('json')
      const result = await printing.list(permitOf(c), toListQuery(body))
      return c.json({
        count: result.count,
        results: result.results.map(templateDto),
      })
    })
    .get('/templates/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      const value = await printing.get(permitOf(c), c.req.valid('param').id)
      return c.json(templateDto(value))
    })
    .post('/templates', guard('create'), zValidator('json', createSchema, validationHook), async (c) => {
      const body = c.req.valid('json')
      const value = await printing.create(permitOf(c), {
        name: body.name,
        resource: body.resource,
        fileId: body.fileId,
        remarks: body.remarks,
      })
      return c.json(templateDto(value), 201)
    })
    .patch(
      '/templates/:id',
      guard('update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', updateSchema, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const value = await printing.update(permitOf(c), c.req.valid('param').id, {
          name: body.name,
          fileId: body.fileId,
          remarks: body.remarks,
          remarksPresent: Object.prototype.hasOwnProperty.call(raw, 'remarks'),
        })
        return c.json(templateDto(value))
      },
    )
    .delete('/templates/:id', guard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await printing.delete(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
    .post('/templates/:id/set-default', guard('update'), zValidator('param', idParam, validationHook), async (c) => {
      const value = await printing.setDefault(permitOf(c), c.req.valid('param').id)
      return c.json(templateDto(value))
    })
    .post(
      '/templates/:id/unset-default',
      guard('update'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        const value = await printing.unsetDefault(permitOf(c), c.req.valid('param').id)
        return c.json(templateDto(value))
      },
    )
}

/** 挂载于 /printing：字段目录 / 可用模板 / 渲染 */
export function printingRoutes(deps: PrintingRoutesDeps) {
  const { auth, authz, printing } = deps

  /** 客户端 prefix → sealed registry 资源名；不在目录内即 400（与迁移前同码） */
  function resolveResource(prefix: string): { prefix: string; name: string } {
    const name = printing.getCatalog().resourceNameOf(prefix)
    if (!name) {
      throw ApiError.validation(`不支持的资源类型 ${prefix}`, {
        resource: ['不在打印字段目录中'],
      })
    }
    return { prefix, name }
  }

  /**
   * 模板可用性凭证：`sys.print_template:read` 或该资源的 print/export/batch_print 任一
   * （多码可读 → guard 的 anyOf，声明即执行；取代旧 canUseTemplates 裸函数）。
   */
  function usablePermit(c: Context<AppEnv>, prefix: string): Permit {
    return authz.permitFor(c, RESOURCE_NAME, 'read', {
      anyOf: [
        `${PERMISSION_PREFIX}:read`,
        `${prefix}:print`,
        `${prefix}:export`,
        `${prefix}:batch_print`,
      ],
    })
  }

  /**
   * 打印凭证：动作已声明 → 正常码级判定；未声明 → 该资源无打印权限点，
   * 按主体种类 fail-closed，放行后取一张 read 凭证作行过滤器。
   */
  function renderPermit(c: Context<AppEnv>, resourceName: string, action: string): Permit {
    if (authz.hasAction(resourceName, action)) {
      return authz.permitFor(c, resourceName, action)
    }
    const actor = c.get('actor')
    if (!actor) throw new ApiError('unauthorized', '未登录或登录状态已失效')
    if (!actor.superAdmin && actor.kind !== 'system') {
      throw new ApiError('forbidden', '无权限执行该操作')
    }
    return authz.permitFor(c, resourceName, 'read')
  }

  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .get('/resources', async (c) => {
      // 打印前缀清单只判「已登录」（无独立权限码，对齐 Go requireActor）
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
        const resource = resolveResource(c.req.valid('query').resource).prefix
        usablePermit(c, resource)
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
        const resource = resolveResource(c.req.valid('query').resource).prefix
        const results = await printing.listUsable(usablePermit(c, resource), resource)
        return c.json({
          count: results.length,
          results: results.map(templateDto),
        })
      },
    )
    .post('/render', zValidator('json', renderSchema, validationHook), async (c) => {
      const body = c.req.valid('json')
      const target = resolveResource(body.resource.trim())
      // mode + arity 派生动作码（S9）：单条打印 print / 多条 batch_print / 导出 export
      const action =
        body.mode === RENDER_MODE_PRINT
          ? body.ids.length > 1
            ? 'batch_print'
            : 'print'
          : 'export'
      const permit = renderPermit(c, target.name, action)
      const output = await printing.render(permit, {
        resource: target.prefix,
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
