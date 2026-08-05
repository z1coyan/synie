/**
 * 库存三单据的授权端到端（工单 08，「平凡多数」模板的验收基准）。
 *
 * 断言口径（错误语义唯一规则）：动作码不满足 403 forbidden；行级范围不命中
 * 404 not_found / 列表不含；状态不满足 409 conflict（状态守卫划出权限系统）。
 * 三单据无 owner/dept 绑定，故矩阵只应授出 all——本文件同时验证「授了 dept 也
 * 只会 fail-closed 成空集」，即范围维度必须由 supportedScopes 收窄。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createIamService } from '~/modules/iam/index.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { buildTestApp, createPlatformRegistry, testDatabaseUrl } from './helpers.ts'

const url = testDatabaseUrl()
const run = url ? describe : describe.skip

/** 库管员：三单据全套 + 分录只读 */
const FULL_CODES = [
  'inv.stock_doc:read',
  'inv.stock_doc:create',
  'inv.stock_doc:update',
  'inv.stock_doc:delete',
  'inv.stock_doc:audit',
  'inv.stock_doc:void',
  'inv.stock_transfer:read',
  'inv.stock_transfer:create',
  'inv.stock_transfer:update',
  'inv.stock_transfer:delete',
  'inv.stock_transfer:ship',
  'inv.stock_transfer:receive',
  'inv.stock_count:read',
  'inv.stock_count:create',
  'inv.stock_count:update',
  'inv.stock_count:delete',
  'inv.stock_count:approve',
  'inv.stock_count:cancel',
  'inv.stock_entry:read',
] as const

/** 只读角色：三单据只读，无任何写/工作流码 */
const READ_ONLY_CODES = [
  'inv.stock_doc:read',
  'inv.stock_transfer:read',
  'inv.stock_count:read',
  'inv.stock_entry:read',
] as const

run('PG 集成（库存三单据：公司域授权与语义统一）', () => {
  const db = createDb(url!)
  const registry = createPlatformRegistry()
  const iam = createIamService(db, registry)
  const admin = testActor({ superAdmin: true, allCompanies: true })

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const currencyId = crypto.randomUUID()
  const companyA = crypto.randomUUID()
  const companyB = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const keeperRoleId = crypto.randomUUID()
  const viewerRoleId = crypto.randomUUID()
  const globalRoleId = crypto.randomUUID()
  const warehouses = {
    a1: crypto.randomUUID(),
    b1: crypto.randomUUID(),
    b2: crypto.randomUUID(),
    b3: crypto.randomUUID(),
  }

  let keeperId = ''
  let viewerId = ''
  let globalId = ''
  let keeperHeaders: Record<string, string> = {}
  let viewerHeaders: Record<string, string> = {}
  let globalHeaders: Record<string, string> = {}
  let app: Awaited<ReturnType<typeof buildTestApp>>

  const docIds: string[] = []
  const transferIds: string[] = []
  const countIds: string[] = []

  /** 覆盖式授权（role, code, scope）三元组；矩阵范围 UI 未到位前直接写授权表 */
  async function grant(
    roleId: string,
    codes: readonly string[],
    scope: 'all' | 'dept' | 'dept_tree' | 'self',
  ): Promise<void> {
    await db.deleteFrom('sys_role_permission').where('role_id', '=', roleId).execute()
    if (codes.length > 0) {
      await db
        .insertInto('sys_role_permission')
        .values(codes.map((permission) => ({ role_id: roleId, permission, scope })))
        .execute()
    }
  }

  async function login(username: string, password: string): Promise<Record<string, string>> {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const { token } = (await res.json()) as { token: string }
    return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  }

  const post = (path: string, headers: Record<string, string>, body: unknown) =>
    app.request(`/api/v1/inventory${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  const patch = (path: string, headers: Record<string, string>, body: unknown) =>
    app.request(`/api/v1/inventory${path}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    })
  const del = (path: string, headers: Record<string, string>) =>
    app.request(`/api/v1/inventory${path}`, { method: 'DELETE', headers })
  const get = (path: string, headers: Record<string, string>) =>
    app.request(`/api/v1/inventory${path}`, { headers })

  interface DocDto {
    id: string
    docNo: string
    status: string
    companyId: string
  }

  async function ids(
    path: string,
    headers: Record<string, string>,
    body: Record<string, unknown> = {},
  ): Promise<string[]> {
    const res = await post(path, headers, { limit: 100, offset: 0, ...body })
    expect(res.status).toBe(200)
    const parsed = (await res.json()) as { results: Array<{ id: string }> }
    return parsed.results.map((r) => r.id)
  }

  /** 建一张手工出入库单（含一行）；返回头与行 id */
  async function seedDoc(
    headers: Record<string, string>,
    companyId: string,
    warehouseId: string,
    docNo: string,
  ): Promise<{ doc: DocDto; itemId: string }> {
    const created = await post('/stock-docs', headers, {
      docNo,
      direction: 'IN',
      companyId,
      warehouseId,
      summary: '授权用例',
    })
    expect(created.status).toBe(201)
    const doc = (await created.json()) as DocDto
    docIds.push(doc.id)
    const item = await post('/stock-doc-items', headers, {
      stockDocId: doc.id,
      idx: 1,
      qty: '10',
      materialId,
      unitId,
    })
    expect(item.status).toBe(201)
    const { id: itemId } = (await item.json()) as { id: string }
    return { doc, itemId }
  }

  let docA: DocDto
  let docAItemId = ''
  let draftA: DocDto
  let docB: DocDto
  let docBItemId = ''
  let transferB = ''
  let transferBItemId = ''
  let countB = ''
  let countBItemId = ''

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency (id, name, iso_code, symbol, active)
      VALUES (${currencyId}::uuid, ${'库存币-' + suffix}, ${'K' + suffix.slice(0, 2).toUpperCase()}, 'K', true)
    `.execute(db)
    for (const [id, code, name] of [
      [companyA, 'KA', '库存公司甲'],
      [companyB, 'KB', '库存公司乙'],
    ] as const) {
      await sql`
        INSERT INTO bas_company (id, code, name, short_name, base_currency_id)
        VALUES (${id}::uuid, ${code + suffix}, ${name + suffix}, ${code}, ${currencyId}::uuid)
      `.execute(db)
    }
    for (const [id, company, name] of [
      [warehouses.a1, companyA, '甲仓'],
      [warehouses.b1, companyB, '乙调出仓'],
      [warehouses.b2, companyB, '乙调入仓'],
      [warehouses.b3, companyB, '乙在途仓'],
    ] as const) {
      await sql`
        INSERT INTO inv_warehouse (id, company_id, name, is_leaf, active)
        VALUES (${id}::uuid, ${company}::uuid, ${name + suffix}, true, true)
      `.execute(db)
    }
    await db
      .insertInto('bas_unit')
      .values({
        id: unitId,
        unit_type: 'quantity',
        is_base: false,
        name: `库存单位-${suffix}`,
        symbol: `k${suffix.slice(0, 5)}`,
        ratio: '1',
      })
      .execute()
    await db
      .insertInto('inv_material_category')
      .values({
        id: categoryId,
        code: `KC${suffix}`,
        name: `库存分类-${suffix}`,
        is_leaf: true,
        active: true,
      })
      .execute()
    await db
      .insertInto('inv_material')
      .values({
        id: materialId,
        code: `KM${suffix}`,
        name: `库存物料-${suffix}`,
        category_id: categoryId,
        default_unit_id: unitId,
      })
      .execute()
    await db
      .insertInto('sys_role')
      .values([
        { id: keeperRoleId, code: `keeper-${suffix}`, name: `甲库管-${suffix}` },
        { id: viewerRoleId, code: `viewer-${suffix}`, name: `甲只读-${suffix}` },
        { id: globalRoleId, code: `global-${suffix}`, name: `双公司库管-${suffix}` },
      ])
      .execute()

    const keeper = await iam.createUser(admin, {
      username: `keeper-${suffix}`,
      name: '甲库管',
      roleIds: [keeperRoleId],
      companyIds: [companyA],
    })
    keeperId = keeper.user.id
    const viewer = await iam.createUser(admin, {
      username: `viewer-${suffix}`,
      name: '甲只读',
      roleIds: [viewerRoleId],
      companyIds: [companyA],
    })
    viewerId = viewer.user.id
    const globalUser = await iam.createUser(admin, {
      username: `global-${suffix}`,
      name: '双公司库管',
      roleIds: [globalRoleId],
      companyIds: [companyA, companyB],
    })
    globalId = globalUser.user.id

    await grant(keeperRoleId, FULL_CODES, 'all')
    await grant(viewerRoleId, READ_ONLY_CODES, 'all')
    await grant(globalRoleId, FULL_CODES, 'all')

    app = await buildTestApp(db, { registry })
    keeperHeaders = await login(keeper.user.username, keeper.password)
    viewerHeaders = await login(viewer.user.username, viewer.password)
    globalHeaders = await login(globalUser.user.username, globalUser.password)

    // 公司甲：一张已审核单（产生分录）+ 一张草稿单
    const seededA = await seedDoc(keeperHeaders, companyA, warehouses.a1, `KA1-${suffix}`)
    docA = seededA.doc
    docAItemId = seededA.itemId
    expect((await post(`/stock-docs/${docA.id}/audit`, keeperHeaders, {})).status).toBe(200)
    draftA = (await seedDoc(keeperHeaders, companyA, warehouses.a1, `KA2-${suffix}`)).doc

    // 公司乙：出入库单（已审核，产生乙公司分录）+ 调拨单 + 盘点单
    const seededB = await seedDoc(globalHeaders, companyB, warehouses.b1, `KB1-${suffix}`)
    docB = seededB.doc
    docBItemId = seededB.itemId
    expect((await post(`/stock-docs/${docB.id}/audit`, globalHeaders, {})).status).toBe(200)

    const transferRes = await post('/stock-transfers', globalHeaders, {
      docNo: `KB2-${suffix}`,
      companyId: companyB,
      fromWarehouseId: warehouses.b1,
      toWarehouseId: warehouses.b2,
      transitWarehouseId: warehouses.b3,
    })
    expect(transferRes.status).toBe(201)
    transferB = ((await transferRes.json()) as DocDto).id
    transferIds.push(transferB)
    const transferItemRes = await post('/stock-transfer-items', globalHeaders, {
      stockTransferId: transferB,
      idx: 1,
      qty: '2',
      materialId,
      unitId,
    })
    expect(transferItemRes.status).toBe(201)
    transferBItemId = ((await transferItemRes.json()) as { id: string }).id

    const countRes = await post('/stock-counts', globalHeaders, {
      docNo: `KB3-${suffix}`,
      companyId: companyB,
      warehouseId: warehouses.b1,
      items: [{ materialId, unitId, countedQuantity: '9' }],
    })
    expect(countRes.status).toBe(201)
    countB = ((await countRes.json()) as DocDto).id
    countIds.push(countB)
    countBItemId = (await ids('/stock-count-items/query', globalHeaders, {
      filter: { countId: { kind: 'fk', op: 'in', values: [countB], labels: [] } },
    }))[0]!
  })

  afterAll(async () => {
    const voucherIds = [...docIds, ...transferIds, ...countIds]
    if (voucherIds.length > 0) {
      await sql`DELETE FROM inv_stock_entry WHERE voucher_id = ANY(${voucherIds}::uuid[])`.execute(db)
      await sql`
        DELETE FROM sys_audit_log
        WHERE record_id = ANY(${voucherIds}::uuid[])
           OR record_id IN (SELECT id FROM inv_stock_doc_item WHERE stock_doc_id = ANY(${docIds.length ? docIds : voucherIds}::uuid[]))
           OR record_id IN (SELECT id FROM inv_stock_transfer_item WHERE stock_transfer_id = ANY(${transferIds.length ? transferIds : voucherIds}::uuid[]))
           OR record_id IN (SELECT id FROM inv_stock_count_item WHERE count_id = ANY(${countIds.length ? countIds : voucherIds}::uuid[]))
      `.execute(db)
    }
    if (countIds.length > 0) {
      await sql`DELETE FROM inv_stock_count_item WHERE count_id = ANY(${countIds}::uuid[])`.execute(db)
      await sql`DELETE FROM inv_stock_count WHERE id = ANY(${countIds}::uuid[])`.execute(db)
    }
    if (transferIds.length > 0) {
      await sql`DELETE FROM inv_stock_transfer_item WHERE stock_transfer_id = ANY(${transferIds}::uuid[])`.execute(db)
      await sql`DELETE FROM inv_stock_transfer WHERE id = ANY(${transferIds}::uuid[])`.execute(db)
    }
    if (docIds.length > 0) {
      await sql`DELETE FROM inv_stock_doc_item WHERE stock_doc_id = ANY(${docIds}::uuid[])`.execute(db)
      await sql`DELETE FROM inv_stock_doc WHERE id = ANY(${docIds}::uuid[])`.execute(db)
    }
    await sql`DELETE FROM inv_material WHERE id = ${materialId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id = ${categoryId}::uuid`.execute(db)
    await sql`DELETE FROM inv_warehouse WHERE id = ANY(${Object.values(warehouses)}::uuid[])`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id = ${unitId}::uuid`.execute(db)
    for (const userId of [keeperId, viewerId, globalId]) {
      if (!userId) continue
      await sql`DELETE FROM sys_audit_log WHERE actor_id = ${userId}::uuid`.execute(db)
      await db.deleteFrom('sys_user_role').where('user_id', '=', userId).execute()
      await db.deleteFrom('sys_user_company').where('user_id', '=', userId).execute()
      await sql`DELETE FROM auth_account WHERE user_id IN (SELECT auth_user_id FROM sys_user WHERE id = ${userId}::uuid)`.execute(db)
      await db.deleteFrom('sys_user').where('id', '=', userId).execute()
    }
    for (const roleId of [keeperRoleId, viewerRoleId, globalRoleId]) {
      await db.deleteFrom('sys_role_permission').where('role_id', '=', roleId).execute()
      await db.deleteFrom('sys_role').where('id', '=', roleId).execute()
    }
    await sql`DELETE FROM bas_company WHERE id = ANY(${[companyA, companyB]}::uuid[])`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id = ${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  test('未登录一律 401（guard 挂在 requireAuth 之后）', async () => {
    const anonymous = { 'content-type': 'application/json' }
    expect((await post('/stock-docs/query', anonymous, {})).status).toBe(401)
    expect((await get(`/stock-docs/${docA.id}`, anonymous)).status).toBe(401)
    expect((await post('/stock-balance/query', anonymous, { companyId: companyA })).status).toBe(401)
  })

  test('动作码不满足一律 403：只读角色的写与工作流端点', async () => {
    const docBody = {
      docNo: `KX1-${suffix}`,
      direction: 'IN',
      companyId: companyA,
      warehouseId: warehouses.a1,
    }
    const itemBody = { stockDocId: draftA.id, idx: 2, qty: '1', materialId, unitId }
    const calls: Array<[string, () => Promise<Response> | Response]> = [
      ['create doc', () => post('/stock-docs', viewerHeaders, docBody)],
      ['update doc', () => patch(`/stock-docs/${draftA.id}`, viewerHeaders, { summary: 'x' })],
      ['delete doc', () => del(`/stock-docs/${draftA.id}`, viewerHeaders)],
      ['audit doc', () => post(`/stock-docs/${draftA.id}/audit`, viewerHeaders, {})],
      ['void doc', () => post(`/stock-docs/${docA.id}/void`, viewerHeaders, {})],
      ['create item', () => post('/stock-doc-items', viewerHeaders, itemBody)],
      ['ship transfer', () => post(`/stock-transfers/${transferB}/ship`, viewerHeaders, {})],
      ['receive transfer', () => post(`/stock-transfers/${transferB}/receive`, viewerHeaders, {})],
      ['refresh count', () => post(`/stock-counts/${countB}/refresh`, viewerHeaders, {})],
      ['approve count', () => post(`/stock-counts/${countB}/approve`, viewerHeaders, {})],
      ['cancel count', () => post(`/stock-counts/${countB}/cancel`, viewerHeaders, {})],
    ]
    for (const [label, call] of calls) {
      expect([label, (await call()).status]).toEqual([label, 403])
    }
    // 只读码本身可用（403 是缺码而非整体拒绝）
    const readable = await post('/stock-docs/query', viewerHeaders, { limit: 5, offset: 0 })
    expect(readable.status).toBe(200)
  })

  test('跨公司单条一律 404（旧行为是 forbidden）：三单据的读/写/工作流', async () => {
    const calls: Array<[string, () => Promise<Response> | Response]> = [
      ['get doc', () => get(`/stock-docs/${docB.id}`, keeperHeaders)],
      ['patch doc', () => patch(`/stock-docs/${docB.id}`, keeperHeaders, { summary: 'x' })],
      ['delete doc', () => del(`/stock-docs/${docB.id}`, keeperHeaders)],
      ['audit doc', () => post(`/stock-docs/${docB.id}/audit`, keeperHeaders, {})],
      ['void doc', () => post(`/stock-docs/${docB.id}/void`, keeperHeaders, {})],
      ['get doc item', () => get(`/stock-doc-items/${docBItemId}`, keeperHeaders)],
      ['patch doc item', () => patch(`/stock-doc-items/${docBItemId}`, keeperHeaders, { qty: '3' })],
      ['delete doc item', () => del(`/stock-doc-items/${docBItemId}`, keeperHeaders)],
      ['get transfer', () => get(`/stock-transfers/${transferB}`, keeperHeaders)],
      ['ship transfer', () => post(`/stock-transfers/${transferB}/ship`, keeperHeaders, {})],
      ['receive transfer', () => post(`/stock-transfers/${transferB}/receive`, keeperHeaders, {})],
      ['get transfer item', () => get(`/stock-transfer-items/${transferBItemId}`, keeperHeaders)],
      ['get count', () => get(`/stock-counts/${countB}`, keeperHeaders)],
      ['refresh count', () => post(`/stock-counts/${countB}/refresh`, keeperHeaders, {})],
      ['approve count', () => post(`/stock-counts/${countB}/approve`, keeperHeaders, {})],
      ['cancel count', () => post(`/stock-counts/${countB}/cancel`, keeperHeaders, {})],
      [
        'patch count item',
        () => patch(`/stock-count-items/${countBItemId}`, keeperHeaders, { countedQuantity: '1' }),
      ],
    ]
    for (const [label, call] of calls) {
      expect([label, (await call()).status]).toEqual([label, 404])
    }
  })

  test('创建到未授权公司 → 404（不泄露公司存在性）', async () => {
    const doc = await post('/stock-docs', keeperHeaders, {
      docNo: `KX2-${suffix}`,
      direction: 'IN',
      companyId: companyB,
      warehouseId: warehouses.b1,
    })
    expect(doc.status).toBe(404)
    const transfer = await post('/stock-transfers', keeperHeaders, {
      docNo: `KX3-${suffix}`,
      companyId: companyB,
      fromWarehouseId: warehouses.b1,
      toWarehouseId: warehouses.b2,
      transitWarehouseId: warehouses.b3,
    })
    expect(transfer.status).toBe(404)
    const count = await post('/stock-counts', keeperHeaders, {
      docNo: `KX4-${suffix}`,
      companyId: companyB,
      warehouseId: warehouses.b1,
      items: [{ materialId, unitId, countedQuantity: '1' }],
    })
    expect(count.status).toBe(404)
  })

  test('列表按公司边界收窄；领域筛选 ∧ 授权谓词不泄露（每条列表路径的别名回归）', async () => {
    const docs = await ids('/stock-docs/query', keeperHeaders)
    expect(docs).toContain(docA.id)
    expect(docs).toContain(draftA.id)
    expect(docs).not.toContain(docB.id)

    const docItems = await ids('/stock-doc-items/query', keeperHeaders)
    expect(docItems).toContain(docAItemId)
    expect(docItems).not.toContain(docBItemId)

    const transfers = await ids('/stock-transfers/query', keeperHeaders)
    expect(transfers).not.toContain(transferB)
    expect(await ids('/stock-transfer-items/query', keeperHeaders)).not.toContain(transferBItemId)

    const counts = await ids('/stock-counts/query', keeperHeaders)
    expect(counts).not.toContain(countB)
    expect(await ids('/stock-count-items/query', keeperHeaders)).not.toContain(countBItemId)

    // 分录列表（join 物料的投影）：只见本公司分录
    const entries = await post('/stock-entries/query', keeperHeaders, { limit: 200, offset: 0 })
    expect(entries.status).toBe(200)
    const entryRows = (await entries.json()) as {
      results: Array<{ id: string; voucherId: string; companyId: string; materialCode: string }>
    }
    expect(entryRows.results.length).toBeGreaterThan(0)
    expect(entryRows.results.every((r) => r.companyId === companyA)).toBe(true)
    expect(entryRows.results.some((r) => r.voucherId === docA.id)).toBe(true)
    // 投影别名写错会静默丢列：物料四字段必须带出来
    expect(entryRows.results[0]!.materialCode).toBe(`KM${suffix}`)
    const otherEntry = await db
      .selectFrom('inv_stock_entry')
      .select('id')
      .where('voucher_id', '=', docB.id)
      .executeTakeFirstOrThrow()
    expect((await get(`/stock-entries/${otherEntry.id}`, keeperHeaders)).status).toBe(404)

    // 带公司筛选取未授权公司：空集而非 forbidden
    const filtered = await post('/stock-docs/query', keeperHeaders, {
      limit: 100,
      offset: 0,
      filter: { companyId: { kind: 'fk', op: 'in', values: [companyB], labels: [] } },
    })
    expect(filtered.status).toBe(200)
    expect(((await filtered.json()) as { count: number }).count).toBe(0)
  })

  test('余额是单公司聚合：未授权公司返回空结果，本公司照常出数', async () => {
    const mine = await post('/stock-balance/query', keeperHeaders, {
      companyId: companyA,
      materialId,
      hideZero: false,
    })
    expect(mine.status).toBe(200)
    const rows = (await mine.json()) as { results: Array<{ warehouseId: string; quantity: string }> }
    expect(rows.results.some((r) => r.warehouseId === warehouses.a1 && r.quantity === '10')).toBe(true)

    const others = await post('/stock-balance/query', keeperHeaders, {
      companyId: companyB,
      materialId,
      hideZero: false,
    })
    expect(others.status).toBe(200)
    expect(((await others.json()) as { results: unknown[] }).results).toEqual([])
  })

  test('状态守卫仍是 409（划界验证：领域不变量不进权限系统）', async () => {
    expect(docA.status).toBe('DRAFT')
    const audited = await get(`/stock-docs/${docA.id}`, keeperHeaders)
    expect(((await audited.json()) as DocDto).status).toBe('AUDITED')
    expect((await patch(`/stock-docs/${docA.id}`, keeperHeaders, { summary: 'x' })).status).toBe(409)
    expect((await del(`/stock-docs/${docA.id}`, keeperHeaders)).status).toBe(409)
    expect((await post(`/stock-docs/${docA.id}/audit`, keeperHeaders, {})).status).toBe(409)
    // 行编辑的草稿门同理
    expect(
      (await patch(`/stock-doc-items/${docAItemId}`, keeperHeaders, { qty: '3' })).status,
    ).toBe(409)
    expect((await del(`/stock-doc-items/${docAItemId}`, keeperHeaders)).status).toBe(409)
    expect((await post(`/stock-docs/${draftA.id}/void`, keeperHeaders, {})).status).toBe(409)
  })

  test('无 owner/dept 绑定的资源授 dept 范围即 fail-closed（矩阵只应出 all）', async () => {
    await grant(keeperRoleId, FULL_CODES, 'dept')
    try {
      // Actor 装配缓存在测试里关闭（ttlMs=0），同一 token 即刻生效
      expect(await ids('/stock-docs/query', keeperHeaders)).toEqual([])
      expect(await ids('/stock-doc-items/query', keeperHeaders)).toEqual([])
      expect((await get(`/stock-docs/${docA.id}`, keeperHeaders)).status).toBe(404)
      // 码级仍满足（403 只由码不满足产生），故不是 forbidden
      expect((await post('/stock-docs/query', keeperHeaders, { limit: 1, offset: 0 })).status).toBe(200)
    } finally {
      await grant(keeperRoleId, FULL_CODES, 'all')
    }
    expect(await ids('/stock-docs/query', keeperHeaders)).toContain(docA.id)
  })
})
