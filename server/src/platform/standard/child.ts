/**
 * 标准动作内核·子行服务：单据行等 via 资源的 CRUD 派生。
 *
 * 本文件是瘦装配器：记录读侧与写管线骨架（load → normalize → hooks → diff →
 * INSERT/UPDATE/DELETE → mapWriteError → 审计三型 → reload）与 service.ts 共享唯一拷贝
 * （record.ts），以写入闸门（锁母单 → 状态门 → 带入列 → 锁行）与列集合
 * （writable + inherit 带入列 + derived 派生列）参数化；本文件只留 child 真差异——
 * parent 链（含孙级装配断言）、母单锁/带入、listByParentOn。
 *
 * 与标准服务的差异：
 * - 授权：via 目标，行级可达性递归到母单谓词；写侧以「锁母单（授权）→ 状态门」
 *   取代 assertCompanyWritable，行不存在与母单不可达同为 not_found
 * - 加锁顺序：母单先锁（授权 + 状态门），再锁行——与既有手写并发路径一致
 * - 带入列（company_id 等）：inheritFields 声明，wire 不可写，创建时从母单带入
 * - 无批量/工作流/树形/编号（单据行不需要；需要即弹射回手写）
 *
 * 孙级（D3）：`parent.resource` 允许指向另一 child 资源（价格档 → 条目 → 头；
 * 装箱行 → 箱 → 发货单）。装配期断言 via 链深 ≤ {@link MAX_CHILD_PARENT_DEPTH}（=2），
 * 不做任意深度递归。锁的「母单」始终是直接 parent（中间层），根单据状态门由模块
 * gate/钩子或聚合层负责。
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
import type { PgWriteMapping } from '~/db/dberr.ts'
import { ident } from '~/db/ident.ts'
import { loadAuthorized } from '~/db/load.ts'
import { withTx, type DbHandle, type TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'
import { mapRow, physicalFields, writableFields } from './fields.ts'
import { createRecordAccess, createRecordWritePipeline, type RecordWriteGate } from './record.ts'
import type { ExtraWhere, StandardItem, StandardProjection } from './service.ts'

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

/**
 * 子行 parent 链深度上限（D3）：root→child 为 1，root→child→grandchild 为 2。
 * 价格档 / 装箱行足够；超过则装配期失败，不做任意深度递归。
 */
export const MAX_CHILD_PARENT_DEPTH = 2

export interface StandardChildParent {
  /**
   * 直接母资源 Registry 名。
   * 允许指向另一 child（孙级，D3）；装配期按 via 链断言深度 ≤ {@link MAX_CHILD_PARENT_DEPTH}。
   */
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
  /**
   * list/get 领域行筛选（与 root extraWhere 同语义，T1.5）。
   * 写路径仍先锁母单再锁行；本谓词加在行 list/get 的授权查询上。
   */
  extraWhere?: ExtraWhere
}

export interface StandardChildService<TItem extends StandardItem = StandardItem> {
  get(permit: Permit, id: string): Promise<TItem>
  /**
   * 在途读：与 {@link get} 同语义（含 projection / extraWhere），在调用方 handle 上执行。
   */
  getOn(handle: DbHandle, permit: Permit, id: string): Promise<TItem>
  list(permit: Permit, query: Partial<ListQuery>): Promise<{ count: number; results: TItem[] }>
  /**
   * 母下全部子行（无分页截断）：投影与 list/get 同口径。
   * 供聚合 loadTree 装载集合；授权已在头/母行路径完成，此处只按 FK 过滤。
   */
  listByParentOn(handle: DbHandle, parentId: string): Promise<TItem[]>
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

/**
 * 装配期：parent.resource 可指 child，但 via 链深（本资源相对根的层数）不得超过上限。
 * 从直接 parent 沿 meta.authz.via 上行计数；成环或未知资源同步 fail-closed。
 */
export function assertChildParentChainDepth(
  resource: string,
  parentResource: string,
  registry: Registry,
): void {
  let depth = 1
  let currentName = parentResource
  const seen = new Set<string>([resource])
  for (;;) {
    if (seen.has(currentName)) {
      throw new Error(`标准子行派生：资源 ${resource} 的 parent 链成环（经 ${currentName}）`)
    }
    seen.add(currentName)
    const current = registry.get(currentName)
    if (!current) throw new Error(`标准子行派生：未知母单资源 ${currentName}`)
    const authz = current.authz
    if (!authz || authz.kind !== 'via') break
    depth += 1
    if (depth > MAX_CHILD_PARENT_DEPTH) {
      throw new Error(
        `标准子行派生：资源 ${resource} 的 parent 链深 ${depth} 超过上限 ${MAX_CHILD_PARENT_DEPTH}（仅支持到孙级，D3）`,
      )
    }
    if (!authz.parent) {
      throw new Error(`标准子行派生：资源 ${currentName} 的 via 声明缺少 parent`)
    }
    currentName = authz.parent
  }
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
  // D3：parent 可指 child；装配期断言链深 ≤ 2，并与 meta.authz.via 对齐（防描述符漂移）
  if (meta.authz?.kind === 'via' && meta.authz.parent !== parent.resource) {
    throw new Error(
      `标准子行派生：资源 ${resource} 的 parent.resource=${parent.resource} 与 meta.authz.parent=${meta.authz.parent} 不一致`,
    )
  }
  assertChildParentChainDepth(resource, parent.resource, registry)
  const target = registry.authzTarget(resource)
  const parentTarget = registry.authzTarget(parent.resource)

  const TABLE = meta.table
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
  /** 无差异判定的列面：可写列 + 派生列。审计白名单只管审计记录（可写列被 exclude 不得丢写） */
  const WRITE_COLS = [...writable, ...derivedFields].map((f) => f.dbColumn)

  const labelField = meta.lookup?.labelField
    ? byName(meta.lookup.labelField)
    : (byName('name') ?? byName('label') ?? byName('code') ?? meta.fields.find((f) => f.type === 'string' && !f.calculated))

  // 子行公司列是母单（判定归宿根）公司列的镜像带入：列名由根 authz 绑定派生，不用字面量。
  // 根无 company（global 归宿）或子行未带入该列（如工单组件/工艺/副产物）→ 无公司归属
  const rootCompany = parentTarget.root.company
  const companyField = rootCompany
    ? physicalFields(meta).find((f) => f.dbColumn === rootCompany.column)
    : undefined

  const access = createRecordAccess<TItem>({
    db,
    meta,
    target,
    label,
    notFound,
    writeErrors,
    projection,
    defaultOrder: options.defaultOrder ?? sql`"idx" ASC, "id" ASC`,
    companyField,
    labelField,
    recordLabel: options.recordLabel,
    extraWhere: options.extraWhere,
    writable,
    insertFields: [...inheritFields, ...derivedFields],
    updateFields: derivedFields,
    writeCols: WRITE_COLS,
  })

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

  /**
   * 聚合装载：母下全量子行（无 LIMIT）。
   * 投影与 get/list 共用 SELECT/SOURCE/mapRowFull；不走 listAuthorized 分页。
   */
  async function listByParentOn(handle: DbHandle, parentId: string): Promise<TItem[]> {
    const result = await sql<Record<string, unknown>>`
      ${access.SELECT}${access.SOURCE}
      WHERE ${ident(access.ALIAS)}.${ident(fkField!.dbColumn)} = ${parentId}::uuid
      ORDER BY ${access.defaultOrder}
    `.execute(handle)
    return result.rows.map((row) => access.mapRowFull(row))
  }

  // —— 写闸门：锁母单（授权 + 状态门）→ 带入列 → 锁行 ——
  const gate: RecordWriteGate<TItem, { parent: Record<string, unknown> }> = {
    async prepareCreate(trx, permit, draft) {
      const parentId = draft[fkField!.apiName]
      if (typeof parentId !== 'string' || !parentId) {
        throw ApiError.validation(`${label}参数不合法`, { [fkField!.apiName]: ['不能为空'] })
      }
      const parentWire = await lockParent(trx, permit, parentId)
      for (const field of inheritFields) {
        draft[field.apiName] = parentWire[field.apiName]
      }
      return { parent: parentWire }
    },
    async lockForUpdate(trx, permit, id) {
      const parentWire = await parentOf(trx, permit, id)
      const before = await lockRow(trx, id)
      return { before, context: { parent: parentWire } }
    },
  }

  const pipeline = createRecordWritePipeline(access, {
    gate,
    hooks,
    // 派生列在 beforeWrite 充实（物料快照等），须先充实再按 WRITE_COLS 判落库
    beforeWriteBeforeDiff: true,
    // 审计 record_label 取投影后记录（子行名称在 join 引用上），写后返回值审计前重载
    auditLabelFromProjection: true,
  })

  async function create(permit: Permit, input: Record<string, unknown>): Promise<TItem> {
    return withTx(db, (trx) => pipeline.createInTx(trx, permit, input))
  }

  async function update(permit: Permit, id: string, patch: Record<string, unknown>): Promise<TItem> {
    return withTx(db, (trx) => pipeline.updateInTx(trx, permit, id, patch))
  }

  async function remove(permit: Permit, id: string): Promise<void> {
    await withTx(db, (trx) => pipeline.removeInTx(trx, permit, id))
  }

  return {
    get: access.get,
    getOn: access.getOn,
    list: access.list,
    listByParentOn,
    create,
    createInTx: pipeline.createInTx,
    update,
    updateInTx: pipeline.updateInTx,
    remove,
    removeInTx: pipeline.removeInTx,
    meta,
    stampedColumns,
  }
}
