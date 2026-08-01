import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import type { DataModel } from '../../_generated/dataModel'
import type { Actor } from '../../lib/actor'
import { synieError } from '../../lib/errors'
import { requirePermission } from '../../lib/permissions'
import { catalogDocument } from './policies'
import {
  childrenFor,
  createDomainRecord,
  domainRecordCanDelete,
  getDomainRecord,
  removeDomainRecord,
  updateDomainRecord,
} from './records'

type QueryCtx = GenericQueryCtx<DataModel>
type MutationCtx = GenericMutationCtx<DataModel>
export type AggregateRecord = Record<string, unknown>

export type AggregateDeriveContext = {
  actor: Actor
  head: AggregateRecord
  parent: AggregateRecord
  input: AggregateRecord
  existing: AggregateRecord | null
  index: number
}

export type AggregateNode = {
  /** Server-owned Catalog resource. Never accepted from client input. */
  resource: string
  /** Input/output collection key on the parent object. */
  collection: string
  /** Declared reference field from this node to its parent resource. */
  parentField: string
  children?: readonly AggregateNode[]
  derive?: (
    ctx: MutationCtx,
    input: AggregateDeriveContext,
  ) => AggregateRecord | Promise<AggregateRecord>
}

export type AggregatePolicy = {
  /** Server-owned aggregate head. Never accepted from client input. */
  headResource: string
  /**
   * Default replace semantics keep child create/update/delete aligned with the
   * corresponding head permission. Manufacturing-owned snapshot/master rows
   * are an explicit exception: every child change is part of editing the head.
   */
  replaceChildPermission?: 'update'
  nodes: readonly AggregateNode[]
  deriveHead?: (
    ctx: MutationCtx,
    actor: Actor,
    input: AggregateRecord,
    previous: AggregateRecord | null,
  ) => AggregateRecord | Promise<AggregateRecord>
  afterSave?: (
    ctx: MutationCtx,
    actor: Actor,
    head: AggregateRecord,
    input: AggregateRecord,
  ) => Promise<void>
}

function asRecord(value: unknown, path: string): AggregateRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw synieError('validation', `${path}必须是对象`)
  }
  return value as AggregateRecord
}

function collection(parent: AggregateRecord, node: AggregateNode, path: string): AggregateRecord[] {
  const value = parent[node.collection]
  if (!Array.isArray(value)) {
    throw synieError('validation', `聚合草稿 ${path}.${node.collection} 必须显式提交数组`)
  }
  return value.map((item, index) => asRecord(item, `${path}.${node.collection}[${index}]`))
}

/** Validate the entire collection shape before the first write. */
function validateTree(parent: AggregateRecord, nodes: readonly AggregateNode[], path: string): void {
  for (const node of nodes) {
    for (const [index, item] of collection(parent, node, path).entries()) {
      validateTree(item, node.children ?? [], `${path}.${node.collection}[${index}]`)
    }
  }
}

function cleanInput(input: AggregateRecord, nodes: readonly AggregateNode[]): AggregateRecord {
  const result = { ...input }
  delete result.id
  for (const node of nodes) delete result[node.collection]
  return result
}

function declared(resource: string, values: AggregateRecord): AggregateRecord {
  const fields = new Set(catalogDocument(resource).fields.map((field) => field.name))
  return Object.fromEntries(
    Object.entries(values).filter(([field, value]) => fields.has(field) && value !== undefined),
  )
}

export function requireHeadPermission(actor: Actor, headResource: string, action: 'create' | 'update' | 'delete'): void {
  requirePermission(actor, `${catalogDocument(headResource).permissionPrefix}:${action}`)
}

export function aggregateChildPermissionAction(
  policy: Pick<AggregatePolicy, 'replaceChildPermission'>,
  aggregateAction: 'create' | 'replace',
  childAction: 'create' | 'update' | 'delete',
): 'create' | 'update' | 'delete' {
  return aggregateAction === 'replace' && policy.replaceChildPermission === 'update'
    ? 'update'
    : childAction
}

function sorted(rows: AggregateRecord[]): AggregateRecord[] {
  return [...rows].sort((left, right) =>
    Number(left.idx ?? left.seq ?? 0) - Number(right.idx ?? right.seq ?? 0) ||
    String(left.id).localeCompare(String(right.id)),
  )
}

async function loadNodes(
  ctx: QueryCtx | MutationCtx,
  parent: AggregateRecord,
  nodes: readonly AggregateNode[],
): Promise<AggregateRecord> {
  const result = { ...parent }
  for (const node of nodes) {
    const rows = sorted(await childrenFor(ctx, node.resource, String(parent.id)))
    result[node.collection] = await Promise.all(rows.map((row) => loadNodes(ctx, row, node.children ?? [])))
  }
  return result
}

export async function loadAggregate(
  ctx: QueryCtx | MutationCtx,
  actor: Actor,
  policy: AggregatePolicy,
  id: string,
): Promise<AggregateRecord> {
  const head = await getDomainRecord(ctx, actor, policy.headResource, id)
  if (!head) throw synieError('not_found', `${catalogDocument(policy.headResource).label}不存在`)
  return loadNodes(ctx, head, policy.nodes)
}

async function deleteNodeTree(
  ctx: MutationCtx,
  actor: Actor,
  node: AggregateNode,
  row: AggregateRecord,
): Promise<void> {
  for (const child of node.children ?? []) {
    for (const childRow of await childrenFor(ctx, child.resource, String(row.id))) {
      await deleteNodeTree(ctx, actor, child, childRow)
    }
  }
  await removeDomainRecord(ctx, actor, node.resource, String(row.id), { permissionChecked: true })
}

async function saveNodeCollection(
  ctx: MutationCtx,
  actor: Actor,
  policy: AggregatePolicy,
  head: AggregateRecord,
  parent: AggregateRecord,
  parentInput: AggregateRecord,
  node: AggregateNode,
  aggregateAction: 'create' | 'replace',
): Promise<void> {
  const inputs = collection(parentInput, node, catalogDocument(policy.headResource).label)
  const existing = await childrenFor(ctx, node.resource, String(parent.id))
  const byId = new Map(existing.map((row) => [String(row.id), row]))
  const seen = new Set<string>()
  const creates = inputs.some((item) => typeof item.id !== 'string')
  const updates = inputs.some((item) => typeof item.id === 'string')
  if (creates) requireHeadPermission(
    actor,
    policy.headResource,
    aggregateChildPermissionAction(policy, aggregateAction, 'create'),
  )
  if (updates) requireHeadPermission(
    actor,
    policy.headResource,
    aggregateChildPermissionAction(policy, aggregateAction, 'update'),
  )

  for (const [index, input] of inputs.entries()) {
    const id = typeof input.id === 'string' ? input.id : null
    const before = id ? byId.get(id) ?? null : null
    if (id && (!before || seen.has(id))) {
      throw synieError('validation', `${node.resource} 子记录不属于当前聚合或重复`)
    }
    if (id) seen.add(id)
    const derived = declared(node.resource, {
      ...(node.derive ? await node.derive(ctx, { actor, head, parent, input, existing: before, index }) : {}),
      [node.parentField]: parent.id,
      companyId: head.companyId,
    })
    const clean = cleanInput(input, node.children ?? [])
    const saved = before
      ? await updateDomainRecord(ctx, actor, node.resource, id!, clean, {
          permissionChecked: true,
          trustedDerived: derived,
        })
      : await createDomainRecord(ctx, actor, node.resource, clean, {
          permissionChecked: true,
          trustedDerived: derived,
    })
    for (const child of node.children ?? []) {
      await saveNodeCollection(ctx, actor, policy, head, saved, input, child, aggregateAction)
    }
  }

  const removed = existing.filter((row) => !seen.has(String(row.id)))
  if (removed.length) requireHeadPermission(
    actor,
    policy.headResource,
    aggregateChildPermissionAction(policy, aggregateAction, 'delete'),
  )
  for (const row of removed) await deleteNodeTree(ctx, actor, node, row)
}

async function saveCollections(
  ctx: MutationCtx,
  actor: Actor,
  policy: AggregatePolicy,
  head: AggregateRecord,
  input: AggregateRecord,
  aggregateAction: 'create' | 'replace',
): Promise<void> {
  for (const node of policy.nodes) {
    await saveNodeCollection(ctx, actor, policy, head, head, input, node, aggregateAction)
  }
  await policy.afterSave?.(ctx, actor, head, input)
}

export async function createAggregate(
  ctx: MutationCtx,
  actor: Actor,
  policy: AggregatePolicy,
  value: unknown,
): Promise<AggregateRecord> {
  const input = asRecord(value, '聚合草稿')
  validateTree(input, policy.nodes, catalogDocument(policy.headResource).label)
  const derived = policy.deriveHead ? await policy.deriveHead(ctx, actor, input, null) : {}
  const head = await createDomainRecord(ctx, actor, policy.headResource, cleanInput(input, policy.nodes), {
    allowAggregateHead: true,
    trustedDerived: declared(policy.headResource, derived),
  })
  await saveCollections(ctx, actor, policy, head, input, 'create')
  return loadAggregate(ctx, actor, policy, String(head.id))
}

export async function replaceAggregate(
  ctx: MutationCtx,
  actor: Actor,
  policy: AggregatePolicy,
  id: string,
  value: unknown,
): Promise<AggregateRecord> {
  const input = asRecord(value, '聚合草稿')
  validateTree(input, policy.nodes, catalogDocument(policy.headResource).label)
  const previous = await getDomainRecord(ctx, actor, policy.headResource, id)
  if (!previous) throw synieError('not_found', `${catalogDocument(policy.headResource).label}不存在`)
  const derived = policy.deriveHead ? await policy.deriveHead(ctx, actor, input, previous) : {}
  const head = await updateDomainRecord(ctx, actor, policy.headResource, id, cleanInput(input, policy.nodes), {
    allowAggregateHead: true,
    trustedDerived: declared(policy.headResource, derived),
  })
  await saveCollections(ctx, actor, policy, head, input, 'replace')
  return loadAggregate(ctx, actor, policy, id)
}

export async function removeAggregate(
  ctx: MutationCtx,
  actor: Actor,
  policy: AggregatePolicy,
  id: string,
): Promise<void> {
  requireHeadPermission(actor, policy.headResource, 'delete')
  const head = await getDomainRecord(ctx, actor, policy.headResource, id)
  if (!head) throw synieError('not_found', `${catalogDocument(policy.headResource).label}不存在`)
  const status = typeof head.status === 'string' ? head.status : null
  if (!domainRecordCanDelete(policy.headResource, status)) {
    throw synieError('conflict', '当前状态不可删除')
  }
  for (const node of policy.nodes) {
    for (const row of await childrenFor(ctx, node.resource, id)) {
      await deleteNodeTree(ctx, actor, node, row)
    }
  }
  await removeDomainRecord(ctx, actor, policy.headResource, id, { permissionChecked: true })
}
