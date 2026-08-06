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
 *
 * 业务资源迁入后各自的行为由 standard-contract 描述符继承；本文件只锁内核语义。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { createRegistry } from '~/platform/meta/registry.ts'
import type { FieldMeta, ResourceMeta } from '~/platform/meta/types.ts'
import { createStandardChildService } from './child.ts'
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
      field('tags', 'tags', 'enumArray', '标签', {
        enumOptions: [
          { value: 'RED', label: '红' },
          { value: 'BLUE', label: '蓝' },
        ],
      }),
      field('status', 'status', 'enum', '状态', { readonly: true, enumOptions: statusOptions, filterable: true }),
      field('audited_at', 'auditedAt', 'datetime', '审核时间', { readonly: true }),
      field('audited_by_id', 'auditedById', 'uuid', '审核人', { readonly: true }),
      field('company_id', 'companyId', 'uuid', '公司', { required: true, createOnly: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, sortable: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, sortable: true }),
    ],
    actions: [
      ...crud,
      { key: 'audit', label: '审核', scope: 'row' as const },
      { key: 'void', label: '作废', scope: 'row' as const },
    ],
    audit: { enabled: true },
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

run('标准动作内核 v2（postgres）', () => {
  const db = createDb(url!)
  const registry = createRegistry()
  registry.register(docMeta())
  registry.register(itemMeta())
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
    await sql`DELETE FROM sys_audit_log WHERE resource IN ('std_v2_doc', 'std_v2_item', 'std_v2_node')`.execute(db)
    await sql`DROP TABLE IF EXISTS std_v2_item`.execute(db)
    await sql`DROP TABLE IF EXISTS std_v2_doc`.execute(db)
    await sql`DROP TABLE IF EXISTS std_v2_node`.execute(db)
    await db.destroy()
  })

  async function createDraft(name = `单-${crypto.randomUUID().slice(0, 6)}`) {
    return docs.create(p('create'), { docNo: `NO-${crypto.randomUUID().slice(0, 8)}`, name, companyId })
  }

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
    test('未提供单号自动取号；显式传入跳过', async () => {
      const before = numberingCalls
      const auto = await docs.create(p('create'), { name: '取号单', companyId })
      expect(String(auto.docNo)).toStartWith('AUTO-')
      expect(numberingCalls).toBe(before + 1)

      const manual = await docs.create(p('create'), { docNo: 'MANUAL-1', name: '手号单', companyId })
      expect(manual.docNo).toBe('MANUAL-1')
      expect(numberingCalls).toBe(before + 1)
    })
  })

  describe('workflow', () => {
    test('创建即草稿；审核翻转状态+盖章+效果列+审计 actionName', async () => {
      const doc = await createDraft()
      expect(doc.status).toBe('DRAFT')

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

  describe('child（子行：母单锁 + 状态门 + 带入列）', () => {
    test('草稿母单可加行；company_id 从母单带入；行审计三型', async () => {
      const doc = await createDraft()
      const item = await items.create(p('create', 'stdV2Items'), { docId: doc.id, idx: 1, qty: '2.5' })
      expect(item.companyId).toBe(companyId)
      expect(item.qty).toBe('2.5')
      expect(await auditRows('std_v2_item', item.id, 'create')).toBe(1)

      const updated = await items.update(p('update', 'stdV2Items'), item.id, { qty: '3' })
      expect(updated.qty).toBe('3')
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
