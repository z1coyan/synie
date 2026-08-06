/**
 * 标准动作内核·服务执行器：meta 声明 + 钩子 → 完整 CRUD 服务。
 *
 * 动作词表（本期）：get / list / create / update / remove / bulkUpdate / bulkRemove。
 * 审核 / 作废（单据状态机）在下一期进入内核；届时流程效果挂 afterApprove / afterVoid 钩子。
 *
 * 平台契约（与手写服务逐字对齐，路由不可区分）：
 * - 授权：列表 listAuthorized、单条/写前 loadAuthorized(forUpdate)、create 走
 *   assertCompanyWritable + ownershipStamp；服务只收 Permit
 * - 审计：白名单自 meta.audit 派生；create/update(有 diff 才写)/destroy 三型
 * - 无变更 update 不落库不审计，直接返回现值
 * - 约束冲突经 writeErrors 映射为领域文案（mapWriteError）
 *
 * 钩子纪律（写进 AGENTS.md）：钩子只做领域不变量与行内充实（可原地改 draft）；
 * 跨资源流程（过账/占量等）不进钩子，留在手写服务与引擎。
 *
 * 逃生舱：任何动作复杂化时，模块可自建同签名函数替换该动作（服务是普通对象），
 * 或整体弹回手写——路由层对两者不可区分。
 */
import type { ListQuery } from '@synie/shared'
import { sql, type RawBuilder } from 'kysely'
import type { Kysely } from 'kysely'
import { mapWriteError, type PgWriteMapping } from '~/db/dberr.ts'
import { listAuthorized } from '~/db/list.ts'
import { assertCompanyWritable, loadAuthorized, ownershipStamp } from '~/db/load.ts'
import { withTx, type TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import { auditCreated, auditDestroyed, auditDiff, writeAudit } from '~/platform/audit/write.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { FieldMeta, ResourceMeta } from '~/platform/meta/types.ts'
import { fromDbValue, mapRow, physicalFields, snapshot, toDbValue, writableFields } from './fields.ts'

export interface StandardItem {
  id: string
  [key: string]: unknown
}

export interface StandardHookContext {
  action: 'create' | 'update'
  permit: Permit
  /** wire 形全记录（update 为 before+patch 合并后）；钩子可原地规范化 */
  draft: Record<string, unknown>
  /** update 才有 */
  before?: Record<string, unknown>
}

export interface StandardHooks {
  /** 领域不变量校验（纯函数，不碰库）：抛 ApiError.validation */
  validate?: (ctx: StandardHookContext) => void
  /** 事务内写前（需要查库的校验放这） */
  beforeWrite?: (trx: TrxHandle, ctx: StandardHookContext) => Promise<void> | void
  /** 事务内写后（同事务联动写放这） */
  afterWrite?: (
    trx: TrxHandle,
    ctx: { action: 'create' | 'update'; permit: Permit; item: Record<string, unknown>; before?: Record<string, unknown> },
  ) => Promise<void> | void
  /** 事务内删前（引用保护等） */
  beforeDelete?: (trx: TrxHandle, ctx: { permit: Permit; item: Record<string, unknown> }) => Promise<void> | void
}

export interface StandardServiceOptions {
  db: Kysely<Database>
  registry: Registry
  /** Registry 资源名（meta 是唯一事实源） */
  resource: string
  /** 缺省 `${label}不存在` */
  notFound?: string
  /** 列表缺省排序；缺省 inserted_at DESC, id ASC */
  defaultOrder?: RawBuilder<unknown>
  /** 唯一/外键冲突 → 领域文案 */
  writeErrors?: readonly PgWriteMapping[]
  hooks?: StandardHooks
}

export interface StandardService<TItem extends StandardItem = StandardItem> {
  get(permit: Permit, id: string): Promise<TItem>
  list(permit: Permit, query: Partial<ListQuery>): Promise<{ count: number; results: TItem[] }>
  create(permit: Permit, input: Record<string, unknown>): Promise<TItem>
  update(permit: Permit, id: string, patch: Record<string, unknown>): Promise<TItem>
  remove(permit: Permit, id: string): Promise<void>
  /** 单事务全成全败；逐行审计 */
  bulkUpdate(permit: Permit, ids: readonly string[], patch: Record<string, unknown>): Promise<TItem[]>
  bulkRemove(permit: Permit, ids: readonly string[]): Promise<number>
  readonly meta: ResourceMeta
  readonly stampedColumns: ReadonlySet<string>
}

/** wire 值规范化往返（enum 大小写、decimal toFixed），保证 diff 与库内一致 */
function normalizeWire(field: FieldMeta, value: unknown): unknown {
  return fromDbValue(field, toDbValue(field, value))
}

export function createStandardService<TItem extends StandardItem = StandardItem>(
  options: StandardServiceOptions,
): StandardService<TItem> {
  const { db, registry, resource, hooks = {} } = options
  const found = registry.get(resource)
  if (!found) throw new Error(`标准派生：未知 Meta 资源 ${resource}`)
  const meta: ResourceMeta = found
  if (!meta.audit?.enabled) {
    throw new Error(`标准派生：资源 ${resource} 未启用审计——标准动作以审计为合同，不可豁免`)
  }
  const target = registry.authzTarget(resource)
  const binding = target.root
  if (binding.kind === 'via' || target.rootResource !== resource) {
    throw new Error(`标准派生：via/派生资源 ${resource} 判定归宿在宿主，不支持标准动作，应并入宿主或手写`)
  }

  const stampedColumns = new Set<string>()
  if (binding.owner) stampedColumns.add(binding.owner.column)
  if (binding.dept?.mode === 'stamped') stampedColumns.add(binding.dept.column)

  const TABLE = meta.table
  const AUDIT = auditFieldsOf(meta)
  const label = meta.label ?? meta.permissionLabel
  const notFound = options.notFound ?? `${label}不存在`
  const writeErrors = options.writeErrors ?? []
  const writable = writableFields(meta, stampedColumns)
  const writableByApi = new Map(writable.map((f) => [f.apiName, f]))

  // recordLabel 字段：镜像 catalog-normalize 的 lookup 缺省（name → label → code → 首个字符串字段）
  const byName = (n: string) => meta.fields.find((f) => f.name === n || f.apiName === n)
  const labelField = meta.lookup?.labelField
    ? byName(meta.lookup.labelField)
    : (byName('name') ?? byName('label') ?? byName('code') ?? meta.fields.find((f) => f.type === 'string' && !f.calculated))

  const companyField = binding.company
    ? physicalFields(meta).find((f) => f.dbColumn === binding.company!.column)
    : undefined
  if (binding.company && !companyField) {
    throw new Error(`标准派生：资源 ${resource} 公司列 ${binding.company.column} 无对应字段`)
  }

  const selectCols = sql.join(physicalFields(meta).map((f) => sql.id(f.dbColumn)))
  const defaultOrder = options.defaultOrder ?? sql`"inserted_at" DESC, "id" ASC`

  function recordLabel(item: Record<string, unknown>): string | null {
    if (!labelField) return null
    const value = item[labelField.apiName]
    return value === null || value === undefined ? null : String(value)
  }

  function auditCompanyId(item: Record<string, unknown>): string | null {
    if (!companyField) return null
    const value = item[companyField.apiName]
    return value === null || value === undefined ? null : String(value)
  }

  /** patch/input → wire 规范形（只收可写字段的已提供键；schema 已挡未知键与类型） */
  function normalizeInput(input: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
      const field = writableByApi.get(key)
      if (!field || value === undefined) continue
      out[key] = value === null ? null : normalizeWire(field, value)
    }
    return out
  }

  async function loadItem(handle: Kysely<Database> | TrxHandle, permit: Permit, id: string, forUpdate: boolean) {
    const row = await loadAuthorized({
      db: handle,
      permit,
      target,
      table: TABLE,
      id,
      forUpdate,
      notFoundMessage: notFound,
    })
    return mapRow(meta, row as Record<string, unknown>) as TItem
  }

  async function get(permit: Permit, id: string): Promise<TItem> {
    return loadItem(db, permit, id, false)
  }

  async function list(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized<TItem>({
      db,
      permit,
      target,
      alias: TABLE,
      resource: meta,
      source: sql` FROM ${sql.id(TABLE)}`,
      select: sql`SELECT ${selectCols}`,
      defaultOrder,
      query,
      mapRow: (r) => mapRow(meta, r as Record<string, unknown>) as TItem,
    })
  }

  async function insertRow(trx: TrxHandle, draft: Record<string, unknown>, permit: Permit): Promise<TItem> {
    const cols: RawBuilder<unknown>[] = []
    const vals: RawBuilder<unknown>[] = []
    for (const field of writable) {
      const value = draft[field.apiName]
      if (value === undefined) continue
      cols.push(sql.id(field.dbColumn))
      vals.push(sql`${toDbValue(field, value)}`)
    }
    for (const [column, value] of Object.entries(ownershipStamp(permit, target))) {
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

  async function create(permit: Permit, input: Record<string, unknown>): Promise<TItem> {
    const draft = normalizeInput(input)
    if (companyField) {
      const companyId = draft[companyField.apiName]
      if (typeof companyId !== 'string' || !companyId) {
        throw ApiError.validation(`${label}参数不合法`, { [companyField.apiName]: ['不能为空'] })
      }
      assertCompanyWritable(permit, companyId, notFound)
    }
    hooks.validate?.({ action: 'create', permit, draft })
    return withTx(db, async (trx) => {
      await hooks.beforeWrite?.(trx, { action: 'create', permit, draft })
      let item: TItem
      try {
        item = await insertRow(trx, draft, permit)
      } catch (err) {
        throw mapWriteError(err, `保存${label}失败`, writeErrors)
      }
      await writeAudit(trx, permit.actor, {
        resource: TABLE,
        recordId: item.id,
        recordLabel: recordLabel(item),
        actionType: 'create',
        actionName: 'create',
        companyId: auditCompanyId(item),
        changes: auditCreated(snapshot(meta, item, AUDIT), AUDIT),
        sensitiveFields: meta.audit?.sensitiveFields,
      })
      await hooks.afterWrite?.(trx, { action: 'create', permit, item })
      return item
    })
  }

  async function updateInTx(trx: TrxHandle, permit: Permit, id: string, patch: Record<string, unknown>): Promise<TItem> {
    const before = await loadItem(trx, permit, id, true)
    const draft: Record<string, unknown> = { ...before, ...normalizeInput(patch) }
    hooks.validate?.({ action: 'update', permit, draft, before })
    const changes = auditDiff(snapshot(meta, before, AUDIT), snapshot(meta, draft, AUDIT), AUDIT)
    if (Object.keys(changes).length === 0) return before
    await hooks.beforeWrite?.(trx, { action: 'update', permit, draft, before })
    const sets = writable.map((f) => sql`${sql.id(f.dbColumn)} = ${toDbValue(f, draft[f.apiName])}`)
    sets.push(sql`updated_at = (now() AT TIME ZONE 'utc')`)
    let item: TItem
    try {
      const result = await sql`UPDATE ${sql.id(TABLE)} SET ${sql.join(sets)} WHERE id = ${id}::uuid RETURNING *`.execute(trx)
      item = mapRow(meta, result.rows[0] as Record<string, unknown>) as TItem
    } catch (err) {
      throw mapWriteError(err, `保存${label}失败`, writeErrors)
    }
    await writeAudit(trx, permit.actor, {
      resource: TABLE,
      recordId: id,
      recordLabel: recordLabel(item),
      actionType: 'update',
      actionName: 'update',
      companyId: auditCompanyId(item),
      changes,
      sensitiveFields: meta.audit?.sensitiveFields,
    })
    await hooks.afterWrite?.(trx, { action: 'update', permit, item, before })
    return item
  }

  async function update(permit: Permit, id: string, patch: Record<string, unknown>): Promise<TItem> {
    return withTx(db, (trx) => updateInTx(trx, permit, id, patch))
  }

  async function removeInTx(trx: TrxHandle, permit: Permit, id: string): Promise<void> {
    const item = await loadItem(trx, permit, id, true)
    await hooks.beforeDelete?.(trx, { permit, item })
    try {
      await sql`DELETE FROM ${sql.id(TABLE)} WHERE id = ${id}::uuid`.execute(trx)
    } catch (err) {
      throw mapWriteError(err, `删除${label}失败`, writeErrors)
    }
    await writeAudit(trx, permit.actor, {
      resource: TABLE,
      recordId: id,
      recordLabel: recordLabel(item),
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

  function uniqueIds(ids: readonly string[]): string[] {
    const seen = [...new Set(ids)]
    if (seen.length === 0) throw ApiError.validation(`${label}参数不合法`, { ids: ['不能为空'] })
    return seen
  }

  async function bulkUpdate(permit: Permit, ids: readonly string[], patch: Record<string, unknown>): Promise<TItem[]> {
    const targets = uniqueIds(ids)
    return withTx(db, async (trx) => {
      const items: TItem[] = []
      for (const id of targets) items.push(await updateInTx(trx, permit, id, patch))
      return items
    })
  }

  async function bulkRemove(permit: Permit, ids: readonly string[]): Promise<number> {
    const targets = uniqueIds(ids)
    return withTx(db, async (trx) => {
      for (const id of targets) await removeInTx(trx, permit, id)
      return targets.length
    })
  }

  return { get, list, create, update, remove, bulkUpdate, bulkRemove, meta, stampedColumns }
}
