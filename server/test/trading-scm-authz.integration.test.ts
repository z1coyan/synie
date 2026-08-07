/**
 * 扫荡批 3（工单 10）的授权端到端验收：trading 销/采全链 + scm orderflow。
 *
 * 断言口径（错误语义唯一规则）：动作码不满足 403 forbidden；行级范围不命中
 * 404 not_found / 列表不含；状态不满足 409 conflict（状态守卫划出权限系统）。
 * 双边 spec 驱动的资源在此按「路由按 side 选资源名」验证：同一服务方法、
 * 两套资源名与动作码（sales.order:* / purchase.order:*）。
 * orderflow 是 `readAnyOf` 四码析取的唯一消费者：任一来源码命中即可读、全缺 403，
 * 且行集仍受公司边界收窄（声明即执行，路由与服务的两份手写析取已删除）。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createIamService } from '~/modules/iam/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { buildTestApp, createPlatformRegistry, testDatabaseUrl } from './helpers.ts'

const url = testDatabaseUrl()
const run = url ? describe : describe.skip

/** 交易员：销售订单全套 + 采购侧与履约只读 */
const TRADER_CODES = [
  'sales.order:read',
  'sales.order:create',
  'sales.order:update',
  'sales.order:delete',
  'sales.order:audit',
  'sales.order:close',
  'sales.order:void',
  'purchase.order:read',
  'purchase.receipt:read',
] as const

/** 只读角色：销售订单只读（缺 audit/delete/update → 403 用例） */
const READ_ONLY_CODES = ['sales.order:read', 'purchase.order:read'] as const

/** orderflow anyOf 用例：只持一条来源单据 read 码 */
const FLOW_ONE_CODE = ['sales.delivery:read'] as const

/** orderflow anyOf 反例：四条来源码全缺（另给一条无关码保证能登录并读别的） */
const FLOW_NONE_CODES = ['sales.order:read'] as const

run('PG 集成（扫荡 10：trading 销/采全链与 scm orderflow 授权语义）', () => {
  const db = createDb(url!)
  const registry = createPlatformRegistry()
  const authz = createAuthzEnforcer(registry)
  const iam = createIamService(db, registry)
  const admin = testActor({ superAdmin: true, allCompanies: true })
  const adminUserPermit = () => {
    const decision = authz.decideFor(admin, 'sysUsers', 'create')
    if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
    return decision.permit
  }

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const currencyId = crypto.randomUUID()
  const companyA = crypto.randomUUID()
  const companyB = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  const supplierId = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const warehouseA = crypto.randomUUID()
  const warehouseB = crypto.randomUUID()
  const debitAccountA = crypto.randomUUID()
  const creditAccountA = crypto.randomUUID()
  const salesOrderA = crypto.randomUUID()
  const salesItemA = crypto.randomUUID()
  const salesOrderB = crypto.randomUUID()
  const salesItemB = crypto.randomUUID()
  const salesOrderPut = crypto.randomUUID()
  const salesItemPut = crypto.randomUUID()
  const purchaseOrderA = crypto.randomUUID()
  const purchaseItemA = crypto.randomUUID()
  const purchaseOrderB = crypto.randomUUID()
  const purchaseItemB = crypto.randomUUID()
  const receiptA = crypto.randomUUID()
  const receiptItemA = crypto.randomUUID()
  const receiptB = crypto.randomUUID()
  const receiptItemB = crypto.randomUUID()
  const traderRoleId = crypto.randomUUID()
  const readRoleId = crypto.randomUUID()
  const flowOneRoleId = crypto.randomUUID()
  const flowNoneRoleId = crypto.randomUUID()

  let traderHeaders: Record<string, string> = {}
  let readHeaders: Record<string, string> = {}
  let flowOneHeaders: Record<string, string> = {}
  let flowNoneHeaders: Record<string, string> = {}
  let app: Awaited<ReturnType<typeof buildTestApp>>

  const flowIdA = () => `purchase_receipt:${receiptItemA}`
  const flowIdB = () => `purchase_receipt:${receiptItemB}`

  async function grant(roleId: string, codes: readonly string[]): Promise<void> {
    await db.deleteFrom('sys_role_permission').where('role_id', '=', roleId).execute()
    if (codes.length > 0) {
      await db
        .insertInto('sys_role_permission')
        .values(codes.map((permission) => ({ role_id: roleId, permission, scope: 'all' })))
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

  async function createUser(
    name: string,
    roleId: string,
    companyIds: string[],
  ): Promise<Record<string, string>> {
    const created = await iam.createUser(adminUserPermit(), {
      username: `${name}-${suffix}`,
      name,
      roleIds: [roleId],
      companyIds,
    })
    return login(`${name}-${suffix}`, created.password)
  }

  const post = async (path: string, headers: Record<string, string>, body: unknown) =>
    app.request(`/api/v1${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const put = async (path: string, headers: Record<string, string>, body: unknown) =>
    app.request(`/api/v1${path}`, { method: 'PUT', headers, body: JSON.stringify(body) })
  const patch = async (path: string, headers: Record<string, string>, body: unknown) =>
    app.request(`/api/v1${path}`, { method: 'PATCH', headers, body: JSON.stringify(body) })
  const del = async (path: string, headers: Record<string, string>) =>
    app.request(`/api/v1${path}`, { method: 'DELETE', headers })
  const get = async (path: string, headers: Record<string, string>) =>
    app.request(`/api/v1${path}`, { headers })

  /** 列表别名回归：断言**本公司的行在结果里**（只断言别人的不在，对空集永真） */
  async function listIds(path: string, headers: Record<string, string>): Promise<string[]> {
    const res = await post(path, headers, { limit: 200, offset: 0 })
    expect([path, res.status]).toEqual([path, 200])
    const parsed = (await res.json()) as { results: Array<{ id: string }> }
    return parsed.results.map((r) => r.id)
  }

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency (id, name, iso_code, symbol, active)
      VALUES (${currencyId}::uuid, ${'交易币-' + suffix}, ${'T' + suffix.slice(0, 2).toUpperCase()},
        ${'T' + suffix.slice(0, 3)}, true)
    `.execute(db)
    for (const [id, code, name] of [
      [companyA, 'TA', '交易公司甲'],
      [companyB, 'TB', '交易公司乙'],
    ] as const) {
      await sql`
        INSERT INTO bas_company (id, code, name, short_name, base_currency_id)
        VALUES (${id}::uuid, ${code + suffix}, ${name + suffix}, ${code}, ${currencyId}::uuid)
      `.execute(db)
    }
    await sql`
      INSERT INTO sal_customers (id, code, name, short_name)
      VALUES (${customerId}::uuid, ${'TC' + suffix}, ${'交易客户-' + suffix}, 'TC')
    `.execute(db)
    await sql`
      INSERT INTO pur_supplier (id, code, name, short_name)
      VALUES (${supplierId}::uuid, ${'TS' + suffix}, ${'交易供应商-' + suffix}, 'TS')
    `.execute(db)
    await sql`
      INSERT INTO bas_unit (id, unit_type, is_base, name, symbol, ratio)
      VALUES (${unitId}::uuid, ${'tr-' + suffix}, true, ${'交易件-' + suffix},
        ${'u' + suffix.slice(0, 3)}, 1)
    `.execute(db)
    await sql`
      INSERT INTO inv_material_category (id, code, name, is_leaf, active)
      VALUES (${categoryId}::uuid, ${'TM' + suffix}, ${'交易分类-' + suffix}, true, true)
    `.execute(db)
    await sql`
      INSERT INTO inv_material (id, code, name, category_id, default_unit_id, active)
      VALUES (${materialId}::uuid, ${'MT' + suffix}, ${'交易物料-' + suffix},
        ${categoryId}::uuid, ${unitId}::uuid, true)
    `.execute(db)
    for (const [id, companyId] of [
      [warehouseA, companyA],
      [warehouseB, companyB],
    ] as const) {
      await sql`
        INSERT INTO inv_warehouse (id, name, code, company_id, is_leaf, active)
        VALUES (${id}::uuid, ${'交易仓-' + id.slice(0, 4)}, ${'W' + id.slice(0, 8).replace(/-/g, '')},
          ${companyId}::uuid, true, true)
      `.execute(db)
    }
    await sql`
      INSERT INTO bas_account (id, code, name, direction, is_group, active, company_id, currency_id)
      VALUES
        (${debitAccountA}::uuid, ${'TD' + suffix}, ${'交易借-' + suffix}, 'debit', false, true,
          ${companyA}::uuid, ${currencyId}::uuid),
        (${creditAccountA}::uuid, ${'TK' + suffix}, ${'交易贷-' + suffix}, 'credit', false, true,
          ${companyA}::uuid, ${currencyId}::uuid)
    `.execute(db)

    // 销售订单：甲公司样品单（可审核）+ 乙公司一张（跨公司 404 用例）
    for (const [orderId, itemId, companyId, no] of [
      [salesOrderA, salesItemA, companyA, `SO-A-${suffix}`],
      [salesOrderB, salesItemB, companyB, `SO-B-${suffix}`],
      [salesOrderPut, salesItemPut, companyA, `SO-P-${suffix}`],
    ] as const) {
      await sql`
        INSERT INTO sal_order (id, order_no, order_date, order_type, party_type, party_id,
          company_id, currency_id, exchange_rate, status)
        VALUES (${orderId}::uuid, ${no}, CURRENT_DATE, 'sample', 'customer', ${customerId}::uuid,
          ${companyId}::uuid, ${currencyId}::uuid, 1, 'draft')
      `.execute(db)
      await sql`
        INSERT INTO sal_order_item (id, idx, qty, base_qty, price, amount, base_price, base_amount,
          tax_rate, material_code, material_name, unit_name, order_id, company_id, material_id, unit_id)
        VALUES (${itemId}::uuid, 1, 10, 10, 5, 50, 5, 50, 0.13, ${'MT' + suffix},
          ${'交易物料-' + suffix}, ${'交易件-' + suffix}, ${orderId}::uuid, ${companyId}::uuid,
          ${materialId}::uuid, ${unitId}::uuid)
      `.execute(db)
    }

    // 采购订单 + 已审核入库单：orderflow 视图（purchase_receipt 分支）的行来源
    for (const [orderId, itemId, receiptId, receiptItemId, companyId, warehouseId, no] of [
      [purchaseOrderA, purchaseItemA, receiptA, receiptItemA, companyA, warehouseA, `PO-A-${suffix}`],
      [purchaseOrderB, purchaseItemB, receiptB, receiptItemB, companyB, warehouseB, `PO-B-${suffix}`],
    ] as const) {
      await sql`
        INSERT INTO pur_order (id, order_no, order_date, order_type, party_type, party_id,
          company_id, currency_id, exchange_rate, status)
        VALUES (${orderId}::uuid, ${no}, CURRENT_DATE, 'spot', 'supplier', ${supplierId}::uuid,
          ${companyId}::uuid, ${currencyId}::uuid, 1, 'audited')
      `.execute(db)
      await sql`
        INSERT INTO pur_order_item (id, idx, qty, base_qty, price, amount, tax_rate,
          material_code, material_name, unit_name, order_id, company_id, material_id, unit_id)
        VALUES (${itemId}::uuid, 1, 10, 10, 5, 50, 0.13, ${'MT' + suffix},
          ${'交易物料-' + suffix}, ${'交易件-' + suffix}, ${orderId}::uuid, ${companyId}::uuid,
          ${materialId}::uuid, ${unitId}::uuid)
      `.execute(db)
      await sql`
        INSERT INTO pur_receipt (id, receipt_no, receipt_date, party_type, party_id, status,
          company_id, warehouse_id, debit_account_id, credit_account_id)
        VALUES (${receiptId}::uuid, ${'PR-' + no}, CURRENT_DATE, 'supplier', ${supplierId}::uuid,
          'audited', ${companyId}::uuid, ${warehouseId}::uuid, ${debitAccountA}::uuid,
          ${creditAccountA}::uuid)
      `.execute(db)
      await sql`
        INSERT INTO pur_receipt_item (id, idx, qty, base_qty, material_code, material_name,
          unit_name, order_no, order_unit_name, order_currency_code, receipt_id, company_id,
          order_item_id, material_id, unit_id, warehouse_id)
        VALUES (${receiptItemId}::uuid, 1, 4, 4, ${'MT' + suffix}, ${'交易物料-' + suffix},
          ${'交易件-' + suffix}, ${no}, ${'交易件-' + suffix},
          ${'T' + suffix.slice(0, 2).toUpperCase()}, ${receiptId}::uuid, ${companyId}::uuid,
          ${itemId}::uuid, ${materialId}::uuid, ${unitId}::uuid, ${warehouseId}::uuid)
      `.execute(db)
    }

    await db
      .insertInto('sys_role')
      .values([
        { id: traderRoleId, code: `trade-full-${suffix}`, name: `交易全量-${suffix}` },
        { id: readRoleId, code: `trade-read-${suffix}`, name: `交易只读-${suffix}` },
        { id: flowOneRoleId, code: `flow-one-${suffix}`, name: `流水单码-${suffix}` },
        { id: flowNoneRoleId, code: `flow-none-${suffix}`, name: `流水无码-${suffix}` },
      ])
      .execute()
    await grant(traderRoleId, TRADER_CODES)
    await grant(readRoleId, READ_ONLY_CODES)
    await grant(flowOneRoleId, FLOW_ONE_CODE)
    await grant(flowNoneRoleId, FLOW_NONE_CODES)

    app = await buildTestApp(db)
    // 四个用户一律只授权公司甲：公司域边界（跨公司 404 / 列表不含）由此可验
    traderHeaders = await createUser('trade-full', traderRoleId, [companyA])
    readHeaders = await createUser('trade-read', readRoleId, [companyA])
    flowOneHeaders = await createUser('flow-one', flowOneRoleId, [companyA])
    flowNoneHeaders = await createUser('flow-none', flowNoneRoleId, [companyA])
  })

  afterAll(async () => {
    await sql`DELETE FROM sys_audit_log WHERE company_id IN (${companyA}::uuid, ${companyB}::uuid)`
      .execute(db)
    await sql`DELETE FROM pur_receipt_item WHERE company_id IN (${companyA}::uuid, ${companyB}::uuid)`
      .execute(db)
    await sql`DELETE FROM pur_receipt WHERE company_id IN (${companyA}::uuid, ${companyB}::uuid)`
      .execute(db)
    await sql`DELETE FROM pur_order WHERE company_id IN (${companyA}::uuid, ${companyB}::uuid)`
      .execute(db)
    await sql`DELETE FROM sal_order WHERE company_id IN (${companyA}::uuid, ${companyB}::uuid)`
      .execute(db)
    await sql`DELETE FROM bas_account WHERE company_id IN (${companyA}::uuid, ${companyB}::uuid)`
      .execute(db)
    await sql`DELETE FROM inv_warehouse WHERE company_id IN (${companyA}::uuid, ${companyB}::uuid)`
      .execute(db)
    await sql`DELETE FROM inv_material WHERE id=${materialId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id=${categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id=${unitId}::uuid`.execute(db)
    await sql`DELETE FROM sal_customers WHERE id=${customerId}::uuid`.execute(db)
    await sql`DELETE FROM pur_supplier WHERE id=${supplierId}::uuid`.execute(db)
    await sql`
      DELETE FROM sys_user_company WHERE company_id IN (${companyA}::uuid, ${companyB}::uuid)
    `.execute(db)
    await sql`
      DELETE FROM sys_user_role WHERE user_id IN (
        SELECT id FROM sys_user WHERE username LIKE ${'%-' + suffix}
      )
    `.execute(db)
    await sql`
      DELETE FROM sys_user WHERE username LIKE ${'%-' + suffix}
    `.execute(db)
    await sql`
      DELETE FROM sys_role_permission WHERE role_id IN (${traderRoleId}::uuid, ${readRoleId}::uuid,
        ${flowOneRoleId}::uuid, ${flowNoneRoleId}::uuid)
    `.execute(db)
    await sql`
      DELETE FROM sys_role WHERE id IN (${traderRoleId}::uuid, ${readRoleId}::uuid,
        ${flowOneRoleId}::uuid, ${flowNoneRoleId}::uuid)
    `.execute(db)
    await sql`DELETE FROM bas_company WHERE id IN (${companyA}::uuid, ${companyB}::uuid)`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id=${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  test('列表别名回归：本公司行可见，他司行不可见（含 via 子行与只读投影）', async () => {
    const salesHeads = await listIds('/sales/orders/query', traderHeaders)
    expect(salesHeads).toContain(salesOrderA)
    expect(salesHeads).not.toContain(salesOrderB)

    // 条目是 via(母单)：判定递归到订单头，不看行自身 company_id
    const salesItems = await listIds('/sales/order-items/query', traderHeaders)
    expect(salesItems).toContain(salesItemA)
    expect(salesItems).not.toContain(salesItemB)

    const purchaseHeads = await listIds('/purchase/orders/query', traderHeaders)
    expect(purchaseHeads).toContain(purchaseOrderA)
    expect(purchaseHeads).not.toContain(purchaseOrderB)

    const purchaseItems = await listIds('/purchase/order-items/query', traderHeaders)
    expect(purchaseItems).toContain(purchaseItemA)
    expect(purchaseItems).not.toContain(purchaseItemB)

    const flows = await listIds('/base/order-flow-items/query', traderHeaders)
    expect(flows).toContain(flowIdA())
    expect(flows).not.toContain(flowIdB())
  })

  test('跨公司单条一律 404（不泄露存在性），双边对称', async () => {
    const cases: Array<[string, string]> = [
      ['销售订单头', `/sales/orders/${salesOrderB}`],
      ['销售订单头草稿', `/sales/orders/${salesOrderB}/draft`],
      ['销售订单条目', `/sales/order-items/${salesItemB}`],
      ['销售订单收发货历史', `/sales/orders/${salesOrderB}/history`],
      ['采购订单头', `/purchase/orders/${purchaseOrderB}`],
      ['采购订单条目', `/purchase/order-items/${purchaseItemB}`],
      ['订单收发货历史行', `/base/order-flow-items/${encodeURIComponent(flowIdB())}`],
    ]
    for (const [label, path] of cases) {
      const res = await get(path, traderHeaders)
      expect([label, res.status]).toEqual([label, 404])
      expect((await res.json()) as unknown).toMatchObject({ error: { code: 'not_found' } })
    }
    // 写侧同理：跨公司行不可达 → not_found（不是 forbidden）
    const denied = await post(`/sales/orders/${salesOrderB}/audit`, traderHeaders, {})
    expect(denied.status).toBe(404)
  })

  test('动作码不满足一律 403：只读角色的写与工作流端点', async () => {
    const calls: Array<[string, () => Promise<Response>]> = [
      ['审核', () => post(`/sales/orders/${salesOrderA}/audit`, readHeaders, {})],
      ['关闭', () => post(`/sales/orders/${salesOrderA}/close`, readHeaders, {})],
      ['作废', () => post(`/sales/orders/${salesOrderA}/void`, readHeaders, {})],
      ['删除', () => del(`/sales/orders/${salesOrderA}`, readHeaders)],
      ['改头', () => patch(`/sales/orders/${salesOrderA}`, readHeaders, { remarks: 'x' })],
      [
        '整单替换',
        () =>
          put(`/sales/orders/${salesOrderA}`, readHeaders, {
            companyId: companyA,
            partyType: 'CUSTOMER',
            partyId: customerId,
            items: [],
          }),
      ],
      [
        '新增条目',
        () =>
          post('/sales/order-items', readHeaders, {
            orderId: salesOrderA,
            idx: 2,
            qty: '1',
            materialId,
            unitId,
          }),
      ],
    ]
    for (const [label, call] of calls) {
      const res = await call()
      expect([label, res.status]).toEqual([label, 403])
      expect((await res.json()) as unknown).toMatchObject({ error: { code: 'forbidden' } })
    }
    // 同一角色读同一行 200：403 的唯一成因是码不满足
    const readable = await get(`/sales/orders/${salesOrderA}`, readHeaders)
    expect(readable.status).toBe(200)
  })

  test('聚合 PUT 声明式要求 update ∧ create ∧ delete（缺任一码 403）', async () => {
    await grant(traderRoleId, ['sales.order:read', 'sales.order:update'])
    const partial = await put(`/sales/orders/${salesOrderPut}`, traderHeaders, {
      companyId: companyA,
      partyType: 'CUSTOMER',
      partyId: customerId,
      items: [],
    })
    expect(partial.status).toBe(403)
    await grant(traderRoleId, TRADER_CODES)
    // 齐码后同一请求不再是 403（条目清空触发领域校验，而非权限）
    const complete = await put(`/sales/orders/${salesOrderPut}`, traderHeaders, {
      companyId: companyA,
      partyType: 'CUSTOMER',
      partyId: customerId,
      items: [],
    })
    expect(complete.status).not.toBe(403)
  })

  test('状态守卫是领域不变量：重复审核 409 conflict（不是 403/404）', async () => {
    const audited = await post(`/sales/orders/${salesOrderA}/audit`, traderHeaders, {})
    expect(audited.status).toBe(200)
    const again = await post(`/sales/orders/${salesOrderA}/audit`, traderHeaders, {})
    expect(again.status).toBe(409)
    expect((await again.json()) as unknown).toMatchObject({ error: { code: 'conflict' } })
    // 已审核单据改头也是 conflict（授权通过、领域拒绝）
    const patched = await patch(`/sales/orders/${salesOrderA}`, traderHeaders, { remarks: 'x' })
    expect(patched.status).toBe(409)
  })

  test('orderflow readAnyOf 声明即执行：任一来源码命中即可读，四码全缺 403', async () => {
    // 只持 sales.delivery:read 也能读整张订单流水视图（码级析取，与行的来源单据类型无关）
    const oneCode = await post('/base/order-flow-items/query', flowOneHeaders, {
      limit: 200,
      offset: 0,
    })
    expect(oneCode.status).toBe(200)
    const rows = (await oneCode.json()) as { results: Array<{ id: string }> }
    expect(rows.results.map((r) => r.id)).toContain(flowIdA())
    const oneCodeGet = await get(
      `/base/order-flow-items/${encodeURIComponent(flowIdA())}`,
      flowOneHeaders,
    )
    expect(oneCodeGet.status).toBe(200)

    // 四码全缺：403（而不是空列表——码级判定先于行级）
    const noCode = await post('/base/order-flow-items/query', flowNoneHeaders, {
      limit: 200,
      offset: 0,
    })
    expect(noCode.status).toBe(403)
    expect((await noCode.json()) as unknown).toMatchObject({ error: { code: 'forbidden' } })
    const noCodeGet = await get(
      `/base/order-flow-items/${encodeURIComponent(flowIdA())}`,
      flowNoneHeaders,
    )
    expect(noCodeGet.status).toBe(403)
  })

  test('矩阵可授范围：trading 前缀均无 owner/dept 绑定，supportedScopes 只有 all', async () => {
    const res = await get('/meta/permission-catalog', traderHeaders)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      groups: Array<{ prefix: string; supportedScopes?: string[] }>
    }
    const tradingPrefixes = body.groups.filter((g) =>
      ['sales.order', 'purchase.order', 'sales.delivery', 'purchase.receipt',
        'sales.reconciliation', 'purchase.reconciliation'].includes(g.prefix),
    )
    expect(tradingPrefixes.length).toBeGreaterThan(0)
    for (const group of tradingPrefixes) {
      expect([group.prefix, group.supportedScopes ?? ['all']]).toEqual([group.prefix, ['all']])
    }
  })
})
