/**
 * 标准动作内核·子行服务：单据行等 via 资源的 CRUD 派生。
 *
 * 与标准服务的差异：
 * - 授权：via 目标，行级可达性递归到母单谓词；写侧以「锁母单（授权）→ 状态门」
 *   取代 assertCompanyWritable，行不存在与母单不可达同为 not_found
 * - 加锁顺序：母单先锁（授权 + 状态门），再锁行——与既有手写并发路径一致
 * - 带入列（company_id 等）：inheritFields 声明，wire 不可写，创建时从母单带入
 * - 无批量/工作流/树形/编号（单据行不需要；需要即弹射回手写）
 *
 * 投影（projection）与标准服务同口径：列表/单条/**写后返回值**共用一份 join 投影，
 * 审计 record_label 亦取投影后的记录（子行的名称在引用上，可用 recordLabel 覆盖）。
 *
 * 钩子纪律同标准服务；行内充实（物料快照投影等）放 beforeWrite。
 *
 * 在途事务变体 createInTx / updateInTx / removeInTx（D1）：与 root 同形态，
 * 供聚合层在外层事务内编排多资源写路径；公开 create/update/remove 仍自开事务。
 */
import type { ListQuery } from '@synie/shared'
import { sql, type RawBuilder } from 'kysely'
import type { Kysely } from 'kysely'
import { mapWriteError, type PgWriteMapping } from '~/db/dberr.ts'
import { listAuthorized } from '~/db/list.ts'
import { loadAuthorized, loadAuthorizedFrom } from '~/db/load.ts'
import { withTx, type DbHandle, type TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import { auditCreated, auditDestroyed, auditDiff, writeAudit } from '~/platform/audit/write.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { FieldMeta, ResourceMeta } from '~/platform/meta/types.ts'
import { fromDbValue, mapRow, physicalFields, snapshot, toDbValue, writableFields } from './fields.ts'
import type { StandardItem, StandardProjection } from './service.ts'

export interface ChildHookContext {
  action: 'create' | 'update'
  permit: Permit
  /** wire 形全记录（update 为 before+patch 合并后）；钩子可原地充实（物料快照等） */
  draft: Record<string, unknown>
  /** 母单 wire 形（已锁、已过状态门） */
  parent: Record<string, unknown>
  before?: Record<string, unknown>
}

export interface ChildHooks {
  validate?: (ctx: ChildHookContext) => void
  beforeWrite?: (trx: TrxHandle, ctx: ChildHookContext) => Promise<void> | void
  afterWrite?: (
    trx: TrxHandle,
    ctx: { action: 'create' | 'update'; permit: Permit; item: Record<string, unknown>; parent: Record<string, unknown>; before?: Record<string, unknown> },
  ) => Promise<void> | void
  beforeDelete?: (
    trx: TrxHandle,
    ctx: { permit: Permit; item: Record<string, unknown>; parent: Record<string, unknown> },
  ) => Promise<void> | void
}

export interface StandardChildParent {
  /** 母单 Registry 资源名 */
  resource: string
  /** 子行上指向母单的外键字段 apiName（meta 声明 createOnly） */
  fkField: string
  /** 母单状态门（母单已锁）：非可编辑状态抛 conflict */
  gate?: (parent: Record<string, unknown>) => void
  /** 从母单带入的子行字段（apiName 同名映射）：wire 不可写，创建时自动填充 */
  inheritFields?: readonly string[]
  /** 母单 not_found 文案；缺省 `${母单label}不存在` */
  notFound?: string
}

export interface StandardChildServiceOptions {
  db: Kysely<Database>
  registry: Registry
  resource: string
  parent: StandardChildParent
  notFound?: string
  defaultOrder?: RawBuilder<unknown>
  writeErrors?: readonly PgWriteMapping[]
  hooks?: ChildHooks
  projection?: StandardProjection
  /**
   * 服务端派生列（apiName，meta 声明 readonly）：钩子在 beforeWrite 里充实 draft
   * （物料快照 material_code/base_qty 等），这些列随 INSERT/UPDATE 一并落库。
   * wire 不可写（readonly 已保证），审计 diff 覆盖（物理列天然进白名单）。
   */
  derivedFields?: readonly string[]
  /**
   * 审计 record_label 覆盖：子行常无自己的名称列（label 在 join 出来的引用上），
   * meta 派生取不到时由模块给出（item 为投影后的 wire 形）。
   */
  recordLabel?: (item: Record<string, unknown>) => string | null
}

export interface StandardChildService<TItem extends StandardItem = StandardItem> {
  get(permit: Permit, id: string): Promise<TItem>
  list(permit: Permit, query: Partial<ListQuery>): Promise<{ count: number; results: TItem[] }>
  create(permit: Permit, input: Record<string, unknown>): Promise<TItem>
  /**
   * 在途事务变体（D1）：外层事务由调用方持有；Permit 仍是唯一入场券。
   * 签名对齐 root `*InTx(trx, permit, …)`——trx 在前，不采用可选 trx 重载。
   */
  createInTx(trx: TrxHandle, permit: Permit, input: Record<string, unknown>): Promise<TItem>
  update(permit: Permit, id: string, patch: Record<string, unknown>): Promise<TItem>
  updateInTx(trx: TrxHandle, permit: Permit, id: string, patch: Record<string, unknown>): Promise<TItem>
  remove(permit: Permit, id: string): Promise<void>
  removeInTx(trx: TrxHandle, permit: Permit, id: string): Promise<void>
  readonly meta: ResourceMeta
  /** 派生 wire schema 时排除的列（带入列 + 平台管理列同语义） */
  readonly stampedColumns: ReadonlySet<string>
}

function normalizeWire(field: FieldMeta, value: unknown): unknown {
  return fromDbValue(field, toDbValue(field, value))
}

export function createStandardChildService<TItem extends StandardItem = StandardItem>(
  options: StandardChildServiceOptions,
): StandardChildService<TItem> {
  const { db, registry, resource, parent, hooks = {}, projection } = options
  const foundMeta = registry.get(resource)
  if (!foundMeta) throw new Error(`标准子行派生：未知 Meta 资源 ${resource}`)
  const meta: ResourceMeta = foundMeta
  if (!meta.audit?.enabled) {
    throw new Error(`标准子行派生：资源 ${resource} 未启用审计——标准动作以审计为合同，不可豁免`)
  }
  const foundParentMeta = registry.get(parent.resource)
  if (!foundParentMeta) throw new Error(`标准子行派生：未知母单资源 ${parent.resource}`)
  const parentMeta: ResourceMeta = foundParentMeta
  const target = registry.authzTarget(resource)
  const parentTarget = registry.authzTarget(parent.resource)

  const TABLE = meta.table
  const AUDIT = auditFieldsOf(meta)
  const label = meta.label ?? meta.permissionLabel
  const parentLabel = parentMeta.label ?? parentMeta.permissionLabel
  const notFound = options.notFound ?? `${label}不存在`
  const parentNotFound = parent.notFound ?? `${parentLabel}不存在`
  const writeErrors = options.writeErrors ?? []

  const byName = (n: string) => meta.fields.find((f) => f.name === n || f.apiName === n)
  const fkField = byName(parent.fkField)
  if (!fkField) throw new Error(`标准子行派生：资源 ${resource} 外键字段 ${parent.fkField} 不存在`)
  const inheritFields = (parent.inheritFields ?? []).map((n) => {
    const f = byName(n)
    if (!f) throw new Error(`标准子行派生：资源 ${resource} 带入字段 ${n} 不存在`)
    return f
  })
  const derivedFields = (options.derivedFields ?? []).map((n) => {
    const f = byName(n)
    if (!f) throw new Error(`标准子行派生：资源 ${resource} 派生字段 ${n} 不存在`)
    if (!f.readonly) throw new Error(`标准子行派生：资源 ${resource} 派生字段 ${n} 必须声明 readonly（wire 不可写）`)
    return f
  })
  const stampedColumns = new Set(inheritFields.map((f) => f.dbColumn))
  const writable = writableFields(meta, stampedColumns)
  const writableByApi = new Map(writable.map((f) => [f.apiName, f]))
  /** 无差异判定的列面：可写列 + 派生列。审计白名单只管审计记录（可写列被 exclude 不得丢写） */
  const WRITE_COLS = [...writable, ...derivedFields].map((f) => f.dbColumn)

  const labelField = meta.lookup?.labelField
    ? byName(meta.lookup.labelField)
    : (byName('name') ?? byName('label') ?? byName('code') ?? meta.fields.find((f) => f.type === 'string' && !f.calculated))

  const companyField = physicalFields(meta).find((f) => f.dbColumn === 'company_id')

  const selectCols = sql.join(physicalFields(meta).map((f) => sql.id(f.dbColumn)))
  const SELECT = projection?.selectExtra ? sql`SELECT ${selectCols}, ${projection.selectExtra}` : sql`SELECT ${selectCols}`
  const SOURCE = projection?.source ?? sql` FROM ${sql.id(TABLE)}`
  const ALIAS = projection?.alias ?? TABLE
  const defaultOrder = options.defaultOrder ?? sql`"idx" ASC, "id" ASC`

  function mapRowFull(row: Record<string, unknown>): TItem {
    const base = mapRow(meta, row)
    if (projection?.mapExtra) Object.assign(base, projection.mapExtra(row))
    return base as TItem
  }

  function recordLabel(item: Record<string, unknown>): string | null {
    if (options.recordLabel) return options.recordLabel(item)
    if (!labelField) return null
    const value = item[labelField.apiName]
    return value === null || value === undefined ? null : String(value)
  }

  function auditCompanyId(item: Record<string, unknown>): string | null {
    if (!companyField) return null
    const value = item[companyField.apiName]
    return value === null || value === undefined ? null : String(value)
  }

  function normalizeInput(input: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
      const field = writableByApi.get(key)
      if (!field || value === undefined) continue
      out[key] = value === null ? null : normalizeWire(field, value)
    }
    return out
  }

  /** 锁母单（授权 + 状态门）：行编辑与并发路径的公共前置 */
  async function lockParent(trx: TrxHandle, permit: Permit, parentId: string): Promise<Record<string, unknown>> {
    const row = await loadAuthorized({
      db: trx,
      permit,
      target: parentTarget,
      table: parentMeta.table,
      id: parentId,
      forUpdate: true,
      notFoundMessage: parentNotFound,
    })
    const wire = mapRow(parentMeta, row as Record<string, unknown>)
    parent.gate?.(wire)
    return wire
  }

  /** 行的母单：行不存在与母单不可达同为 not_found（先母单锁，再锁行） */
  async function parentOf(trx: TrxHandle, permit: Permit, itemId: string): Promise<Record<string, unknown>> {
    const result = await sql<Record<string, unknown>>`
      SELECT ${sql.id(fkField!.dbColumn)} AS fk FROM ${sql.id(TABLE)} WHERE id = ${itemId}::uuid
    `.execute(trx)
    if (result.rows.length === 0) throw new ApiError('not_found', notFound)
    return lockParent(trx, permit, String(result.rows[0]!.fk))
  }

  async function lockRow(trx: TrxHandle, id: string): Promise<TItem> {
    const result = await sql<Record<string, unknown>>`
      SELECT * FROM ${sql.id(TABLE)} WHERE id = ${id}::uuid FOR UPDATE
    `.execute(trx)
    if (result.rows.length === 0) throw new ApiError('not_found', notFound)
    return mapRow(meta, result.rows[0]!) as TItem
  }

  /** 投影单条（get 与写后重载共用） */
  async function loadProjected(handle: DbHandle, permit: Permit, id: string): Promise<TItem> {
    return loadAuthorizedFrom({
      db: handle,
      permit,
      target,
      alias: ALIAS,
      source: SOURCE,
      select: SELECT,
      id,
      mapRow: mapRowFull,
      notFoundMessage: notFound,
    })
  }

  /** 写后返回值：有投影则按投影重载（同事务），无投影直接映射 RETURNING 行 */
  async function reload(trx: TrxHandle, permit: Permit, fallback: TItem): Promise<TItem> {
    if (!projection) return fallback
    return loadProjected(trx, permit, fallback.id)
  }

  async function get(permit: Permit, id: string): Promise<TItem> {
    if (projection) {
      return loadProjected(db, permit, id)
    }
    const row = await loadAuthorized({ db, permit, target, table: TABLE, id, notFoundMessage: notFound })
    return mapRow(meta, row as Record<string, unknown>) as TItem
  }

  async function list(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized<TItem>({
      db,
      permit,
      target,
      alias: ALIAS,
      resource: meta,
      source: SOURCE,
      select: SELECT,
      defaultOrder,
      query,
      mapRow: mapRowFull,
    })
  }

  async function insertRow(trx: TrxHandle, draft: Record<string, unknown>): Promise<TItem> {
    const cols: RawBuilder<unknown>[] = []
    const vals: RawBuilder<unknown>[] = []
    for (const field of writable) {
      const value = draft[field.apiName]
      if (value === undefined) continue
      cols.push(sql.id(field.dbColumn))
      vals.push(sql`${toDbValue(field, value)}`)
    }
    for (const field of [...inheritFields, ...derivedFields]) {
      const value = draft[field.apiName]
      if (value === undefined) continue
      cols.push(sql.id(field.dbColumn))
      vals.push(sql`${toDbValue(field, value)}`)
    }
    const result = await sql`
      INSERT INTO ${sql.id(TABLE)} (${sql.join(cols)}) VALUES (${sql.join(vals)}) RETURNING *
    `.execute(trx)
    return mapRow(meta, result.rows[0] as Record<string, unknown>) as TItem
  }

  async function createInTx(trx: TrxHandle, permit: Permit, input: Record<string, unknown>): Promise<TItem> {
    const draft = normalizeInput(input)
    const parentId = draft[fkField!.apiName]
    if (typeof parentId !== 'string' || !parentId) {
      throw ApiError.validation(`${label}参数不合法`, { [fkField!.apiName]: ['不能为空'] })
    }
    const parentWire = await lockParent(trx, permit, parentId)
    for (const field of inheritFields) {
      draft[field.apiName] = parentWire[field.apiName]
    }
    hooks.validate?.({ action: 'create', permit, draft, parent: parentWire })
    await hooks.beforeWrite?.(trx, { action: 'create', permit, draft, parent: parentWire })
    let item: TItem
    try {
      item = await insertRow(trx, draft)
    } catch (err) {
      throw mapWriteError(err, `保存${label}失败`, writeErrors)
    }
    const projected = await reload(trx, permit, item)
    await writeAudit(trx, permit.actor, {
      resource: TABLE,
      recordId: item.id,
      recordLabel: recordLabel(projected),
      actionType: 'create',
      actionName: 'create',
      companyId: auditCompanyId(item),
      changes: auditCreated(snapshot(meta, item, AUDIT), AUDIT),
      sensitiveFields: meta.audit?.sensitiveFields,
    })
    await hooks.afterWrite?.(trx, { action: 'create', permit, item, parent: parentWire })
    return projected
  }

  async function create(permit: Permit, input: Record<string, unknown>): Promise<TItem> {
    return withTx(db, (trx) => createInTx(trx, permit, input))
  }

  async function updateInTx(
    trx: TrxHandle,
    permit: Permit,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<TItem> {
    const parentWire = await parentOf(trx, permit, id)
    const before = await lockRow(trx, id)
    const draft: Record<string, unknown> = { ...before, ...normalizeInput(patch) }
    hooks.validate?.({ action: 'update', permit, draft, parent: parentWire, before })
    await hooks.beforeWrite?.(trx, { action: 'update', permit, draft, parent: parentWire, before })
    const changes = auditDiff(snapshot(meta, before, AUDIT), snapshot(meta, draft, AUDIT), AUDIT)
    if (Object.keys(changes).length === 0) return reload(trx, permit, before)
    const sets = [...writable, ...derivedFields].map(
      (f) => sql`${sql.id(f.dbColumn)} = ${toDbValue(f, draft[f.apiName])}`,
    )
    sets.push(sql`updated_at = (now() AT TIME ZONE 'utc')`)
    let item: TItem
    try {
      const result = await sql`UPDATE ${sql.id(TABLE)} SET ${sql.join(sets)} WHERE id = ${id}::uuid RETURNING *`.execute(trx)
      item = mapRow(meta, result.rows[0] as Record<string, unknown>) as TItem
    } catch (err) {
      throw mapWriteError(err, `保存${label}失败`, writeErrors)
    }
    const projected = await reload(trx, permit, item)
    await writeAudit(trx, permit.actor, {
      resource: TABLE,
      recordId: id,
      recordLabel: recordLabel(projected),
      actionType: 'update',
      actionName: 'update',
      companyId: auditCompanyId(item),
      changes,
      sensitiveFields: meta.audit?.sensitiveFields,
    })
    await hooks.afterWrite?.(trx, { action: 'update', permit, item, parent: parentWire, before })
    return projected
  }

  async function update(permit: Permit, id: string, patch: Record<string, unknown>): Promise<TItem> {
    return withTx(db, (trx) => updateInTx(trx, permit, id, patch))
  }

  async function removeInTx(trx: TrxHandle, permit: Permit, id: string): Promise<void> {
    const parentWire = await parentOf(trx, permit, id)
    const item = await lockRow(trx, id)
    // 标签取自投影（引用名在 join 上），须在 DELETE 前取
    const projected = await reload(trx, permit, item)
    await hooks.beforeDelete?.(trx, { permit, item, parent: parentWire })
    try {
      await sql`DELETE FROM ${sql.id(TABLE)} WHERE id = ${id}::uuid`.execute(trx)
    } catch (err) {
      throw mapWriteError(err, `删除${label}失败`, writeErrors)
    }
    await writeAudit(trx, permit.actor, {
      resource: TABLE,
      recordId: id,
      recordLabel: recordLabel(projected),
      actionType: 'destroy',
      actionName: 'destroy',
      companyId: auditCompanyId(item),
      changes: auditDestroyed(snapshot(meta, item, AUDIT), AUDIT),
      sensitiveFields: meta.audit?.sensitiveFields,
    })
  }

  async function remove(permit: Permit, id: string): Promise<void> {
    await withTx(db, (trx) => removeInTx(trx, permit, id))
  }

  return {
    get,
    list,
    create,
    createInTx,
    update,
    updateInTx,
    remove,
    removeInTx,
    meta,
    stampedColumns,
  }
}
