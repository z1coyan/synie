/**
 * 车间权限收口端到端（工单物料需求派生 · 票 03）。
 *
 * 角色：计划员（需求单/工单全套，scope=all，无部门）× 车间经理 A/B
 * （mfg.demand 的 read/update/confirm/delete + 工单全套 + generate_material_demand，
 * 均 scope=dept，分别挂车间 A / 车间 B；**不授 create/dispatch/close/void**）。
 *
 * 断言口径：车间经工单「生成物料需求」动作完成派生（不持 mfg.demand:create）；
 * 下发到本车间的派生草稿可改/可审/可删；手工建单与销售勾选纳入端点 403；
 * 未下发到本车间的需求单（含派生给他车间的）一律不可见；计划角色全链路不回归。
 * 前端建单按钮随 create capability 缺失自动隐藏（meta 能力下发既有机制，不在本文件覆盖）。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createIamService } from '~/modules/iam/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { buildTestApp, createPlatformRegistry, testDatabaseUrl } from './helpers.ts'

const url = testDatabaseUrl()
const run = url ? describe : describe.skip

/** 计划员：需求单/工单全套 + 部门可读（下发时要选车间） */
const PLANNER_CODES = [
  'mfg.demand:read',
  'mfg.demand:create',
  'mfg.demand:update',
  'mfg.demand:delete',
  'mfg.demand:confirm',
  'mfg.demand:close',
  'mfg.demand:void',
  'mfg.demand:dispatch',
  'mfg.work_order:read',
  'mfg.work_order:create',
  'mfg.work_order:update',
  'mfg.work_order:void',
  'sys.department:read',
] as const

/**
 * 车间经理：需求单 read/update/confirm/delete（本部门）+ 工单全套（本部门）
 * + 派生动作码；**不授 mfg.demand:create**——手工建单与勾选销售入口因此关闭
 */
const SHOP_CODES = [
  'mfg.demand:read',
  'mfg.demand:update',
  'mfg.demand:confirm',
  'mfg.demand:delete',
  'mfg.work_order:read',
  'mfg.work_order:create',
  'mfg.work_order:update',
  'mfg.work_order:void',
  'mfg.work_order:generate_material_demand',
] as const

run('PG 集成（车间权限收口：需求单限定入口授权）', () => {
  const db = createDb(url!)
  const registry = createPlatformRegistry()
  const authz = createAuthzEnforcer(registry)
  const iam = createIamService(db, registry)
  const numbering = createNumberingService(db, buildNumberingCatalog(registry), registry)
  const admin = testActor({ superAdmin: true, allCompanies: true })
  /** 建用户/编号规则走 superAdmin 凭证 */
  const adminPermit = (resource: string, action: string) => {
    const decision = authz.decideFor(admin, resource, action)
    if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
    return decision.permit
  }

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const deptAId = crypto.randomUUID()
  const deptBId = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const productId = crypto.randomUUID()
  const compAId = crypto.randomUUID()
  const compBId = crypto.randomUUID()
  const bomId = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  const salesOrderId = crypto.randomUUID()
  const salesItemId = crypto.randomUUID()
  const plannerRoleId = crypto.randomUUID()
  const shopRoleId = crypto.randomUUID()

  let plannerId = ''
  let shopAId = ''
  let shopBId = ''
  let plannerHeaders: Record<string, string> = {}
  let shopAHeaders: Record<string, string> = {}
  let shopBHeaders: Record<string, string> = {}
  let app: Awaited<ReturnType<typeof buildTestApp>>

  const createdDemands: string[] = []
  /** 派生草稿单独登记：行引用工单（source_work_order_id），必须先于工单清场 */
  const derivedDemands: string[] = []
  const createdWorkOrders: string[] = []
  const createdNumberingRules: string[] = []

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
    app.request(`/api/v1/manufacturing${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  const patch = (path: string, headers: Record<string, string>, body: unknown) =>
    app.request(`/api/v1/manufacturing${path}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    })
  const del = (path: string, headers: Record<string, string>) =>
    app.request(`/api/v1/manufacturing${path}`, { method: 'DELETE', headers })
  const get = (path: string, headers: Record<string, string>) =>
    app.request(`/api/v1/manufacturing${path}`, { headers })

  interface DemandDto {
    id: string
    demandNo: string
    status: string
    assignedDeptId: string | null
  }
  interface WorkOrderDto {
    id: string
    workOrderNo: string
    ownerDeptId: string | null
  }
  interface SnapshotComponent {
    id: string
    materialId: string
  }
  interface DeriveResult {
    demands: Array<{ id: string; demandNo: string; assignedDeptId: string | null }>
  }

  async function demandIds(headers: Record<string, string>): Promise<string[]> {
    const res = await post('/demands/query', headers, { limit: 100, offset: 0 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: DemandDto[] }
    return body.results.map((r) => r.id)
  }

  let sourceDemand: DemandDto
  let sourceItemId = ''
  let workOrder: WorkOrderDto
  let snapComponents: SnapshotComponent[] = []

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency (id, name, iso_code, symbol, active)
      VALUES (${currencyId}::uuid, ${'收口币-' + suffix}, ${'W' + suffix.slice(0, 2).toUpperCase()}, 'W', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company (id, code, name, short_name, base_currency_id)
      VALUES (${companyId}::uuid, ${'WS' + suffix}, ${'收口公司-' + suffix}, 'WS', ${currencyId}::uuid)
    `.execute(db)
    for (const [id, code, name] of [
      [deptAId, 'WA', '车间A'],
      [deptBId, 'WB', '车间B'],
    ] as const) {
      await sql`
        INSERT INTO sys_department (id, company_id, code, name, path)
        VALUES (${id}::uuid, ${companyId}::uuid, ${code + suffix}, ${name + suffix}, ${'/' + id + '/'})
      `.execute(db)
    }
    await db
      .insertInto('bas_unit')
      .values({
        id: unitId,
        unit_type: 'quantity',
        is_base: false,
        name: `收口单位-${suffix}`,
        symbol: `w${suffix.slice(0, 5)}`,
        ratio: '1',
      })
      .execute()
    await db
      .insertInto('inv_material_category')
      .values({
        id: categoryId,
        code: `WC${suffix}`,
        name: `收口分类-${suffix}`,
        is_leaf: true,
        active: true,
      })
      .execute()
    await db
      .insertInto('inv_material')
      .values([
        { id: productId, code: `WP${suffix}`, name: `收口成品-${suffix}`, category_id: categoryId, default_unit_id: unitId },
        { id: compAId, code: `WA${suffix}`, name: `嵌件A-${suffix}`, category_id: categoryId, default_unit_id: unitId },
        { id: compBId, code: `WB${suffix}`, name: `材料B-${suffix}`, category_id: categoryId, default_unit_id: unitId },
      ])
      .execute()
    // BOM 主数据裸插（active，两行配料）：工单创建即快照
    await db
      .insertInto('mfg_bom')
      .values({ id: bomId, code: `WBOM${suffix}`, material_id: productId, status: 'active', note: null, plan_name: null })
      .execute()
    await db
      .insertInto('mfg_bom_component')
      .values([
        { bom_id: bomId, material_id: compAId, unit_id: unitId, quantity: '2', loss_rate: null, note: null },
        { bom_id: bomId, material_id: compBId, unit_id: unitId, quantity: '1', loss_rate: null, note: null },
      ])
      .execute()
    // 已审核销售订单（计划角色勾选纳入回归用）
    await sql`
      INSERT INTO sal_customers (id, code, name, short_name)
      VALUES (${customerId}::uuid, ${'CU' + suffix}, ${'收口客户-' + suffix}, 'CU')
    `.execute(db)
    await sql`
      INSERT INTO sal_order (id, order_no, order_date, order_type, party_type, party_id,
        company_id, currency_id, exchange_rate, status)
      VALUES (${salesOrderId}::uuid, ${'SO-' + suffix}, CURRENT_DATE, 'sample', 'customer',
        ${customerId}::uuid, ${companyId}::uuid, ${currencyId}::uuid, 1, 'audited')
    `.execute(db)
    await sql`
      INSERT INTO sal_order_item (id, idx, qty, base_qty, price, amount, base_price, base_amount,
        tax_rate, material_code, material_name, unit_name, order_id, company_id, material_id, unit_id)
      VALUES (${salesItemId}::uuid, 1, 10, 10, 5, 50, 5, 50, 0.13, ${'WP' + suffix},
        ${'收口成品-' + suffix}, ${'收口单位-' + suffix}, ${salesOrderId}::uuid, ${companyId}::uuid,
        ${productId}::uuid, ${unitId}::uuid)
    `.execute(db)
    await db
      .insertInto('sys_role')
      .values([
        { id: plannerRoleId, code: `planner-${suffix}`, name: `计划员-${suffix}` },
        { id: shopRoleId, code: `shop-${suffix}`, name: `车间经理-${suffix}` },
      ])
      .execute()

    const planner = await iam.createUser(adminPermit('sysUsers', 'create'), {
      username: `planner-${suffix}`,
      name: '计划员',
      roleIds: [plannerRoleId],
      companyIds: [companyId],
    })
    plannerId = planner.user.id
    const shopA = await iam.createUser(adminPermit('sysUsers', 'create'), {
      username: `shopa-${suffix}`,
      name: '车间经理A',
      departmentId: deptAId,
      roleIds: [shopRoleId],
      companyIds: [companyId],
    })
    shopAId = shopA.user.id
    const shopB = await iam.createUser(adminPermit('sysUsers', 'create'), {
      username: `shopb-${suffix}`,
      name: '车间经理B',
      departmentId: deptBId,
      roleIds: [shopRoleId],
      companyIds: [companyId],
    })
    shopBId = shopB.user.id

    await grant(plannerRoleId, PLANNER_CODES, 'all')
    await grant(shopRoleId, SHOP_CODES, 'dept')

    // 派生草稿/工单经编号规则取号：已有启用规则则复用，否则建本测前缀规则
    // （共享库并发建撞 one_enabled_per_resource 唯一索引时回落复用）
    async function ensureRule(resource: string, name: string, prefix: string): Promise<void> {
      const existing = await db
        .selectFrom('sys_numbering_rule')
        .select('id')
        .where('resource', '=', resource)
        .where('enabled', '=', true)
        .executeTakeFirst()
      if (existing) return
      try {
        const rule = await numbering.create(adminPermit('sysNumberingRules', 'create'), {
          resource,
          name,
          segments: [
            { type: 'text', value: prefix },
            { type: 'seq', padding: 3 },
          ],
          perCompany: false,
          enabled: true,
        })
        createdNumberingRules.push(rule.id)
      } catch (err) {
        const again = await db
          .selectFrom('sys_numbering_rule')
          .select('id')
          .where('resource', '=', resource)
          .where('enabled', '=', true)
          .executeTakeFirst()
        if (!again) throw err
      }
    }
    await ensureRule('mfg.demand', `W${suffix}需求`, `WD${suffix}-`)
    await ensureRule('mfg.work_order', `W${suffix}工单`, `WW${suffix}-`)

    app = await buildTestApp(db, { registry })
    plannerHeaders = await login(planner.user.username, planner.password)
    shopAHeaders = await login(shopA.user.username, shopA.password)
    shopBHeaders = await login(shopB.user.username, shopB.password)

    // 来源需求单：计划建单 → 确认 → 下发车间 A（全链路本身即计划回归断言）
    const created = await post('/demands', plannerHeaders, {
      companyId,
      assignType: 'STOCK',
    })
    expect(created.status).toBe(201)
    sourceDemand = (await created.json()) as DemandDto
    createdDemands.push(sourceDemand.id)
    const item = await post('/demand-items', plannerHeaders, {
      demandId: sourceDemand.id,
      idx: 1,
      materialId: productId,
      unitId,
      qty: '10',
      needDate: '2026-08-01',
    })
    expect(item.status).toBe(201)
    sourceItemId = ((await item.json()) as { id: string }).id
    expect((await post(`/demands/${sourceDemand.id}/confirm`, plannerHeaders, {})).status).toBe(200)
    const dispatched = await post(`/demands/${sourceDemand.id}/dispatch`, plannerHeaders, {
      assignType: 'MAKE',
      assignedDeptId: deptAId,
    })
    expect(dispatched.status).toBe(200)
    sourceDemand = (await dispatched.json()) as DemandDto

    // 车间 A 从下发到本车间的需求行开工单（带 BOM → 创建即快照，盖章归属车间 A）
    const wo = await post('/work-orders', shopAHeaders, {
      demandItemId: sourceItemId,
      qty: '10',
      bomId,
    })
    expect(wo.status).toBe(201)
    workOrder = (await wo.json()) as WorkOrderDto
    createdWorkOrders.push(workOrder.id)
    expect(workOrder.ownerDeptId).toBe(deptAId)

    const snap = await get(`/work-orders/${workOrder.id}/bom-snapshot`, shopAHeaders)
    expect(snap.status).toBe(200)
    snapComponents = ((await snap.json()) as { components: SnapshotComponent[] }).components
    expect(snapComponents).toHaveLength(2)
  })

  afterAll(async () => {
    // 逆序清场：派生草稿（行引用工单）→ 工单 → 来源需求单 → 主数据
    for (const id of derivedDemands) {
      await sql`
        DELETE FROM sys_audit_log
        WHERE record_id = ${id}::uuid
           OR record_id IN (SELECT id FROM mfg_demand_item WHERE demand_id = ${id}::uuid)
      `.execute(db)
      await sql`
        DELETE FROM sys_attachment
        WHERE owner_type = 'mfg_demand_item'
          AND owner_id IN (SELECT id FROM mfg_demand_item WHERE demand_id = ${id}::uuid)
      `.execute(db)
      await sql`DELETE FROM mfg_demand_item WHERE demand_id = ${id}::uuid`.execute(db)
      await sql`DELETE FROM mfg_demand WHERE id = ${id}::uuid`.execute(db)
    }
    for (const id of createdWorkOrders) {
      await sql`DELETE FROM sys_audit_log WHERE record_id = ${id}::uuid`.execute(db)
      await sql`DELETE FROM sys_attachment WHERE owner_type = 'mfg_work_order' AND owner_id = ${id}::uuid`.execute(db)
      await sql`DELETE FROM mfg_demand_arrangement WHERE work_order_id = ${id}::uuid`.execute(db)
      await sql`DELETE FROM mfg_work_order WHERE id = ${id}::uuid`.execute(db)
    }
    for (const id of createdDemands) {
      await sql`
        DELETE FROM sys_audit_log
        WHERE record_id = ${id}::uuid
           OR record_id IN (SELECT id FROM mfg_demand_item WHERE demand_id = ${id}::uuid)
      `.execute(db)
      await sql`
        DELETE FROM mfg_demand_arrangement
        WHERE demand_item_id IN (SELECT id FROM mfg_demand_item WHERE demand_id = ${id}::uuid)
      `.execute(db)
      await sql`
        DELETE FROM sys_attachment
        WHERE owner_type = 'mfg_demand_item'
          AND owner_id IN (SELECT id FROM mfg_demand_item WHERE demand_id = ${id}::uuid)
      `.execute(db)
      await sql`DELETE FROM mfg_demand_item WHERE demand_id = ${id}::uuid`.execute(db)
      await sql`DELETE FROM mfg_demand WHERE id = ${id}::uuid`.execute(db)
    }
    await sql`DELETE FROM sal_order_item WHERE order_id = ${salesOrderId}::uuid`.execute(db)
    await sql`DELETE FROM sal_order WHERE id = ${salesOrderId}::uuid`.execute(db)
    await sql`DELETE FROM sal_customers WHERE id = ${customerId}::uuid`.execute(db)
    await sql`DELETE FROM mfg_bom_component WHERE bom_id = ${bomId}::uuid`.execute(db)
    await sql`DELETE FROM mfg_bom WHERE id = ${bomId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material WHERE id = ANY(${[productId, compAId, compBId]}::uuid[])`.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id = ${categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id = ${unitId}::uuid`.execute(db)
    for (const userId of [plannerId, shopAId, shopBId]) {
      if (!userId) continue
      await sql`DELETE FROM sys_audit_log WHERE actor_id = ${userId}::uuid`.execute(db)
      await db.deleteFrom('sys_user_role').where('user_id', '=', userId).execute()
      await db.deleteFrom('sys_user_company').where('user_id', '=', userId).execute()
      await sql`DELETE FROM auth_account WHERE user_id IN (SELECT auth_user_id FROM sys_user WHERE id = ${userId}::uuid)`.execute(db)
      await db.deleteFrom('sys_user').where('id', '=', userId).execute()
    }
    for (const roleId of [plannerRoleId, shopRoleId]) {
      await db.deleteFrom('sys_role_permission').where('role_id', '=', roleId).execute()
      await db.deleteFrom('sys_role').where('id', '=', roleId).execute()
    }
    for (const id of createdNumberingRules) {
      await sql`DELETE FROM sys_audit_log WHERE record_id = ${id}::uuid`.execute(db)
      await db.deleteFrom('sys_numbering_rule').where('id', '=', id).execute()
    }
    await sql`DELETE FROM sys_department WHERE id = ANY(${[deptAId, deptBId]}::uuid[])`.execute(db)
    await sql`DELETE FROM bas_company WHERE id = ${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id = ${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  let derivedToBId = ''
  let derivedPurchaseId = ''

  test('车间持动作码完成派生：按去向拆单（他车间+采购），全程无需 mfg.demand:create', async () => {
    const compA = snapComponents.find((c) => c.materialId === compAId)!
    const compB = snapComponents.find((c) => c.materialId === compBId)!
    const res = await post(`/work-orders/${workOrder.id}/generate-material-demand`, shopAHeaders, {
      lines: [
        { componentId: compA.id, qty: '5', target: { kind: 'dept', deptId: deptBId } },
        { componentId: compB.id, qty: '3', target: { kind: 'purchase' } },
      ],
    })
    expect(res.status).toBe(201)
    const result = (await res.json()) as DeriveResult
    expect(result.demands).toHaveLength(2)
    for (const d of result.demands) derivedDemands.push(d.id)

    const toB = result.demands.find((d) => d.assignedDeptId === deptBId)
    const purchase = result.demands.find((d) => d.assignedDeptId === null)
    expect(toB).toBeDefined()
    expect(purchase).toBeDefined()
    derivedToBId = toB!.id
    derivedPurchaseId = purchase!.id
    for (const d of result.demands) expect(d.demandNo.trim().length).toBeGreaterThan(0)
  })

  test('数据范围：车间只见下发到本车间的需求单（含派生给他车间的单不可见）', async () => {
    // 车间 A：来源单（下发 A）可见；派生给 B 的与采购向（未下发）不可见
    const visibleA = await demandIds(shopAHeaders)
    expect(visibleA).toContain(sourceDemand.id)
    expect(visibleA).not.toContain(derivedToBId)
    expect(visibleA).not.toContain(derivedPurchaseId)
    expect((await get(`/demands/${derivedToBId}`, shopAHeaders)).status).toBe(404)
    expect((await get(`/demands/${derivedPurchaseId}`, shopAHeaders)).status).toBe(404)

    // 车间 B：派生到 B 的草稿可见（草稿谓词只看指派列）；A 的单与采购向不可见
    const visibleB = await demandIds(shopBHeaders)
    expect(visibleB).toContain(derivedToBId)
    expect(visibleB).not.toContain(sourceDemand.id)
    expect(visibleB).not.toContain(derivedPurchaseId)
    expect((await get(`/demands/${sourceDemand.id}`, shopBHeaders)).status).toBe(404)

    // 计划 scope=all：三张全在
    const all = await demandIds(plannerHeaders)
    expect(all).toContain(sourceDemand.id)
    expect(all).toContain(derivedToBId)
    expect(all).toContain(derivedPurchaseId)
  })

  test('派生草稿可改可审（下发到本车间）：审核后下游车间/采购勾选池可见', async () => {
    // 车间 B 改 + 审派生到本车间的草稿
    const patched = await patch(`/demands/${derivedToBId}`, shopBHeaders, {
      remarks: `车间B接手-${suffix}`,
    })
    expect(patched.status).toBe(200)
    const confirmed = await post(`/demands/${derivedToBId}/confirm`, shopBHeaders, {})
    expect(confirmed.status).toBe(200)
    expect(((await confirmed.json()) as DemandDto).status).toBe('CONFIRMED')
    // 审核后仍在车间 B 与计划的需求单列表（下游勾选池可见）
    expect(await demandIds(shopBHeaders)).toContain(derivedToBId)
    expect(await demandIds(plannerHeaders)).toContain(derivedToBId)

    // 采购向草稿（下发为空）：车间皆不可见，计划确认后留采购勾选池消化
    const purchaseConfirmed = await post(`/demands/${derivedPurchaseId}/confirm`, plannerHeaders, {})
    expect(purchaseConfirmed.status).toBe(200)
    expect(await demandIds(plannerHeaders)).toContain(derivedPurchaseId)
    expect((await get(`/demands/${derivedPurchaseId}`, shopBHeaders)).status).toBe(404)
  })

  test('车间对自己派生到本车间的草稿可改可删', async () => {
    const compA = snapComponents.find((c) => c.materialId === compAId)!
    const res = await post(`/work-orders/${workOrder.id}/generate-material-demand`, shopAHeaders, {
      lines: [{ componentId: compA.id, qty: '2', target: { kind: 'dept', deptId: deptAId } }],
    })
    expect(res.status).toBe(201)
    const result = (await res.json()) as DeriveResult
    expect(result.demands).toHaveLength(1)
    const selfDerived = result.demands[0]!
    derivedDemands.push(selfDerived.id)
    expect(selfDerived.assignedDeptId).toBe(deptAId)

    expect(await demandIds(shopAHeaders)).toContain(selfDerived.id)
    expect(
      (await patch(`/demands/${selfDerived.id}`, shopAHeaders, { remarks: `自派生-${suffix}` }))
        .status,
    ).toBe(200)
    expect((await del(`/demands/${selfDerived.id}`, shopAHeaders)).status).toBe(204)
    expect(await demandIds(shopAHeaders)).not.toContain(selfDerived.id)
  })

  test('车间手工建单 403；销售勾选纳入端点 403；下发/关闭/作废码不授', async () => {
    // 手工建单
    const create = await post('/demands', shopAHeaders, { companyId })
    expect(create.status).toBe(403)
    // 勾选销售条目纳入（写路径 = 建行，码为 mfg.demand:create）
    const tick = await post('/demand-items', shopAHeaders, {
      demandId: sourceDemand.id,
      idx: 2,
      materialId: productId,
      unitId,
      qty: '1',
      salesOrderItemId: salesItemId,
    })
    expect(tick.status).toBe(403)
    // 下发/关闭/作废仍为计划侧码
    expect(
      (await post(`/demands/${sourceDemand.id}/dispatch`, shopAHeaders, { assignedDeptId: deptBId }))
        .status,
    ).toBe(403)
    expect((await post(`/demands/${sourceDemand.id}/close`, shopAHeaders, {})).status).toBe(403)
    expect((await post(`/demands/${sourceDemand.id}/void`, shopAHeaders, {})).status).toBe(403)
  })

  test('计划角色不回归：建单/勾选销售条目/审核/下发全链路', async () => {
    // 勾选池查询（占用口径）
    const occ = await post('/sales-item-occupancies', plannerHeaders, {
      salesOrderItemIds: [salesItemId],
    })
    expect(occ.status).toBe(200)

    const created = await post('/demands', plannerHeaders, {
      companyId,
      assignType: 'STOCK',
    })
    expect(created.status).toBe(201)
    const demand = (await created.json()) as DemandDto
    createdDemands.push(demand.id)

    // 勾选已审核销售订单条目纳入
    const item = await post('/demand-items', plannerHeaders, {
      demandId: demand.id,
      idx: 1,
      materialId: productId,
      unitId,
      qty: '4',
      needDate: '2026-08-01',
      salesOrderItemId: salesItemId,
    })
    expect(item.status).toBe(201)
    expect((await post(`/demands/${demand.id}/confirm`, plannerHeaders, {})).status).toBe(200)
    const dispatched = await post(`/demands/${demand.id}/dispatch`, plannerHeaders, {
      assignType: 'MAKE',
      assignedDeptId: deptBId,
    })
    expect(dispatched.status).toBe(200)
    // 下发后下游车间 B 可见
    expect(await demandIds(shopBHeaders)).toContain(demand.id)
  })
})
