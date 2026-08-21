/**
 * 标准动作内核·记录访问与写管线（内部共享）：root（service.ts）与 child（child.ts）
 * 写路径的唯一拷贝，收口两文件曾经的结构双胞胎（normalize/投影装载/审计标签/写骨架）。
 *
 * 读侧：投影/裸表装载、wire 规范化、领域行筛选（extraWhere）、审计 record_label/companyId。
 * 写侧管线骨架：闸门 → normalize → validate → beforeWrite → diff → INSERT/UPDATE/DELETE
 * → mapWriteError → 审计三型 → afterWrite → reload。两装配器的真差异经 spec 参数化：
 *
 * - 写入闸门（gate）：root = 公司可写校验（assertCompanyWritable）+ 树锁/授权锁行；
 *   child = 锁母单（授权 + 状态门）→ 带入列充实 draft → 再锁行
 * - 列集合：writable 之外，child 有带入列（仅 INSERT）与派生列（INSERT/UPDATE）
 * - beforeWriteBeforeDiff：child 派生列在 beforeWrite 充实，须先充实再按 WRITE_COLS
 *   判落库（充实参与 diff 与审计）；root 保持既有口径——先判无差异（无差异不进
 *   beforeWrite），beforeWrite 的落库规范形随 UPDATE 落库但不参与 diff/审计
 * - auditLabelFromProjection：child 审计 record_label 取投影后记录（名称在 join 引用上），
 *   写后返回值在审计前重载；root 取裸行，返回值在 afterWrite 之后重载（payroll 等在
 *   afterWrite 补写派生列，reload 必须在其后）
 *
 * 钩子纪律同 service.ts/child.ts 文件头：只做领域不变量与行内充实。
 */
import type { ListQuery } from '@synie/shared'
import { sql, type RawBuilder } from 'kysely'
import type { Kysely } from 'kysely'
import { mapWriteError, type PgWriteMapping } from '~/db/dberr.ts'
import { listAuthorized } from '~/db/list.ts'
import { loadAuthorizedFrom } from '~/db/load.ts'
import type { DbHandle, TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import { auditCreated, auditDestroyed, auditDiff, writeAudit } from '~/platform/audit/write.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import type { AuthzTarget } from '~/platform/meta/resource-authz.ts'
import type { FieldMeta, ResourceMeta } from '~/platform/meta/types.ts'
import { fromDbValue, mapRow, physicalFields, snapshot, toDbValue } from './fields.ts'
import { loadBareAuthorized } from './load-bare.ts'
import type { ExtraWhere, StandardItem, StandardProjection } from './service.ts'

/** wire 值规范化往返（enum 大小写、decimal toFixed），保证 diff 与库内一致 */
function normalizeWire(field: FieldMeta, value: unknown): unknown {
  // codec 字段保持调用方原始形：快照/diff/写入口径与手写服务逐字一致（raw 进 raw 出）
  if (field.codec) return value
  return fromDbValue(field, toDbValue(field, value))
}

export interface RecordAccessOptions {
  db: Kysely<Database>
  meta: ResourceMeta
  target: AuthzTarget
  label: string
  notFound: string
  writeErrors: readonly PgWriteMapping[]
  projection?: StandardProjection
  /** 装配器解析后的缺省排序（root inserted_at DESC, id ASC；child idx ASC, id ASC） */
  defaultOrder: RawBuilder<unknown>
  /** 审计 companyId 取值列；无公司归属（global 资源/子行未带入）缺省 */
  companyField?: FieldMeta
  /** record_label 字段（lookup 缺省镜像 name → label → code → 首个字符串字段） */
  labelField?: FieldMeta
  /** 审计 record_label 覆盖（child：子行名称在 join 引用上，由模块给出） */
  recordLabel?: (item: Record<string, unknown>) => string | null
  /** list/load 领域行筛选谓词（与 root/child extraWhere 同语义） */
  extraWhere?: ExtraWhere
  writable: readonly FieldMeta[]
  /** INSERT 追加列（child 带入列 + 派生列；从 draft 取值，wire 不可写） */
  insertFields?: readonly FieldMeta[]
  /** UPDATE 追加列（child 派生列；带入列 createOnly 不在内） */
  updateFields?: readonly FieldMeta[]
  /** 无差异判定列面（WRITE_COLS）：审计白名单只管审计记录，可写列被 audit.exclude 不得丢写 */
  writeCols: readonly string[]
}

export interface RecordAccess<TItem extends StandardItem = StandardItem> {
  readonly meta: ResourceMeta
  readonly label: string
  readonly notFound: string
  readonly writeErrors: readonly PgWriteMapping[]
  readonly TABLE: string
  readonly ALIAS: string
  readonly AUDIT: readonly string[]
  readonly writeCols: readonly string[]
  readonly SELECT: RawBuilder<unknown>
  readonly SOURCE: RawBuilder<unknown>
  readonly defaultOrder: RawBuilder<unknown>
  /** db 行 → wire item（物理映射 + 投影 mapExtra） */
  mapRowFull(row: Record<string, unknown>): TItem
  recordLabel(item: Record<string, unknown>): string | null
  auditCompanyId(item: Record<string, unknown>): string | null
  /** patch/input → wire 规范形（只收可写字段的已提供键；schema 已挡未知键与类型） */
  normalizeInput(input: Record<string, unknown>): Record<string, unknown>
  /** 解析领域行筛选：list 传调用方 query；load/写前锁传空 query */
  resolveExtraWhere(
    permit: Permit,
    alias: string,
    query?: Partial<ListQuery> & Record<string, unknown>,
  ): { where: RawBuilder<unknown> | null; query: Partial<ListQuery> }
  /** 裸表行加载（锁路径）；返回物理字段 wire 形（无投影列） */
  loadBare(handle: DbHandle, permit: Permit, id: string, forUpdate: boolean): Promise<TItem>
  /** 投影单条（get 与写后重载共用） */
  loadProjected(handle: DbHandle, permit: Permit, id: string): Promise<TItem>
  /** 写后返回值：有投影则按投影重载（同事务），无投影直接映射 RETURNING 行 */
  reload(trx: TrxHandle, permit: Permit, fallback: TItem): Promise<TItem>
  get(permit: Permit, id: string): Promise<TItem>
  getOn(handle: DbHandle, permit: Permit, id: string): Promise<TItem>
  list(permit: Permit, query: Partial<ListQuery>): Promise<{ count: number; results: TItem[] }>
  /** INSERT（writable + insertFields 取 draft 值 + extraCols 附加 db 列） */
  insertRow(trx: TrxHandle, draft: Record<string, unknown>, extraCols: Record<string, unknown>): Promise<TItem>
  /** UPDATE 全量可写列（writable + updateFields）+ updated_at */
  updateRow(trx: TrxHandle, id: string, draft: Record<string, unknown>): Promise<TItem>
  deleteRow(trx: TrxHandle, id: string): Promise<void>
}

export function createRecordAccess<TItem extends StandardItem = StandardItem>(
  options: RecordAccessOptions,
): RecordAccess<TItem> {
  const { db, meta, target, label, notFound, writeErrors, projection } = options
  const TABLE = meta.table
  const AUDIT = auditFieldsOf(meta)
  const writableByApi = new Map(options.writable.map((f) => [f.apiName, f]))
  const insertFields = options.insertFields ?? []
  const updateFields = options.updateFields ?? []

  const selectCols = sql.join(physicalFields(meta).map((f) => sql.id(f.dbColumn)))
  const SELECT = projection?.selectExtra ? sql`SELECT ${selectCols}, ${projection.selectExtra}` : sql`SELECT ${selectCols}`
  const SOURCE = projection?.source ?? sql` FROM ${sql.id(TABLE)}`
  const ALIAS = projection?.alias ?? TABLE

  function mapRowFull(row: Record<string, unknown>): TItem {
    const base = mapRow(meta, row)
    if (projection?.mapExtra) Object.assign(base, projection.mapExtra(row))
    return base as TItem
  }

  function recordLabel(item: Record<string, unknown>): string | null {
    if (options.recordLabel) return options.recordLabel(item)
    const field = options.labelField
    if (!field) return null
    const value = item[field.apiName]
    return value === null || value === undefined ? null : String(value)
  }

  function auditCompanyId(item: Record<string, unknown>): string | null {
    const field = options.companyField
    if (!field) return null
    const value = item[field.apiName]
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

  function resolveExtraWhere(
    permit: Permit,
    alias: string,
    query: Partial<ListQuery> & Record<string, unknown> = {},
  ): { where: RawBuilder<unknown> | null; query: Partial<ListQuery> } {
    if (!options.extraWhere) return { where: null, query }
    const result = options.extraWhere({ permit, query, alias })
    if (!result) return { where: null, query }
    return {
      where: result.where ?? null,
      query: result.query ?? query,
    }
  }

  async function loadBare(handle: DbHandle, permit: Permit, id: string, forUpdate: boolean): Promise<TItem> {
    const { where: extraWhere } = resolveExtraWhere(permit, TABLE)
    return loadBareAuthorized<TItem>({
      handle,
      permit,
      target,
      meta,
      id,
      forUpdate,
      notFoundMessage: notFound,
      extraWhere,
    })
  }

  async function loadProjected(handle: DbHandle, permit: Permit, id: string): Promise<TItem> {
    const { where: extraWhere } = resolveExtraWhere(permit, ALIAS)
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
      extraWhere,
    })
  }

  async function reload(trx: TrxHandle, permit: Permit, fallback: TItem): Promise<TItem> {
    if (!projection) return fallback
    return loadProjected(trx, permit, fallback.id)
  }

  async function get(permit: Permit, id: string): Promise<TItem> {
    return getOn(db, permit, id)
  }

  async function getOn(handle: DbHandle, permit: Permit, id: string): Promise<TItem> {
    if (projection) return loadProjected(handle, permit, id)
    return loadBare(handle, permit, id, false)
  }

  async function list(permit: Permit, query: Partial<ListQuery>) {
    const resolved = resolveExtraWhere(permit, ALIAS, query as Partial<ListQuery> & Record<string, unknown>)
    return listAuthorized<TItem>({
      db,
      permit,
      target,
      alias: ALIAS,
      resource: meta,
      source: SOURCE,
      select: SELECT,
      defaultOrder: options.defaultOrder,
      query: resolved.query,
      extraWhere: resolved.where,
      mapRow: mapRowFull,
    })
  }

  async function insertRow(
    trx: TrxHandle,
    draft: Record<string, unknown>,
    extraCols: Record<string, unknown>,
  ): Promise<TItem> {
    const cols: RawBuilder<unknown>[] = []
    const vals: RawBuilder<unknown>[] = []
    for (const field of [...options.writable, ...insertFields]) {
      const value = draft[field.apiName]
      if (value === undefined) continue
      cols.push(sql.id(field.dbColumn))
      vals.push(field.codec ? field.codec.toSql(value) : sql`${toDbValue(field, value)}`)
    }
    for (const [column, value] of Object.entries(extraCols)) {
      cols.push(sql.id(column))
      vals.push(sql`${value}`)
    }
    const stmt =
      cols.length === 0
        ? sql`INSERT INTO ${sql.id(TABLE)} DEFAULT VALUES RETURNING *`
        : sql`INSERT INTO ${sql.id(TABLE)} (${sql.join(cols)}) VALUES (${sql.join(vals)}) RETURNING *`
    const result = await stmt.execute(trx)
    return mapRow(meta, result.rows[0] as Record<string, unknown>) as TItem
  }

  async function updateRow(trx: TrxHandle, id: string, draft: Record<string, unknown>): Promise<TItem> {
    const sets = [...options.writable, ...updateFields].map((f) =>
      f.codec
        ? sql`${sql.id(f.dbColumn)} = ${f.codec.toSql(draft[f.apiName])}`
        : sql`${sql.id(f.dbColumn)} = ${toDbValue(f, draft[f.apiName])}`,
    )
    sets.push(sql`updated_at = (now() AT TIME ZONE 'utc')`)
    const result = await sql`UPDATE ${sql.id(TABLE)} SET ${sql.join(sets)} WHERE id = ${id}::uuid RETURNING *`.execute(trx)
    return mapRow(meta, result.rows[0] as Record<string, unknown>) as TItem
  }

  async function deleteRow(trx: TrxHandle, id: string): Promise<void> {
    await sql`DELETE FROM ${sql.id(TABLE)} WHERE id = ${id}::uuid`.execute(trx)
  }

  return {
    meta,
    label,
    notFound,
    writeErrors,
    TABLE,
    ALIAS,
    AUDIT,
    writeCols: options.writeCols,
    SELECT,
    SOURCE,
    defaultOrder: options.defaultOrder,
    mapRowFull,
    recordLabel,
    auditCompanyId,
    normalizeInput,
    resolveExtraWhere,
    loadBare,
    loadProjected,
    reload,
    get,
    getOn,
    list,
    insertRow,
    updateRow,
    deleteRow,
  }
}

// —— 记录写管线 ——

type WriteHookContext<TContext> = {
  action: 'create' | 'update'
  permit: Permit
  draft: Record<string, unknown>
  before?: Record<string, unknown>
} & TContext

/**
 * 写管线钩子：与 StandardHooks/ChildHooks 结构同形（TContext 展开进 ctx），
 * 两装配器的公开钩子原样透传，无适配层。child 的 TContext 携带母单 wire 形。
 */
export interface RecordWriteHooks<TContext extends Record<string, unknown>> {
  validate?: (ctx: WriteHookContext<TContext>) => void
  beforeWrite?: (trx: TrxHandle, ctx: WriteHookContext<TContext>) => Promise<void> | void
  afterWrite?: (
    trx: TrxHandle,
    ctx: {
      action: 'create' | 'update'
      permit: Permit
      item: Record<string, unknown>
      before?: Record<string, unknown>
    } & TContext,
  ) => Promise<void> | void
  beforeDelete?: (
    trx: TrxHandle,
    ctx: { permit: Permit; item: Record<string, unknown> } & TContext,
  ) => Promise<void> | void
}

/** 写入闸门：root 公司可写 vs child 母单锁/状态门/带入——两装配器各自的真差异 */
export interface RecordWriteGate<TItem extends StandardItem, TContext extends Record<string, unknown>> {
  /** create 前置：入参级校验 + 授权闸门（可原地充实 draft，如 child 带入列），返回钩子上下文 */
  prepareCreate(trx: TrxHandle, permit: Permit, draft: Record<string, unknown>): Promise<TContext>
  /** update/remove 前置：定位 + 锁行 + 授权（root 树锁→授权锁行；child 锁母单→锁行） */
  lockForUpdate(trx: TrxHandle, permit: Permit, id: string): Promise<{ before: TItem; context: TContext }>
}

export interface RecordWriteSpec<TItem extends StandardItem, TContext extends Record<string, unknown>> {
  gate: RecordWriteGate<TItem, TContext>
  hooks?: RecordWriteHooks<TContext>
  /** create：normalize 前的入参守卫（root 拒手填编号） */
  assertInput?: (input: Record<string, unknown>) => void
  /** create：validate 后、beforeWrite 前（root 树锁） */
  beforeCreateWrite?: (trx: TrxHandle, draft: Record<string, unknown>) => Promise<void> | void
  /**
   * create：beforeWrite 后、INSERT 前的附加 db 列（可原地充实 draft）。
   * root：ownershipStamp + 树 id/path + hooks.insertColumns + 编号取号；child 无。
   */
  insertColumns?: (
    trx: TrxHandle,
    ctx: { permit: Permit; draft: Record<string, unknown> },
  ) => Promise<Record<string, unknown>> | Record<string, unknown>
  /** update/remove：行锁后、validate/删除前（root 可变状态门） */
  onLocked?: (before: TItem) => void
  /**
   * beforeWrite 与无差异判定的顺序。true（child）：beforeWrite 先充实派生列，再按
   * WRITE_COLS 判落库——充实参与 diff 与审计；缺省 false（root）：先判无差异
   * （无差异直接返回、不进 beforeWrite），beforeWrite 的落库规范形随 UPDATE 落库
   * 但不参与 diff 与审计——两口径均为既有行为，不可互换。
   */
  beforeWriteBeforeDiff?: boolean
  /**
   * update：beforeWrite 后、UPDATE 前（root 树移动解析）；返回的续体在 UPDATE 成功后
   * 执行（root 子树物化路径重写）。
   */
  beforeUpdate?: (
    trx: TrxHandle,
    ctx: { id: string; draft: Record<string, unknown>; before: TItem },
  ) => Promise<((trx: TrxHandle) => Promise<void>) | void> | ((trx: TrxHandle) => Promise<void>) | void
  /** remove：onLocked 后、beforeDelete 前（root 有子节点删除保护） */
  beforeRemove?: (trx: TrxHandle, before: TItem) => Promise<void> | void
  /**
   * 审计 record_label 取投影后记录（child：名称在 join 引用上；写后返回值在审计前
   * 重载）。缺省 false（root）：取裸行，返回值在 afterWrite 之后重载——afterWrite
   * 可补写派生列（payroll 金额等），reload 必须在其后。
   */
  auditLabelFromProjection?: boolean
}

export interface RecordWritePipeline<TItem extends StandardItem = StandardItem> {
  createInTx(trx: TrxHandle, permit: Permit, input: Record<string, unknown>): Promise<TItem>
  updateInTx(trx: TrxHandle, permit: Permit, id: string, patch: Record<string, unknown>): Promise<TItem>
  removeInTx(trx: TrxHandle, permit: Permit, id: string): Promise<void>
}

/**
 * 记录写管线：load（闸门）→ normalize → hooks → diff → write → mapWriteError
 * → 审计三型 → reload。root/child 各装配一次，公开 *InTx 签名不变。
 */
export function createRecordWritePipeline<TItem extends StandardItem, TContext extends Record<string, unknown>>(
  access: RecordAccess<TItem>,
  spec: RecordWriteSpec<TItem, TContext>,
): RecordWritePipeline<TItem> {
  const { meta, label, writeErrors, TABLE, AUDIT, writeCols } = access
  const hooks = spec.hooks ?? {}

  function writeCtx(
    action: 'create' | 'update',
    permit: Permit,
    draft: Record<string, unknown>,
    context: TContext,
    before?: Record<string, unknown>,
  ): WriteHookContext<TContext> {
    return { action, permit, draft, ...(before === undefined ? {} : { before }), ...context } as WriteHookContext<TContext>
  }

  function afterCtx(
    action: 'create' | 'update',
    permit: Permit,
    item: Record<string, unknown>,
    context: TContext,
    before?: Record<string, unknown>,
  ) {
    return { action, permit, item, ...(before === undefined ? {} : { before }), ...context } as {
      action: 'create' | 'update'
      permit: Permit
      item: Record<string, unknown>
      before?: Record<string, unknown>
    } & TContext
  }

  async function createInTx(trx: TrxHandle, permit: Permit, input: Record<string, unknown>): Promise<TItem> {
    spec.assertInput?.(input)
    const draft = access.normalizeInput(input)
    const context = await spec.gate.prepareCreate(trx, permit, draft)
    hooks.validate?.(writeCtx('create', permit, draft, context))
    await spec.beforeCreateWrite?.(trx, draft)
    await hooks.beforeWrite?.(trx, writeCtx('create', permit, draft, context))
    const extraCols = (await spec.insertColumns?.(trx, { permit, draft })) ?? {}
    let item: TItem
    try {
      item = await access.insertRow(trx, draft, extraCols)
    } catch (err) {
      throw mapWriteError(err, `保存${label}失败`, writeErrors)
    }
    // child 标签在投影上：审计前重载；root 裸行标签：返回值留到 afterWrite 之后重载
    const projected = spec.auditLabelFromProjection ? await access.reload(trx, permit, item) : item
    await writeAudit(trx, permit.actor, {
      resource: TABLE,
      recordId: item.id,
      recordLabel: access.recordLabel(projected),
      actionType: 'create',
      actionName: 'create',
      companyId: access.auditCompanyId(item),
      changes: auditCreated(snapshot(meta, item, AUDIT), AUDIT),
      sensitiveFields: meta.audit?.sensitiveFields,
    })
    await hooks.afterWrite?.(trx, afterCtx('create', permit, item, context))
    return spec.auditLabelFromProjection ? projected : access.reload(trx, permit, item)
  }

  async function updateInTx(
    trx: TrxHandle,
    permit: Permit,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<TItem> {
    const { before, context } = await spec.gate.lockForUpdate(trx, permit, id)
    spec.onLocked?.(before)
    const draft: Record<string, unknown> = { ...before, ...access.normalizeInput(patch) }
    const ctx = writeCtx('update', permit, draft, context, before)
    hooks.validate?.(ctx)
    // child：beforeWrite 先充实派生列，再判 WRITE_COLS——审计 exclude 不得短路丢写
    if (spec.beforeWriteBeforeDiff) await hooks.beforeWrite?.(trx, ctx)
    const writeChanges = auditDiff(snapshot(meta, before, writeCols), snapshot(meta, draft, writeCols), writeCols)
    // 无变更 update 不落库不审计，直接返回现值
    if (Object.keys(writeChanges).length === 0) return access.reload(trx, permit, before)
    const changes = auditDiff(snapshot(meta, before, AUDIT), snapshot(meta, draft, AUDIT), AUDIT)
    // root：既有口径——beforeWrite 在 diff 之后，其落库规范形不参与 diff/审计
    if (!spec.beforeWriteBeforeDiff) await hooks.beforeWrite?.(trx, ctx)
    const postUpdate = await spec.beforeUpdate?.(trx, { id, draft, before })
    let item: TItem
    try {
      item = await access.updateRow(trx, id, draft)
    } catch (err) {
      throw mapWriteError(err, `保存${label}失败`, writeErrors)
    }
    if (postUpdate) await postUpdate(trx)
    const projected = spec.auditLabelFromProjection ? await access.reload(trx, permit, item) : item
    if (Object.keys(changes).length > 0) {
      await writeAudit(trx, permit.actor, {
        resource: TABLE,
        recordId: item.id,
        recordLabel: access.recordLabel(projected),
        actionType: 'update',
        actionName: 'update',
        companyId: access.auditCompanyId(item),
        changes,
        sensitiveFields: meta.audit?.sensitiveFields,
      })
    }
    await hooks.afterWrite?.(trx, afterCtx('update', permit, item, context, before))
    return spec.auditLabelFromProjection ? projected : access.reload(trx, permit, item)
  }

  async function removeInTx(trx: TrxHandle, permit: Permit, id: string): Promise<void> {
    const { before, context } = await spec.gate.lockForUpdate(trx, permit, id)
    spec.onLocked?.(before)
    // child：标签取自投影（引用名在 join 上），须在 DELETE 前取
    const projected = spec.auditLabelFromProjection ? await access.reload(trx, permit, before) : before
    await spec.beforeRemove?.(trx, before)
    await hooks.beforeDelete?.(trx, { permit, item: before, ...context } as { permit: Permit; item: Record<string, unknown> } & TContext)
    try {
      await access.deleteRow(trx, id)
    } catch (err) {
      throw mapWriteError(err, `删除${label}失败`, writeErrors)
    }
    await writeAudit(trx, permit.actor, {
      resource: TABLE,
      recordId: before.id,
      recordLabel: access.recordLabel(projected),
      actionType: 'destroy',
      actionName: 'destroy',
      companyId: access.auditCompanyId(before),
      changes: auditDestroyed(snapshot(meta, before, AUDIT), AUDIT),
      sensitiveFields: meta.audit?.sensitiveFields,
    })
  }

  return { createInTx, updateInTx, removeInTx }
}
