/**
 * 标准动作内核·服务执行器：meta 声明 + 钩子 → 完整 CRUD 服务。
 *
 * 动作词表：get / list / create / update / remove / bulkUpdate / bulkRemove
 * + 工作流转移 transition / bulkTransition（v2：统一单据状态机 draft→approved→voided，
 * 各资源的动作名/状态值/盖章列经 workflow 声明冻结为既有 wire 形状）。
 * + 在途事务变体 createInTx / updateInTx / removeInTx / transitionInTx（D1：
 * 对齐 numbering.nextInTx；外层事务由调用方持有，Permit 仍是唯一入场券；
 * 不采用可选 trx 参数重载）。
 *
 * 本文件是瘦装配器：记录读侧与写管线骨架（load → normalize → hooks → diff →
 * INSERT/UPDATE/DELETE → mapWriteError → 审计三型 → reload）与 child.ts 共享唯一拷贝
 * （record.ts），以写入闸门（公司可写校验 + 树锁/授权锁行）与列集合参数化；
 * 本文件只留 root 真差异——tree / workflow / numbering / transition / 批量。
 *
 * 平台契约（与手写服务逐字对齐，路由不可区分）：
 * - 授权：列表 listAuthorized、单条/写前 loadAuthorized(forUpdate)、create 走
 *   assertCompanyWritable + ownershipStamp；服务只收 Permit
 * - 审计：白名单自 meta.audit 派生；create/update(有 diff 才写)/destroy 三型；
 *   工作流转移 actionType=update、actionName=转移名（对齐 posting/skeleton 口径）
 * - 无变更 update 不落库不审计，直接返回现值
 * - 约束冲突经 writeErrors 映射为领域文案（mapWriteError）
 *
 * v2 能力：
 * - projection：带 join 的列表/单条投影（source/selectExtra/mapExtra），写后事务内重载
 * - numbering：meta.numbering 资源 create 时自动取号；编号一律系统生成，传非空值 400
 *   （ADR 2026-08-06-system-generated-numbering；wire 层由字段 readonly 挡手填）
 * - workflow：状态机通则合同——可变状态才能改/删；转移表驱动 from→to、盖章、
 *   事务内 effect（过账/占量等调既有引擎）与 after（翻转后副作用）
 * - tree：树锁（advisory，按公司/全局）、父子校验（存在/自身/后代/跨公司）、
 *   物化路径维护与子树重写、有子节点删除保护
 * - extraWhere：list/load 领域行筛选谓词（EXISTS 派生可见性、companyId 过滤、
 *   行内伪筛选等）；可改写 list query（剥离 filter 伪字段交给 filterbuild）
 *
 * 钩子纪律（写进 AGENTS.md）：钩子只做领域不变量与行内充实（可原地改 draft）；
 * 跨资源流程编排不进钩子，留在手写服务与引擎。
 *
 * 逃生舱：任何动作复杂化时，模块可自建同签名函数替换该动作（服务是普通对象），
 * 或整体弹回手写——路由层对两者不可区分。
 */
import type { ListQuery } from '@synie/shared'
import { sql, type RawBuilder } from 'kysely'
import type { Kysely } from 'kysely'
import { mapWriteError, type PgWriteMapping } from '~/db/dberr.ts'
import { assertCompanyWritable, ownershipStamp } from '~/db/load.ts'
import { withTx, type DbHandle, type TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { auditDiff, writeAudit } from '~/platform/audit/write.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'
import { runeLen } from '~/platform/posting/text.ts'
import { companyFieldOf, mapRow, physicalFields, snapshot, toDbValue, writableFields } from './fields.ts'
import { createRecordAccess, createRecordWritePipeline, type RecordWriteGate } from './record.ts'

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
  /**
   * create 的服务端派生列（db 列名 → 值）：readonly 系统列（如无 owner 绑定时的
   * created_by_id、快照时间戳）随 INSERT 一并落库——写在 RETURNING 之前，
   * 故 create 审计快照完整（afterWrite 补写会让审计记 null，不允许）。
   */
  insertColumns?: (ctx: StandardHookContext) => Record<string, unknown>
}

/** 工作流转移上下文（before 为 wire 形现值） */
export interface TransitionContext {
  permit: Permit
  before: Record<string, unknown>
  /** 路由层校验后的转移入参（无输入的转移为空对象） */
  input: Record<string, unknown>
}

/**
 * 状态机转移声明：key 即权限动作码与缺省 URL 段（audit/void/approve/cancel…），
 * from/to 用 wire 形状态值（大写）。effect 在状态翻转前执行（对齐 skeleton
 * 「引擎 → 翻转 → 审计」顺序），可返回附加 SET 列（db 列名 → 值/sql 片段）；
 * after 在翻转与审计后执行（对账结单、级联作废等副作用）。
 */
export interface StandardTransition {
  key: string
  /** 动作文案（审核/作废/…），缺省守卫文案用 */
  label: string
  from: readonly string[]
  to: string
  /** 状态不满足 from 时的 conflict 文案；缺省 `当前状态不可${label}` */
  guardMessage?: string
  /** 盖章列（db 列名 → 值；值可为 sql 片段），如 audited_at/audited_by_id */
  stamps?: (ctx: TransitionContext) => Record<string, unknown>
  /** 事务内效果（过账/占量/红字对冲调既有引擎）；返回值并入状态翻转 UPDATE */
  effect?: (trx: TrxHandle, ctx: TransitionContext) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void
  /** 翻转+审计后的事务内副作用（拿到翻转后的 item） */
  after?: (trx: TrxHandle, ctx: TransitionContext & { item: Record<string, unknown> }) => Promise<void> | void
  /** 审计 actionName 覆盖；缺省取 key */
  auditActionName?: string
}

export interface StandardWorkflow {
  /** 状态字段 apiName；缺省 status */
  statusField?: string
  /** 可修改/删除的状态白名单（wire 形）；缺省 ['DRAFT'] */
  mutableStatuses?: readonly string[]
  /** 非可变状态改/删的 conflict 文案；缺省 `仅草稿${label}可修改或删除` */
  mutableMessage?: string
  transitions: readonly StandardTransition[]
}

/**
 * 树形声明：投影展示（父名/has_children）走 projection，本声明只管写侧不变量。
 * 锁粒度：公司域资源按公司 advisory 锁，全局资源按整表锁。
 */
export interface StandardTree {
  /** 父引用字段 apiName；缺省 parentId */
  parentField?: string
  /** 物化路径列（db 列名，如 path）：声明则内核维护路径与子树重写；未声明用递归 CTE 防环 */
  pathColumn?: string
  /** 父行个性校验（停用检查等）；parent 为父行 wire 形 */
  onParent?: (trx: TrxHandle, ctx: { draft: Record<string, unknown>; parent: Record<string, unknown> }) => void | Promise<void>
  /** 有子节点删除保护文案；缺省 `存在下级${label},不能删除` */
  childBlockMessage?: string
}

/** 带 join 的投影：列表/单条共用一份 SQL；写路径落库后按投影重载返回 */
export interface StandardProjection {
  /** 不含 WHERE 的 FROM 子句（子查询须暴露全部物理列 + 附加列） */
  source: RawBuilder<unknown>
  /** 目标行别名（子查询别名）；缺省 meta.table */
  alias?: string
  /** 附加 SELECT 列（跟在物理列后，不带前导逗号） */
  selectExtra?: RawBuilder<unknown>
  /** 附加列 db 行 → wire 键值（叠加在物理映射之上，可产出嵌套对象） */
  mapExtra?: (row: Record<string, unknown>) => Record<string, unknown>
}

export interface StandardNumbering {
  service: { nextInTx: (handle: DbHandle, input: { resource: string; values?: Record<string, unknown> }) => Promise<string> }
  /** 单号字段 apiName；create 未提供或为空时自动取号 */
  field: string
}

/**
 * list/load 领域行筛选上下文。
 * - `query`：list 为调用方入参（可含 companyId 等扩展键）；load/写前锁行为空对象
 * - `alias`：list/投影 load 为 source 别名；裸表 load 为 meta.table
 */
export interface ExtraWhereContext {
  permit: Permit
  query: Partial<ListQuery> & Record<string, unknown>
  alias: string
}

/**
 * 领域附加行筛选结果：
 * - `where`：AND 进 listAuthorized / loadAuthorized（null/缺省 = 不加）
 * - `query`：覆盖传入 filterbuild 的 list query（如剥离 `lines` 伪筛选）
 */
export interface ExtraWhereResult {
  where?: RawBuilder<unknown> | null
  query?: Partial<ListQuery> & Record<string, unknown>
}

/** list/load 共用的行筛选谓词；返回 null/undefined 等同无附加条件 */
export type ExtraWhere = (ctx: ExtraWhereContext) => ExtraWhereResult | null | undefined

export interface StandardServiceOptions {
  db: Kysely<Database>
  registry: Registry
  /** Registry 资源名（meta 是唯一事实源） */
  resource: string
  /** 缺省 `${label}不存在` */
  notFound?: string
  /** 审计 record_label 覆盖；缺省镜像 lookup 缺省（name → label → code → 首个字符串字段） */
  recordLabel?: (item: Record<string, unknown>) => string | null
  /** 列表缺省排序；缺省 inserted_at DESC, id ASC */
  defaultOrder?: RawBuilder<unknown>
  /** 唯一/外键冲突 → 领域文案 */
  writeErrors?: readonly PgWriteMapping[]
  hooks?: StandardHooks
  projection?: StandardProjection
  numbering?: StandardNumbering
  workflow?: StandardWorkflow
  tree?: StandardTree
  /**
   * list/get/写前锁 共用的领域行筛选（T1.5）。
   * 授权谓词由平台编译；本回调只表达领域谓词（可见性 EXISTS、companyId 等）。
   * load 路径以空 query 调用——依赖 query 的筛选在 get 上 naturally 失效（与既有弹射一致）。
   */
  extraWhere?: ExtraWhere
}

export interface StandardService<TItem extends StandardItem = StandardItem> {
  get(permit: Permit, id: string): Promise<TItem>
  /**
   * 在途读：与 {@link get} 同语义（含 projection / extraWhere），但在调用方持有的
   * handle 上执行——供聚合 `loadDraft` 在 snapshot/trx 内装载头，避免绕开投影。
   */
  getOn(handle: DbHandle, permit: Permit, id: string): Promise<TItem>
  list(permit: Permit, query: Partial<ListQuery>): Promise<{ count: number; results: TItem[] }>
  create(permit: Permit, input: Record<string, unknown>): Promise<TItem>
  /**
   * 在途事务变体（D1）：外层事务由调用方持有；Permit 仍是唯一入场券。
   * 签名对齐 numbering.nextInTx(handle, …)——trx 在前，不采用可选 trx 重载。
   */
  createInTx(trx: TrxHandle, permit: Permit, input: Record<string, unknown>): Promise<TItem>
  update(permit: Permit, id: string, patch: Record<string, unknown>): Promise<TItem>
  updateInTx(trx: TrxHandle, permit: Permit, id: string, patch: Record<string, unknown>): Promise<TItem>
  remove(permit: Permit, id: string): Promise<void>
  removeInTx(trx: TrxHandle, permit: Permit, id: string): Promise<void>
  /** 单事务全成全败；逐行审计 */
  bulkUpdate(permit: Permit, ids: readonly string[], patch: Record<string, unknown>): Promise<TItem[]>
  bulkRemove(permit: Permit, ids: readonly string[]): Promise<number>
  /** 工作流转移（未声明 workflow 时调用即抛错） */
  transition(permit: Permit, id: string, key: string, input?: Record<string, unknown>): Promise<TItem>
  transitionInTx(
    trx: TrxHandle,
    permit: Permit,
    id: string,
    key: string,
    input?: Record<string, unknown>,
  ): Promise<TItem>
  bulkTransition(permit: Permit, ids: readonly string[], key: string, input?: Record<string, unknown>): Promise<TItem[]>
  readonly meta: ResourceMeta
  readonly stampedColumns: ReadonlySet<string>
}

/** 转移盖章便捷式：audited_at/audited_by_id（全站单据盖章列的既有口径） */
export function auditStamp(permit: Permit): Record<string, unknown> {
  return {
    audited_at: sql`(now() AT TIME ZONE 'utc')`,
    audited_by_id: permit.actor.userId || null,
  }
}

export function createStandardService<TItem extends StandardItem = StandardItem>(
  options: StandardServiceOptions,
): StandardService<TItem> {
  const { db, registry, resource, hooks = {}, projection, workflow, tree } = options
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
  if (options.numbering && !meta.numbering) {
    throw new Error(`标准派生：资源 ${resource} 未声明 meta.numbering，不可挂自动取号`)
  }

  const stampedColumns = new Set<string>()
  if (binding.owner) stampedColumns.add(binding.owner.column)
  if (binding.dept?.mode === 'stamped') stampedColumns.add(binding.dept.column)

  const TABLE = meta.table
  const label = meta.label ?? meta.permissionLabel
  const notFound = options.notFound ?? `${label}不存在`
  const writeErrors = options.writeErrors ?? []
  const writable = writableFields(meta, stampedColumns)
  const writableByApi = new Map(writable.map((f) => [f.apiName, f]))
  /** 无差异判定的列面：可写列全集。审计白名单只管审计记录——可写列被 audit.exclude 时不得丢写 */
  const WRITE_COLS = writable.map((f) => f.dbColumn)

  // recordLabel 字段：镜像 catalog-normalize 的 lookup 缺省（name → label → code → 首个字符串字段）
  const byName = (n: string) => meta.fields.find((f) => f.name === n || f.apiName === n)
  const labelField = meta.lookup?.labelField
    ? byName(meta.lookup.labelField)
    : (byName('name') ?? byName('label') ?? byName('code') ?? meta.fields.find((f) => f.type === 'string' && !f.calculated))

  const companyField = companyFieldOf(meta, binding)

  // —— 工作流装配 ——
  const statusField = workflow ? (byName(workflow.statusField ?? 'status') ?? null) : null
  if (workflow && !statusField) {
    throw new Error(`标准派生：资源 ${resource} 声明 workflow 但缺少状态字段 ${workflow.statusField ?? 'status'}`)
  }
  const mutableStatuses = new Set(workflow?.mutableStatuses ?? ['DRAFT'])
  const mutableMessage = workflow?.mutableMessage ?? `仅草稿${label}可修改或删除`
  const transitionsByKey = new Map((workflow?.transitions ?? []).map((t) => [t.key, t]))

  // —— 树形装配 ——
  const parentField = tree ? (byName(tree.parentField ?? 'parentId') ?? null) : null
  if (tree && !parentField) {
    throw new Error(`标准派生：资源 ${resource} 声明 tree 但缺少父引用字段 ${tree.parentField ?? 'parentId'}`)
  }
  // 编号字段装配（存在性校验）
  const numberField = options.numbering ? (byName(options.numbering.field) ?? null) : null
  if (options.numbering && !numberField) {
    throw new Error(`标准派生：资源 ${resource} 编号字段 ${options.numbering.field} 不存在`)
  }

  const access = createRecordAccess<TItem>({
    db,
    meta,
    target,
    label,
    notFound,
    writeErrors,
    projection,
    defaultOrder: options.defaultOrder ?? sql`"inserted_at" DESC, "id" ASC`,
    companyField,
    labelField,
    recordLabel: options.recordLabel,
    extraWhere: options.extraWhere,
    writable,
    writeCols: WRITE_COLS,
  })

  // —— 树形写侧 ——

  /** 树级串行化：公司域按公司锁（父子/子树封闭在一家公司内），全局树整表一把锁 */
  async function lockTree(trx: TrxHandle, scopeValue: string | null): Promise<void> {
    const key = `${TABLE}:${scopeValue ?? ''}`
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`.execute(trx)
  }

  interface ParentRow {
    id: string
    path: string | null
  }

  /**
   * 父子校验（存在/自身/跨公司/后代成环），返回父行（拼路径用）。
   * @param selfPath 移动场景传本节点路径（pathColumn 树）；无路径列用递归 CTE 防环
   */
  async function resolveParent(
    trx: TrxHandle,
    draft: Record<string, unknown>,
    selfId: string | null,
    selfPath: string | null,
  ): Promise<ParentRow | null> {
    const pf = parentField!
    const parentId = draft[pf.apiName]
    if (parentId === null || parentId === undefined) return null
    const invalid = (msg: string): never => {
      throw ApiError.validation(`${label}参数不合法`, { [pf.apiName]: [msg] })
    }
    if (selfId !== null && parentId === selfId) invalid(`上级${label}不能选择自身`)
    const pathSel = tree!.pathColumn ? sql`, ${sql.id(tree!.pathColumn)} AS path` : sql``
    const result = await sql<Record<string, unknown>>`
      SELECT * ${pathSel} FROM ${sql.id(TABLE)} WHERE id = ${parentId}::uuid
    `.execute(trx)
    const parent = result.rows[0]
    if (!parent) invalid(`上级${label}不存在`)
    if (companyField) {
      const draftCompany = draft[companyField.apiName]
      if (String(parent![companyField.dbColumn]) !== String(draftCompany)) {
        invalid(`上级${label}必须属于同一公司`)
      }
    }
    if (tree!.pathColumn) {
      if (selfPath !== null && String(parent!.path).startsWith(selfPath)) {
        invalid(`上级${label}不能是自身的下级`)
      }
    } else if (selfId !== null) {
      // 无物化路径列：递归 CTE 沿新父的祖先链找自身即成环
      const cycle = await sql<{ id: string }>`
        WITH RECURSIVE ancestors AS (
          SELECT id, ${sql.id(parentField!.dbColumn)} AS parent_id FROM ${sql.id(TABLE)} WHERE id = ${parentId}::uuid
          UNION ALL
          SELECT t.id, t.${sql.id(parentField!.dbColumn)} FROM ${sql.id(TABLE)} t
          JOIN ancestors a ON t.id = a.parent_id
        )
        SELECT id FROM ancestors WHERE id = ${selfId}::uuid LIMIT 1
      `.execute(trx)
      if (cycle.rows.length > 0) invalid(`上级${label}不能是自身的下级`)
    }
    await tree!.onParent?.(trx, { draft, parent: mapRow(meta, parent!) })
    return { id: String(parent!.id), path: tree!.pathColumn ? String(parent!.path) : null }
  }

  /** 物化路径：`/{祖先id}/…/{本id}/`；一级节点即 `/{id}/` */
  function childPath(parentPath: string | null, id: string): string {
    return `${parentPath ?? '/'}${id}/`
  }

  /** 工作流可变状态门：非可变状态的改/删一律 conflict */
  function assertMutable(before: Record<string, unknown>): void {
    if (!workflow || !statusField) return
    const status = before[statusField.apiName]
    if (!mutableStatuses.has(String(status))) {
      throw new ApiError('conflict', mutableMessage)
    }
  }

  /** 树形移动前置（更新路径重算的公共段）：返回本行路径（无树/无路径列为 null） */
  async function treePathOf(trx: TrxHandle, id: string): Promise<string | null> {
    if (!tree?.pathColumn) return null
    const result = await sql<Record<string, unknown>>`
      SELECT ${sql.id(tree.pathColumn)} AS path FROM ${sql.id(TABLE)} WHERE id = ${id}::uuid
    `.execute(trx)
    if (result.rows.length === 0) throw new ApiError('not_found', notFound)
    return String(result.rows[0]!.path)
  }

  // —— 写闸门：公司可写校验（create）+ 树锁/授权锁行（update/remove）——
  const gate: RecordWriteGate<TItem, {}> = {
    async prepareCreate(_trx, permit, draft) {
      if (companyField) {
        const companyId = draft[companyField.apiName]
        if (typeof companyId !== 'string' || !companyId) {
          throw ApiError.validation(`${label}参数不合法`, { [companyField.apiName]: ['不能为空'] })
        }
        assertCompanyWritable(permit, companyId, notFound)
      }
      return {}
    },
    async lockForUpdate(trx, permit, id) {
      if (tree && companyField) {
        // 树锁先于行锁（对齐既有加锁顺序）；公司列 createOnly 不会变，无锁读安全
        const result = await sql<Record<string, unknown>>`
          SELECT ${sql.id(companyField.dbColumn)} AS company FROM ${sql.id(TABLE)} WHERE id = ${id}::uuid
        `.execute(trx)
        if (result.rows.length === 0) throw new ApiError('not_found', notFound)
        await lockTree(trx, String(result.rows[0]!.company))
      } else if (tree) {
        await lockTree(trx, null)
      }
      const before = await access.loadBare(trx, permit, id, true)
      return { before, context: {} }
    },
  }

  const pipeline = createRecordWritePipeline(access, {
    gate,
    hooks,
    assertInput(input) {
      // 编号一律系统生成：readonly 使 wire 层拿不到编号键；服务层调用方传非空值同样 400，
      // 不做静默丢弃（ADR 2026-08-06-system-generated-numbering：编号由系统生成,不接受手填）
      if (options.numbering && numberField) {
        const provided = input[numberField.apiName]
        if (provided !== undefined && provided !== null && String(provided).trim() !== '') {
          throw ApiError.validation('编号由系统生成,不接受手填', {
            [numberField.apiName]: ['编号由系统生成,不接受手填'],
          })
        }
      }
    },
    async beforeCreateWrite(trx, draft) {
      if (tree) {
        await lockTree(trx, companyField ? String(draft[companyField.apiName]) : null)
      }
    },
    async insertColumns(trx, { permit, draft }) {
      const extraCols: Record<string, unknown> = { ...ownershipStamp(permit, target) }
      if (tree) {
        const parent = await resolveParent(trx, draft, null, null)
        if (tree.pathColumn) {
          const id = crypto.randomUUID()
          extraCols.id = id
          extraCols[tree.pathColumn] = childPath(parent?.path ?? null, id)
        }
      }
      if (hooks.insertColumns) Object.assign(extraCols, hooks.insertColumns({ action: 'create', permit, draft }))
      if (options.numbering && numberField) {
        // 编号一律系统生成（ADR 2026-08-06-system-generated-numbering）：
        // wire 层 readonly 已挡手填；内部调用方传非空值同样 400，不做静默覆盖
        const current = draft[numberField.apiName]
        if (current !== undefined && current !== null && String(current).trim() !== '') {
          throw ApiError.validation('编号由系统生成,不接受手填', {
            [numberField.apiName]: ['编号由系统生成,不接受手填'],
          })
        }
        const values: Record<string, unknown> = {}
        for (const field of physicalFields(meta)) {
          const v = draft[field.apiName]
          if (v !== undefined) values[field.dbColumn] = toDbValue(field, v)
        }
        const assigned = await options.numbering.service.nextInTx(trx, {
          resource: meta.permissionPrefix,
          values,
        })
        if (numberField.maxLength !== undefined && runeLen(assigned) > numberField.maxLength) {
          throw ApiError.validation(`${label}参数不合法`, {
            [numberField.apiName]: [`最多 ${numberField.maxLength} 个字符`],
          })
        }
        draft[numberField.apiName] = assigned
        // 编号字段声明 readonly（wire 不可写）时不在可写列集，须经 extraCols 落库（与树 path 同形态）；
        // 可写编号字段（个别夹具/过渡资源）已随 draft 进可写列，勿重复
        if (!writableByApi.has(numberField.apiName)) {
          extraCols[numberField.dbColumn] = assigned
        }
      }
      return extraCols
    },
    onLocked: (before) => assertMutable(before),
    async beforeUpdate(trx, { id, draft, before }) {
      if (!tree || !parentField) return undefined
      const moved = draft[parentField.apiName] !== before[parentField.apiName]
      if (!moved) return undefined
      const selfPath = await treePathOf(trx, id)
      const parent = await resolveParent(trx, draft, id, selfPath)
      if (tree.pathColumn && selfPath) {
        const pathRewrite = { oldPath: selfPath, newPath: childPath(parent?.path ?? null, id) }
        // 移动节点即改写整棵子树的物化路径（含自身：oldPath 处的后缀为空串）
        return async (post: TrxHandle) => {
          // ::int 必须显式：无类型参数会让 PG 选中 substring(text FROM text) 的正则重载
          await sql`
            UPDATE ${sql.id(TABLE)}
            SET ${sql.id(tree.pathColumn!)} = ${pathRewrite.newPath} || substring(${sql.id(tree.pathColumn!)} FROM ${pathRewrite.oldPath.length + 1}::int),
                updated_at = (now() AT TIME ZONE 'utc')
            WHERE ${sql.id(tree.pathColumn!)} LIKE ${pathRewrite.oldPath} || '%'
          `.execute(post)
        }
      }
      return undefined
    },
    async beforeRemove(trx, before) {
      if (tree && parentField) {
        const child = await sql<{ id: string }>`
          SELECT id FROM ${sql.id(TABLE)} WHERE ${sql.id(parentField.dbColumn)} = ${before.id}::uuid LIMIT 1
        `.execute(trx)
        if (child.rows.length > 0) {
          throw new ApiError('conflict', tree.childBlockMessage ?? `存在下级${label},不能删除`)
        }
      }
    },
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

  function uniqueIds(ids: readonly string[]): string[] {
    const seen = [...new Set(ids)]
    if (seen.length === 0) throw ApiError.validation(`${label}参数不合法`, { ids: ['不能为空'] })
    return seen
  }

  async function bulkUpdate(permit: Permit, ids: readonly string[], patch: Record<string, unknown>): Promise<TItem[]> {
    const targets = uniqueIds(ids)
    return withTx(db, async (trx) => {
      const items: TItem[] = []
      for (const id of targets) items.push(await pipeline.updateInTx(trx, permit, id, patch))
      return items
    })
  }

  async function bulkRemove(permit: Permit, ids: readonly string[]): Promise<number> {
    const targets = uniqueIds(ids)
    return withTx(db, async (trx) => {
      for (const id of targets) await pipeline.removeInTx(trx, permit, id)
      return targets.length
    })
  }

  // —— 工作流转移 ——

  async function transitionInTx(
    trx: TrxHandle,
    permit: Permit,
    id: string,
    key: string,
    input: Record<string, unknown> = {},
  ): Promise<TItem> {
    const t = transitionsByKey.get(key)
    if (!t || !statusField) {
      throw new Error(`标准派生：资源 ${resource} 未声明工作流转移 ${key}`)
    }
    const before = await access.loadBare(trx, permit, id, true)
    const status = String(before[statusField.apiName])
    if (!t.from.includes(status)) {
      throw new ApiError('conflict', t.guardMessage ?? `当前状态不可${t.label}`)
    }
    const ctx: TransitionContext = { permit, before, input }
    const extraSets = (await t.effect?.(trx, ctx)) ?? {}
    const sets: RawBuilder<unknown>[] = [
      sql`${sql.id(statusField.dbColumn)} = ${toDbValue(statusField, t.to)}`,
      sql`updated_at = (now() AT TIME ZONE 'utc')`,
    ]
    for (const [column, value] of Object.entries({ ...(t.stamps?.(ctx) ?? {}), ...extraSets })) {
      sets.push(sql`${sql.id(column)} = ${value}`)
    }
    let item: TItem
    try {
      const result = await sql`UPDATE ${sql.id(TABLE)} SET ${sql.join(sets)} WHERE id = ${id}::uuid RETURNING *`.execute(trx)
      item = mapRow(meta, result.rows[0] as Record<string, unknown>) as TItem
    } catch (err) {
      throw mapWriteError(err, `保存${label}失败`, writeErrors)
    }
    const changes = auditDiff(snapshot(meta, before, access.AUDIT), snapshot(meta, item, access.AUDIT), access.AUDIT)
    await writeAudit(trx, permit.actor, {
      resource: TABLE,
      recordId: id,
      recordLabel: access.recordLabel(item),
      actionType: 'update',
      actionName: t.auditActionName ?? t.key,
      companyId: access.auditCompanyId(item),
      changes,
      sensitiveFields: meta.audit?.sensitiveFields,
    })
    await t.after?.(trx, { ...ctx, item })
    return access.reload(trx, permit, item)
  }

  async function transition(
    permit: Permit,
    id: string,
    key: string,
    input: Record<string, unknown> = {},
  ): Promise<TItem> {
    return withTx(db, (trx) => transitionInTx(trx, permit, id, key, input))
  }

  async function bulkTransition(
    permit: Permit,
    ids: readonly string[],
    key: string,
    input: Record<string, unknown> = {},
  ): Promise<TItem[]> {
    const targets = uniqueIds(ids)
    return withTx(db, async (trx) => {
      const items: TItem[] = []
      for (const id of targets) items.push(await transitionInTx(trx, permit, id, key, input))
      return items
    })
  }

  return {
    get: access.get,
    getOn: access.getOn,
    list: access.list,
    create,
    createInTx: pipeline.createInTx,
    update,
    updateInTx: pipeline.updateInTx,
    remove,
    removeInTx: pipeline.removeInTx,
    bulkUpdate,
    bulkRemove,
    transition,
    transitionInTx,
    bulkTransition,
    meta,
    stampedColumns,
  }
}
