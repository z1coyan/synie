/**
 * 标准动作内核·聚合草稿（D2）：组合 root/child 的 `*InTx` 变体，派生
 * `loadDraft` / `createDraft` / `replaceDraft`。
 *
 * 不扩宽 {@link StandardServiceOptions}——平坦资源 interface 保持小；聚合描述符是
 * 独立 module，有自己的合同测试面（T1.4）。
 *
 * ## 语义（D4，照抄术语表「聚合草稿 Adapter」）
 *
 * - **全集合快照**：`replaceDraft` 入参必须显式提交全部子集合（缺字段 fail-closed）；
 *   快照中缺失的既有行即删除。
 * - **差异拆增/改/删**：逐行走 child `createInTx` / `updateInTx` / `removeInTx`，
 *   保留原授权路径与逐行审计三型。
 * - **暂态空集不删**：编辑态闸门在前端（`assertAggregateDraftReady`）；后端收到的
 *   空数组是权威快照，按「清空全部子行」处理。
 * - **删行先于头更新**：omitted 顶层子行先删，再 `updateInTx` 头——保留手写实现
 *   「对手/币种切换 + 清空旧行」同一事务时序。
 *
 * ## 编号（D6）
 *
 * 头资源 create 走既有 `options.numbering`（root `createInTx` 内 `nextInTx`）；
 * 聚合层不重做取号、不扩宽 StandardServiceOptions。
 *
 * ## 读路径
 *
 * `loadDraft` 用 `withReadSnapshot`（repeatable read）在同一提交代际内读头 + 子树，
 * 避免把不同代际拼成可再保存草稿。
 *
 * 钩子纪律：聚合草稿只管持久化；跨资源效果走 transition effect / 手写编排。
 * platform 禁止 import `~/modules/*`。
 */
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { loadAuthorized } from '~/db/load.ts'
import { withReadSnapshot, withTx, type DbHandle, type TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { FieldMeta, ResourceMeta } from '~/platform/meta/types.ts'
import { withIndexedFields } from '~/platform/posting/text.ts'
import type { StandardChildService } from './child.ts'
import { mapRow, physicalFields } from './fields.ts'
import type { StandardItem, StandardService } from './service.ts'

/** 聚合子树节点：collection 键 + 已装配 child service + 可选孙级 */
export interface AggregateChildSpec {
  /** draft 上的集合键（items / tiers / packBoxes…） */
  key: string
  /** 已由 `createStandardChildService` 装配的子行服务 */
  service: StandardChildService
  /** 嵌套孙级（D3 上限 2；装配期再断言 parent 链与 head 对齐） */
  children?: readonly AggregateChildSpec[]
}

export interface AggregateServiceOptions {
  db: Kysely<Database>
  registry: Registry
  /** 已装配的 root 服务（含 numbering / workflow 等，不经本 module 扩宽） */
  head: StandardService
  /** 头下一级子集合（可多支平行子树，如发货条目 + 装箱箱） */
  children: readonly AggregateChildSpec[]
  /**
   * 身份/形状校验文案；缺省 `${head.label}草稿参数不合法`。
   * 字段键为相对 draft 根的路径（如 `items[0].id`、`companyId`）。
   */
  validationMessage?: string
}

export interface AggregateService {
  /**
   * 一致快照读取：repeatable-read 下头 + 全部子集合（无分页截断）。
   * 返回 wire 形 `{ ...head, [collectionKey]: rows[] }`，嵌套同构。
   */
  loadDraft(permit: Permit, id: string): Promise<Record<string, unknown>>
  /** 单事务创建头 + 全量子树；编号走 head 的 options.numbering（D6） */
  createDraft(permit: Permit, input: Record<string, unknown>): Promise<Record<string, unknown>>
  /**
   * 单事务全量替换（D4）：缺失即删、差异增/改、删行先于头更新；
   * 逐行 InTx 审计与授权路径与独立 child CRUD 一致。
   */
  replaceDraft(
    permit: Permit,
    id: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>
  readonly head: StandardService
  readonly children: readonly AggregateChildSpec[]
}

interface ChildRuntime {
  spec: AggregateChildSpec
  meta: ResourceMeta
  table: string
  label: string
  /** 指向母单/母行的 FK 字段（apiName + dbColumn） */
  fk: FieldMeta
  /** 直接母资源名（装配期与 via.parent 对齐） */
  parentResource: string
  children: ChildRuntime[]
  orderSql: ReturnType<typeof sql>
}

function headLabel(meta: ResourceMeta): string {
  return meta.label ?? meta.permissionLabel
}

function viaFkField(meta: ResourceMeta, path: string): FieldMeta {
  const authz = meta.authz
  if (!authz || authz.kind !== 'via') {
    throw new Error(`聚合派生：${path} 资源 ${meta.name} 须为 via 子行`)
  }
  const field = meta.fields.find((f) => f.dbColumn === authz.fk)
  if (!field) {
    throw new Error(`聚合派生：${path} 资源 ${meta.name} 外键列 ${authz.fk} 无对应字段`)
  }
  return field
}

function buildRuntime(
  specs: readonly AggregateChildSpec[],
  expectedParent: string,
  path: string,
): ChildRuntime[] {
  return specs.map((spec) => {
    const meta = spec.service.meta
    const authz = meta.authz
    if (!authz || authz.kind !== 'via') {
      throw new Error(`聚合派生：${path}.${spec.key} 资源 ${meta.name} 须为 via 子行`)
    }
    if (authz.parent !== expectedParent) {
      throw new Error(
        `聚合派生：${path}.${spec.key} 的 via.parent=${authz.parent} 与期望母资源 ${expectedParent} 不一致`,
      )
    }
    const fk = viaFkField(meta, `${path}.${spec.key}`)
    const hasIdx = meta.fields.some((f) => f.dbColumn === 'idx')
    const orderSql = hasIdx ? sql`"idx" ASC, "id" ASC` : sql`"id" ASC`
    return {
      spec,
      meta,
      table: meta.table,
      label: headLabel(meta),
      fk,
      parentResource: expectedParent,
      children: buildRuntime(spec.children ?? [], meta.name, `${path}.${spec.key}`),
      orderSql,
    }
  })
}

function asRecord(value: unknown, path: string, validationMessage: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.validation(validationMessage, { [path || 'draft']: ['必须是对象'] })
  }
  return value as Record<string, unknown>
}

function requireArray(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  validationMessage: string,
): Record<string, unknown>[] {
  const value = parent[key]
  if (!Array.isArray(value)) {
    throw ApiError.validation(validationMessage, {
      [path ? `${path}.${key}` : key]: ['必须显式提交数组'],
    })
  }
  return value.map((item, index) => {
    const itemPath = path ? `${path}.${key}[${index}]` : `${key}[${index}]`
    return asRecord(item, itemPath, validationMessage)
  })
}

function stripCollections(
  input: Record<string, unknown>,
  runtimes: readonly ChildRuntime[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input }
  delete out.id
  for (const node of runtimes) delete out[node.spec.key]
  return out
}

function collectNoIds(
  input: Record<string, unknown>,
  runtimes: readonly ChildRuntime[],
  path: string,
  fields: Record<string, string[]>,
  validationMessage: string,
): void {
  for (const node of runtimes) {
    const rows = requireArray(input, node.spec.key, path, validationMessage)
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!
      const rowPath = path ? `${path}.${node.spec.key}[${i}]` : `${node.spec.key}[${i}]`
      if (row.id !== undefined) {
        fields[`${rowPath}.id`] = ['新记录不能包含 id']
      }
      collectNoIds(row, node.children, rowPath, fields, validationMessage)
    }
  }
}

function collectIdentityErrors(
  input: Record<string, unknown>,
  runtimes: readonly ChildRuntime[],
  /** parentId → 该母下既有行 id 集合；顶层 key 为头 id */
  existingByParent: Map<string, Map<string, Set<string>>>,
  parentId: string,
  path: string,
  parentLabel: string,
  fields: Record<string, string[]>,
  validationMessage: string,
): void {
  for (const node of runtimes) {
    const rows = requireArray(input, node.spec.key, path, validationMessage)
    const existing = existingByParent.get(node.meta.name)?.get(parentId) ?? new Set<string>()
    const seen = new Set<string>()
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!
      const rowPath = path ? `${path}.${node.spec.key}[${i}]` : `${node.spec.key}[${i}]`
      const id = row.id
      if (id !== undefined) {
        if (typeof id !== 'string' || !id) {
          fields[`${rowPath}.id`] = [`不属于该${parentLabel}`]
        } else if (seen.has(id)) {
          fields[`${rowPath}.id`] = ['同一草稿中不能重复']
        } else if (!existing.has(id)) {
          fields[`${rowPath}.id`] = [`不属于该${parentLabel}`]
        }
        if (typeof id === 'string') seen.add(id)
      }
      // 嵌套：母标签用本节点 label；母 id 为既有行 id 或（新建）空——新建行的孙级不得带 id
      if (node.children.length > 0) {
        if (typeof id === 'string' && existing.has(id)) {
          collectIdentityErrors(
            row,
            node.children,
            existingByParent,
            id,
            rowPath,
            node.label,
            fields,
            validationMessage,
          )
        } else {
          // 新建母行：子树一律新记录
          collectNoIds(row, node.children, rowPath, fields, validationMessage)
        }
      }
    }
  }
}

export function createAggregateService(options: AggregateServiceOptions): AggregateService {
  const { db, registry, head } = options
  const headMeta = head.meta
  const headTarget = registry.authzTarget(headMeta.name)
  const label = headLabel(headMeta)
  const notFound = `${label}不存在`
  const validationMessage = options.validationMessage ?? `${label}草稿参数不合法`
  const runtimes = buildRuntime(options.children, headMeta.name, headMeta.name)

  const companyField = physicalFields(headMeta).find((f) => f.dbColumn === 'company_id')

  async function loadHead(
    handle: DbHandle,
    permit: Permit,
    id: string,
    forUpdate: boolean,
  ): Promise<StandardItem> {
    const row = await loadAuthorized({
      db: handle,
      permit,
      target: headTarget,
      table: headMeta.table,
      id,
      forUpdate,
      notFoundMessage: notFound,
    })
    return mapRow(headMeta, row as Record<string, unknown>) as StandardItem
  }

  async function listChildren(
    handle: DbHandle,
    node: ChildRuntime,
    parentId: string,
  ): Promise<StandardItem[]> {
    const result = await sql<Record<string, unknown>>`
      SELECT * FROM ${sql.id(node.table)}
      WHERE ${sql.id(node.fk.dbColumn)} = ${parentId}::uuid
      ORDER BY ${node.orderSql}
    `.execute(handle)
    return result.rows.map((row) => mapRow(node.meta, row) as StandardItem)
  }

  async function loadTree(
    handle: DbHandle,
    permit: Permit,
    id: string,
  ): Promise<Record<string, unknown>> {
    const headRow = await loadHead(handle, permit, id, false)
    return attachChildren(handle, headRow, runtimes)
  }

  async function attachChildren(
    handle: DbHandle,
    parent: StandardItem,
    nodes: readonly ChildRuntime[],
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = { ...parent }
    for (const node of nodes) {
      const rows = await listChildren(handle, node, parent.id)
      out[node.spec.key] = await Promise.all(
        rows.map((row) => attachChildren(handle, row, node.children)),
      )
    }
    return out
  }

  /**
   * 预载 replace 用的既有行索引：resourceName → parentId → id 集合。
   * 一次扫完子树，避免身份校验与删行阶段重复查询形态不一致。
   */
  async function indexExisting(
    handle: DbHandle,
    headId: string,
  ): Promise<Map<string, Map<string, Set<string>>>> {
    const index = new Map<string, Map<string, Set<string>>>()

    async function walk(nodes: readonly ChildRuntime[], parentId: string): Promise<void> {
      for (const node of nodes) {
        const rows = await listChildren(handle, node, parentId)
        let byParent = index.get(node.meta.name)
        if (!byParent) {
          byParent = new Map()
          index.set(node.meta.name, byParent)
        }
        byParent.set(parentId, new Set(rows.map((r) => r.id)))
        for (const row of rows) {
          if (node.children.length > 0) await walk(node.children, row.id)
        }
      }
    }

    await walk(runtimes, headId)
    return index
  }

  async function deleteTree(trx: TrxHandle, permit: Permit, node: ChildRuntime, rowId: string): Promise<void> {
    // 先删孙级再删本行——逐行审计；DB CASCADE 仅作兜底
    if (node.children.length > 0) {
      for (const child of node.children) {
        const nested = await listChildren(trx, child, rowId)
        for (const row of nested) {
          await deleteTree(trx, permit, child, row.id)
        }
      }
    }
    await node.spec.service.removeInTx(trx, permit, rowId)
  }

  async function createTree(
    trx: TrxHandle,
    permit: Permit,
    node: ChildRuntime,
    parentId: string,
    input: Record<string, unknown>,
    path: string,
  ): Promise<StandardItem> {
    const payload = stripCollections(input, node.children)
    const created = await withIndexedFields(path, () =>
      node.spec.service.createInTx(trx, permit, {
        ...payload,
        [node.fk.apiName]: parentId,
      }),
    )
    for (const child of node.children) {
      const rows = requireArray(input, child.spec.key, path, validationMessage)
      for (let i = 0; i < rows.length; i++) {
        await createTree(
          trx,
          permit,
          child,
          created.id,
          rows[i]!,
          `${path}.${child.spec.key}[${i}]`,
        )
      }
    }
    return created
  }

  async function saveTree(
    trx: TrxHandle,
    permit: Permit,
    node: ChildRuntime,
    parentId: string,
    input: Record<string, unknown>,
    path: string,
  ): Promise<StandardItem> {
    const payload = stripCollections(input, node.children)
    let saved: StandardItem
    if (input.id === undefined) {
      saved = await withIndexedFields(path, () =>
        node.spec.service.createInTx(trx, permit, {
          ...payload,
          [node.fk.apiName]: parentId,
        }),
      )
    } else {
      const id = String(input.id)
      // 既有行：先删 omitted 孙级，再更新本行（与报价 replace 时序一致）
      for (const child of node.children) {
        const childInputs = requireArray(input, child.spec.key, path, validationMessage)
        const requested = new Set(
          childInputs.flatMap((row) => (typeof row.id === 'string' ? [row.id] : [])),
        )
        const existingNested = await listChildren(trx, child, id)
        for (const row of existingNested) {
          if (!requested.has(row.id)) await deleteTree(trx, permit, child, row.id)
        }
      }
      saved = await withIndexedFields(path, () =>
        node.spec.service.updateInTx(trx, permit, id, payload),
      )
    }
    for (const child of node.children) {
      const rows = requireArray(input, child.spec.key, path, validationMessage)
      for (let i = 0; i < rows.length; i++) {
        await saveTree(
          trx,
          permit,
          child,
          saved.id,
          rows[i]!,
          `${path}.${child.spec.key}[${i}]`,
        )
      }
    }
    return saved
  }

  async function loadDraft(permit: Permit, id: string): Promise<Record<string, unknown>> {
    return withReadSnapshot(db, (snapshot) => loadTree(snapshot, permit, id))
  }

  async function createDraft(
    permit: Permit,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const draft = asRecord(input, '', validationMessage)
    // 全集合显式 + 新记录禁 id
    const fields: Record<string, string[]> = {}
    collectNoIds(draft, runtimes, '', fields, validationMessage)
    if (Object.keys(fields).length > 0) throw ApiError.validation(validationMessage, fields)

    return withTx(db, async (trx) => {
      const headItem = await withIndexedFields('header', () =>
        head.createInTx(trx, permit, stripCollections(draft, runtimes)),
      )
      for (const node of runtimes) {
        const rows = requireArray(draft, node.spec.key, '', validationMessage)
        for (let i = 0; i < rows.length; i++) {
          await createTree(trx, permit, node, headItem.id, rows[i]!, `${node.spec.key}[${i}]`)
        }
      }
      return loadTree(trx, permit, headItem.id)
    })
  }

  async function replaceDraft(
    permit: Permit,
    id: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const draft = asRecord(input, '', validationMessage)
    // 入口先校验集合键存在（写库前 fail-closed；不把缺字段当空删）
    for (const node of runtimes) {
      requireArray(draft, node.spec.key, '', validationMessage)
    }

    return withTx(db, async (trx) => {
      const before = await loadHead(trx, permit, id, true)
      if (companyField) {
        const nextCompany = draft[companyField.apiName]
        if (
          nextCompany !== undefined &&
          nextCompany !== null &&
          String(nextCompany) !== String(before[companyField.apiName])
        ) {
          throw ApiError.validation(validationMessage, {
            [companyField.apiName]: ['创建后不可修改公司'],
          })
        }
      }

      const existingIndex = await indexExisting(trx, id)
      const fields: Record<string, string[]> = {}
      collectIdentityErrors(
        draft,
        runtimes,
        existingIndex,
        id,
        '',
        label,
        fields,
        validationMessage,
      )
      if (Object.keys(fields).length > 0) throw ApiError.validation(validationMessage, fields)

      // D4：omitted 顶层子行先删（含子树），再更新头
      for (const node of runtimes) {
        const rows = requireArray(draft, node.spec.key, '', validationMessage)
        const requested = new Set(
          rows.flatMap((row) => (typeof row.id === 'string' ? [row.id] : [])),
        )
        const existing = await listChildren(trx, node, id)
        for (const row of existing) {
          if (!requested.has(row.id)) await deleteTree(trx, permit, node, row.id)
        }
      }

      await withIndexedFields('header', () =>
        head.updateInTx(trx, permit, id, stripCollections(draft, runtimes)),
      )

      for (const node of runtimes) {
        const rows = requireArray(draft, node.spec.key, '', validationMessage)
        for (let i = 0; i < rows.length; i++) {
          await saveTree(trx, permit, node, id, rows[i]!, `${node.spec.key}[${i}]`)
        }
      }

      return loadTree(trx, permit, id)
    })
  }

  return {
    loadDraft,
    createDraft,
    replaceDraft,
    head,
    children: options.children,
  }
}
