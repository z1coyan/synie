import type { ListQuery } from '@synie/shared'
import { sql, type Expression, type Kysely, type SqlBool } from 'kysely'
import { buildListQuery } from '~/db/filterbuild.ts'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { auditCreated, auditDestroyed, auditDiff, writeAudit } from '../audit/write.ts'
import type { Actor } from '../authz/actor.ts'
import { ApiError } from '../http/errors.ts'
import { storageResourceMeta } from './meta.ts'
import type {
  FileListQuery,
  StorageCreateInput,
  StorageEndpoint,
  StorageKind,
  StorageList,
  StorageUpdateInput,
} from './types.ts'

const STORAGE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
const STORAGE_AUDIT_FIELDS = [
  'name',
  'label',
  'kind',
  'root',
  'endpoint',
  'region',
  'bucket',
  'prefix',
  'access_key_id',
  'builtin',
  'is_default',
] as const

export interface StorageServiceDeps {
  db: Kysely<Database>
}

export function createStorageService(deps: StorageServiceDeps) {
  const { db } = deps

  async function get(id: string): Promise<StorageEndpoint> {
    const row = await db.selectFrom('sys_storage').selectAll().where('id', '=', id).executeTakeFirst()
    if (!row) throw new ApiError('not_found', '存储接入不存在')
    return mapStorage(row)
  }

  async function list(query: FileListQuery): Promise<StorageList> {
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
    const built = buildListQuery(storageResourceMeta(), listQuery)

    let countQ = db.selectFrom('sys_storage').select(db.fn.countAll<string>().as('count'))
    if (built.where) countQ = countQ.where(built.where as Expression<SqlBool>)
    const count = Number((await countQ.executeTakeFirstOrThrow()).count)

    let rowsQ = db.selectFrom('sys_storage').selectAll()
    if (built.where) rowsQ = rowsQ.where(built.where as Expression<SqlBool>)
    if (built.orderBy) {
      rowsQ = rowsQ.orderBy(built.orderBy as never).orderBy('id')
    } else {
      rowsQ = rowsQ.orderBy('is_default', 'desc').orderBy('label').orderBy('id')
    }
    const rows = await rowsQ.limit(limit).offset(offset).execute()

    return { count, results: rows.map(mapStorage) }
  }

  async function create(actor: Actor, input: StorageCreateInput): Promise<StorageEndpoint> {
    const normalized = validateStorageInput(input, '')
    return withTx(db, async (trx) => {
      let id: string
      try {
        const inserted = await trx
          .insertInto('sys_storage')
          .values({
            name: normalized.name,
            label: normalized.label,
            kind: normalized.kind.toLowerCase(),
            root: normalized.root,
            endpoint: normalized.endpoint,
            region: normalized.region,
            bucket: normalized.bucket,
            prefix: normalized.prefix,
            access_key_id: normalized.accessKeyId,
            secret_access_key: normalized.secretAccessKey,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        id = inserted.id
      } catch (err) {
        throw storageWriteError(err)
      }
      const value = await getStorageTx(trx, id)
      await writeAudit(trx, actor, {
        resource: 'sys_storage',
        recordId: id,
        recordLabel: value.label,
        actionType: 'create',
        actionName: 'create',
        changes: auditCreated(storageSnapshot(value), STORAGE_AUDIT_FIELDS),
        sensitiveFields: ['secret_access_key'],
      })
      return value
    })
  }

  async function update(actor: Actor, id: string, input: StorageUpdateInput): Promise<StorageEndpoint> {
    return withTx(db, async (trx) => {
      const before = await lockStorage(trx, id)
      const merged: StorageCreateInput = {
        name: before.name,
        label: before.label,
        kind: before.kind,
        root: before.root,
        endpoint: before.endpoint,
        region: before.region,
        bucket: before.bucket,
        prefix: before.prefix,
        accessKeyId: before.accessKeyId,
      }
      if (input.present.label && input.label !== undefined) merged.label = input.label
      if (input.present.root) merged.root = input.root ?? null
      if (input.present.endpoint) merged.endpoint = input.endpoint ?? null
      if (input.present.region) merged.region = input.region ?? null
      if (input.present.bucket) merged.bucket = input.bucket ?? null
      if (input.present.prefix) merged.prefix = input.prefix ?? null
      if (input.present.accessKeyId) merged.accessKeyId = input.accessKeyId ?? null

      let secret = before.secret
      if (input.present.secretAccessKey && input.secretAccessKey !== undefined) {
        const trimmed = input.secretAccessKey.trim()
        if (trimmed !== '') secret = trimmed
      }
      merged.secretAccessKey = secret

      const normalized = validateStorageInput(merged, before.secret)
      try {
        await trx
          .updateTable('sys_storage')
          .set({
            label: normalized.label,
            root: normalized.root,
            endpoint: normalized.endpoint,
            region: normalized.region,
            bucket: normalized.bucket,
            prefix: normalized.prefix,
            access_key_id: normalized.accessKeyId,
            secret_access_key: normalized.secretAccessKey,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .execute()
      } catch (err) {
        throw storageWriteError(err)
      }
      const after = await getStorageTx(trx, id)
      const changes = auditDiff(storageSnapshot(before.endpointView), storageSnapshot(after), STORAGE_AUDIT_FIELDS)
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, actor, {
          resource: 'sys_storage',
          recordId: id,
          recordLabel: after.label,
          actionType: 'update',
          actionName: 'update',
          changes,
          sensitiveFields: ['secret_access_key'],
        })
      }
      return after
    })
  }

  async function setDefault(actor: Actor, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('sys_storage_default'))`.execute(trx)
      const target = await getStorageTx(trx, id)
      const previous = await trx
        .selectFrom('sys_storage')
        .selectAll()
        .where('is_default', '=', true)
        .where('id', '<>', id)
        .forUpdate()
        .execute()

      try {
        await trx
          .updateTable('sys_storage')
          .set({ is_default: false, updated_at: sql`(now() AT TIME ZONE 'utc')` })
          .where('is_default', '=', true)
          .where('id', '<>', id)
          .execute()
        await trx
          .updateTable('sys_storage')
          .set({ is_default: true, updated_at: sql`(now() AT TIME ZONE 'utc')` })
          .where('id', '=', id)
          .execute()
      } catch (err) {
        throw storageWriteError(err)
      }

      for (const row of previous) {
        const value = mapStorage(row)
        const after = { ...value, isDefault: false }
        await writeAudit(trx, actor, {
          resource: 'sys_storage',
          recordId: value.id,
          recordLabel: value.label,
          actionType: 'update',
          actionName: 'unset_default',
          changes: auditDiff(storageSnapshot(value), storageSnapshot(after), STORAGE_AUDIT_FIELDS),
        })
      }
      if (!target.isDefault) {
        const after = { ...target, isDefault: true }
        await writeAudit(trx, actor, {
          resource: 'sys_storage',
          recordId: id,
          recordLabel: target.label,
          actionType: 'update',
          actionName: 'set_default',
          changes: auditDiff(storageSnapshot(target), storageSnapshot(after), STORAGE_AUDIT_FIELDS),
        })
      }
    })
  }

  async function remove(actor: Actor, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const value = await getStorageTx(trx, id)
      if (value.builtin) throw new ApiError('conflict', '内置存储接入不可删除')
      if (value.isDefault) {
        throw new ApiError('conflict', '默认存储接入不可删除，请先将其他接入点设为默认')
      }
      const count = await trx
        .selectFrom('sys_file')
        .select(trx.fn.countAll<string>().as('count'))
        .where('storage', '=', value.name)
        .executeTakeFirstOrThrow()
      if (Number(count.count) > 0) {
        throw new ApiError('conflict', '仍有文件存于该接入点，不可删除')
      }
      try {
        await trx.deleteFrom('sys_storage').where('id', '=', id).execute()
      } catch (err) {
        throw storageWriteError(err)
      }
      await writeAudit(trx, actor, {
        resource: 'sys_storage',
        recordId: id,
        recordLabel: value.label,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(storageSnapshot(value), STORAGE_AUDIT_FIELDS),
      })
    })
  }

  return { get, list, create, update, setDefault, delete: remove }
}

export type StorageService = ReturnType<typeof createStorageService>

function validateStorageInput(
  input: StorageCreateInput,
  oldSecret: string,
): {
  name: string
  label: string
  kind: string
  root: string | null
  endpoint: string | null
  region: string | null
  bucket: string | null
  prefix: string | null
  accessKeyId: string | null
  secretAccessKey: string | null
} {
  const name = input.name.trim()
  const label = input.label.trim()
  const kind = input.kind.trim().toUpperCase()
  const root = trimNullable(input.root)
  const endpoint = trimNullable(input.endpoint)
  const region = trimNullable(input.region)
  const bucket = trimNullable(input.bucket)
  const prefix = trimNullable(input.prefix)
  const accessKeyId = trimNullable(input.accessKeyId)
  const fields: Record<string, string[]> = {}

  if (!STORAGE_NAME_RE.test(name) || name.length > 32) {
    fields.name = ['接入名只能用小写字母、数字、中划线、下划线，且以字母或数字开头，最多 32 个字符']
  }
  if (!label || [...label].length > 64) {
    fields.label = ['显示名必填且最多 64 个字符']
  }

  let secretAccessKey: string | null = null
  switch (kind) {
    case 'LOCAL':
      if (!root) fields.root = ['该存储类型下「根目录」必填']
      break
    case 'S3':
    case 'OSS': {
      if (!endpoint) fields.endpoint = ['该存储类型下「服务地址」必填']
      if (!bucket) fields.bucket = ['该存储类型下「Bucket」必填']
      if (!accessKeyId) fields.accessKeyId = ['该存储类型下「Access Key ID」必填']
      let secret = oldSecret
      if (input.secretAccessKey !== undefined && input.secretAccessKey !== null) {
        const trimmed = input.secretAccessKey.trim()
        if (trimmed !== '') secret = trimmed
      }
      if (!secret) {
        fields.secretAccessKey = ['该存储类型下「Secret Access Key」必填']
      } else {
        secretAccessKey = secret
      }
      break
    }
    default:
      fields.kind = ['仅支持 LOCAL、S3、OSS']
  }

  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('存储接入参数不合法', fields)
  }

  return {
    name,
    label,
    kind,
    root,
    endpoint,
    region,
    bucket,
    prefix,
    accessKeyId,
    secretAccessKey,
  }
}

async function lockStorage(
  db: DbHandle,
  id: string,
): Promise<{ endpointView: StorageEndpoint; secret: string; name: string; label: string; kind: string; root: string | null; endpoint: string | null; region: string | null; bucket: string | null; prefix: string | null; accessKeyId: string | null }> {
  const row = await db
    .selectFrom('sys_storage')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw new ApiError('not_found', '存储接入不存在')
  const endpointView = mapStorage(row)
  return {
    endpointView,
    secret: row.secret_access_key ?? '',
    name: row.name,
    label: row.label,
    kind: row.kind.toUpperCase(),
    root: row.root,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    prefix: row.prefix,
    accessKeyId: row.access_key_id,
  }
}

async function getStorageTx(db: DbHandle, id: string): Promise<StorageEndpoint> {
  const row = await db.selectFrom('sys_storage').selectAll().where('id', '=', id).executeTakeFirst()
  if (!row) throw new ApiError('not_found', '存储接入不存在')
  return mapStorage(row)
}

function mapStorage(row: {
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
  inserted_at: Date | string
  updated_at: Date | string
}): StorageEndpoint {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    kind: row.kind.toUpperCase() as StorageKind,
    root: row.root,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    prefix: row.prefix,
    accessKeyId: row.access_key_id,
    secretConfigured: !!(row.secret_access_key && row.secret_access_key.trim() !== ''),
    builtin: row.builtin,
    isDefault: row.is_default,
    insertedAt: row.inserted_at instanceof Date ? row.inserted_at : new Date(row.inserted_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  }
}

function storageSnapshot(value: StorageEndpoint): Record<string, unknown> {
  return {
    name: value.name,
    label: value.label,
    kind: value.kind.toLowerCase(),
    root: value.root,
    endpoint: value.endpoint,
    region: value.region,
    bucket: value.bucket,
    prefix: value.prefix,
    access_key_id: value.accessKeyId,
    builtin: value.builtin,
    is_default: value.isDefault,
  }
}

function trimNullable(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function storageWriteError(err: unknown): ApiError {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: string; constraint_name?: string; constraint?: string }).code
    const constraint =
      (err as { constraint_name?: string }).constraint_name ??
      (err as { constraint?: string }).constraint
    if (code === '23505') {
      if (constraint === 'sys_storage_single_default_index') {
        return new ApiError('conflict', '全局默认存储只能有一个', { cause: err })
      }
      return new ApiError('conflict', '接入名已存在', { cause: err })
    }
  }
  return new ApiError('internal', '保存存储接入失败', { cause: err })
}
