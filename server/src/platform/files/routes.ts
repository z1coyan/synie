import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '../auth/middleware.ts'
import type { AuthService } from '../auth/service.ts'
import type { RateLimiter } from '../auth/limiter.ts'
import { permitOf, type AuthzEnforcer } from '../authz/enforce.ts'
import type { AppEnv } from '../http/context.ts'
import { ApiError } from '../http/errors.ts'
import { rateLimitByActor } from '../http/rate-limit.ts'
import { listQuerySchema, toListQuery, validationHook } from '../http/zod.ts'
import { attachmentDto, storageDto, storedFileDto } from './dto.ts'
import { ATTACHMENT_RESOURCE_NAME, FILE_RESOURCE_NAME, STORAGE_RESOURCE_NAME } from './meta.ts'
import type { FileService } from './service.ts'
import type { StorageService } from './storage-service.ts'
import type { StorageUpdateInput } from './types.ts'

const UUID = z.string().uuid()

const attachmentCreateSchema = z
  .object({
    ownerType: z.string().min(1),
    ownerId: UUID,
    category: z.string().optional(),
  })
  .strict()

const attachmentQuerySchema = z
  .object({
    limit: z.number().int().min(0).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    fileId: UUID.optional(),
    ownerType: z.string().optional(),
    ownerId: UUID.optional(),
    category: z.string().optional(),
  })
  .strict()

const storageCreateSchema = z
  .object({
    name: z.string().min(1).max(32),
    label: z.string().min(1).max(64),
    kind: z.enum(['LOCAL', 'S3', 'OSS']),
    root: z.string().nullable().optional(),
    endpoint: z.string().nullable().optional(),
    region: z.string().nullable().optional(),
    bucket: z.string().nullable().optional(),
    prefix: z.string().nullable().optional(),
    accessKeyId: z.string().nullable().optional(),
    secretAccessKey: z.string().optional(),
  })
  .strict()

const storageUpdateSchema = z
  .object({
    label: z.string().min(1).max(64).optional(),
    root: z.string().nullable().optional(),
    endpoint: z.string().nullable().optional(),
    region: z.string().nullable().optional(),
    bucket: z.string().nullable().optional(),
    prefix: z.string().nullable().optional(),
    accessKeyId: z.string().nullable().optional(),
    secretAccessKey: z.string().optional(),
  })
  .strict()

const idParam = z.object({ id: UUID })

const MAX_MULTIPART_BYTES = 51 << 20

export interface FileRoutesDeps {
  auth: AuthService
  authz: AuthzEnforcer
  files: FileService
  /** 上传限流（按用户分桶）；缺省不限（测试基座兼容） */
  uploadLimiter?: RateLimiter
}

/**
 * 挂载于 /files：query / upload / download / metadata / attachments。
 * 每个端点挂 `guard(资源, 动作)`（requireAuth 之后）；挂接端点的资源是 sysAttachments
 * （via sysFiles，故码仍是 sys.file:*），handler 用 permitOf(c) 取凭证。
 */
export function fileRoutes(deps: FileRoutesDeps) {
  const { auth, authz, files, uploadLimiter } = deps
  const guard = (action: string) => authz.guard(FILE_RESOURCE_NAME, action)
  const guardAttachment = (action: string) => authz.guard(ATTACHMENT_RESOURCE_NAME, action)
  /** 挂接要求「能读 + 能挂」：附加码取归宿前缀（动作码事实源仍是 meta，不写字面量） */
  const guardAttach = () =>
    authz.guard(ATTACHMENT_RESOURCE_NAME, 'create', {
      allOf: [`${authz.targetOf(ATTACHMENT_RESOURCE_NAME).prefix}:read`],
    })

  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const body = c.req.valid('json')
      const result = await files.list(permitOf(c), toListQuery(body))
      return c.json({
        count: result.count,
        results: result.results.map(storedFileDto),
      })
    })
    .post(
      '/',
      guard('create'),
      // 大文件上传（≤50MB）是重资源：限流先于 multipart 解析
      rateLimitByActor(uploadLimiter, '文件上传过于频繁，请稍后再试'),
      async (c) => {
      let body: Record<string, string | File>
      try {
        body = (await c.req.parseBody({ all: true })) as Record<string, string | File>
      } catch {
        throw ApiError.validation('请求参数错误', { file: ['缺少 file 字段或文件超过 50MB'] })
      }

      const fileField = body.file
      if (!(fileField instanceof File)) {
        throw ApiError.validation('请求参数错误', { file: ['缺少 file 字段(multipart)'] })
      }
      if (fileField.size > MAX_MULTIPART_BYTES) {
        throw ApiError.validation('请求参数错误', { file: ['缺少 file 字段或文件超过 50MB'] })
      }

      const data = new Uint8Array(await fileField.arrayBuffer())
      const ownerType = formString(body, 'ownerType', 'owner_type')
      const ownerIdRaw = formString(body, 'ownerId', 'owner_id')
      let ownerId: string | undefined
      if (ownerIdRaw) {
        const parsed = UUID.safeParse(ownerIdRaw)
        if (!parsed.success) {
          throw ApiError.validation('请求参数错误', { ownerId: ['ownerId 必须是 UUID'] })
        }
        ownerId = parsed.data
      }
      const category = formString(body, 'category')

      const result = await files.upload(permitOf(c), {
        data,
        filename: fileField.name || 'upload.bin',
        contentType: fileField.type || '',
        ownerType: ownerType || undefined,
        ownerId,
        category: category || undefined,
      })

      return c.json(
        {
          file: storedFileDto(result.file),
          attachment: result.attachment ? attachmentDto(result.attachment) : null,
        },
        201,
      )
    })
    .post(
      '/attachments/query',
      guardAttachment('read'),
      zValidator('json', attachmentQuerySchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const result = await files.listAttachments(permitOf(c), body)
        return c.json({
          count: result.count,
          results: result.results.map(attachmentDto),
        })
      },
    )
    .delete(
      '/attachments/:id',
      guardAttachment('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await files.deleteAttachment(permitOf(c), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    .get('/:id/metadata', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      const value = await files.get(permitOf(c), c.req.valid('param').id)
      return c.json(storedFileDto(value))
    })
    .post(
      '/:id/attachments',
      guardAttach(),
      zValidator('param', idParam, validationHook),
      zValidator('json', attachmentCreateSchema, validationHook),
      async (c) => {
        const { id } = c.req.valid('param')
        const body = c.req.valid('json')
        const value = await files.attach(permitOf(c), id, body)
        return c.json({ attachment: attachmentDto(value) }, 201)
      },
    )
    .get('/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      const result = await files.download(permitOf(c), c.req.valid('param').id)
      if (result.redirectUrl) {
        return c.redirect(result.redirectUrl, 302)
      }
      const content = result.content ?? new Uint8Array()
      // web 引用 server 源时 DOM lib 会把 Uint8Array 与 BodyInit 收窄冲突；拷一份 ArrayBuffer 视图规避
      const body = new Uint8Array(content)
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': result.contentType,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
          'X-Content-Type-Options': 'nosniff',
        },
      })
    })
    .delete('/:id', guard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await files.deleteFile(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export interface StorageRoutesDeps {
  auth: AuthService
  authz: AuthzEnforcer
  storages: StorageService
}

/** 挂载于 /system/storages */
export function storageRoutes(deps: StorageRoutesDeps) {
  const { auth, authz, storages } = deps
  const guard = (action: string) => authz.guard(STORAGE_RESOURCE_NAME, action)

  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const result = await storages.list(permitOf(c), toListQuery(c.req.valid('json')))
      return c.json({
        count: result.count,
        results: result.results.map(storageDto),
      })
    })
    .post('/', guard('create'), zValidator('json', storageCreateSchema, validationHook), async (c) => {
      const body = c.req.valid('json')
      const value = await storages.create(permitOf(c), body)
      return c.json(storageDto(value), 201)
    })
    .get('/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      const value = await storages.get(permitOf(c), c.req.valid('param').id)
      return c.json(storageDto(value))
    })
    .patch(
      '/:id',
      guard('update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', storageUpdateSchema, validationHook),
      async (c) => {
        const raw = await c.req.json()
        if (raw && typeof raw === 'object' && 'label' in raw && raw.label === null) {
          throw ApiError.validation('请求参数错误', { label: ['label 不能为 null'] })
        }
        const body = c.req.valid('json')
        const present: StorageUpdateInput['present'] = {
          label: Object.prototype.hasOwnProperty.call(raw, 'label'),
          root: Object.prototype.hasOwnProperty.call(raw, 'root'),
          endpoint: Object.prototype.hasOwnProperty.call(raw, 'endpoint'),
          region: Object.prototype.hasOwnProperty.call(raw, 'region'),
          bucket: Object.prototype.hasOwnProperty.call(raw, 'bucket'),
          prefix: Object.prototype.hasOwnProperty.call(raw, 'prefix'),
          accessKeyId: Object.prototype.hasOwnProperty.call(raw, 'accessKeyId'),
          secretAccessKey: Object.prototype.hasOwnProperty.call(raw, 'secretAccessKey'),
        }
        const value = await storages.update(permitOf(c), c.req.valid('param').id, {
          ...body,
          present,
        })
        return c.json(storageDto(value))
      },
    )
    .delete('/:id', guard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await storages.delete(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
    .post('/:id/set-default', guard('update'), zValidator('param', idParam, validationHook), async (c) => {
      await storages.setDefault(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

function formString(body: Record<string, string | File>, ...names: string[]): string {
  for (const name of names) {
    const value = body[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}
