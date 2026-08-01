import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import { v } from 'convex/values'
import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import { authedMutation, authedQuery } from '../../lib/auth'
import type { Actor } from '../../lib/actor'
import { canAccessCompany, companyFilter } from '../../lib/companyScope'
import { decimalToScaledInt64, scaledInt64ToDecimal } from '../../lib/decimal'
import { synieError } from '../../lib/errors'
import { paginationOptions } from '../../lib/pagination'
import { hasPermission } from '../../lib/permissions'
import { hydrateStored } from '../shared/records'

type QueryCtx = GenericQueryCtx<DataModel>
type MutationCtx = GenericMutationCtx<DataModel>
type Ctx = QueryCtx | MutationCtx
type Todo = Doc<'todos'>
type SourceType = Todo['sourceType']
type Wire = Record<string, unknown>

function requireAction(actor: Actor): void {
  if (!hasPermission(actor, 'acc.vat_invoice:create')) {
    throw synieError('forbidden', '无权限查看待办')
  }
}

function requireUnread(actor: Actor): void {
  if (!hasPermission(actor, 'acc.vat_invoice:create') && !hasPermission(actor, 'acc.vat_invoice:read')) {
    throw synieError('forbidden', '无权限查看待办')
  }
}

function sourceType(resource: string): SourceType {
  if (resource === 'salReconciliations') return 'sales.reconciliation'
  if (resource === 'purReconciliations') return 'purchase.reconciliation'
  throw synieError('internal', `${resource} 不是待办来源`)
}

function orderKey(at: number, id: string): string {
  return `${String(Math.trunc(at)).padStart(16, '0')}:${id}`
}

/** Producer seam: called from reconciliation and invoice state transitions in the same mutation. */
export async function openReconciliationTodo(
  ctx: MutationCtx,
  actor: Actor,
  resource: string,
  sourceId: string,
  reconciliation: Wire,
  createdBy: boolean,
): Promise<void> {
  if (String(reconciliation.reconciliationType).toUpperCase() !== 'REGULAR') return
  const source = sourceType(resource)
  const now = Date.now()
  const active = await ctx.db.query('todos').withIndex('by_source_status', (q) =>
    q.eq('sourceType', source).eq('sourceId', sourceId).eq('status', 'ACTIVE'),
  ).unique()
  const fields = {
    type: source === 'sales.reconciliation' ? 'ISSUE_INVOICE' as const : 'RECEIVE_INVOICE' as const,
    sourceType: source,
    sourceId,
    sourceNo: String(reconciliation.reconciliationNo ?? sourceId),
    partyType: String(reconciliation.partyType ?? ''),
    partyId: String(reconciliation.partyId ?? ''),
    amountScaled: decimalToScaledInt64(String(reconciliation.baseGrossTotal ?? '0'), 2),
    status: 'ACTIVE' as const,
    closedReason: null,
    sourceChangedAt: now,
    closedAt: null,
    companyId: String(reconciliation.companyId ?? ''),
    createdById: createdBy ? actor.userId : null,
    updatedAt: now,
  }
  if (!fields.companyId || !fields.partyId) throw synieError('internal', '待办来源缺少公司或对手')
  if (active) {
    await ctx.db.patch(active._id, { ...fields, orderKey: orderKey(now, active._id) })
    return
  }
  const id = await ctx.db.insert('todos', {
    ...fields,
    orderKey: orderKey(now, sourceId),
    insertedAt: now,
  })
  await ctx.db.patch(id, { orderKey: orderKey(now, id) })
}

export async function closeReconciliationTodo(
  ctx: MutationCtx,
  resource: string,
  sourceId: string,
  reason: 'UNCONFIRM' | 'INVOICE_AUDIT',
): Promise<void> {
  const source = sourceType(resource)
  const active = await ctx.db.query('todos').withIndex('by_source_status', (q) =>
    q.eq('sourceType', source).eq('sourceId', sourceId).eq('status', 'ACTIVE'),
  ).collect()
  const now = Date.now()
  for (const todo of active) {
    await ctx.db.patch(todo._id, {
      status: 'CLOSED', closedReason: reason, closedAt: now, updatedAt: now,
    })
  }
}

async function stateFor(ctx: Ctx, todoId: Id<'todos'>, userId: Id<'appUsers'>) {
  return ctx.db.query('todoStates').withIndex('by_todo_user', (q) =>
    q.eq('todoId', todoId).eq('userId', userId),
  ).unique()
}

async function partyName(ctx: Ctx, type: string, id: string): Promise<string> {
  const tables = {
    CUSTOMER: 'customers', SUPPLIER: 'suppliers', COMPANY: 'companies', EMPLOYEE: 'employees',
  } as const
  const table = tables[type.toUpperCase() as keyof typeof tables]
  if (!table) return ''
  const normalized = ctx.db.normalizeId(table, id)
  const row = normalized ? await ctx.db.get(normalized as never) as { name?: string } | null : null
  return row?.name ?? ''
}

async function draftInvoiceLinked(ctx: Ctx, todo: Todo): Promise<boolean> {
  const targetResource = todo.sourceType === 'sales.reconciliation'
    ? 'salReconciliations'
    : 'purReconciliations'
  const references = await ctx.db.query('domainReferences').withIndex('by_target', (q) =>
    q.eq('targetResource', targetResource).eq('targetRecordId', todo.sourceId),
  ).collect()
  for (const reference of references) {
    if (reference.sourceResource !== 'accVatInvoices') continue
    const id = ctx.db.normalizeId('financeDocuments', reference.sourceRecordId)
    const row = id ? await ctx.db.get(id) : null
    if (row?.resource === 'accVatInvoices' && row.status === 'DRAFT') return true
  }
  return false
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}

async function present(ctx: Ctx, todo: Todo, actor: Actor) {
  const [company, createdBy, state, resolvedParty, linked] = await Promise.all([
    (() => {
      const id = ctx.db.normalizeId('companies', todo.companyId)
      return id ? ctx.db.get(id) : null
    })(),
    todo.createdById ? ctx.db.get(todo.createdById) : null,
    stateFor(ctx, todo._id, actor.userId),
    partyName(ctx, todo.partyType, todo.partyId),
    draftInvoiceLinked(ctx, todo),
  ])
  const dismissed = Boolean(
    state?.dismissedAt !== null && state?.dismissedAt !== undefined &&
    state.resetBasisAt === todo.sourceChangedAt,
  )
  return {
    id: todo._id,
    type: todo.type,
    sourceType: todo.sourceType,
    sourceId: todo.sourceId,
    sourceNo: todo.sourceNo,
    partyType: todo.partyType.toUpperCase(),
    partyId: todo.partyId,
    partyName: resolvedParty,
    amount: scaledInt64ToDecimal(todo.amountScaled, 2),
    status: todo.status,
    closedReason: todo.closedReason,
    sourceChangedAt: iso(todo.sourceChangedAt),
    closedAt: iso(todo.closedAt),
    insertedAt: iso(todo.insertedAt),
    updatedAt: iso(todo.updatedAt),
    companyId: todo.companyId,
    company: company ? { id: company._id, name: company.name, shortName: company.shortName } : null,
    createdById: todo.createdById,
    createdBy: createdBy ? { id: createdBy._id, username: createdBy.username, name: createdBy.name } : null,
    draftInvoiceLinked: linked,
    myReadAt: iso(state?.readAt ?? null),
    myDismissedAt: iso(state?.dismissedAt ?? null),
    dismissed,
  }
}

async function candidates(
  ctx: QueryCtx,
  actor: Actor,
  status: 'ACTIVE' | 'CLOSED',
  cursor: string | null,
  limit: number,
): Promise<{ rows: Todo[]; truncated: boolean }> {
  const take = Math.min(limit * 4 + 1, 401)
  const scope = companyFilter(actor)
  if (scope.bypass) {
    const rows = await ctx.db.query('todos').withIndex('by_status_order', (q) => {
      const base = q.eq('status', status)
      return cursor ? base.lt('orderKey', cursor) : base
    }).order('desc').take(take)
    return { rows: rows.slice(0, take - 1), truncated: rows.length === take }
  }
  const batches: Todo[][] = []
  let truncated = false
  for (const companyId of scope.ids) {
    const rows = await ctx.db.query('todos').withIndex('by_company_status_order', (q) => {
      const base = q.eq('companyId', companyId).eq('status', status)
      return cursor ? base.lt('orderKey', cursor) : base
    }).order('desc').take(take)
    if (rows.length === take) truncated = true
    batches.push(rows.slice(0, take - 1))
  }
  const byId = new Map<string, Todo>()
  for (const row of batches.flat()) byId.set(row._id, row)
  return {
    rows: [...byId.values()].sort((left, right) => right.orderKey.localeCompare(left.orderKey)),
    truncated,
  }
}

export const list = authedQuery({
  args: {
    tab: v.union(v.literal('active'), v.literal('history'), v.literal('recent')),
    includeDismissed: v.optional(v.boolean()),
    numItems: v.number(),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireAction(ctx.actor)
    const requested = args.tab === 'recent' ? 8 : paginationOptions(args).numItems
    const batch = await candidates(
      ctx, ctx.actor, args.tab === 'history' ? 'CLOSED' : 'ACTIVE', args.cursor ?? null, requested,
    )
    const visible = []
    for (const row of batch.rows) {
      const item = await present(ctx, row, ctx.actor)
      if ((args.tab === 'active' || args.tab === 'recent') && !args.includeDismissed && item.dismissed) continue
      visible.push({ row, item })
      if (visible.length > requested) break
    }
    const page = visible.slice(0, requested)
    const hasMore = batch.truncated || visible.length > requested || batch.rows.length > page.length
    const last = page.at(-1)?.row ?? (batch.rows.length ? batch.rows.at(-1) : null)
    return {
      count: page.length,
      results: page.map(({ item }) => item),
      pageInfo: { continueCursor: hasMore && last ? last.orderKey : null, isDone: !hasMore },
    }
  },
})

async function accessibleTodo(ctx: MutationCtx, actor: Actor, id: string): Promise<Todo> {
  requireAction(actor)
  const normalized = ctx.db.normalizeId('todos', id)
  const todo = normalized ? await ctx.db.get(normalized) : null
  if (!todo || !canAccessCompany(actor, todo.companyId)) {
    throw synieError('not_found', '待办不存在或无权访问')
  }
  return todo
}

async function changeState(ctx: MutationCtx, actor: Actor, id: string, dismiss: boolean) {
  const todo = await accessibleTodo(ctx, actor, id)
  const now = Date.now()
  const state = await stateFor(ctx, todo._id, actor.userId)
  const patch = dismiss
    ? { readAt: state?.readAt ?? now, dismissedAt: now, resetBasisAt: todo.sourceChangedAt, updatedAt: now }
    : { readAt: state?.readAt ?? now, dismissedAt: state?.dismissedAt ?? null, resetBasisAt: state?.resetBasisAt ?? null, updatedAt: now }
  if (state) await ctx.db.patch(state._id, patch)
  else await ctx.db.insert('todoStates', { todoId: todo._id, userId: actor.userId, ...patch })
  await ctx.db.patch(todo._id, { updatedAt: now })
  return present(ctx, (await ctx.db.get(todo._id))!, actor)
}

export const markRead = authedMutation({
  args: { id: v.string() }, returns: v.any(),
  handler: (ctx, args) => changeState(ctx, ctx.actor, args.id, false),
})

export const dismiss = authedMutation({
  args: { id: v.string() }, returns: v.any(),
  handler: (ctx, args) => changeState(ctx, ctx.actor, args.id, true),
})

export const unreadCount = authedQuery({
  args: {}, returns: v.object({ count: v.number() }),
  handler: async (ctx) => {
    requireUnread(ctx.actor)
    const batch = await candidates(ctx, ctx.actor, 'ACTIVE', null, 100)
    let count = 0
    for (const todo of batch.rows) {
      const state = await stateFor(ctx, todo._id, ctx.actor.userId)
      const dismissed = Boolean(state?.dismissedAt && state.resetBasisAt === todo.sourceChangedAt)
      if (!state?.readAt && !dismissed) count += 1
    }
    return { count }
  },
})
