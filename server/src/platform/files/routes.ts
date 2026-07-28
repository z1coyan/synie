import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '../auth/middleware.ts'
import type { AuthService } from '../auth/service.ts'
import { requirePermission } from '../authz/actor.ts'
import type { AppEnv } from '../http/context.ts'
import { ApiError } from '../http/errors.ts'
import { validationHook } from '../http/zod.ts'
import { attachmentDto, storageDto, storedFileDto } from './dto.ts'
import type { FileService } from './service.ts'
import type { StorageService } from './storage-service.ts'
import type { StorageUpdateInput } from './types.ts'

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
  files: FileService
}

/** 挂载于 /files：query / upload / download / metadata / attachments */
export function fileRoutes(deps: FileRoutesDeps) {
  const { auth, files } = deps

  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.file:read')
      const body = c.req.valid('json')
      const result = await files.list(toListQuery(body))
      return c.json({
        count: result.count,
        results: result.results.map(storedFileDto),
      })
    })
    .post('/', async (c) => {
      const actor = c.get('actor')
      requirePermission(actor, 'sys.file:create')

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

      const result = await files.upload(actor, {
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
    .post('/attachments/query', zValidator('json', attachmentQuerySchema, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.file:read')
      const body = c.req.valid('json')
      const result = await files.listAttachments(c.get('actor'), body)
      return c.json({
        count: result.count,
        results: result.results.map(attachmentDto),
      })
    })
    .delete('/attachments/:id', zValidator('param', idParam, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.file:delete')
      await files.deleteAttachment(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })
    .get('/:id/metadata', zValidator('param', idParam, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.file:read')
      const value = await files.get(c.req.valid('param').id)
      return c.json(storedFileDto(value))
    })
    .post(
      '/:id/attachments',
      zValidator('param', idParam, validationHook),
      zValidator('json', attachmentCreateSchema, validationHook),
      async (c) => {
        requirePermission(c.get('actor'), 'sys.file:create')
        const { id } = c.req.valid('param')
        const body = c.req.valid('json')
        const value = await files.attach(c.get('actor'), id, body)
        return c.json({ attachment: attachmentDto(value) }, 201)
      },
    )
    .get('/:id', zValidator('param', idParam, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.file:read')
      const result = await files.download(c.get('actor'), c.req.valid('param').id)
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
    .delete('/:id', zValidator('param', idParam, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.file:delete')
      await files.deleteFile(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export interface StorageRoutesDeps {
  auth: AuthService
  storages: StorageService
}

/** 挂载于 /system/storages */
export function storageRoutes(deps: StorageRoutesDeps) {
  const { auth, storages } = deps

  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.storage:read')
      const result = await storages.list(toListQuery(c.req.valid('json')))
      return c.json({
        count: result.count,
        results: result.results.map(storageDto),
      })
    })
    .post('/', zValidator('json', storageCreateSchema, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.storage:create')
      const body = c.req.valid('json')
      const value = await storages.create(c.get('actor'), body)
      return c.json(storageDto(value), 201)
    })
    .get('/:id', zValidator('param', idParam, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.storage:read')
      const value = await storages.get(c.req.valid('param').id)
      return c.json(storageDto(value))
    })
    .patch(
      '/:id',
      zValidator('param', idParam, validationHook),
      zValidator('json', storageUpdateSchema, validationHook),
      async (c) => {
        requirePermission(c.get('actor'), 'sys.storage:update')
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
        const value = await storages.update(c.get('actor'), c.req.valid('param').id, {
          ...body,
          present,
        })
        return c.json(storageDto(value))
      },
    )
    .delete('/:id', zValidator('param', idParam, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.storage:delete')
      await storages.delete(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })
    .post('/:id/set-default', zValidator('param', idParam, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.storage:update')
      await storages.setDefault(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

function toListQuery(body: z.infer<typeof listQuerySchema>): Partial<ListQuery> {
  return {
    limit: body.limit,
    offset: body.offset,
    search: body.search,
    sort: body.sort,
    filter: body.filter as ListQuery['filter'],
  }
}

function formString(body: Record<string, string | File>, ...names: string[]): string {
  for (const name of names) {
    const value = body[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}
