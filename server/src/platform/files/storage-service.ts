/**
 * 存储接入点（sys_storage）——CRUD 标准派生（platform/standard）+ setDefault 手写弹射。
 *
 * CRUD（get/list/create/update/delete）由内核承接：授权锁行、审计三型（白名单自
 * meta.audit 派生，secret_access_key 经 audit.exclude 永不进快照）、无差异早退、
 * 约束冲突文案（mapWriteError）。领域不变量走钩子：
 * - validate：接入名正则/显示名长度/按存储类型的条件必填/可空字段 trim 归空/
 *   密钥「空白=不改动，LOCAL 一律清空」（纯函数，语义逐字来自历史 validateStorageInput）
 * - beforeDelete：内置/默认/仍有文件的删除保护（跨表计数查库）
 *
 * setDefault 是跨行串行化流程（advisory lock + 旧默认逐行 unset 审计），按动作
 * 弹射留手写——与派生动作对路由不可区分。
 *
 * 密钥纪律：secretAccessKey 只写不回读。内核 item 携带密钥列（写路径保差异判定
 * 需要），出服务边界一律经 toEndpoint 剥除，只发 secretConfigured。
 */
import { sql, type Kysely } from 'kysely'
import { loadAuthorized } from '~/db/load.ts'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { auditDiff, writeAudit } from '../audit/write.ts'
import { auditSpecOf } from '../audit/spec.ts'
import type { Permit } from '../authz/core/index.ts'
import { ApiError } from '../http/errors.ts'
import type { Registry } from '../meta/registry.ts'
import { createStandardService, type StandardHookContext } from '../standard/service.ts'
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
const STORAGE_AUDIT_SPEC = auditSpecOf(storageResourceMeta())
const STORAGE_AUDIT_FIELDS = STORAGE_AUDIT_SPEC.fields

const WRITE_CONFLICTS = [
  { code: '23505', constraint: 'sys_storage_single_default_index', message: '全局默认存储只能有一个' },
  { code: '23505', message: '接入名已存在' },
] as const

export interface StorageServiceDeps {
  db: Kysely<Database>
  registry: Registry
}

export function createStorageService(deps: StorageServiceDeps) {
  const { db, registry } = deps
  const target = registry.authzTarget(STORAGE_RESOURCE_NAME)
  const standard = createStandardService({
    db,
    registry,
    resource: STORAGE_RESOURCE_NAME,
    // 审计 record_label 取显示名（历史口径），非内核缺省的 name 字段
    recordLabel: (item) => (item.label === null || item.label === undefined ? null : String(item.label)),
    defaultOrder: sql`"is_default" DESC, "label" ASC, "id" ASC`,
    writeErrors: WRITE_CONFLICTS,
    hooks: {
      validate: validateStorageDraft,
      beforeDelete: assertStorageRemovable,
    },
  })

  /** 密钥只写不回读：剥掉 secretAccessKey，只发 secretConfigured */
  function toEndpoint(item: Record<string, unknown>): StorageEndpoint {
    const { secretAccessKey, ...rest } = item
    return {
      ...rest,
      secretConfigured: typeof secretAccessKey === 'string' && secretAccessKey.trim() !== '',
    } as unknown as StorageEndpoint
  }

  async function get(permit: Permit, id: string): Promise<StorageEndpoint> {
    return toEndpoint(await standard.get(permit, id))
  }

  async function list(permit: Permit, query: FileListQuery): Promise<StorageList> {
    const result = await standard.list(permit, query)
    return { count: result.count, results: result.results.map(toEndpoint) }
  }

  async function create(permit: Permit, input: StorageCreateInput): Promise<StorageEndpoint> {
    return toEndpoint(await standard.create(permit, { ...input }))
  }

  async function update(permit: Permit, id: string, patch: StorageUpdateInput): Promise<StorageEndpoint> {
    return toEndpoint(await standard.update(permit, id, { ...patch }))
  }

  async function remove(permit: Permit, id: string): Promise<void> {
    try {
      await standard.remove(permit, id)
    } catch (err) {
      // 历史 remove 的写错误一律经 storageWriteError：内部错误文案对齐「保存存储接入失败」
      if (err instanceof ApiError && err.code === 'internal') {
        throw new ApiError('internal', '保存存储接入失败', { cause: err.cause ?? err })
      }
      throw err
    }
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
      table: 'sys_storage',
      id,
      forUpdate: true,
      notFoundMessage: '存储接入不存在',
    })
    return row as unknown as StorageRow
  }

  return {
    get,
    list,
    create,
    update,
    setDefault,
    delete: remove,
    /** 标准动作合同套件接入点（同 mfg/payroll 先例） */
    _standardForContract: () => standard,
  }
}

export type StorageService = ReturnType<typeof createStorageService>

/**
 * 领域不变量（纯函数，不碰库；可原地规范化 draft）。语义逐字来自历史
 * validateStorageInput：create 校验全量入参；update 校验 before+patch 合并后
 * 全量（name/kind 为 createOnly，合并后取库内现值）。
 */
function validateStorageDraft({ action, draft, before }: StandardHookContext): void {
  if (typeof draft.name === 'string') draft.name = draft.name.trim()
  if (typeof draft.label === 'string') draft.label = draft.label.trim()
  if (typeof draft.kind === 'string') draft.kind = draft.kind.trim().toUpperCase()
  const name = String(draft.name ?? '')
  const label = String(draft.label ?? '')
  const kind = String(draft.kind ?? '')
  const fields: Record<string, string[]> = {}

  if (!STORAGE_NAME_RE.test(name) || name.length > 32) {
    fields.name = ['接入名只能用小写字母、数字、中划线、下划线，且以字母或数字开头，最多 32 个字符']
  }
  if (!label || [...label].length > 64) {
    fields.label = ['显示名必填且最多 64 个字符']
  }

  for (const key of ['root', 'endpoint', 'region', 'bucket', 'prefix', 'accessKeyId'] as const) {
    if (key in draft) draft[key] = trimNullable(draft[key] as string | null | undefined)
  }

  switch (kind) {
    case 'LOCAL':
      // LOCAL 不持密钥（历史口径：建/改一律清空）
      draft.secretAccessKey = null
      if (!draft.root) fields.root = ['该存储类型下「根目录」必填']
      break
    case 'S3':
    case 'OSS': {
      if (!draft.endpoint) fields.endpoint = ['该存储类型下「服务地址」必填']
      if (!draft.bucket) fields.bucket = ['该存储类型下「Bucket」必填']
      if (!draft.accessKeyId) fields.accessKeyId = ['该存储类型下「Access Key ID」必填']
      if (action === 'create') {
        const trimmed = draft.secretAccessKey == null ? '' : String(draft.secretAccessKey).trim()
        if (!trimmed) {
          fields.secretAccessKey = ['该存储类型下「Secret Access Key」必填']
        } else {
          draft.secretAccessKey = trimmed
        }
      } else {
        // 空白密钥 = 不改动（保留库内现值）；非空 trim 后覆盖
        const beforeSecret = (before?.secretAccessKey as string | null | undefined) ?? null
        if (draft.secretAccessKey !== beforeSecret) {
          const trimmed = draft.secretAccessKey == null ? '' : String(draft.secretAccessKey).trim()
          draft.secretAccessKey = trimmed === '' ? beforeSecret : trimmed
        }
        if (!draft.secretAccessKey) {
          fields.secretAccessKey = ['该存储类型下「Secret Access Key」必填']
        }
      }
      break
    }
    default:
      fields.kind = ['仅支持 LOCAL、S3、OSS']
  }

  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('存储接入参数不合法', fields)
  }
}

/** 删除保护（内置/默认/仍有文件），逐字来自历史 remove */
async function assertStorageRemovable(
  trx: DbHandle,
  { item }: { permit: Permit; item: Record<string, unknown> },
): Promise<void> {
  if (item.builtin) throw new ApiError('conflict', '内置存储接入不可删除')
  if (item.isDefault) {
    throw new ApiError('conflict', '默认存储接入不可删除，请先将其他接入点设为默认')
  }
  const count = await trx
    .selectFrom('sys_file')
    .select(trx.fn.countAll<string>().as('count'))
    .where('storage', '=', String(item.name))
    .executeTakeFirstOrThrow()
  if (Number(count.count) > 0) {
    throw new ApiError('conflict', '仍有文件存于该接入点，不可删除')
  }
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
