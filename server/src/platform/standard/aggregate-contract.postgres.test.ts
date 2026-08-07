/**
 * 聚合草稿合同测试：对每个聚合派生资源跑同一组断言。
 *
 * 合同（写一次，所有接入资源免费继承）：
 * - createDraft 整单落库；头与子行 create 审计
 * - replaceDraft 缺失即删除；显式空数组清空全部子行
 * - 缺集合键 fail-closed（不把缺字段当空删——后端对「暂态空不删」的对偶；
 *   编辑态闸门仍在前端 `assertAggregateDraftReady`）
 * - 逐行审计三型（create / update / destroy）
 * - 任一行失败整单回滚（原子性）
 * - 无差异不落库不审计
 * - 公司创建后不可改
 * - 授权决策 fail-closed
 *
 * 新聚合资源迁入后在 CASES 里加一行描述符即可（W2+ 业务资源）。
 * 合成 stdAc* 作合同种子，与 standard-v2 的 std_v2_* 表隔离，避免并行测互踩。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { createRegistry, type Registry } from '~/platform/meta/registry.ts'
import type { FieldMeta, ResourceMeta } from '~/platform/meta/types.ts'
import { createAggregateService, type AggregateService } from './aggregate.ts'
import { createStandardChildService } from './child.ts'
import { createStandardService } from './service.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10)

function field(
  name: string,
  apiName: string,
  type: FieldMeta['type'],
  label: string,
  extra: Partial<FieldMeta> = {},
): FieldMeta {
  return { name, apiName, dbColumn: name, type, label, ...extra }
}

const crud = [
  { key: 'read', label: '查看', scope: 'row' as const },
  { key: 'create', label: '新建', scope: 'row' as const },
  { key: 'update', label: '编辑', scope: 'row' as const },
  { key: 'delete', label: '删除', scope: 'row' as const },
  { key: 'batch_update', label: '批量编辑', scope: 'bulk' as const },
  { key: 'batch_delete', label: '批量删除', scope: 'bulk' as const },
]

const statusOptions = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'AUDITED', label: '已审核' },
]

// ── 合成资源 meta（合同种子；表名 std_ac_* 与 v2 隔离）──────────────────────

function acDocMeta(): ResourceMeta {
  return {
    name: 'stdAcDocs',
    classification: { presentation: 'none', interactive: false, note: '聚合合同种子·头' },
    permissionPrefix: 'stdac.doc',
    permissionLabel: '合同测试单',
    table: 'std_ac_doc',
    authz: { kind: 'company' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('name', 'name', 'string', '名称', { required: true, maxLength: 64, filterable: true }),
      field('status', 'status', 'enum', '状态', {
        readonly: true,
        enumOptions: statusOptions,
        filterable: true,
      }),
      field('company_id', 'companyId', 'uuid', '公司', { required: true, createOnly: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true }),
    ],
    actions: crud,
    audit: { enabled: true },
  }
}

function acItemMeta(): ResourceMeta {
  return {
    name: 'stdAcItems',
    classification: { presentation: 'none', interactive: false, note: '聚合合同种子·行' },
    permissionPrefix: 'stdac.item',
    permissionLabel: '合同测试行',
    table: 'std_ac_item',
    authz: { kind: 'via', parent: 'stdAcDocs', fk: 'doc_id' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('doc_id', 'docId', 'uuid', '母单', { required: true, createOnly: true, filterable: true }),
      field('idx', 'idx', 'integer', '行号', { required: true, sortable: true }),
      field('qty', 'qty', 'decimal', '数量', { required: true }),
      field('company_id', 'companyId', 'uuid', '公司', { readonly: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true }),
    ],
    actions: crud.slice(0, 4),
    audit: { enabled: true },
  }
}

function acTierMeta(): ResourceMeta {
  return {
    name: 'stdAcTiers',
    classification: { presentation: 'none', interactive: false, note: '聚合合同种子·孙级' },
    permissionPrefix: 'stdac.tier',
    permissionLabel: '合同测试档',
    table: 'std_ac_tier',
    authz: { kind: 'via', parent: 'stdAcItems', fk: 'item_id' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('item_id', 'itemId', 'uuid', '母行', { required: true, createOnly: true, filterable: true }),
      field('min_qty', 'minQty', 'decimal', '起订量', { required: true }),
      field('price', 'price', 'decimal', '档价', { required: true }),
      field('company_id', 'companyId', 'uuid', '公司', { readonly: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true }),
    ],
    actions: crud.slice(0, 4),
    audit: { enabled: true },
  }
}

// ── 描述符 ──────────────────────────────────────────────────────────────────

interface AggregateContractCase {
  title: string
  /** 头资源名（authz / permit） */
  headResource: string
  /** 决策层 fail-closed 覆盖的资源（头 + 子 + 孙） */
  authzResources: string[]
  headTable: string
  itemTable: string
  /** draft 上一级集合键（items / lines…） */
  itemsKey: string
  /** 可选孙级（价格档等）；无则跳过孙级审计断言 */
  nested?: { table: string; key: string }
  /**
   * 装配聚合服务 + 已 seal 的 registry。
   * 合成种子自建 registry；业务资源可用 sealed 全局 registry。
   */
  prepare: (db: ReturnType<typeof createDb>) => { service: AggregateService; registry: Registry }
  companyId: () => string
  otherCompanyId: () => string
  /** 至少两行一级子（便于缺失删 + 保留改）；有孙级时首行带 ≥1 档 */
  validDraft: () => Record<string, unknown>
  /**
   * 有差异替换：改头名、改保留行、删一行、加一行。
   * 返回 input 与断言用 id。
   */
  buildDiffReplace: (created: Record<string, unknown>) => {
    input: Record<string, unknown>
    keptItemId: string
    deletedItemId: string
  }
  /** 与现值完全一致的快照（含全部 id） */
  buildNoopReplace: (created: Record<string, unknown>) => Record<string, unknown>
  /** 含一行故意校验失败的替换（整单应回滚） */
  buildFailReplace: (created: Record<string, unknown>) => Record<string, unknown>
  /** 显式空集合 = 删全部子行 */
  buildEmptyReplace: (created: Record<string, unknown>) => Record<string, unknown>
}

/** 合成夹具公司 id（无 FK；仅 wire 字段） */
const syntheticFixture = {
  companyId: crypto.randomUUID(),
  otherCompanyId: crypto.randomUUID(),
}

function asItems(draft: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const rows = draft[key]
  if (!Array.isArray(rows)) throw new Error(`合同夹具：draft.${key} 须为数组`)
  return rows as Array<Record<string, unknown>>
}

/**
 * 从 load/create 结果重建 noop 快照：保留 id + 可写字段。
 * 合成资源字段固定；业务 CASES 应自写 buildNoopReplace。
 */
function syntheticNoop(created: Record<string, unknown>): Record<string, unknown> {
  const items = asItems(created, 'items').map((item) => {
    const tiers = Array.isArray(item.tiers)
      ? (item.tiers as Array<Record<string, unknown>>).map((t) => ({
          id: t.id,
          minQty: t.minQty,
          price: t.price,
        }))
      : []
    return { id: item.id, idx: item.idx, qty: item.qty, tiers }
  })
  return {
    name: created.name,
    companyId: created.companyId,
    items,
  }
}

const CASES: AggregateContractCase[] = [
  {
    title: '合成聚合（stdAc）',
    headResource: 'stdAcDocs',
    authzResources: ['stdAcDocs', 'stdAcItems', 'stdAcTiers'],
    headTable: 'std_ac_doc',
    itemTable: 'std_ac_item',
    itemsKey: 'items',
    nested: { table: 'std_ac_tier', key: 'tiers' },
    prepare: (db) => {
      const registry = createRegistry()
      registry.register(acDocMeta())
      registry.register(acItemMeta())
      registry.register(acTierMeta())
      registry.seal()

      const head = createStandardService({
        db,
        registry,
        resource: 'stdAcDocs',
        hooks: {
          insertColumns: () => ({ status: 'draft' }),
        },
      })
      const items = createStandardChildService({
        db,
        registry,
        resource: 'stdAcItems',
        parent: {
          resource: 'stdAcDocs',
          fkField: 'docId',
          inheritFields: ['companyId'],
          gate: (parent) => {
            if (parent.status !== 'DRAFT') {
              throw new ApiError('conflict', '仅草稿合同测试单可编辑单据行')
            }
          },
        },
      })
      const tiers = createStandardChildService({
        db,
        registry,
        resource: 'stdAcTiers',
        parent: {
          resource: 'stdAcItems',
          fkField: 'itemId',
          inheritFields: ['companyId'],
          notFound: '合同测试行不存在',
        },
        notFound: '合同测试档不存在',
        defaultOrder: sql`"id" ASC`,
      })
      const service = createAggregateService({
        db,
        registry,
        head,
        children: [
          {
            key: 'items',
            service: items,
            children: [{ key: 'tiers', service: tiers }],
          },
        ],
      })
      return { service, registry }
    },
    companyId: () => syntheticFixture.companyId,
    otherCompanyId: () => syntheticFixture.otherCompanyId,
    validDraft: () => ({
      name: `合同聚-${crypto.randomUUID().slice(0, 8)}`,
      companyId: syntheticFixture.companyId,
      items: [
        {
          idx: 1,
          qty: '10',
          tiers: [
            { minQty: '1', price: '10.0000' },
            { minQty: '10', price: '9.0000' },
          ],
        },
        { idx: 2, qty: '20', tiers: [{ minQty: '1', price: '5.0000' }] },
      ],
    }),
    buildDiffReplace: (created) => {
      const items = asItems(created, 'items')
      const kept = items[0]!
      const deleted = items[1]!
      const keptTiers = (kept.tiers as Array<Record<string, unknown>>) ?? []
      const tier0 = keptTiers[0]!
      return {
        keptItemId: String(kept.id),
        deletedItemId: String(deleted.id),
        input: {
          name: `合同改-${crypto.randomUUID().slice(0, 8)}`,
          companyId: created.companyId,
          items: [
            {
              id: kept.id,
              idx: 1,
              qty: '11',
              tiers: [
                { id: tier0.id, minQty: '1', price: '11.0000' },
                // 第二档缺失 → 删
                { minQty: '100', price: '7.0000' },
              ],
            },
            // deleted 缺失 → 删整行（含其孙级）
            { idx: 3, qty: '3', tiers: [{ minQty: '1', price: '2.0000' }] },
          ],
        },
      }
    },
    buildNoopReplace: syntheticNoop,
    buildFailReplace: (created) => {
      const items = asItems(created, 'items')
      const kept = items[0]!
      const keptTiers = ((kept.tiers as Array<Record<string, unknown>>) ?? []).map((t) => ({
        id: t.id,
        minQty: t.minQty,
        price: t.price,
      }))
      return {
        name: '不应落库',
        companyId: created.companyId,
        items: [
          { id: kept.id, idx: kept.idx, qty: '99', tiers: keptTiers },
          // qty 必填缺失 → child 校验失败
          { idx: 9, tiers: [] },
        ],
      }
    },
    buildEmptyReplace: (created) => ({
      name: created.name,
      companyId: created.companyId,
      items: [],
    }),
  },
  // W2+：salQuotations / purQuotations / purReceipts … 各加一行描述符即可继承本合同。
]

// ── 套件 ────────────────────────────────────────────────────────────────────

run('聚合草稿合同（postgres）', () => {
  const db = createDb(url!)

  beforeAll(async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS std_ac_doc (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(64) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'draft',
        company_id uuid NOT NULL,
        inserted_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
        updated_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
      )
    `.execute(db)
    await sql`
      CREATE TABLE IF NOT EXISTS std_ac_item (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        doc_id uuid NOT NULL REFERENCES std_ac_doc(id) ON DELETE CASCADE,
        idx integer NOT NULL,
        qty numeric(18,6) NOT NULL,
        company_id uuid NOT NULL,
        inserted_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
        updated_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
      )
    `.execute(db)
    await sql`
      CREATE TABLE IF NOT EXISTS std_ac_tier (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        item_id uuid NOT NULL REFERENCES std_ac_item(id) ON DELETE CASCADE,
        min_qty numeric(18,6) NOT NULL,
        price numeric(18,6) NOT NULL,
        company_id uuid NOT NULL,
        inserted_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
        updated_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
      )
    `.execute(db)
  })

  afterAll(async () => {
    await sql`DELETE FROM sys_audit_log WHERE resource IN ('std_ac_doc', 'std_ac_item', 'std_ac_tier')`.execute(
      db,
    )
    await sql`DROP TABLE IF EXISTS std_ac_tier`.execute(db)
    await sql`DROP TABLE IF EXISTS std_ac_item`.execute(db)
    await sql`DROP TABLE IF EXISTS std_ac_doc`.execute(db)
    await db.destroy()
  })

  async function auditCount(table: string, recordId: string, actionType: string): Promise<number> {
    const rows = await db
      .selectFrom('sys_audit_log')
      .select('id')
      .where('resource', '=', table)
      .where('record_id', '=', recordId)
      .where('action_type', '=', actionType)
      .execute()
    return rows.length
  }

  for (const c of CASES) {
    describe(c.title, () => {
      const { service, registry } = c.prepare(db)
      const authz = createAuthzEnforcer(registry)
      const admin = testActor({
        username: `agg-contract-${suffix}`,
        superAdmin: true,
        allCompanies: true,
      })

      function permitOf(actor: Actor, resource: string, action: string): Permit {
        const decision = authz.decideFor(actor, resource, action)
        if (decision.outcome !== 'permit') {
          throw new Error(`夹具应当 permit：${resource}:${action}`)
        }
        return decision.permit
      }

      const p = (action: string) => permitOf(admin, c.headResource, action)

      test('无授权 actor 决策层即 deny（fail-closed）', () => {
        const nobody = testActor({ username: `agg-nobody-${suffix}` })
        for (const resource of c.authzResources) {
          for (const action of ['read', 'create', 'update', 'delete']) {
            expect(authz.decideFor(nobody, resource, action).outcome).not.toBe('permit')
          }
        }
      })

      test('createDraft：整单落库；头与子行 create 审计', async () => {
        const created = await service.createDraft(p('create'), c.validDraft())
        expect(created.id).toBeTruthy()
        expect(await auditCount(c.headTable, String(created.id), 'create')).toBe(1)

        const items = asItems(created, c.itemsKey)
        expect(items.length).toBeGreaterThanOrEqual(2)
        for (const item of items) {
          expect(await auditCount(c.itemTable, String(item.id), 'create')).toBe(1)
        }
        if (c.nested) {
          const nestedRows = items.flatMap((item) => {
            const nested = item[c.nested!.key]
            return Array.isArray(nested) ? (nested as Array<Record<string, unknown>>) : []
          })
          expect(nestedRows.length).toBeGreaterThanOrEqual(1)
          for (const row of nestedRows) {
            expect(await auditCount(c.nested.table, String(row.id), 'create')).toBe(1)
          }
        }

        const loaded = await service.loadDraft(p('read'), String(created.id))
        expect(loaded.id).toBe(created.id)
        expect(asItems(loaded, c.itemsKey).length).toBe(items.length)
      })

      test('replaceDraft：缺失即删 + 逐行审计三型（改/删/增）', async () => {
        const created = await service.createDraft(p('create'), c.validDraft())
        const { input, keptItemId, deletedItemId } = c.buildDiffReplace(created)

        const replaced = await service.replaceDraft(p('update'), String(created.id), input)
        expect(await auditCount(c.headTable, String(created.id), 'update')).toBe(1)
        expect(await auditCount(c.itemTable, keptItemId, 'update')).toBe(1)
        expect(await auditCount(c.itemTable, deletedItemId, 'destroy')).toBe(1)

        const items = asItems(replaced, c.itemsKey)
        expect(items.some((i) => String(i.id) === keptItemId)).toBe(true)
        expect(items.some((i) => String(i.id) === deletedItemId)).toBe(false)
        const added = items.find((i) => String(i.id) !== keptItemId)
        expect(added).toBeTruthy()
        expect(await auditCount(c.itemTable, String(added!.id), 'create')).toBe(1)
      })

      test('replaceDraft：显式空集合 = 删全部子行（权威快照）', async () => {
        const created = await service.createDraft(p('create'), c.validDraft())
        const itemIds = asItems(created, c.itemsKey).map((i) => String(i.id))
        expect(itemIds.length).toBeGreaterThanOrEqual(1)

        const emptied = await service.replaceDraft(
          p('update'),
          String(created.id),
          c.buildEmptyReplace(created),
        )
        expect(asItems(emptied, c.itemsKey)).toEqual([])
        for (const id of itemIds) {
          expect(await auditCount(c.itemTable, id, 'destroy')).toBe(1)
        }
      })

      test('缺集合键 fail-closed（不把缺字段当空删 · 暂态空对偶）', async () => {
        const created = await service.createDraft(p('create'), c.validDraft())
        const itemCountBefore = asItems(created, c.itemsKey).length
        const omit: Record<string, unknown> = {
          name: created.name,
          companyId: created.companyId,
        }
        // 故意不带 c.itemsKey

        await expect(
          service.replaceDraft(p('update'), String(created.id), omit),
        ).rejects.toMatchObject({
          code: 'validation',
          fields: { [c.itemsKey]: ['必须显式提交数组'] },
        })

        const reloaded = await service.loadDraft(p('read'), String(created.id))
        expect(asItems(reloaded, c.itemsKey).length).toBe(itemCountBefore)
        expect(await auditCount(c.headTable, String(created.id), 'update')).toBe(0)
      })

      test('replaceDraft：任一行失败整单回滚（原子性）', async () => {
        const created = await service.createDraft(p('create'), c.validDraft())
        const nameBefore = created.name
        const itemsBefore = asItems(created, c.itemsKey)
        const qtyBefore = itemsBefore[0]!.qty

        await expect(
          service.replaceDraft(p('update'), String(created.id), c.buildFailReplace(created)),
        ).rejects.toThrow()

        const reloaded = await service.loadDraft(p('read'), String(created.id))
        expect(reloaded.name).toBe(nameBefore)
        const items = asItems(reloaded, c.itemsKey)
        expect(items.length).toBe(itemsBefore.length)
        expect(items[0]!.qty).toBe(qtyBefore)
        expect(await auditCount(c.headTable, String(created.id), 'update')).toBe(0)
      })

      test('replaceDraft：无差异不落库不审计', async () => {
        const created = await service.createDraft(p('create'), c.validDraft())
        const item0 = asItems(created, c.itemsKey)[0]!
        await service.replaceDraft(p('update'), String(created.id), c.buildNoopReplace(created))
        expect(await auditCount(c.headTable, String(created.id), 'update')).toBe(0)
        expect(await auditCount(c.itemTable, String(item0.id), 'update')).toBe(0)
      })

      test('公司创建后不可改', async () => {
        const created = await service.createDraft(p('create'), c.validDraft())
        const noop = c.buildNoopReplace(created)
        await expect(
          service.replaceDraft(p('update'), String(created.id), {
            ...noop,
            companyId: c.otherCompanyId(),
          }),
        ).rejects.toMatchObject({
          code: 'validation',
          fields: { companyId: ['创建后不可修改公司'] },
        })
        const reloaded = await service.loadDraft(p('read'), String(created.id))
        expect(reloaded.companyId).toBe(c.companyId())
      })
    })
  }
})
