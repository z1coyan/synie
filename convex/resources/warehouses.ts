import { v } from 'convex/values'
import type { PaginationResult } from 'convex/server'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import type { Actor } from '../lib/actor'
import { permissionedMutation, permissionedQuery } from '../lib/auth'
import { canAccessCompany } from '../lib/companyScope'
import { synieError, validationError } from '../lib/errors'
import { paginationOptions, rejectSearch, requireSearchTerm, resourcePage } from '../lib/pagination'
import { normalizeWarehouse } from './model'
import { asDomainMutationCtx } from '../lib/mutationContext'
import { changedFields } from '../platform/audit/model'
import { writeAudit } from '../platform/audit/write'
import { seedDefaultWarehouses } from './warehouseSeed'

const partyType = v.union(v.literal('SUPPLIER'), v.literal('COMPANY'), v.null())
const warehouse = v.object({
  id: v.id('warehouses'),
  name: v.string(),
  isLeaf: v.boolean(),
  active: v.boolean(),
  isOutsourced: v.boolean(),
  partyType,
  partyId: v.union(v.string(), v.null()),
  allowNegative: v.boolean(),
  insertedAt: v.number(),
  updatedAt: v.number(),
  companyId: v.string(),
  parentId: v.union(v.id('warehouses'), v.null()),
  accountId: v.union(v.string(), v.null()),
  company: v.object({ id: v.string(), name: v.string(), code: v.string() }),
  parent: v.union(v.object({ id: v.id('warehouses'), name: v.string() }), v.null()),
  account: v.union(v.object({ id: v.string(), name: v.string(), code: v.string() }), v.null()),
  hasChildren: v.boolean(),
})
const page = v.object({
  results: v.array(warehouse),
  pageInfo: v.object({ continueCursor: v.union(v.string(), v.null()), isDone: v.boolean() }),
})

type ReadCtx = Pick<QueryCtx, 'db'> | Pick<MutationCtx, 'db'>

async function companyAny(ctx: ReadCtx, rawId: string) {
  const formalId = ctx.db.normalizeId('companies', rawId)
  const formal = formalId ? await ctx.db.get(formalId) : null
  if (formal) return formal
  const pilotId = ctx.db.normalizeId('pilotCompanies', rawId)
  return pilotId ? ctx.db.get(pilotId) : null
}

async function accountAny(ctx: ReadCtx, rawId: string) {
  const formalId = ctx.db.normalizeId('accounts', rawId)
  const formal = formalId ? await ctx.db.get(formalId) : null
  if (formal) return formal
  const pilotId = ctx.db.normalizeId('pilotAccounts', rawId)
  return pilotId ? ctx.db.get(pilotId) : null
}

async function supplierAny(ctx: ReadCtx, rawId: string) {
  const formalId = ctx.db.normalizeId('suppliers', rawId)
  const formal = formalId ? await ctx.db.get(formalId) : null
  if (formal) return formal
  const pilotId = ctx.db.normalizeId('pilotSuppliers', rawId)
  return pilotId ? ctx.db.get(pilotId) : null
}

async function present(ctx: ReadCtx, row: Doc<'warehouses'>) {
  const [company, parent, account, child] = await Promise.all([
    companyAny(ctx, row.companyId),
    row.parentId ? ctx.db.get(row.parentId) : null,
    row.accountId ? accountAny(ctx, row.accountId) : null,
    ctx.db.query('warehouses').withIndex('by_parent', (query) => query.eq('parentId', row._id)).first(),
  ])
  if (!company) throw synieError('internal', '仓库引用的公司不存在')
  return {
    id: row._id,
    name: row.name,
    isLeaf: row.isLeaf,
    active: row.active,
    isOutsourced: row.isOutsourced,
    partyType: row.partyType,
    partyId: row.partyId,
    allowNegative: row.allowNegative,
    insertedAt: row.insertedAt,
    updatedAt: row.updatedAt,
    companyId: row.companyId,
    parentId: row.parentId,
    accountId: row.accountId,
    company: { id: company._id, name: company.name, code: company.code },
    parent: parent ? { id: parent._id, name: parent.name } : null,
    account: account ? { id: account._id, name: account.name, code: account.code } : null,
    hasChildren: child !== null,
  }
}

function snapshot(row: Awaited<ReturnType<typeof present>>) {
  return {
    name: row.name,
    isLeaf: row.isLeaf,
    active: row.active,
    isOutsourced: row.isOutsourced,
    partyType: row.partyType,
    partyId: row.partyId,
    allowNegative: row.allowNegative,
    companyId: row.companyId,
    parentId: row.parentId,
    accountId: row.accountId,
  }
}

function requireCompanyAccess(actor: Actor, companyId: string): void {
  if (!canAccessCompany(actor, companyId)) throw synieError('forbidden', '无权在该公司下操作数据')
}

async function requireCompany(ctx: ReadCtx, companyId: string) {
  const company = await companyAny(ctx, companyId)
  if (!company) throw validationError('仓库参数不合法', { companyId: ['公司不存在'] })
  return company
}

async function validateRelations(
  ctx: ReadCtx,
  id: Id<'warehouses'> | null,
  input: ReturnType<typeof normalizeWarehouse>,
): Promise<void> {
  await requireCompany(ctx, input.companyId)
  if (input.parentId) {
    const parentId = ctx.db.normalizeId('warehouses', input.parentId)
    const parent = parentId ? await ctx.db.get(parentId) : null
    if (!parent) throw validationError('仓库参数不合法', { parentId: ['上级仓库不存在'] })
    if (id && parent._id === id) throw validationError('仓库参数不合法', { parentId: ['上级仓库不能选择自身'] })
    if (parent.companyId !== input.companyId) throw validationError('仓库参数不合法', { parentId: ['上级仓库不属于本公司'] })
    if (parent.isLeaf) throw validationError('仓库参数不合法', { parentId: ['上级仓库是叶子仓库,不能挂子仓库'] })

    // Follow the parent chain with direct ID reads; never scan the table.
    const visited = new Set<string>()
    let cursor: Doc<'warehouses'> | null = parent
    while (cursor) {
      if (id && cursor._id === id) throw validationError('仓库参数不合法', { parentId: ['上级仓库不能形成循环'] })
      if (visited.has(cursor._id)) throw validationError('仓库参数不合法', { parentId: ['仓库树已存在循环'] })
      visited.add(cursor._id)
      cursor = cursor.parentId ? await ctx.db.get(cursor.parentId) : null
    }
  }
  if (input.accountId) {
    const account = await accountAny(ctx, input.accountId)
    if (!account) throw validationError('仓库参数不合法', { accountId: ['关联科目不存在'] })
    if (account.companyId !== input.companyId) throw validationError('仓库参数不合法', { accountId: ['关联科目不属于本公司'] })
    if (account.isGroup) throw validationError('仓库参数不合法', { accountId: ['汇总科目不能作为关联科目'] })
    if (account.currencyId !== null) throw validationError('仓库参数不合法', { accountId: ['外币科目不能作为关联科目'] })
  }
  if (input.partyType && input.partyId) {
    if (input.partyType === 'COMPANY') {
      if (input.partyId === input.companyId) throw validationError('仓库参数不合法', { partyId: ['协作方不能是本公司'] })
      if (!(await companyAny(ctx, input.partyId))) throw validationError('仓库参数不合法', { partyId: ['协作方不存在'] })
    } else {
      if (!(await supplierAny(ctx, input.partyId))) throw validationError('仓库参数不合法', { partyId: ['协作方不存在'] })
    }
  }
}

export const get = permissionedQuery('inv.warehouse:read')({
  args: { id: v.id('warehouses') },
  returns: v.union(warehouse, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id)
    if (!row || !canAccessCompany(ctx.actor, row.companyId)) return null
    return present(ctx, row)
  },
})

const supportKind = v.union(
  v.literal('companies'),
  v.literal('accounts'),
  v.literal('suppliers'),
  v.literal('parents'),
)
const supportOption = v.object({ id: v.string(), name: v.string(), code: v.optional(v.string()) })
const supportOptionPage = v.object({
  results: v.array(supportOption),
  pageInfo: v.object({ continueCursor: v.union(v.string(), v.null()), isDone: v.boolean() }),
})

type WarehouseSupportKind = 'companies' | 'accounts' | 'suppliers' | 'parents'
type WarehouseSupportSource =
  | 'formalCompanies'
  | 'pilotCompanies'
  | 'companyAssignments'
  | 'formalAccounts'
  | 'pilotAccounts'
  | 'formalSuppliers'
  | 'pilotSuppliers'
  | 'parentWarehouses'
type WarehouseSupportOption = { id: string; name: string; code?: string }
type WarehouseSupportArgs = {
  kind: WarehouseSupportKind
  numItems: number
  cursor?: string | null
  companyId?: string
}
type WarehouseSupportCursorScope = {
  kind: WarehouseSupportKind
  companyId: string | null
  actorId: string
}
type WarehouseSupportCursor = {
  source: WarehouseSupportSource
  cursor: string | null
}

const WAREHOUSE_SUPPORT_CURSOR_PREFIX = 'warehouse-support:v1:'

function encodeWarehouseSupportCursor(
  scope: WarehouseSupportCursorScope,
  source: WarehouseSupportSource,
  cursor: string | null,
): string {
  return `${WAREHOUSE_SUPPORT_CURSOR_PREFIX}${JSON.stringify({
    version: 1,
    kind: scope.kind,
    companyId: scope.companyId,
    actorId: scope.actorId,
    source,
    cursor,
  })}`
}

function decodeWarehouseSupportCursor(
  raw: string | null | undefined,
  scope: WarehouseSupportCursorScope,
  initialSource: WarehouseSupportSource,
  allowedSources: readonly WarehouseSupportSource[],
): WarehouseSupportCursor {
  if (raw == null) return { source: initialSource, cursor: null }
  if (!raw.startsWith(WAREHOUSE_SUPPORT_CURSOR_PREFIX)) {
    throw synieError('validation', '仓库辅助选项 cursor 不合法')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(raw.slice(WAREHOUSE_SUPPORT_CURSOR_PREFIX.length))
  } catch {
    throw synieError('validation', '仓库辅助选项 cursor 不合法')
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw synieError('validation', '仓库辅助选项 cursor 不合法')
  }
  const value = decoded as Record<string, unknown>
  const source = value.source
  const cursor = value.cursor
  if (
    value.version !== 1
    || value.kind !== scope.kind
    || value.companyId !== scope.companyId
    || value.actorId !== scope.actorId
    || typeof source !== 'string'
    || !allowedSources.includes(source as WarehouseSupportSource)
    || (cursor !== null && typeof cursor !== 'string')
  ) {
    throw synieError('validation', '仓库辅助选项 cursor 不合法')
  }
  return { source: source as WarehouseSupportSource, cursor }
}

function warehouseSupportPage(
  results: WarehouseSupportOption[],
  raw: { continueCursor: string; isDone: boolean },
  scope: WarehouseSupportCursorScope,
  source: WarehouseSupportSource,
  nextSource?: WarehouseSupportSource,
) {
  if (!raw.isDone) {
    return {
      results,
      pageInfo: {
        continueCursor: encodeWarehouseSupportCursor(scope, source, raw.continueCursor),
        isDone: false,
      },
    }
  }
  if (nextSource) {
    return {
      results,
      pageInfo: {
        continueCursor: encodeWarehouseSupportCursor(scope, nextSource, null),
        isDone: false,
      },
    }
  }
  return { results, pageInfo: { continueCursor: null, isDone: true } }
}

function warehouseSupportCompanyId(args: WarehouseSupportArgs): string | null {
  if (args.kind === 'accounts' || args.kind === 'parents') {
    const companyId = args.companyId?.trim()
    if (!companyId) throw synieError('validation', `${args.kind} 辅助选项需要 companyId`)
    return companyId
  }
  if (args.companyId !== undefined) {
    throw synieError('validation', `${args.kind} 辅助选项不接受 companyId`)
  }
  return null
}

/**
 * Purpose-bound picker data for warehouses. It deliberately keeps the
 * inv.warehouse:read permission boundary while exposing only minimal option rows.
 */
export async function paginateWarehouseSupportOptions(
  ctx: ReadCtx,
  actor: Actor,
  args: WarehouseSupportArgs,
) {
  const companyId = warehouseSupportCompanyId(args)
  const validated = paginationOptions({ numItems: args.numItems, cursor: null })
  const scope: WarehouseSupportCursorScope = {
    kind: args.kind,
    companyId,
    actorId: actor.userId,
  }

  if (args.kind === 'companies') {
    if (actor.superAdmin || actor.allCompanies) {
      const state = decodeWarehouseSupportCursor(
        args.cursor,
        scope,
        'formalCompanies',
        ['formalCompanies', 'pilotCompanies'],
      )
      if (state.source === 'formalCompanies') {
        const raw = await ctx.db
          .query('companies')
          .withIndex('by_code_key')
          .order('asc')
          .paginate({ ...validated, cursor: state.cursor })
        const results: WarehouseSupportOption[] = []
        for (const row of raw.page) results.push({ id: row._id, name: row.name, code: row.code })
        return warehouseSupportPage(results, raw, scope, state.source, 'pilotCompanies')
      }
      const raw = await ctx.db
        .query('pilotCompanies')
        .withIndex('by_code_key')
        .order('asc')
        .paginate({ ...validated, cursor: state.cursor })
      const results: WarehouseSupportOption[] = []
      for (const row of raw.page) results.push({ id: row._id, name: row.name, code: row.code })
      return warehouseSupportPage(results, raw, scope, state.source)
    }

    const state = decodeWarehouseSupportCursor(
      args.cursor,
      scope,
      'companyAssignments',
      ['companyAssignments'],
    )
    const raw = await ctx.db
      .query('iamUserCompanies')
      .withIndex('by_user_company', (query) => query.eq('userId', actor.userId))
      .order('asc')
      .paginate({ ...validated, cursor: state.cursor })
    const results: WarehouseSupportOption[] = []
    for (const assignment of raw.page) {
      const company = await companyAny(ctx, assignment.companyId)
      if (company) results.push({ id: company._id, name: company.name, code: company.code })
    }
    return warehouseSupportPage(results, raw, scope, state.source)
  }

  if (args.kind === 'suppliers') {
    const state = decodeWarehouseSupportCursor(
      args.cursor,
      scope,
      'formalSuppliers',
      ['formalSuppliers', 'pilotSuppliers'],
    )
    if (state.source === 'formalSuppliers') {
      const raw = await ctx.db
        .query('suppliers')
        .withIndex('by_code_key')
        .order('asc')
        .paginate({ ...validated, cursor: state.cursor })
      const results: WarehouseSupportOption[] = []
      for (const row of raw.page) results.push({ id: row._id, name: row.name })
      return warehouseSupportPage(results, raw, scope, state.source, 'pilotSuppliers')
    }
    const raw = await ctx.db
      .query('pilotSuppliers')
      .withIndex('by_name_key')
      .order('asc')
      .paginate({ ...validated, cursor: state.cursor })
    const results: WarehouseSupportOption[] = []
    for (const row of raw.page) {
      if (row.enabled) results.push({ id: row._id, name: row.name })
    }
    return warehouseSupportPage(results, raw, scope, state.source)
  }

  requireCompanyAccess(actor, companyId!)
  await requireCompany(ctx, companyId!)

  if (args.kind === 'accounts') {
    const formalCompanyId = ctx.db.normalizeId('companies', companyId!)
    const formalCompany = formalCompanyId ? await ctx.db.get(formalCompanyId) : null
    const accountSource = formalCompany ? 'formalAccounts' : 'pilotAccounts'
    const state = decodeWarehouseSupportCursor(args.cursor, scope, accountSource, [accountSource])
    if (state.source === 'formalAccounts') {
      const raw = await ctx.db
        .query('accounts')
        .withIndex('by_company_is_group_code_key', (query) => query
          .eq('companyId', formalCompanyId!)
          .eq('isGroup', false))
        .order('asc')
        .paginate({ ...validated, cursor: state.cursor })
      const results: WarehouseSupportOption[] = []
      for (const row of raw.page) {
        if (row.currencyId === null) results.push({ id: row._id, name: row.name, code: row.code })
      }
      return warehouseSupportPage(results, raw, scope, state.source)
    }
    const raw = await ctx.db
      .query('pilotAccounts')
      .withIndex('by_company_code', (query) => query.eq('companyId', companyId!))
      .order('asc')
      .paginate({ ...validated, cursor: state.cursor })
    const results: WarehouseSupportOption[] = []
    for (const row of raw.page) {
      if (!row.isGroup && row.currencyId === null) {
        results.push({ id: row._id, name: row.name, code: row.code })
      }
    }
    return warehouseSupportPage(results, raw, scope, state.source)
  }

  const state = decodeWarehouseSupportCursor(
    args.cursor,
    scope,
    'parentWarehouses',
    ['parentWarehouses'],
  )
  const raw = await ctx.db
    .query('warehouses')
    .withIndex('by_company_name_key', (query) => query.eq('companyId', companyId!))
    .order('asc')
    .paginate({ ...validated, cursor: state.cursor })
  const results: WarehouseSupportOption[] = []
  for (const row of raw.page) {
    if (!row.isLeaf) results.push({ id: row._id, name: row.name })
  }
  return warehouseSupportPage(results, raw, scope, state.source)
}

export const supportOptions = permissionedQuery('inv.warehouse:read')({
  args: {
    kind: supportKind,
    numItems: v.number(),
    cursor: v.optional(v.union(v.string(), v.null())),
    companyId: v.optional(v.string()),
  },
  returns: supportOptionPage,
  handler: (ctx, args) => paginateWarehouseSupportOptions(ctx, ctx.actor, args),
})

type WarehouseListArgs = {
  profile: 'default' | 'lookup' | 'treeChildren' | 'search'
  numItems: number
  cursor?: string | null
  search?: string
  companyId: string
  parentId?: Id<'warehouses'> | null
  active?: boolean
  isLeaf?: boolean
}

function hasCandidateFilters(args: WarehouseListArgs): boolean {
  return args.active !== undefined || args.isLeaf !== undefined
}

function requireLookupFilters(args: WarehouseListArgs): { active: boolean; isLeaf: boolean } {
  if (args.active === undefined || args.isLeaf === undefined) {
    throw synieError('validation', 'lookup profile 需要 active 与 isLeaf 参数')
  }
  return { active: args.active, isLeaf: args.isLeaf }
}

function optionalCandidateFilters(args: WarehouseListArgs): { active: boolean; isLeaf: boolean } | null {
  if (!hasCandidateFilters(args)) return null
  if (args.active === undefined || args.isLeaf === undefined) {
    throw synieError('validation', '候选筛选必须同时提供 active 与 isLeaf 参数')
  }
  return { active: args.active, isLeaf: args.isLeaf }
}

/** Indexed warehouse query seam kept separate so filters and opaque cursors are testable without bypassing auth. */
export async function paginateWarehouseDocs(
  db: QueryCtx['db'],
  args: WarehouseListArgs,
): Promise<PaginationResult<Doc<'warehouses'>>> {
  const options = paginationOptions(args)
  if (args.profile === 'search') {
    if (args.parentId !== undefined) throw synieError('validation', 'search profile 不接受 parentId')
    const filters = optionalCandidateFilters(args)
    if (filters) {
      return db
        .query('warehouses')
        .withSearchIndex('search_text', (query) => query
          .search('searchText', requireSearchTerm(args.search))
          .eq('companyId', args.companyId)
          .eq('active', filters.active)
          .eq('isLeaf', filters.isLeaf))
        .paginate(options)
    }
    return db
      .query('warehouses')
      .withSearchIndex('search_text', (query) =>
        query.search('searchText', requireSearchTerm(args.search)).eq('companyId', args.companyId),
      )
      .paginate(options)
  }

  rejectSearch(args.search)
  if (args.profile === 'treeChildren') {
    if (hasCandidateFilters(args)) throw synieError('validation', 'treeChildren profile 不接受候选筛选参数')
    if (args.parentId === undefined) throw synieError('validation', 'treeChildren profile 需要 parentId（根层传 null）')
    return db
      .query('warehouses')
      .withIndex('by_company_parent_name_key', (query) =>
        query.eq('companyId', args.companyId).eq('parentId', args.parentId!),
      )
      .order('asc')
      .paginate(options)
  }

  if (args.parentId !== undefined) throw synieError('validation', `${args.profile} profile 不接受 parentId`)
  if (args.profile === 'lookup') {
    const filters = requireLookupFilters(args)
    return db
      .query('warehouses')
      .withIndex('by_company_active_is_leaf_name_key', (query) => query
        .eq('companyId', args.companyId)
        .eq('active', filters.active)
        .eq('isLeaf', filters.isLeaf))
      .order('asc')
      .paginate(options)
  }
  if (hasCandidateFilters(args)) throw synieError('validation', 'default profile 不接受候选筛选参数')
  return db
    .query('warehouses')
    .withIndex('by_company_name_key', (query) => query.eq('companyId', args.companyId))
    .order('asc')
    .paginate(options)
}

export const list = permissionedQuery('inv.warehouse:read')({
  args: {
    profile: v.union(v.literal('default'), v.literal('lookup'), v.literal('treeChildren'), v.literal('search')),
    numItems: v.number(),
    cursor: v.optional(v.union(v.string(), v.null())),
    search: v.optional(v.string()),
    args: v.object({
      companyId: v.string(),
      parentId: v.optional(v.union(v.id('warehouses'), v.null())),
      active: v.optional(v.boolean()),
      isLeaf: v.optional(v.boolean()),
    }),
  },
  returns: page,
  handler: async (ctx, args) => {
    requireCompanyAccess(ctx.actor, args.args.companyId)
    await requireCompany(ctx, args.args.companyId)
    const result = await paginateWarehouseDocs(ctx.db, {
      profile: args.profile,
      numItems: args.numItems,
      cursor: args.cursor,
      search: args.search,
      companyId: args.args.companyId,
      parentId: args.args.parentId,
      active: args.args.active,
      isLeaf: args.args.isLeaf,
    })
    const rows = await Promise.all(result.page.map((row) => present(ctx, row)))
    return resourcePage({ ...result, page: rows })
  },
})

const warehouseCreateArgs = {
  name: v.string(),
  isLeaf: v.optional(v.boolean()),
  active: v.optional(v.boolean()),
  isOutsourced: v.optional(v.boolean()),
  partyType: v.optional(partyType),
  partyId: v.optional(v.union(v.string(), v.null())),
  allowNegative: v.optional(v.boolean()),
  companyId: v.string(),
  parentId: v.optional(v.union(v.id('warehouses'), v.null())),
  accountId: v.optional(v.union(v.string(), v.null())),
}

export const create = permissionedMutation('inv.warehouse:create')({
  args: warehouseCreateArgs,
  returns: warehouse,
  handler: async (ctx, args) => {
    const normalized = normalizeWarehouse(args)
    requireCompanyAccess(ctx.actor, normalized.companyId)
    await validateRelations(ctx, null, normalized)
    const existing = await ctx.db
      .query('warehouses')
      .withIndex('by_company_name_key', (query) =>
        query.eq('companyId', normalized.companyId).eq('nameKey', normalized.nameKey),
      )
      .unique()
    if (existing) throw synieError('conflict', '仓库名称已存在')
    const now = Date.now()
    const id = await ctx.db.insert('warehouses', {
      ...normalized,
      parentId: normalized.parentId as Id<'warehouses'> | null,
      insertedAt: now,
      updatedAt: now,
    })
    const row = await present(ctx, (await ctx.db.get(id))!)
    await writeAudit(asDomainMutationCtx(ctx), ctx.actor, {
      resource: 'invWarehouses', recordId: id, recordLabel: row.name, companyId: row.companyId, action: 'create', changes: snapshot(row),
    })
    return row
  },
})

export const update = permissionedMutation('inv.warehouse:update')({
  args: {
    id: v.id('warehouses'),
    name: v.optional(v.string()),
    isLeaf: v.optional(v.boolean()),
    active: v.optional(v.boolean()),
    isOutsourced: v.optional(v.boolean()),
    partyType: v.optional(partyType),
    partyId: v.optional(v.union(v.string(), v.null())),
    allowNegative: v.optional(v.boolean()),
    parentId: v.optional(v.union(v.id('warehouses'), v.null())),
    accountId: v.optional(v.union(v.string(), v.null())),
  },
  returns: warehouse,
  handler: async (ctx, args) => {
    const beforeDoc = await ctx.db.get(args.id)
    if (!beforeDoc || !canAccessCompany(ctx.actor, beforeDoc.companyId)) throw synieError('not_found', '仓库不存在')
    const normalized = normalizeWarehouse({
      name: args.name ?? beforeDoc.name,
      isLeaf: args.isLeaf ?? beforeDoc.isLeaf,
      active: args.active ?? beforeDoc.active,
      isOutsourced: args.isOutsourced ?? beforeDoc.isOutsourced,
      partyType: args.partyType === undefined ? beforeDoc.partyType : args.partyType,
      partyId: args.partyId === undefined ? beforeDoc.partyId : args.partyId,
      allowNegative: args.allowNegative ?? beforeDoc.allowNegative,
      companyId: beforeDoc.companyId,
      parentId: args.parentId === undefined ? beforeDoc.parentId : args.parentId,
      accountId: args.accountId === undefined ? beforeDoc.accountId : args.accountId,
    })
    await validateRelations(ctx, beforeDoc._id, normalized)
    const duplicate = await ctx.db
      .query('warehouses')
      .withIndex('by_company_name_key', (query) =>
        query.eq('companyId', beforeDoc.companyId).eq('nameKey', normalized.nameKey),
      )
      .unique()
    if (duplicate && duplicate._id !== beforeDoc._id) throw synieError('conflict', '仓库名称已存在')

    if (normalized.isLeaf !== beforeDoc.isLeaf) {
      if (normalized.isLeaf) {
        const child = await ctx.db.query('warehouses').withIndex('by_parent', (query) => query.eq('parentId', beforeDoc._id)).first()
        if (child) throw validationError('仓库参数不合法', { isLeaf: ['存在下级仓库,不能改为叶子仓库'] })
      } else {
        const [pilotStock, stock] = await Promise.all([
          ctx.db.query('pilotResourceReferences').withIndex('by_target', (query) => query.eq('targetResource', 'invWarehouses').eq('targetId', beforeDoc._id)).first(),
          ctx.db.query('stockEntries').withIndex('by_warehouse', query => query.eq('warehouseId', beforeDoc._id)).first(),
        ])
        if (pilotStock || stock) throw validationError('仓库参数不合法', { isLeaf: ['仓库已有库存分录,不能改为非叶子'] })
      }
    }

    const before = await present(ctx, beforeDoc)
    await ctx.db.patch(beforeDoc._id, {
      ...normalized,
      parentId: normalized.parentId as Id<'warehouses'> | null,
      updatedAt: Date.now(),
    })
    const after = await present(ctx, (await ctx.db.get(beforeDoc._id))!)
    const changes = changedFields(snapshot(before), snapshot(after))
    if (Object.keys(changes).length > 0) {
      await writeAudit(asDomainMutationCtx(ctx), ctx.actor, {
        resource: 'invWarehouses', recordId: beforeDoc._id, recordLabel: after.name, companyId: after.companyId, action: 'update', changes,
      })
    }
    return after
  },
})

export const remove = permissionedMutation('inv.warehouse:delete')({
  args: { id: v.id('warehouses') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id)
    if (!row || !canAccessCompany(ctx.actor, row.companyId)) throw synieError('not_found', '仓库不存在')
    const [child, pilotStock, stock] = await Promise.all([
      ctx.db.query('warehouses').withIndex('by_parent', (query) => query.eq('parentId', row._id)).first(),
      ctx.db.query('pilotResourceReferences').withIndex('by_target', (query) => query.eq('targetResource', 'invWarehouses').eq('targetId', row._id)).first(),
      ctx.db.query('stockEntries').withIndex('by_warehouse', query => query.eq('warehouseId', row._id)).first(),
    ])
    if (child) throw synieError('conflict', '存在下级仓库,不能删除')
    if (pilotStock || stock) throw synieError('conflict', '仓库已有库存分录,不能删除')
    const item = await present(ctx, row)
    await ctx.db.delete(row._id)
    await writeAudit(asDomainMutationCtx(ctx), ctx.actor, {
      resource: 'invWarehouses', recordId: row._id, recordLabel: item.name, companyId: item.companyId, action: 'destroy', changes: snapshot(item),
    })
    return null
  },
})

export const seedDefaults = permissionedMutation('inv.warehouse:create')({
  args: { companyId: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    requireCompanyAccess(ctx.actor, args.companyId)
    const company = await requireCompany(ctx, args.companyId)
    return seedDefaultWarehouses(ctx, ctx.actor, company)
  },
})
