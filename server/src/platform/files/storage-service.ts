import { sql, type Kysely } from 'kysely'
import { listAuthorized } from '~/db/list.ts'
import { loadAuthorized } from '~/db/load.ts'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { auditCreated, auditDestroyed, auditDiff, writeAudit } from '../audit/write.ts'
import { auditSpecOf } from '../audit/spec.ts'
import type { Permit } from '../authz/core/index.ts'
import type { AuthzEnforcer } from '../authz/enforce.ts'
import { ApiError } from '../http/errors.ts'
import { STORAGE_RESOURCE_NAME, storageResourceMeta } from './meta.ts'
import type {
  FileListQuery,
  StorageCreateInput,
  StorageEndpoint,
  StorageKind,
  StorageList,
  StorageUpdateInput,
} from './types.ts'

const STORAGE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
const STORAGE_META = storageResourceMeta()
const STORAGE_AUDIT_SPEC = auditSpecOf(STORAGE_META)
const STORAGE_AUDIT_FIELDS = STORAGE_AUDIT_SPEC.fields

export interface StorageServiceDeps {
  db: Kysely<Database>
  authz: Pick<AuthzEnforcer, 'targetOf'>
}

export function createStorageService(deps: StorageServiceDeps) {
  const { db } = deps
  const target = deps.authz.targetOf(STORAGE_RESOURCE_NAME)

  async function get(permit: Permit, id: string): Promise<StorageEndpoint> {
    return mapStorage(
      (await loadAuthorized({
        db,
        permit,
        target,
        table: STORAGE_META.table,
        id,
        notFoundMessage: '存储接入不存在',
      })) as unknown as StorageRow,
    )
  }

  async function list(permit: Permit, query: FileListQuery): Promise<StorageList> {
    return listAuthorized<StorageEndpoint>({
      db,
      permit,
      target,
      alias: STORAGE_META.table,
      resource: STORAGE_META,
      source: sql`FROM sys_storage`,
      select: sql`SELECT sys_storage.*`,
      defaultOrder: sql`"is_default" DESC, "label" ASC, "id" ASC`,
      query,
      mapRow: (row) => mapStorage(row as unknown as StorageRow),
    })
  }

  async function create(permit: Permit, input: StorageCreateInput): Promise<StorageEndpoint> {
    const actor = permit.actor
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
        sensitiveFields: STORAGE_AUDIT_SPEC.sensitiveFields,
      })
      return value
    })
  }

  async function update(permit: Permit, id: string, input: StorageUpdateInput): Promise<StorageEndpoint> {
    const actor = permit.actor
    return withTx(db, async (trx) => {
      const before = storageDetail(await lockStorageRow(trx, permit, id))
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
          sensitiveFields: STORAGE_AUDIT_SPEC.sensitiveFields,
        })
      }
      return after
    })
  }

  async function setDefault(permit: Permit, id: string): Promise<void> {
    const actor = permit.actor
    await withTx(db, async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('sys_storage_default'))`.execute(trx)
      const current = mapStorage(await lockStorageRow(trx, permit, id))
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
      if (!current.isDefault) {
        const after = { ...current, isDefault: true }
        await writeAudit(trx, actor, {
          resource: 'sys_storage',
          recordId: id,
          recordLabel: current.label,
          actionType: 'update',
          actionName: 'set_default',
          changes: auditDiff(storageSnapshot(current), storageSnapshot(after), STORAGE_AUDIT_FIELDS),
        })
      }
    })
  }

  async function remove(permit: Permit, id: string): Promise<void> {
    const actor = permit.actor
    await withTx(db, async (trx) => {
      const value = mapStorage(await lockStorageRow(trx, permit, id))
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

  /** 授权闸 + 行锁；不命中一律 not_found（不区分不存在与不可达） */
  async function lockStorageRow(
    handle: DbHandle,
    permit: Permit,
    id: string,
  ): Promise<StorageRow> {
    const row = await loadAuthorized({
      db: handle,
      permit,
      target,
      table: STORAGE_META.table,
      id,
      forUpdate: true,
      notFoundMessage: '存储接入不存在',
    })
    return row as unknown as StorageRow
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

/** 更新用的可写视图（含密钥原值，不进 wire） */
function storageDetail(row: StorageRow): {
  endpointView: StorageEndpoint
  secret: string
  name: string
  label: string
  kind: string
  root: string | null
  endpoint: string | null
  region: string | null
  bucket: string | null
  prefix: string | null
  accessKeyId: string | null
} {
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

interface StorageRow {
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
}

function mapStorage(row: StorageRow): StorageEndpoint {
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
