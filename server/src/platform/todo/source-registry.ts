import { sql, type RawBuilder } from 'kysely'
import { ApiError } from '../http/errors.ts'
import type { ResourceMeta } from '../meta/types.ts'

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/

/**
 * 待办源单据声明：业务域注册 sourceType → 权限 / 草稿关联判定。
 * platform/todo 只消费 registry，不硬编码业务表名与权限码。
 */
export interface TodoDraftLinkSpec {
  /** 关联表（业务域注册；标识符经 register 校验） */
  table: string
  /** 指向 todo.source_id 的外键列 */
  fkColumn: string
  /** 视为「已挂草稿」的状态列与值（默认 status='draft'） */
  statusColumn?: string
  statusValue?: string
}

export interface TodoSourceSpec {
  /** 操作待办（list / read / dismiss）所需权限，任一命中即可 */
  actionPermissions: readonly string[]
  /** 未读徽标所需权限（通常比 action 更宽，含 :read） */
  unreadPermissions: readonly string[]
  /** 可选：是否已挂草稿单据（驱动 draftInvoiceLinked） */
  draftLink?: TodoDraftLinkSpec
}

/**
 * 对手方名称解析：party_type → 业务表。
 * 业务域注册，platform 拼 CASE 表达式时只读 registry。
 */
export interface TodoPartySpec {
  table: string
  nameColumn: string
}

export function createTodoSourceRegistry() {
  const sources = new Map<string, TodoSourceSpec>()
  const parties = new Map<string, TodoPartySpec>()

  function registerSource(sourceType: string, spec: TodoSourceSpec): void {
    if (!sourceType) throw new Error('todo: sourceType 不能为空')
    if (!spec.actionPermissions?.length) {
      throw new Error(`todo: sourceType=${sourceType} 缺少 actionPermissions`)
    }
    if (!spec.unreadPermissions?.length) {
      throw new Error(`todo: sourceType=${sourceType} 缺少 unreadPermissions`)
    }
    if (spec.draftLink) {
      assertIdentifier(spec.draftLink.table, 'draftLink.table')
      assertIdentifier(spec.draftLink.fkColumn, 'draftLink.fkColumn')
      if (spec.draftLink.statusColumn) {
        assertIdentifier(spec.draftLink.statusColumn, 'draftLink.statusColumn')
      }
    }
    if (sources.has(sourceType)) {
      throw new Error(`重复待办源注册: ${sourceType}`)
    }
    sources.set(sourceType, {
      actionPermissions: [...spec.actionPermissions],
      unreadPermissions: [...spec.unreadPermissions],
      draftLink: spec.draftLink ? { ...spec.draftLink } : undefined,
    })
  }

  function registerParty(partyType: string, spec: TodoPartySpec): void {
    if (!partyType) throw new Error('todo: partyType 不能为空')
    assertIdentifier(spec.table, 'party.table')
    assertIdentifier(spec.nameColumn, 'party.nameColumn')
    if (parties.has(partyType)) {
      throw new Error(`重复待办对手类型注册: ${partyType}`)
    }
    parties.set(partyType, { ...spec })
  }

  function lookupSource(sourceType: string): TodoSourceSpec | undefined {
    return sources.get(sourceType)
  }

  function allSources(): ReadonlyMap<string, TodoSourceSpec> {
    return new Map(sources)
  }

  function allParties(): ReadonlyMap<string, TodoPartySpec> {
    return new Map(parties)
  }

  /** 任一已注册源的 actionPermissions 命中 */
  function actionPermissionCodes(): string[] {
    const set = new Set<string>()
    for (const spec of sources.values()) {
      for (const p of spec.actionPermissions) set.add(p)
    }
    return [...set]
  }

  /** 任一已注册源的 unreadPermissions 命中 */
  function unreadPermissionCodes(): string[] {
    const set = new Set<string>()
    for (const spec of sources.values()) {
      for (const p of spec.unreadPermissions) set.add(p)
    }
    return [...set]
  }

  return {
    registerSource,
    registerParty,
    lookupSource,
    allSources,
    allParties,
    actionPermissionCodes,
    unreadPermissionCodes,
  }
}

export type TodoSourceRegistry = ReturnType<typeof createTodoSourceRegistry>

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(`todo: ${label} 非法标识符: ${value}`)
  }
}

/** 由 registry 拼 party_name CASE 表达式（无注册则空串） */
export function buildPartyNameCase(registry: TodoSourceRegistry): RawBuilder<unknown> {
  const parts: RawBuilder<unknown>[] = []
  for (const [partyType, spec] of registry.allParties()) {
    // table/nameColumn 经 register 时标识符校验，可 sql.raw
    const sub = sql.raw(
      `COALESCE((SELECT ${spec.nameColumn} FROM ${spec.table} WHERE id=todo.party_id),'')`,
    )
    parts.push(sql`WHEN ${partyType} THEN ${sub}`)
  }
  if (parts.length === 0) {
    return sql`''`
  }
  return sql`CASE todo.party_type ${sql.join(parts, sql` `)} ELSE '' END`
}

/** 由 registry 拼 draft_invoice_linked CASE 表达式 */
export function buildDraftLinkedCase(registry: TodoSourceRegistry): RawBuilder<unknown> {
  const parts: RawBuilder<unknown>[] = []
  for (const [sourceType, spec] of registry.allSources()) {
    if (!spec.draftLink) continue
    const link = spec.draftLink
    const statusCol = link.statusColumn ?? 'status'
    const statusVal = link.statusValue ?? 'draft'
    // 标识符已校验；状态值走参数位
    const head = sql.raw(
      `EXISTS(SELECT 1 FROM ${link.table} inv WHERE inv.${link.fkColumn}=todo.source_id AND inv.${statusCol}=`,
    )
    const tail = sql.raw(`)`)
    parts.push(sql`WHEN ${sourceType} THEN ${head}${statusVal}${tail}`)
  }
  if (parts.length === 0) {
    return sql`false`
  }
  return sql`CASE todo.source_type ${sql.join(parts, sql` `)} ELSE false END`
}

/** 注册表为空时拒绝查询（fail-closed） */
export function assertSourcesRegistered(registry: TodoSourceRegistry): void {
  if (registry.allSources().size === 0) {
    throw new ApiError('internal', '待办源未注册')
  }
}

/**
 * 启动期一致性断言（组合根调用）：
 * 1. 双向镜像：meta.todoSource 声明的 source_type 与 registerSource 注册项必须一一对应，
 *    抓「开待办的资源忘了配权限 spec」与「注册了 spec 却没人开待办」两个方向；
 * 2. 有效性：draftLink / party 引用的表与列必须存在于 Meta Registry（防手抄表名漂移）。
 */
export function assertTodoSourcesConsistent(
  resources: ResourceMeta[],
  registry: TodoSourceRegistry,
): void {
  const declared = new Set(
    resources.filter((r) => r.todoSource).map((r) => r.todoSource as string),
  )
  const registered = new Set(registry.allSources().keys())
  const missing = [...declared].filter((s) => !registered.has(s))
  const extra = [...registered].filter((s) => !declared.has(s))
  if (missing.length || extra.length) {
    throw new Error(
      `todo: 待办源声明与注册不一致: 声明未注册=[${missing.join(',')}] 注册未声明=[${extra.join(',')}]`,
    )
  }

  const byTable = new Map(resources.map((r) => [r.table, r]))
  const hasColumn = (meta: ResourceMeta, column: string) =>
    meta.fields.some((f) => f.dbColumn === column)

  for (const [sourceType, spec] of registry.allSources()) {
    if (!spec.draftLink) continue
    const target = byTable.get(spec.draftLink.table)
    if (!target) {
      throw new Error(`todo: 源 ${sourceType} 的 draftLink.table ${spec.draftLink.table} 不在 Meta Registry`)
    }
    for (const column of [spec.draftLink.fkColumn, spec.draftLink.statusColumn ?? 'status']) {
      if (!hasColumn(target, column)) {
        throw new Error(`todo: 源 ${sourceType} 的 draftLink 列 ${column} 不在 ${target.name} 字段中`)
      }
    }
  }
  for (const [partyType, spec] of registry.allParties()) {
    const target = byTable.get(spec.table)
    if (!target) {
      throw new Error(`todo: 对手类型 ${partyType} 的表 ${spec.table} 不在 Meta Registry`)
    }
    if (!hasColumn(target, spec.nameColumn)) {
      throw new Error(`todo: 对手类型 ${partyType} 的列 ${spec.nameColumn} 不在 ${target.name} 字段中`)
    }
  }
}
