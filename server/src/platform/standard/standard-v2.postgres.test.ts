/**
 * 标准动作内核 v2 合同测试（合成资源 + 临时表，不依赖业务模块）：
 *
 * - workflow：状态机通则——可变状态才能改/删；转移 from 门/盖章/effect 合并列/
 *   审计 actionName；bulkTransition 单事务全成全败；effect 抛错整体回滚
 * - numbering：create 未提供单号自动取号；显式传入跳过
 * - tree：树锁下的父子校验（自身/不存在/后代成环）、物化路径与子树重写、
 *   有子节点删除保护
 * - projection：selectExtra/mapExtra 进 list 与 get（has_children 投影）
 * - child：母单授权锁 + 状态门 + 带入列；行审计三型
 * - 孙级（D3）：parent.resource 可指 child；链深 ≤2 装配；孙级 CRUD 与越母单 not_found
 * - InTx（D1）：root/child 动作族 `*InTx(trx, permit, …)`；外层事务回滚则全链无痕
 * - aggregate（D2/D4/D6）：loadDraft/createDraft/replaceDraft；缺失即删；
 *   删行先于头更新；numbering 走 head options；逐行审计三型；孙级子树
 *
 * 业务资源迁入后各自的行为由 standard-contract 描述符继承；本文件只锁内核语义。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { withTx } from '~/db/tx.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { createRegistry } from '~/platform/meta/registry.ts'
import type { FieldMeta, ResourceMeta } from '~/platform/meta/types.ts'
import { createAggregateService } from './aggregate.ts'
import {
  assertChildParentChainDepth,
  createStandardChildService,
  MAX_CHILD_PARENT_DEPTH,
} from './child.ts'
import { auditStamp, createStandardService } from './service.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

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
  { value: 'VOIDED', label: '已作废' },
]

function docMeta(): ResourceMeta {
  return {
    name: 'stdV2Docs',
    classification: { presentation: 'none', interactive: false, note: '内核合同测试合成资源' },
    permissionPrefix: 'stdv2.doc',
    permissionLabel: '测试单',
    table: 'std_v2_doc',
    authz: { kind: 'company' },
    numbering: true,
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('doc_no', 'docNo', 'string', '单号', { maxLength: 32, nullable: true, filterable: true, sortable: true }),
      field('name', 'name', 'string', '名称', { required: true, maxLength: 64, filterable: true, sortable: true }),
      field('scratch', 'scratch', 'string', '便签', { nullable: true, maxLength: 64 }),
      field('tags', 'tags', 'enumArray', '标签', {
        enumOptions: [
          { value: 'RED', label: '红' },
          { value: 'BLUE', label: '蓝' },
        ],
      }),
      field('status', 'status', 'enum', '状态', { readonly: true, enumOptions: statusOptions, filterable: true }),
      field('audited_at', 'auditedAt', 'datetime', '审核时间', { readonly: true }),
      field('audited_by_id', 'auditedById', 'uuid', '审核人', { readonly: true }),
      field('stamped_note', 'stampedNote', 'string', '系统章', { readonly: true, nullable: true }),
      field('company_id', 'companyId', 'uuid', '公司', { required: true, createOnly: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, sortable: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, sortable: true }),
    ],
    actions: [
      ...crud,
      { key: 'audit', label: '审核', scope: 'row' as const },
      { key: 'void', label: '作废', scope: 'row' as const },
    ],
    // scratch 可写但排除出审计白名单：钉「无差异判定按可写列算,不得丢写」
    audit: { enabled: true, exclude: ['scratch'] },
  }
}

function itemMeta(): ResourceMeta {
  return {
    name: 'stdV2Items',
    classification: { presentation: 'none', interactive: false, note: '内核合同测试合成子行' },
    permissionPrefix: 'stdv2.item',
    permissionLabel: '测试单行',
    table: 'std_v2_item',
    authz: { kind: 'via', parent: 'stdV2Docs', fk: 'doc_id' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('doc_id', 'docId', 'uuid', '母单', { required: true, createOnly: true, filterable: true }),
      field('idx', 'idx', 'integer', '行号', { required: true, sortable: true }),
      field('qty', 'qty', 'decimal', '数量', { required: true }),
      field('qty_x2', 'qtyX2', 'decimal', '双倍数量', { readonly: true }),
      field('company_id', 'companyId', 'uuid', '公司', { readonly: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true }),
    ],
    actions: crud.slice(0, 4),
    audit: { enabled: true },
  }
}

/** 孙级：parent=stdV2Items（via docs）→ 链深 2，D3 首消费者形态（价格档/装箱行） */
function tierMeta(): ResourceMeta {
  return {
    name: 'stdV2Tiers',
    classification: { presentation: 'none', interactive: false, note: '内核合同测试合成孙级' },
    permissionPrefix: 'stdv2.tier',
    permissionLabel: '测试价格档',
    table: 'std_v2_tier',
    authz: { kind: 'via', parent: 'stdV2Items', fk: 'item_id' },
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

function nodeMeta(): ResourceMeta {
  return {
    name: 'stdV2Nodes',
    classification: { presentation: 'none', interactive: false, note: '内核合同测试合成树' },
    permissionPrefix: 'stdv2.node',
    permissionLabel: '测试节点',
    table: 'std_v2_node',
    authz: { kind: 'global' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('name', 'name', 'string', '名称', { required: true, maxLength: 64, filterable: true, sortable: true }),
      field('parent_id', 'parentId', 'uuid', '上级', { nullable: true, filterable: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true }),
    ],
    actions: crud,
    audit: { enabled: true },
  }
}

/** 装配期链深断言（不依赖 DB；D3 纯描述符校验） */
describe('标准子行装配（孙级链深 D3）', () => {
  test(`parent 指向 child 时链深 ${MAX_CHILD_PARENT_DEPTH} 可装配；链深 3 装配期抛错`, () => {
    const registry = createRegistry()
    registry.register(docMeta())
    registry.register(itemMeta())
    registry.register(tierMeta())
    // 曾孙：故意超限
    registry.register({
      name: 'stdV2TooDeep',
      classification: { presentation: 'none', interactive: false, note: '超限链深合成' },
      permissionPrefix: 'stdv2.deep',
      permissionLabel: '超限孙孙',
      table: 'std_v2_too_deep',
      authz: { kind: 'via', parent: 'stdV2Tiers', fk: 'tier_id' },
      fields: [
        field('id', 'id', 'uuid', 'id', { readonly: true }),
        field('tier_id', 'tierId', 'uuid', '母档', { required: true, createOnly: true }),
        field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true }),
        field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true }),
      ],
      actions: crud.slice(0, 4),
      audit: { enabled: true },
    })
    registry.seal()

    expect(() => assertChildParentChainDepth('stdV2Items', 'stdV2Docs', registry)).not.toThrow()
    expect(() => assertChildParentChainDepth('stdV2Tiers', 'stdV2Items', registry)).not.toThrow()
    expect(() => assertChildParentChainDepth('stdV2TooDeep', 'stdV2Tiers', registry)).toThrow(
      /parent 链深 3 超过上限 2/,
    )

    // parent.resource 与 meta.authz.parent 不一致 → 装配失败
    expect(() =>
      createStandardChildService({
        db: null as never,
        registry,
        resource: 'stdV2Tiers',
        parent: { resource: 'stdV2Docs', fkField: 'itemId' },
      }),
    ).toThrow(/parent\.resource=stdV2Docs 与 meta\.authz\.parent=stdV2Items 不一致/)

    // 链深 3：createStandardChildService 同步 fail-closed（不落到运行时）
    expect(() =>
      createStandardChildService({
        db: null as never,
        registry,
        resource: 'stdV2TooDeep',
        parent: { resource: 'stdV2Tiers', fkField: 'tierId' },
      }),
    ).toThrow(/parent 链深 3 超过上限 2/)
  })
})

run('标准动作内核 v2（postgres）', () => {
  const db = createDb(url!)
  const registry = createRegistry()
  registry.register(docMeta())
  registry.register(itemMeta())
  registry.register(tierMeta())
  registry.register(nodeMeta())
  registry.seal()
  const authz = createAuthzEnforcer(registry)
  const admin = testActor({ username: `std-v2-${crypto.randomUUID().slice(0, 8)}`, superAdmin: true, allCompanies: true })

  function permitOf(actor: Actor, resource: string, action: string): Permit {
    const decision = authz.decideFor(actor, resource, action)
    if (decision.outcome !== 'permit') throw new Error(`夹具应当 permit：${resource}:${action}`)
    return decision.permit
  }
  const p = (action: string, resource = 'stdV2Docs') => permitOf(admin, resource, action)

  const companyId = crypto.randomUUID()
  const otherCompanyId = crypto.randomUUID()
  let numberingCalls = 0
  const fakeNumbering = {
    nextInTx: async (_handle: unknown, input: { resource: string }) => {
      numberingCalls += 1
      expect(input.resource).toBe('stdv2.doc')
      return `AUTO-${String(numberingCalls).padStart(4, '0')}`
    },
  }

  /** effect 探针：返回附加 SET 列并计数 */
  let effectRuns = 0
  let effectFail = false

  const docs = createStandardService({
    db,
    registry,
    resource: 'stdV2Docs',
    numbering: { service: fakeNumbering, field: 'docNo' },
    hooks: {
      insertColumns: () => ({ stamped_note: 'G1' }),
    },
    workflow: {
      mutableStatuses: ['DRAFT'],
      mutableMessage: '仅草稿测试单可修改或删除',
      transitions: [
        {
          key: 'audit',
          label: '审核',
          from: ['DRAFT'],
          to: 'AUDITED',
          guardMessage: '仅草稿测试单可审核',
          stamps: ({ permit }) => auditStamp(permit),
          effect: async () => {
            if (effectFail) throw new Error('引擎爆炸')
            effectRuns += 1
            return { name: '效果改名' }
          },
        },
        {
          key: 'void',
          label: '作废',
          from: ['AUDITED'],
          to: 'VOIDED',
          guardMessage: '仅已审核测试单可作废',
        },
      ],
    },
  })

  const items = createStandardChildService({
    db,
    registry,
    resource: 'stdV2Items',
    parent: {
      resource: 'stdV2Docs',
      fkField: 'docId',
      inheritFields: ['companyId'],
      gate: (parent) => {
        if (parent.status !== 'DRAFT') throw new ApiError('conflict', '仅草稿测试单可编辑单据行')
      },
    },
    derivedFields: ['qtyX2'],
    hooks: {
      beforeWrite: (_trx, { draft }) => {
        draft.qtyX2 = String(Number(draft.qty) * 2)
      },
    },
  })

  /** 孙级：parent.resource 指向 child（stdV2Items），链深 2 */
  const tiers = createStandardChildService({
    db,
    registry,
    resource: 'stdV2Tiers',
    parent: {
      resource: 'stdV2Items',
      fkField: 'itemId',
      inheritFields: ['companyId'],
      notFound: '测试单行不存在',
    },
    notFound: '测试价格档不存在',
    // 孙级无 idx 列；避免默认 `"idx" ASC` 在 list 时炸列
    defaultOrder: sql`"id" ASC`,
  })

  /** 聚合草稿：头 + 条目 + 价格档（D2/D4/D6 合成合同） */
  const aggregate = createAggregateService({
    db,
    registry,
    head: docs,
    children: [
      {
        key: 'items',
        service: items,
        children: [{ key: 'tiers', service: tiers }],
      },
    ],
  })

  const nodes = createStandardService({
    db,
    registry,
    resource: 'stdV2Nodes',
    tree: { pathColumn: 'path' },
    projection: {
      source: sql` FROM std_v2_node`,
      alias: 'std_v2_node',
      selectExtra: sql`EXISTS(SELECT 1 FROM std_v2_node c WHERE c.parent_id = std_v2_node.id) AS has_children`,
      mapExtra: (row) => ({ hasChildren: Boolean(row.has_children) }),
    },
  })

  async function auditRows(table: string, recordId: string, actionName: string): Promise<number> {
    const rows = await sql<{ id: string }>`
      SELECT id FROM sys_audit_log
      WHERE resource = ${table} AND record_id = ${recordId}::uuid AND action_name = ${actionName}
    `.execute(db)
    return rows.rows.length
  }

  beforeAll(async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS std_v2_doc (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        doc_no varchar(32),
        name varchar(64) NOT NULL,
        scratch varchar(64),
        stamped_note varchar(32),
        tags text[] NOT NULL DEFAULT '{}',
        status varchar(16) NOT NULL DEFAULT 'draft',
        audited_at timestamp,
        audited_by_id uuid,
        company_id uuid NOT NULL,
        inserted_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
        updated_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
      )
    `.execute(db)
    await sql`
      CREATE TABLE IF NOT EXISTS std_v2_item (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        doc_id uuid NOT NULL REFERENCES std_v2_doc(id) ON DELETE CASCADE,
        idx integer NOT NULL,
        qty numeric(18,6) NOT NULL,
        qty_x2 numeric(18,6),
        company_id uuid NOT NULL,
        inserted_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
        updated_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
      )
    `.execute(db)
    await sql`
      CREATE TABLE IF NOT EXISTS std_v2_tier (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        item_id uuid NOT NULL REFERENCES std_v2_item(id) ON DELETE CASCADE,
        min_qty numeric(18,6) NOT NULL,
        price numeric(18,6) NOT NULL,
        company_id uuid NOT NULL,
        inserted_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
        updated_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
      )
    `.execute(db)
    await sql`
      CREATE TABLE IF NOT EXISTS std_v2_node (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(64) NOT NULL,
        parent_id uuid REFERENCES std_v2_node(id),
        path varchar NOT NULL,
        inserted_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
        updated_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
      )
    `.execute(db)
  })

  afterAll(async () => {
    await sql`DELETE FROM sys_audit_log WHERE resource IN ('std_v2_doc', 'std_v2_item', 'std_v2_tier', 'std_v2_node')`.execute(db)
    await sql`DROP TABLE IF EXISTS std_v2_tier`.execute(db)
    await sql`DROP TABLE IF EXISTS std_v2_item`.execute(db)
    await sql`DROP TABLE IF EXISTS std_v2_doc`.execute(db)
    await sql`DROP TABLE IF EXISTS std_v2_node`.execute(db)
    await db.destroy()
  })

  async function createDraft(name = `单-${crypto.randomUUID().slice(0, 6)}`) {
    // 编号一律系统生成（ADR 2026-08-06-system-generated-numbering）：不再手填单号
    return docs.create(p('create'), { name, companyId })
  }

  describe('无差异判定按可写列（审计白名单外的可写列不得丢写）', () => {
    test('只改 audit.exclude 可写列：落库、不写审计;审计面变化才写审计行', async () => {
      const doc = await createDraft()
      const updated = await docs.update(p('update'), doc.id, { scratch: '便签一' })
      expect(updated.scratch).toBe('便签一')
      const raw = await sql<{ scratch: string | null }>`
        SELECT scratch FROM std_v2_doc WHERE id = ${doc.id}::uuid
      `.execute(db)
      expect(raw.rows[0]!.scratch).toBe('便签一')
      expect(await auditRows('std_v2_doc', doc.id, 'update')).toBe(0)

      // 审计面内列变化 → 落库且写审计
      await docs.update(p('update'), doc.id, { name: '审计面变化' })
      expect(await auditRows('std_v2_doc', doc.id, 'update')).toBe(1)

      // 同值补丁(含 exclude 列)仍是无差异:不落库不审计
      const noop = await docs.update(p('update'), doc.id, { scratch: '便签一', name: '审计面变化' })
      expect(await auditRows('std_v2_doc', doc.id, 'update')).toBe(1)
      expect(noop.scratch).toBe('便签一')
    })
  })

  describe('enumArray', () => {
    test('wire 大写往返、库内小写;同值补丁无差异不审计', async () => {
      const doc = await docs.create(p('create'), { name: '标签单', companyId, tags: ['RED', 'BLUE'] })
      expect(doc.tags).toEqual(['RED', 'BLUE'])
      const raw = await sql<{ tags: string[] }>`SELECT tags FROM std_v2_doc WHERE id = ${doc.id}::uuid`.execute(db)
      expect(raw.rows[0]!.tags).toEqual(['red', 'blue'])

      await docs.update(p('update'), doc.id, { tags: ['RED', 'BLUE'] })
      expect(await auditRows('std_v2_doc', doc.id, 'update')).toBe(0)

      const updated = await docs.update(p('update'), doc.id, { tags: ['BLUE'] })
      expect(updated.tags).toEqual(['BLUE'])
      expect(await auditRows('std_v2_doc', doc.id, 'update')).toBe(1)
    })
  })

  describe('numbering', () => {
    test('未提供单号自动取号；显式传入一律 400（编号由系统生成）', async () => {
      const before = numberingCalls
      const auto = await docs.create(p('create'), { name: '取号单', companyId })
      expect(String(auto.docNo)).toStartWith('AUTO-')
      expect(numberingCalls).toBe(before + 1)

      await expect(
        docs.create(p('create'), { docNo: 'MANUAL-1', name: '手号单', companyId }),
      ).rejects.toMatchObject({ code: 'validation', message: '编号由系统生成,不接受手填' })
      expect(numberingCalls).toBe(before + 1)
    })
  })

  describe('workflow', () => {
    test('创建即草稿；审核翻转状态+盖章+效果列+审计 actionName', async () => {
      const doc = await createDraft()
      expect(doc.status).toBe('DRAFT')
      // G1:服务端派生插入列随 INSERT 落库,create 审计快照完整
      expect(doc.stampedNote).toBe('G1')

      const audited = await docs.transition(p('audit'), doc.id, 'audit')
      expect(audited.status).toBe('AUDITED')
      expect(audited.auditedAt).not.toBeNull()
      expect(audited.name).toBe('效果改名')
      expect(await auditRows('std_v2_doc', doc.id, 'audit')).toBe(1)
    })

    test('通则合同：已审核不能改/删，只能作废；作废后不能再作废', async () => {
      const doc = await createDraft()
      await docs.transition(p('audit'), doc.id, 'audit')

      await expect(docs.update(p('update'), doc.id, { name: '改' })).rejects.toMatchObject({
        code: 'conflict',
        message: '仅草稿测试单可修改或删除',
      })
      await expect(docs.remove(p('delete'), doc.id)).rejects.toMatchObject({ code: 'conflict' })
      await expect(docs.transition(p('audit'), doc.id, 'audit')).rejects.toMatchObject({
        code: 'conflict',
        message: '仅草稿测试单可审核',
      })

      const voided = await docs.transition(p('void'), doc.id, 'void')
      expect(voided.status).toBe('VOIDED')
      expect(await auditRows('std_v2_doc', doc.id, 'void')).toBe(1)
      await expect(docs.transition(p('void'), doc.id, 'void')).rejects.toMatchObject({ code: 'conflict' })
    })

    test('草稿不可作废（from 门）', async () => {
      const doc = await createDraft()
      await expect(docs.transition(p('void'), doc.id, 'void')).rejects.toMatchObject({
        code: 'conflict',
        message: '仅已审核测试单可作废',
      })
    })

    test('effect 抛错整体回滚：状态不动、无审计', async () => {
      const doc = await createDraft()
      effectFail = true
      try {
        await expect(docs.transition(p('audit'), doc.id, 'audit')).rejects.toThrow('引擎爆炸')
      } finally {
        effectFail = false
      }
      const still = await docs.get(p('read'), doc.id)
      expect(still.status).toBe('DRAFT')
      expect(await auditRows('std_v2_doc', doc.id, 'audit')).toBe(0)
    })

    test('bulkTransition 单事务全成全败', async () => {
      const a = await createDraft()
      const b = await createDraft()
      const ghost = crypto.randomUUID()
      await expect(docs.bulkTransition(p('audit'), [a.id, ghost], 'audit')).rejects.toMatchObject({
        code: 'not_found',
      })
      expect((await docs.get(p('read'), a.id)).status).toBe('DRAFT')

      const done = await docs.bulkTransition(p('audit'), [a.id, b.id], 'audit')
      expect(done).toHaveLength(2)
      expect(done.every((d) => d.status === 'AUDITED')).toBe(true)
    })
  })

  describe('InTx（外层事务由调用方持有）', () => {
    test('外层回滚则全链无痕：root create + child create + 审计', async () => {
      let docId = ''
      let itemId = ''
      await expect(
        withTx(db, async (trx) => {
          const doc = await docs.createInTx(trx, p('create'), {
            name: `回滚链-${crypto.randomUUID().slice(0, 6)}`,
            companyId,
          })
          docId = doc.id
          const item = await items.createInTx(trx, p('create', 'stdV2Items'), {
            docId: doc.id,
            idx: 1,
            qty: '1',
          })
          itemId = item.id
          // 事务内可见（证明确实写进了本事务）
          const mid = await sql<{ n: string }>`
            SELECT count(*)::text AS n FROM std_v2_doc WHERE id = ${docId}::uuid
          `.execute(trx)
          expect(mid.rows[0]!.n).toBe('1')
          throw new Error('强制回滚')
        }),
      ).rejects.toThrow('强制回滚')

      expect(docId).not.toBe('')
      expect(itemId).not.toBe('')
      const docsLeft = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM std_v2_doc WHERE id = ${docId}::uuid
      `.execute(db)
      const itemsLeft = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM std_v2_item WHERE id = ${itemId}::uuid
      `.execute(db)
      expect(docsLeft.rows[0]!.n).toBe('0')
      expect(itemsLeft.rows[0]!.n).toBe('0')
      expect(await auditRows('std_v2_doc', docId, 'create')).toBe(0)
      expect(await auditRows('std_v2_item', itemId, 'create')).toBe(0)
    })

    test('外层提交则 root+child 与审计一并落库', async () => {
      const { docId, itemId } = await withTx(db, async (trx) => {
        const doc = await docs.createInTx(trx, p('create'), {
          name: `提交链-${crypto.randomUUID().slice(0, 6)}`,
          companyId,
        })
        const item = await items.createInTx(trx, p('create', 'stdV2Items'), {
          docId: doc.id,
          idx: 1,
          qty: '2',
        })
        return { docId: doc.id, itemId: item.id }
      })
      const got = await docs.get(p('read'), docId)
      expect(got.id).toBe(docId)
      const item = await items.get(p('read', 'stdV2Items'), itemId)
      expect(item.docId).toBe(docId)
      expect(await auditRows('std_v2_doc', docId, 'create')).toBe(1)
      expect(await auditRows('std_v2_item', itemId, 'create')).toBe(1)
    })

    test('updateInTx/removeInTx/transitionInTx 共享外层事务：中途失败无半截状态', async () => {
      const doc = await createDraft()
      const item = await items.create(p('create', 'stdV2Items'), { docId: doc.id, idx: 1, qty: '1' })
      await expect(
        withTx(db, async (trx) => {
          await items.updateInTx(trx, p('update', 'stdV2Items'), item.id, { qty: '9' })
          await docs.transitionInTx(trx, p('audit'), doc.id, 'audit')
          // 审核后删行应被状态门拦住；整段回滚
          await items.removeInTx(trx, p('delete', 'stdV2Items'), item.id)
        }),
      ).rejects.toMatchObject({ code: 'conflict' })

      const still = await docs.get(p('read'), doc.id)
      expect(still.status).toBe('DRAFT')
      expect(still.name).not.toBe('效果改名')
      const stillItem = await items.get(p('read', 'stdV2Items'), item.id)
      expect(stillItem.qty).toBe('1')
      expect(await auditRows('std_v2_doc', doc.id, 'audit')).toBe(0)
      expect(await auditRows('std_v2_item', item.id, 'update')).toBe(0)
      expect(await auditRows('std_v2_item', item.id, 'destroy')).toBe(0)
    })
  })

  describe('child（子行：母单锁 + 状态门 + 带入列）', () => {
    test('草稿母单可加行；company_id 从母单带入；行审计三型', async () => {
      const doc = await createDraft()
      const item = await items.create(p('create', 'stdV2Items'), { docId: doc.id, idx: 1, qty: '2.5' })
      expect(item.companyId).toBe(companyId)
      expect(item.qty).toBe('2.5')
      expect(item.qtyX2).toBe('5')
      expect(await auditRows('std_v2_item', item.id, 'create')).toBe(1)

      const updated = await items.update(p('update', 'stdV2Items'), item.id, { qty: '3' })
      expect(updated.qty).toBe('3')
      expect(updated.qtyX2).toBe('6')
      expect(await auditRows('std_v2_item', item.id, 'update')).toBe(1)

      // 无差异补丁：不写审计
      await items.update(p('update', 'stdV2Items'), item.id, { qty: '3' })
      expect(await auditRows('std_v2_item', item.id, 'update')).toBe(1)

      await items.remove(p('delete', 'stdV2Items'), item.id)
      expect(await auditRows('std_v2_item', item.id, 'destroy')).toBe(1)
    })

    test('非草稿母单：加行/改行/删行一律 conflict', async () => {
      const doc = await createDraft()
      const item = await items.create(p('create', 'stdV2Items'), { docId: doc.id, idx: 1, qty: '1' })
      await docs.transition(p('audit'), doc.id, 'audit')

      await expect(items.create(p('create', 'stdV2Items'), { docId: doc.id, idx: 2, qty: '1' })).rejects.toMatchObject({
        code: 'conflict',
      })
      await expect(items.update(p('update', 'stdV2Items'), item.id, { qty: '9' })).rejects.toMatchObject({
        code: 'conflict',
      })
      await expect(items.remove(p('delete', 'stdV2Items'), item.id)).rejects.toMatchObject({ code: 'conflict' })
    })

    test('母单不存在 → not_found', async () => {
      await expect(
        items.create(p('create', 'stdV2Items'), { docId: crypto.randomUUID(), idx: 1, qty: '1' }),
      ).rejects.toMatchObject({ code: 'not_found' })
    })
  })

  describe('孙级（D3：parent 指 child；CRUD + 越母单 not_found）', () => {
    test('孙级 CRUD：挂条目下建档；company_id 从母行带入；行审计三型', async () => {
      const doc = await createDraft()
      const item = await items.create(p('create', 'stdV2Items'), { docId: doc.id, idx: 1, qty: '10' })
      const tier = await tiers.create(p('create', 'stdV2Tiers'), {
        itemId: item.id,
        minQty: '1',
        price: '9.5',
      })
      expect(tier.itemId).toBe(item.id)
      expect(tier.companyId).toBe(companyId)
      expect(tier.minQty).toBe('1')
      expect(tier.price).toBe('9.5')
      expect(await auditRows('std_v2_tier', tier.id, 'create')).toBe(1)

      const got = await tiers.get(p('read', 'stdV2Tiers'), tier.id)
      expect(got.id).toBe(tier.id)
      expect(got.itemId).toBe(item.id)

      const listed = await tiers.list(p('read', 'stdV2Tiers'), {
        filter: { itemId: { kind: 'fk', op: 'in', values: [item.id], labels: [] } },
      })
      expect(listed.results.map((r) => r.id)).toContain(tier.id)

      const updated = await tiers.update(p('update', 'stdV2Tiers'), tier.id, { price: '8' })
      expect(updated.price).toBe('8')
      expect(await auditRows('std_v2_tier', tier.id, 'update')).toBe(1)

      // 无差异补丁：不写审计
      await tiers.update(p('update', 'stdV2Tiers'), tier.id, { price: '8' })
      expect(await auditRows('std_v2_tier', tier.id, 'update')).toBe(1)

      await tiers.remove(p('delete', 'stdV2Tiers'), tier.id)
      expect(await auditRows('std_v2_tier', tier.id, 'destroy')).toBe(1)
      await expect(tiers.get(p('read', 'stdV2Tiers'), tier.id)).rejects.toMatchObject({
        code: 'not_found',
        message: '测试价格档不存在',
      })
    })

    test('越母单 not_found（与 invMaterialUnits 一致：母行不存在/不可达同为 not_found，不泄露）', async () => {
      // 1) 幽灵母行 id → 母 not_found 文案（create 锁母）
      await expect(
        tiers.create(p('create', 'stdV2Tiers'), {
          itemId: crypto.randomUUID(),
          minQty: '1',
          price: '1',
        }),
      ).rejects.toMatchObject({ code: 'not_found', message: '测试单行不存在' })

      // 2) 母行在不可达公司：公司域 actor 写孙级 → 母 not_found（不暴露存在性）
      const homeDoc = await docs.create(p('create'), {
        name: `本司-${crypto.randomUUID().slice(0, 6)}`,
        companyId,
      })
      const homeItem = await items.create(p('create', 'stdV2Items'), {
        docId: homeDoc.id,
        idx: 1,
        qty: '1',
      })
      const foreignDoc = await docs.create(p('create'), {
        name: `外司-${crypto.randomUUID().slice(0, 6)}`,
        companyId: otherCompanyId,
      })
      const foreignItem = await items.create(p('create', 'stdV2Items'), {
        docId: foreignDoc.id,
        idx: 1,
        qty: '1',
      })
      const foreignTier = await tiers.create(p('create', 'stdV2Tiers'), {
        itemId: foreignItem.id,
        minQty: '1',
        price: '2',
      })

      // 公司域 actor：superAdmin 的 rowFilter 恒 bypass，测不出越母单；via 归宿码在 root 前缀
      const scoped = testActor({
        username: `std-v2-scoped-${crypto.randomUUID().slice(0, 8)}`,
        superAdmin: false,
        allCompanies: false,
        companyIds: [companyId],
        permissions: new Set([
          'stdv2.doc:read',
          'stdv2.doc:create',
          'stdv2.doc:update',
          'stdv2.doc:delete',
        ]),
      })
      const scopedTierCreate = permitOf(scoped, 'stdV2Tiers', 'create')
      const scopedTierRead = permitOf(scoped, 'stdV2Tiers', 'read')
      const scopedTierUpdate = permitOf(scoped, 'stdV2Tiers', 'update')
      const scopedTierDelete = permitOf(scoped, 'stdV2Tiers', 'delete')

      // 本公司母行仍可建档
      const ok = await tiers.create(scopedTierCreate, {
        itemId: homeItem.id,
        minQty: '5',
        price: '3',
      })
      expect(ok.companyId).toBe(companyId)

      // 跨公司母行 / 跨公司孙级：一律 not_found
      await expect(
        tiers.create(scopedTierCreate, { itemId: foreignItem.id, minQty: '1', price: '1' }),
      ).rejects.toMatchObject({ code: 'not_found', message: '测试单行不存在' })
      await expect(tiers.get(scopedTierRead, foreignTier.id)).rejects.toMatchObject({
        code: 'not_found',
        message: '测试价格档不存在',
      })
      await expect(
        tiers.update(scopedTierUpdate, foreignTier.id, { price: '99' }),
      ).rejects.toMatchObject({ code: 'not_found' })
      await expect(tiers.remove(scopedTierDelete, foreignTier.id)).rejects.toMatchObject({
        code: 'not_found',
      })
    })

    test('孙级 InTx：外层回滚则档+审计无痕', async () => {
      const doc = await createDraft()
      const item = await items.create(p('create', 'stdV2Items'), { docId: doc.id, idx: 1, qty: '1' })
      let tierId = ''
      await expect(
        withTx(db, async (trx) => {
          const tier = await tiers.createInTx(trx, p('create', 'stdV2Tiers'), {
            itemId: item.id,
            minQty: '1',
            price: '1',
          })
          tierId = tier.id
          throw new Error('强制回滚孙级')
        }),
      ).rejects.toThrow('强制回滚孙级')
      expect(tierId).not.toBe('')
      const left = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM std_v2_tier WHERE id = ${tierId}::uuid
      `.execute(db)
      expect(left.rows[0]!.n).toBe('0')
      expect(await auditRows('std_v2_tier', tierId, 'create')).toBe(0)
    })
  })

  describe('aggregate（loadDraft/createDraft/replaceDraft · D2/D4/D6）', () => {
    function draftInput(name: string, itemQty = '10') {
      return {
        name,
        companyId,
        items: [
          {
            idx: 1,
            qty: itemQty,
            tiers: [
              { minQty: '1', price: '10.0000' },
              { minQty: '10', price: '9.0000' },
            ],
          },
        ],
      }
    }

    test('createDraft：头+条目+档；编号走 head.options.numbering；逐行 create 审计', async () => {
      const beforeNum = numberingCalls
      const saved = await aggregate.createDraft(p('create'), draftInput('聚合建单'))
      expect(saved.name).toBe('聚合建单')
      expect(String(saved.docNo)).toMatch(/^AUTO-/)
      expect(numberingCalls).toBe(beforeNum + 1)
      expect(await auditRows('std_v2_doc', String(saved.id), 'create')).toBe(1)

      const itemsArr = saved.items as Array<Record<string, unknown>>
      expect(itemsArr).toHaveLength(1)
      expect(itemsArr[0]!.qty).toBe('10')
      expect(itemsArr[0]!.qtyX2).toBe('20')
      expect(itemsArr[0]!.companyId).toBe(companyId)
      expect(await auditRows('std_v2_item', String(itemsArr[0]!.id), 'create')).toBe(1)

      const tiersArr = itemsArr[0]!.tiers as Array<Record<string, unknown>>
      expect(tiersArr).toHaveLength(2)
      expect(tiersArr[0]!.minQty).toBe('1')
      expect(tiersArr[1]!.price).toBe('9')
      expect(await auditRows('std_v2_tier', String(tiersArr[0]!.id), 'create')).toBe(1)
      expect(await auditRows('std_v2_tier', String(tiersArr[1]!.id), 'create')).toBe(1)
    })

    test('loadDraft：repeatable-read 一致快照返回全树', async () => {
      const created = await aggregate.createDraft(p('create'), draftInput('快照单'))
      const loaded = await aggregate.loadDraft(p('read'), String(created.id))
      expect(loaded.id).toBe(created.id)
      expect(loaded.name).toBe('快照单')
      const itemsArr = loaded.items as Array<Record<string, unknown>>
      expect(itemsArr).toHaveLength(1)
      expect((itemsArr[0]!.tiers as unknown[]).length).toBe(2)
    })

    test('createDraft：新记录带 id / 缺集合键 fail-closed', async () => {
      await expect(
        aggregate.createDraft(p('create'), {
          name: '坏身份',
          companyId,
          items: [{ id: crypto.randomUUID(), idx: 1, qty: '1', tiers: [] }],
        }),
      ).rejects.toMatchObject({
        code: 'validation',
        fields: { 'items[0].id': ['新记录不能包含 id'] },
      })

      await expect(
        aggregate.createDraft(p('create'), { name: '缺集合', companyId }),
      ).rejects.toMatchObject({
        code: 'validation',
        fields: { items: ['必须显式提交数组'] },
      })
    })

    test('replaceDraft：增/改/删差异；缺失即删；逐行审计三型', async () => {
      const created = await aggregate.createDraft(p('create'), draftInput('替换单', '5'))
      const item0 = (created.items as Array<Record<string, unknown>>)[0]!
      const tier0 = (item0.tiers as Array<Record<string, unknown>>)[0]!
      const tier1 = (item0.tiers as Array<Record<string, unknown>>)[1]!

      const replaced = await aggregate.replaceDraft(p('update'), String(created.id), {
        name: '替换后',
        companyId,
        items: [
          {
            id: item0.id,
            idx: 1,
            qty: '8',
            tiers: [
              { id: tier0.id, minQty: '1', price: '11.0000' },
              // tier1 缺失 → 删
              { minQty: '100', price: '7.0000' }, // 新增档
            ],
          },
          { idx: 2, qty: '3', tiers: [{ minQty: '1', price: '2.0000' }] }, // 新增行
        ],
      })

      expect(replaced.name).toBe('替换后')
      expect(await auditRows('std_v2_doc', String(created.id), 'update')).toBe(1)

      const itemsArr = replaced.items as Array<Record<string, unknown>>
      expect(itemsArr).toHaveLength(2)
      const kept = itemsArr.find((i) => i.id === item0.id)!
      expect(kept.qty).toBe('8')
      expect(await auditRows('std_v2_item', String(item0.id), 'update')).toBe(1)

      const tiersKept = kept.tiers as Array<Record<string, unknown>>
      expect(tiersKept).toHaveLength(2)
      expect(tiersKept.some((t) => t.id === tier0.id)).toBe(true)
      expect(tiersKept.some((t) => t.id === tier1.id)).toBe(false)
      expect(await auditRows('std_v2_tier', String(tier0.id), 'update')).toBe(1)
      expect(await auditRows('std_v2_tier', String(tier1.id), 'destroy')).toBe(1)

      const added = itemsArr.find((i) => i.id !== item0.id)!
      expect(added.qty).toBe('3')
      expect(await auditRows('std_v2_item', String(added.id), 'create')).toBe(1)
      const addedTier = (added.tiers as Array<Record<string, unknown>>)[0]!
      expect(await auditRows('std_v2_tier', String(addedTier.id), 'create')).toBe(1)
    })

    test('replaceDraft：空集合 = 删全部子行（权威快照，非暂态）', async () => {
      const created = await aggregate.createDraft(p('create'), draftInput('清空单'))
      const itemId = String((created.items as Array<Record<string, unknown>>)[0]!.id)
      const emptied = await aggregate.replaceDraft(p('update'), String(created.id), {
        name: '已清空',
        companyId,
        items: [],
      })
      expect(emptied.items).toEqual([])
      expect(await auditRows('std_v2_item', itemId, 'destroy')).toBe(1)
      const left = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM std_v2_item WHERE doc_id = ${String(created.id)}::uuid
      `.execute(db)
      expect(left.rows[0]!.n).toBe('0')
    })

    test('replaceDraft：删行先于头更新——清空条目后可改头字段', async () => {
      const created = await aggregate.createDraft(p('create'), draftInput('时序单'))
      const replaced = await aggregate.replaceDraft(p('update'), String(created.id), {
        name: '清空并改名',
        companyId,
        items: [],
      })
      expect(replaced.name).toBe('清空并改名')
      expect(replaced.items).toEqual([])
    })

    test('replaceDraft：身份校验——未知/重复 id、公司不可改、缺集合', async () => {
      const created = await aggregate.createDraft(p('create'), draftInput('身份单'))
      const item0 = (created.items as Array<Record<string, unknown>>)[0]!

      await expect(
        aggregate.replaceDraft(p('update'), String(created.id), {
          name: 'x',
          companyId,
          items: [{ id: crypto.randomUUID(), idx: 1, qty: '1', tiers: [] }],
        }),
      ).rejects.toMatchObject({
        code: 'validation',
        fields: { 'items[0].id': ['不属于该测试单'] },
      })

      await expect(
        aggregate.replaceDraft(p('update'), String(created.id), {
          name: 'x',
          companyId,
          items: [
            { id: item0.id, idx: 1, qty: '1', tiers: [] },
            { id: item0.id, idx: 2, qty: '2', tiers: [] },
          ],
        }),
      ).rejects.toMatchObject({
        code: 'validation',
        fields: { 'items[1].id': ['同一草稿中不能重复'] },
      })

      await expect(
        aggregate.replaceDraft(p('update'), String(created.id), {
          name: 'x',
          companyId: otherCompanyId,
          items: [{ id: item0.id, idx: 1, qty: '1', tiers: [] }],
        }),
      ).rejects.toMatchObject({
        code: 'validation',
        fields: { companyId: ['创建后不可修改公司'] },
      })

      await expect(
        aggregate.replaceDraft(p('update'), String(created.id), {
          name: 'x',
          companyId,
        }),
      ).rejects.toMatchObject({
        code: 'validation',
        fields: { items: ['必须显式提交数组'] },
      })
    })

    test('replaceDraft：任一行失败整单回滚（原子性）', async () => {
      const created = await aggregate.createDraft(p('create'), draftInput('原子单'))
      const item0 = (created.items as Array<Record<string, unknown>>)[0]!
      const nameBefore = created.name

      await expect(
        aggregate.replaceDraft(p('update'), String(created.id), {
          name: '不应落库',
          companyId,
          items: [
            { id: item0.id, idx: 1, qty: '99', tiers: [] },
            // qty 必填缺失 → child validate/insert 失败
            { idx: 2, tiers: [] },
          ],
        }),
      ).rejects.toThrow()

      const reloaded = await aggregate.loadDraft(p('read'), String(created.id))
      expect(reloaded.name).toBe(nameBefore)
      const itemsArr = reloaded.items as Array<Record<string, unknown>>
      expect(itemsArr).toHaveLength(1)
      expect(itemsArr[0]!.qty).toBe('10')
      expect(await auditRows('std_v2_doc', String(created.id), 'update')).toBe(0)
    })

    test('replaceDraft：无差异不落库不审计（头与行）', async () => {
      const created = await aggregate.createDraft(p('create'), {
        name: '无差单',
        companyId,
        items: [{ idx: 1, qty: '1', tiers: [] }],
      })
      const item0 = (created.items as Array<Record<string, unknown>>)[0]!
      const again = await aggregate.replaceDraft(p('update'), String(created.id), {
        name: '无差单',
        companyId,
        items: [{ id: item0.id, idx: 1, qty: '1', tiers: [] }],
      })
      expect(again.name).toBe('无差单')
      expect(await auditRows('std_v2_doc', String(created.id), 'update')).toBe(0)
      expect(await auditRows('std_v2_item', String(item0.id), 'update')).toBe(0)
    })
  })

  describe('tree（父子校验 + 物化路径 + 投影）', () => {
    test('建根与子节点：路径拼接正确；has_children 投影', async () => {
      const root = await nodes.create(p('create', 'stdV2Nodes'), { name: '根', parentId: null })
      const child = await nodes.create(p('create', 'stdV2Nodes'), { name: '子', parentId: root.id })
      expect(String((await getPath(child.id)))).toBe(`/${root.id}/${child.id}/`)

      const gotRoot = await nodes.get(p('read', 'stdV2Nodes'), root.id)
      expect(gotRoot.hasChildren).toBe(true)
      const gotChild = await nodes.get(p('read', 'stdV2Nodes'), child.id)
      expect(gotChild.hasChildren).toBe(false)
    })

    test('父子校验：自身/不存在/后代成环', async () => {
      const a = await nodes.create(p('create', 'stdV2Nodes'), { name: 'A' })
      const b = await nodes.create(p('create', 'stdV2Nodes'), { name: 'B', parentId: a.id })

      await expect(nodes.update(p('update', 'stdV2Nodes'), a.id, { parentId: a.id })).rejects.toMatchObject({
        code: 'validation',
      })
      await expect(
        nodes.create(p('create', 'stdV2Nodes'), { name: 'X', parentId: crypto.randomUUID() }),
      ).rejects.toMatchObject({ code: 'validation' })
      await expect(nodes.update(p('update', 'stdV2Nodes'), a.id, { parentId: b.id })).rejects.toMatchObject({
        code: 'validation',
      })
    })

    test('移动重写整棵子树路径', async () => {
      const a = await nodes.create(p('create', 'stdV2Nodes'), { name: '甲' })
      const b = await nodes.create(p('create', 'stdV2Nodes'), { name: '乙' })
      const c = await nodes.create(p('create', 'stdV2Nodes'), { name: '丙', parentId: a.id })
      const d = await nodes.create(p('create', 'stdV2Nodes'), { name: '丁', parentId: c.id })

      await nodes.update(p('update', 'stdV2Nodes'), c.id, { parentId: b.id })
      expect(await getPath(c.id)).toBe(`/${b.id}/${c.id}/`)
      expect(await getPath(d.id)).toBe(`/${b.id}/${c.id}/${d.id}/`)
    })

    test('有子节点不能删除', async () => {
      const a = await nodes.create(p('create', 'stdV2Nodes'), { name: '父删' })
      await nodes.create(p('create', 'stdV2Nodes'), { name: '子删', parentId: a.id })
      await expect(nodes.remove(p('delete', 'stdV2Nodes'), a.id)).rejects.toMatchObject({
        code: 'conflict',
        message: '存在下级测试节点,不能删除',
      })
    })
  })

  async function getPath(id: string): Promise<string> {
    const result = await sql<{ path: string }>`SELECT path FROM std_v2_node WHERE id = ${id}::uuid`.execute(db)
    return result.rows[0]!.path
  }
})
