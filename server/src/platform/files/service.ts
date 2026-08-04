import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ListQuery } from '@synie/shared'
import { sql, type Expression, type Kysely, type SqlBool } from 'kysely'
import { buildListQuery } from '~/db/filterbuild.ts'
import { toReadSpec } from '~/platform/meta/read-spec.ts'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { auditCreated, auditDestroyed, writeAudit } from '../audit/write.ts'
import { auditFieldsOf } from '../audit/spec.ts'
import { canAccessCompany, hasPermission, requirePermission, type Actor } from '../authz/actor.ts'
import { ApiError } from '../http/errors.ts'
import { fileResourceMeta } from './meta.ts'
import {
  createLocalStorage,
  createS3Storage,
  ERR_OBJECT_NOT_FOUND,
  ERR_PRESIGN_UNSUPPORTED,
  safeExtension,
  type ObjectStorage,
} from './object-storage.ts'
import { resolveOwner, type OwnerRegistry } from './owner-registry.ts'
import type {
  AttachInput,
  Attachment,
  AttachmentList,
  AttachmentQuery,
  DownloadResult,
  FileList,
  FileListQuery,
  StoredFile,
  UploadInput,
  UploadResult,
} from './types.ts'

const MAX_UPLOAD_SIZE = 50 << 20
const FILE_AUDIT_FIELDS = auditFieldsOf(fileResourceMeta())
// sys_attachment 无 ResourceMeta（附件不进 Catalog，挂 owner 资源展示），白名单暂留手抄；
// 若将来为附件建 meta，此清单应改吃 auditFieldsOf。
const ATTACHMENT_AUDIT_FIELDS = ['file_id', 'owner_type', 'owner_id', 'category', 'company_id'] as const

export interface FileServiceDeps {
  db: Kysely<Database>
  owners: OwnerRegistry
}

export function createFileService(deps: FileServiceDeps) {
  const { db, owners } = deps

  async function get(actor: Actor, id: string): Promise<StoredFile> {
    requirePermission(actor, 'sys.file:read')
    return loadFile(id)
  }

  /** 跨模块受信任读：鉴权由调用方业务能力码覆盖，不检 sys.file */
  async function readStoredFile(id: string): Promise<{ file: StoredFile; content: Uint8Array }> {
    const file = await loadFile(id)
    const store = await objectStorageByName(db, file.storage)
    try {
      const content = await store.read(file.key)
      return { file, content }
    } catch (err) {
      if (err === ERR_OBJECT_NOT_FOUND) throw new ApiError('not_found', '文件对象缺失')
      throw new ApiError('internal', '读取文件对象失败', { cause: err })
    }
  }

  async function loadFile(id: string): Promise<StoredFile> {
    const row = await db
      .selectFrom('sys_file')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) throw new ApiError('not_found', '文件不存在')
    return mapFile(row)
  }

  async function list(actor: Actor, query: FileListQuery): Promise<FileList> {
    requirePermission(actor, 'sys.file:read')
    const limit = query.limit === undefined || query.limit === 0 ? 20 : query.limit
    const offset = query.offset ?? 0
    if (limit < 1 || limit > 200 || offset < 0) {
      throw ApiError.validation('分页参数不合法', { limit: ['必须在 1 到 200 之间'] })
    }
    const listQuery: ListQuery = {
      limit,
      offset,
      search: query.search,
      sort: query.sort,
      filter: query.filter,
    }
    const built = buildListQuery(toReadSpec(fileResourceMeta()), listQuery)

    let countQ = db.selectFrom('sys_file').select(db.fn.countAll<string>().as('count'))
    if (built.where) countQ = countQ.where(built.where as Expression<SqlBool>)
    const countRow = await countQ.executeTakeFirstOrThrow()
    const count = Number(countRow.count)

    let rowsQ = db.selectFrom('sys_file').selectAll()
    if (built.where) rowsQ = rowsQ.where(built.where as Expression<SqlBool>)
    if (built.orderBy) {
      // filterbuild 产出参数化 ORDER BY 片段（含方向）
      rowsQ = rowsQ.orderBy(built.orderBy as never).orderBy('id')
    } else {
      rowsQ = rowsQ.orderBy('inserted_at', 'desc').orderBy('id')
    }
    const rows = await rowsQ.limit(limit).offset(offset).execute()
    return { count, results: rows.map(mapFile) }
  }

  async function upload(actor: Actor, input: UploadInput): Promise<UploadResult> {
    if (!hasPermission(actor, 'sys.file:create')) {
      throw new ApiError('forbidden', '无权限上传文件')
    }
    const filename = input.filename.trim()
    if (!filename || [...filename].length > 255) {
      throw ApiError.validation('上传参数不合法', {
        file: ['文件及文件名必填，文件名最多 255 个字符'],
      })
    }
    const hasOwnerType = !!(input.ownerType && input.ownerType.trim())
    const hasOwnerId = !!(input.ownerId && input.ownerId.trim())
    if (hasOwnerType !== hasOwnerId) {
      throw ApiError.validation('附件宿主参数不完整', {
        owner: ['ownerType 与 ownerId 必须同时提供'],
      })
    }
    if (input.data.byteLength > MAX_UPLOAD_SIZE) {
      throw ApiError.validation('文件过大', { file: ['单个文件不能超过 50MB'] })
    }

    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(input.data)
    const sha256 = hasher.digest('hex')
    const size = input.data.byteLength

    const endpoint = await defaultStorageConfig(db)
    const store = toObjectStorage(endpoint)
    const key = `${utcDatePath()}/${crypto.randomUUID()}${safeExtension(filename)}`

    const tempPath = join(tmpdir(), `synie-upload-${crypto.randomUUID()}`)
    await writeFile(tempPath, input.data)
    try {
      await store.put(key, tempPath)
    } catch (err) {
      await unlink(tempPath).catch(() => undefined)
      throw new ApiError('internal', '写入文件存储失败', { cause: err })
    }
    await unlink(tempPath).catch(() => undefined)

    let cleanupObject = true
    try {
      const result = await withTx(db, async (trx) => {
        let companyId: string | null = null
        if (hasOwnerId) {
          companyId = await resolveOwner(trx, owners, actor, input.ownerType!.trim(), input.ownerId!)
        }
        const contentType = nullableString(input.contentType)
        const inserted = await trx
          .insertInto('sys_file')
          .values({
            storage: endpoint.name,
            key,
            filename,
            content_type: contentType,
            size,
            sha256,
            uploaded_by_id: actor.userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const file = mapFile(inserted)
        await writeAudit(trx, actor, {
          resource: 'sys_file',
          recordId: file.id,
          recordLabel: file.filename,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(fileSnapshot(file), FILE_AUDIT_FIELDS),
        })
        let attachment: Attachment | undefined
        if (hasOwnerId) {
          attachment = await createAttachment(
            trx,
            actor,
            file.id,
            input.ownerType!.trim(),
            input.ownerId!,
            input.category ?? '',
            companyId,
          )
        }
        return { file, attachment }
      })
      cleanupObject = false
      return result
    } finally {
      if (cleanupObject) {
        await store.delete(key).catch(() => undefined)
      }
    }
  }

  async function attach(actor: Actor, fileId: string, input: AttachInput): Promise<Attachment> {
    if (!hasPermission(actor, 'sys.file:read') || !hasPermission(actor, 'sys.file:create')) {
      throw new ApiError('forbidden', '无权限挂接文件')
    }
    if (!input.ownerType.trim() || !input.ownerId.trim()) {
      throw ApiError.validation('缺少附件宿主参数', { owner: ['ownerType 与 ownerId 必填'] })
    }
    return withTx(db, async (trx) => {
      const row = await trx
        .selectFrom('sys_file')
        .select(['uploaded_by_id'])
        .where('id', '=', fileId)
        .forUpdate()
        .executeTakeFirst()
      if (!row) throw new ApiError('not_found', '文件不存在或无权访问')
      if (!actor.superAdmin && row.uploaded_by_id !== actor.userId) {
        throw new ApiError('forbidden', '仅能挂接本人上传的文件')
      }
      const companyId = await resolveOwner(trx, owners, actor, input.ownerType.trim(), input.ownerId)
      return createAttachment(
        trx,
        actor,
        fileId,
        input.ownerType.trim(),
        input.ownerId,
        input.category ?? '',
        companyId,
      )
    })
  }

  async function listAttachments(actor: Actor, query: AttachmentQuery): Promise<AttachmentList> {
    if (!hasPermission(actor, 'sys.file:read')) {
      throw new ApiError('forbidden', '无权限读取附件')
    }
    const limit = query.limit === undefined || query.limit === 0 ? 200 : query.limit
    const offset = query.offset ?? 0
    if (limit < 1 || limit > 200 || offset < 0) {
      throw ApiError.validation('分页参数不合法', { limit: ['必须在 1 到 200 之间'] })
    }

    const conditions: ReturnType<typeof sql>[] = [sql`1=1`]
    if (query.fileId) conditions.push(sql`a.file_id = ${query.fileId}::uuid`)
    if (query.ownerType) conditions.push(sql`a.owner_type = ${query.ownerType}`)
    if (query.ownerId) conditions.push(sql`a.owner_id = ${query.ownerId}::uuid`)
    if (query.category) conditions.push(sql`a.category = ${query.category}`)
    if (!actor.superAdmin && !actor.allCompanies) {
      const ids = actor.companyIds
      conditions.push(sql`(a.company_id IS NULL OR a.company_id = ANY(${ids}::uuid[]))`)
    }
    const where = sql.join(conditions, sql` AND `)

    const countResult = await sql<{ count: string }>`
      SELECT count(*)::text AS count
      FROM sys_attachment a
      JOIN sys_file f ON f.id = a.file_id
      WHERE ${where}
    `.execute(db)
    const count = Number(countResult.rows[0]?.count ?? 0)

    const rows = await sql<{
      id: string
      file_id: string
      owner_type: string
      owner_id: string
      category: string
      company_id: string | null
      inserted_at: Date
      f_id: string
      f_storage: string
      f_key: string
      f_filename: string
      f_content_type: string | null
      f_size: string | null
      f_sha256: string | null
      f_inserted_at: Date
      f_uploaded_by_id: string | null
    }>`
      SELECT
        a.id, a.file_id, a.owner_type, a.owner_id, a.category, a.company_id, a.inserted_at,
        f.id AS f_id, f.storage AS f_storage, f.key AS f_key, f.filename AS f_filename,
        f.content_type AS f_content_type, f.size::text AS f_size, f.sha256 AS f_sha256,
        f.inserted_at AS f_inserted_at, f.uploaded_by_id AS f_uploaded_by_id
      FROM sys_attachment a
      JOIN sys_file f ON f.id = a.file_id
      WHERE ${where}
      ORDER BY a.inserted_at, a.id
      LIMIT ${limit} OFFSET ${offset}
    `.execute(db)

    const results: Attachment[] = rows.rows.map((row) => ({
      id: row.id,
      fileId: row.file_id,
      ownerType: row.owner_type,
      ownerId: row.owner_id,
      category: row.category,
      companyId: row.company_id,
      insertedAt: asDate(row.inserted_at),
      file: {
        id: row.f_id,
        storage: row.f_storage,
        key: row.f_key,
        filename: row.f_filename,
        contentType: row.f_content_type,
        size: row.f_size != null ? Number(row.f_size) : 0,
        sha256: row.f_sha256 ?? '',
        insertedAt: asDate(row.f_inserted_at),
        uploadedById: row.f_uploaded_by_id,
      },
    }))
    return { count, results }
  }

  async function download(actor: Actor, id: string): Promise<DownloadResult> {
    if (!hasPermission(actor, 'sys.file:read')) {
      throw new ApiError('forbidden', '无权限下载文件')
    }
    const file = await loadFile(id)
    const attachments = await db
      .selectFrom('sys_attachment')
      .select(['owner_type', 'company_id'])
      .where('file_id', '=', id)
      .execute()

    let allowed = false
    if (attachments.length === 0) {
      allowed = actor.superAdmin || file.uploadedById === actor.userId
    } else {
      for (const row of attachments) {
        const spec = owners.lookup(row.owner_type)
        if (!spec || !hasPermission(actor, `${spec.permissionPrefix}:read`)) continue
        if (row.company_id === null || canAccessCompany(actor, row.company_id)) {
          allowed = true
          break
        }
      }
    }
    if (!allowed) throw new ApiError('forbidden', '无权下载该文件')

    const store = await objectStorageByName(db, file.storage)
    try {
      const redirectUrl = await store.presignedGet(file.key, 5 * 60 * 1000)
      return {
        filename: file.filename,
        contentType: contentTypeOf(file.contentType),
        redirectUrl,
      }
    } catch (err) {
      if (err !== ERR_PRESIGN_UNSUPPORTED) {
        throw new ApiError('internal', '生成文件下载地址失败', { cause: err })
      }
    }
    try {
      const content = await store.read(file.key)
      return {
        filename: file.filename,
        contentType: contentTypeOf(file.contentType),
        content,
      }
    } catch (err) {
      if (err === ERR_OBJECT_NOT_FOUND) throw new ApiError('not_found', '文件对象缺失')
      throw new ApiError('internal', '读取文件对象失败', { cause: err })
    }
  }

  async function deleteAttachment(actor: Actor, id: string): Promise<void> {
    if (!hasPermission(actor, 'sys.file:delete')) {
      throw new ApiError('forbidden', '无权限删除附件')
    }
    await withTx(db, async (trx) => {
      const row = await trx
        .selectFrom('sys_attachment')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!row) throw new ApiError('not_found', '附件不存在')
      if (row.company_id !== null && !canAccessCompany(actor, row.company_id)) {
        throw new ApiError('forbidden', '无权限删除其他公司的附件')
      }
      await trx.deleteFrom('sys_attachment').where('id', '=', id).execute()
      const value: Attachment = {
        id: row.id,
        fileId: row.file_id,
        ownerType: row.owner_type,
        ownerId: row.owner_id,
        category: row.category,
        companyId: row.company_id,
        insertedAt: asDate(row.inserted_at),
      }
      await writeAudit(trx, actor, {
        resource: 'sys_attachment',
        recordId: id,
        recordLabel: value.ownerType,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(attachmentSnapshot(value), ATTACHMENT_AUDIT_FIELDS),
      })
    })
  }

  async function deleteFile(actor: Actor, id: string): Promise<void> {
    if (!hasPermission(actor, 'sys.file:delete')) {
      throw new ApiError('forbidden', '无权限删除文件')
    }
    const { file, storageName } = await withTx(db, async (trx) => {
      const row = await trx
        .selectFrom('sys_file')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!row) throw new ApiError('not_found', '文件不存在')
      const fileRow = mapFile(row)

      const attachCount = await trx
        .selectFrom('sys_attachment')
        .select(trx.fn.countAll<string>().as('count'))
        .where('file_id', '=', id)
        .executeTakeFirstOrThrow()
      if (Number(attachCount.count) > 0) {
        throw new ApiError('conflict', '该文件仍有业务挂接，请先在业务单据中移除附件')
      }
      const templateCount = await trx
        .selectFrom('sys_print_template')
        .select(trx.fn.countAll<string>().as('count'))
        .where('file_id', '=', id)
        .executeTakeFirstOrThrow()
      if (Number(templateCount.count) > 0) {
        throw new ApiError('conflict', '该文件仍被打印模板引用，请先删除或更换模板')
      }

      await trx.deleteFrom('sys_file').where('id', '=', id).execute()
      await writeAudit(trx, actor, {
        resource: 'sys_file',
        recordId: id,
        recordLabel: fileRow.filename,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(fileSnapshot(fileRow), FILE_AUDIT_FIELDS),
      })
      return { file: fileRow, storageName: fileRow.storage }
    })

    try {
      const store = await objectStorageByName(db, storageName)
      await store.delete(file.key)
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: '提交后清理文件对象失败',
          storage: file.storage,
          key: file.key,
          err: String(err),
        }),
      )
    }
  }

  return {
    get,
    readStoredFile,
    list,
    upload,
    attach,
    listAttachments,
    download,
    deleteAttachment,
    deleteFile,
  }
}

export type FileService = ReturnType<typeof createFileService>

async function createAttachment(
  db: DbHandle,
  actor: Actor,
  fileId: string,
  ownerType: string,
  ownerId: string,
  category: string,
  companyId: string | null,
): Promise<Attachment> {
  let cat = category.trim()
  if (!cat) cat = 'default'
  if ([...cat].length > 32) {
    throw ApiError.validation('附件分类不合法', { category: ['最多 32 个字符'] })
  }
  const row = await db
    .insertInto('sys_attachment')
    .values({
      file_id: fileId,
      owner_type: ownerType,
      owner_id: ownerId,
      category: cat,
      company_id: companyId,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  const value: Attachment = {
    id: row.id,
    fileId: row.file_id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    category: row.category,
    companyId: row.company_id,
    insertedAt: asDate(row.inserted_at),
  }
  await writeAudit(db, actor, {
    resource: 'sys_attachment',
    recordId: value.id,
    recordLabel: value.ownerType,
    actionType: 'create',
    actionName: 'create',
    changes: auditCreated(attachmentSnapshot(value), ATTACHMENT_AUDIT_FIELDS),
  })
  return value
}

interface StorageConfigRow {
  id: string
  name: string
  label: string
  kind: string
  root: string | null
  endpoint: string | null
  region: string | null
  bucket: string | null
  prefix: string | null
  access_key_id: string | null
  secret_access_key: string | null
  builtin: boolean
  is_default: boolean
}

async function defaultStorageConfig(db: DbHandle): Promise<StorageConfigRow & { secret: string }> {
  const row = await db
    .selectFrom('sys_storage')
    .selectAll()
    .where('is_default', '=', true)
    .executeTakeFirst()
  if (!row) throw new ApiError('conflict', '存储接入未初始化：没有默认接入点')
  return { ...row, secret: row.secret_access_key ?? '' }
}

export async function objectStorageByName(db: DbHandle, name: string): Promise<ObjectStorage> {
  const row = await db.selectFrom('sys_storage').selectAll().where('name', '=', name).executeTakeFirst()
  if (!row) throw new ApiError('not_found', '存储接入不存在')
  return toObjectStorage({ ...row, secret: row.secret_access_key ?? '' })
}

function toObjectStorage(row: {
  kind: string
  root: string | null
  endpoint: string | null
  region: string | null
  bucket: string | null
  prefix: string | null
  access_key_id: string | null
  secret: string
}): ObjectStorage {
  const kind = row.kind.toLowerCase()
  switch (kind) {
    case 'local': {
      if (!row.root?.trim()) throw new ApiError('internal', '本地存储缺少根目录配置')
      return createLocalStorage(row.root)
    }
    case 's3':
    case 'oss': {
      if (!row.endpoint || !row.bucket || !row.access_key_id || !row.secret) {
        throw new ApiError('internal', '对象存储配置不完整')
      }
      try {
        return createS3Storage({
          endpoint: row.endpoint,
          region: row.region ?? '',
          bucket: row.bucket,
          prefix: row.prefix ?? '',
          accessKeyId: row.access_key_id,
          secretAccessKey: row.secret,
          kind,
        })
      } catch (err) {
        throw new ApiError('internal', '对象存储配置不合法', { cause: err })
      }
    }
    default:
      throw new ApiError('internal', '未知的存储类型')
  }
}

function mapFile(row: {
  id: string
  storage: string
  key: string
  filename: string
  content_type: string | null
  size: string | number | bigint | null
  sha256: string | null
  inserted_at: Date | string
  uploaded_by_id: string | null
}): StoredFile {
  return {
    id: row.id,
    storage: row.storage,
    key: row.key,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size != null ? Number(row.size) : 0,
    sha256: row.sha256 ?? '',
    insertedAt: asDate(row.inserted_at),
    uploadedById: row.uploaded_by_id,
  }
}

function fileSnapshot(value: StoredFile): Record<string, unknown> {
  return {
    storage: value.storage,
    key: value.key,
    filename: value.filename,
    content_type: value.contentType,
    size: value.size,
    sha256: value.sha256,
    uploaded_by_id: value.uploadedById,
  }
}

function attachmentSnapshot(value: Attachment): Record<string, unknown> {
  return {
    file_id: value.fileId,
    owner_type: value.ownerType,
    owner_id: value.ownerId,
    category: value.category,
    company_id: value.companyId,
  }
}

function nullableString(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function contentTypeOf(value: string | null): string {
  return value && value.trim() !== '' ? value : 'application/octet-stream'
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function utcDatePath(): string {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return `${y}/${m}/${d}`
}
