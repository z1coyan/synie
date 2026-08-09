/**
 * 销售退货 PG 集成：整单草稿 + 审核（库存回库/GL 反转/已退已发投影）+ 作废回滚 + 拦截。
 * 门控 SYNIE_TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { createInventoryEngine } from '~/engines/inventory/index.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { testActor } from '~/platform/authz/testing.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { ApiError, onError } from '~/platform/http/errors.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { returnHeadRoutes, returnItemRoutes } from './routes.ts'
import { createReturnsService, type ReturnDraftInput } from './service.ts'

/** 编号服务与授权判定共用同一份 sealed registry（授权归宿解析） */
const registry = createSealedResourceRegistry()
const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（销售退货）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db, buildNumberingCatalog(registry), registry)
  const authz = createAuthzEnforcer(registry)
  const returns = createReturnsService(
    db,
    numbering,
    { inventory: createInventoryEngine(), gl: createGlEngine() },
    registry,
  )
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const prefix = `RT${suffix}`

  const currencyId = crypto.randomUUID()
  const currency2Id = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const material2Id = crypto.randomUUID()
  const virtualMaterialId = crypto.randomUUID()
  const warehouseId = crypto.randomUUID()
  const debitAccountId = crypto.randomUUID()
  const creditAccountId = crypto.randomUUID()
  const orderId = crypto.randomUUID()
  const orderItemId = crypto.randomUUID()
  const orderItem2Id = crypto.randomUUID()
  const deliveryId = crypto.randomUUID()
  const deliveryItemId = crypto.randomUUID()
  const deliveryItem2Id = crypto.randomUUID()
  // 零金额源单（免费样品行）：订单快照金额 0 → 审核跳过总账
  const zeroDeliveryId = crypto.randomUUID()
  const zeroDeliveryItemId = crypto.randomUUID()
  const zeroOrderItemId = crypto.randomUUID()

  const actor: Actor = testActor({
    userId: '',
    username: 'return-test',
    name: '销售退货测试',
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })
  const noReadActor: Actor = testActor({
    ...actor,
    username: 'return-no-read',
    superAdmin: false,
    permissions: new Set(),
  })
  function p(resource: string, action: string, who: Actor = actor) {
    const decision = authz.decideFor(who, resource, action)
    if (decision.outcome !== 'permit') {
      throw new Error(`夹具应当 permit: ${resource}:${action}`)
    }
    return decision.permit
  }
  const tokens: Record<string, Actor> = { 'no-read': noReadActor }
  const byToken = (token: string | null) => (token ? tokens[token] ?? actor : actor)
  const auth = {
    authenticate: async (token: string) => byToken(token),
    authenticateRequest: async (headers: Headers) => {
      const header = headers.get('authorization')
      const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null
      return byToken(token)
    },
  } as unknown as AuthService
  const http = new Hono<AppEnv>()
    .route('/api/v1/sales/returns', returnHeadRoutes({ auth, authz, returns, side: 'sales' }))
    .route('/api/v1/sales/return-items', returnItemRoutes({ auth, authz, returns, side: 'sales' }))
  http.onError(onError)

  function draftInput(
    items: Array<{
      id?: string
      idx: number
      qty: string
      deliveryItemId?: string | null
      warehouseId?: string | null
      remarks?: string | null
    }>,
    remarks: string | null = null,
  ): ReturnDraftInput {
    return {
      companyId,
      documentDate: '2026-08-09',
      postingDate: '2026-08-09',
      partyType: 'customer',
      partyId: customerId,
      currencyId,
      remarks,
      warehouseId,
      debitAccountId,
      creditAccountId,
      items: items.map((i) => ({ warehouseId: warehouseId, ...i })),
    }
  }

  const createdRuleIds: string[] = []

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${currencyId}::uuid, ${prefix + '币'}, ${'T' + suffix.slice(0, 2)}, '¤', true),
        (${currency2Id}::uuid, ${prefix + '外币'}, ${'X' + suffix.slice(0, 2)}, 'ξ', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
      VALUES (${companyId}::uuid, ${'T' + suffix}, ${prefix + '公司'}, 'RT', ${currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sal_customers(id,code,name,short_name)
      VALUES (${customerId}::uuid, ${'CU' + suffix}, ${prefix + '客户'}, 'CU')
    `.execute(db)
    await sql`
      INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
      VALUES (${unitId}::uuid, ${'rt-' + suffix}, true, ${prefix + '件'}, 'u', 1)
    `.execute(db)
    await sql`
      INSERT INTO inv_material_category(id,code,name,is_leaf,active)
      VALUES (${categoryId}::uuid, ${'MC' + suffix}, ${prefix + '分类'}, true, true)
    `.execute(db)
    await sql`
      INSERT INTO inv_material(id,code,name,category_id,default_unit_id,active,material_type) VALUES
        (${materialId}::uuid, ${'M' + suffix}, ${prefix + '物料'}, ${categoryId}::uuid, ${unitId}::uuid, true, 'STOCK'),
        (${material2Id}::uuid, ${'N' + suffix}, ${prefix + '物料二'}, ${categoryId}::uuid, ${unitId}::uuid, true, 'STOCK'),
        (${virtualMaterialId}::uuid, ${'V' + suffix}, ${prefix + '虚拟'}, ${categoryId}::uuid, ${unitId}::uuid, true, 'VIRTUAL')
    `.execute(db)
    await sql`
      INSERT INTO inv_warehouse(id,name,code,company_id,active,is_leaf)
      VALUES (${warehouseId}::uuid, ${prefix + '仓'}, ${'W' + suffix}, ${companyId}::uuid, true, true)
    `.execute(db)
    await sql`
      INSERT INTO bas_account(id,code,name,direction,is_group,active,company_id,currency_id,role) VALUES
        (${debitAccountId}::uuid, ${'TD' + suffix}, ${prefix + '借'}, 'debit', false, true, ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${creditAccountId}::uuid, ${'TC' + suffix}, ${prefix + '未开应收'}, 'credit', false, true, ${companyId}::uuid, ${currencyId}::uuid, 'unbilled_receivable')
    `.execute(db)
    await sql`
      INSERT INTO sal_order(id,order_no,order_date,party_type,party_id,status,company_id,exchange_rate,currency_id,order_type)
      VALUES (${orderId}::uuid, ${prefix + '-SO'}, '2026-07-20', 'customer', ${customerId}::uuid,
        'audited', ${companyId}::uuid, 1, ${currencyId}::uuid, 'regular')
    `.execute(db)
    // 已发数量投影：行一已发 100（全发）、行二已发 50（全发）、零金额行已发 10
    await sql`
      INSERT INTO sal_order_item(id,idx,qty,price,amount,order_id,company_id,material_id,unit_id,
        material_code,material_name,unit_name,base_qty,base_price,base_amount,tax_rate,shipped_qty) VALUES
        (${orderItemId}::uuid,1,100,10,1000,${orderId}::uuid,${companyId}::uuid,
          ${materialId}::uuid,${unitId}::uuid,${'M' + suffix},${prefix + '物料'},${prefix + '件'},100,10,1000,0,100),
        (${orderItem2Id}::uuid,2,50,10,500,${orderId}::uuid,${companyId}::uuid,
          ${material2Id}::uuid,${unitId}::uuid,${'N' + suffix},${prefix + '物料二'},${prefix + '件'},50,10,500,0,50),
        (${zeroOrderItemId}::uuid,3,10,0,0,${orderId}::uuid,${companyId}::uuid,
          ${materialId}::uuid,${unitId}::uuid,${'M' + suffix},${prefix + '物料'},${prefix + '件'},10,0,0,0,10)
    `.execute(db)
    await sql`
      INSERT INTO sal_delivery(id,delivery_no,delivery_date,party_type,party_id,status,company_id,
        warehouse_id,debit_account_id,credit_account_id) VALUES
        (${deliveryId}::uuid,${prefix + '-SD'},'2026-07-25','customer',${customerId}::uuid,
          'audited',${companyId}::uuid,${warehouseId}::uuid,${creditAccountId}::uuid,${debitAccountId}::uuid),
        (${zeroDeliveryId}::uuid,${prefix + '-SZ'},'2026-07-26','customer',${customerId}::uuid,
          'audited',${companyId}::uuid,${warehouseId}::uuid,${creditAccountId}::uuid,${debitAccountId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sal_delivery_item(
        id,idx,qty,base_qty,material_code,material_name,unit_name,order_no,
        order_qty,order_base_qty,order_unit_name,order_price,order_amount,
        order_base_price,order_base_amount,order_tax_rate,order_currency_code,
        delivery_id,company_id,order_item_id,material_id,unit_id,warehouse_id,reconciled_qty
      ) VALUES
        (${deliveryItemId}::uuid,1,100,100,${'M' + suffix},${prefix + '物料'},${prefix + '件'},${prefix + '-SO'},
          100,100,${prefix + '件'},10,1000,10,1000,0,${'T' + suffix.slice(0, 2)},
          ${deliveryId}::uuid,${companyId}::uuid,${orderItemId}::uuid,${materialId}::uuid,${unitId}::uuid,${warehouseId}::uuid,0),
        (${deliveryItem2Id}::uuid,2,50,50,${'N' + suffix},${prefix + '物料二'},${prefix + '件'},${prefix + '-SO'},
          50,50,${prefix + '件'},10,500,10,500,0,${'T' + suffix.slice(0, 2)},
          ${deliveryId}::uuid,${companyId}::uuid,${orderItem2Id}::uuid,${material2Id}::uuid,${unitId}::uuid,${warehouseId}::uuid,0),
        (${zeroDeliveryItemId}::uuid,1,10,10,${'M' + suffix},${prefix + '物料'},${prefix + '件'},${prefix + '-SO'},
          10,10,${prefix + '件'},0,0,0,0,0,${'T' + suffix.slice(0, 2)},
          ${zeroDeliveryId}::uuid,${companyId}::uuid,${zeroOrderItemId}::uuid,${materialId}::uuid,${unitId}::uuid,${warehouseId}::uuid,0)
    `.execute(db)

    const existing = await db
      .selectFrom('sys_numbering_rule')
      .select('id')
      .where('resource', '=', 'sales.return')
      .where('enabled', '=', true)
      .executeTakeFirst()
    if (!existing) {
      const rule = await numbering.create(p('sysNumberingRules', 'create'), {
        resource: 'sales.return',
        name: `${prefix}退货规则`,
        segments: [
          { type: 'text', value: `T${suffix}-` },
          { type: 'seq', padding: 4 },
        ],
        perCompany: false,
        enabled: true,
      })
      createdRuleIds.push(rule.id)
    }
  })

  afterAll(async () => {
    for (const id of createdRuleIds) {
      await db.deleteFrom('sys_numbering_rule').where('id', '=', id).execute()
    }
    await sql`DELETE FROM acc_gl_entry WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM inv_stock_entry WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sys_audit_log WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_return WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_delivery WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_order_item WHERE order_id=${orderId}::uuid`.execute(db)
    await sql`DELETE FROM sal_order WHERE id=${orderId}::uuid`.execute(db)
    await sql`DELETE FROM bas_account WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM inv_warehouse WHERE id=${warehouseId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material WHERE id IN (${materialId}::uuid, ${material2Id}::uuid, ${virtualMaterialId}::uuid)`.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id=${categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id=${unitId}::uuid`.execute(db)
    await sql`DELETE FROM sal_customers WHERE id=${customerId}::uuid`.execute(db)
    await sql`DELETE FROM bas_company WHERE id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id IN (${currencyId}::uuid, ${currency2Id}::uuid)`.execute(db)
    await db.destroy()
  })

  async function deliveryItemRow(id: string) {
    const r = await sql<{ base_qty: string; returned_qty: string }>`
      SELECT base_qty::text, returned_qty::text FROM sal_delivery_item WHERE id=${id}::uuid
    `.execute(db)
    return r.rows[0]!
  }
  async function orderItemShipped(id: string) {
    const r = await sql<{ shipped_qty: string }>`
      SELECT shipped_qty::text FROM sal_order_item WHERE id=${id}::uuid
    `.execute(db)
    return r.rows[0]!.shipped_qty
  }
  async function stockEntries(voucherId: string) {
    const r = await sql<{
      warehouse_id: string
      material_id: string
      quantity: string
      is_cancelled: boolean
    }>`
      SELECT warehouse_id::text, material_id::text, quantity::text, is_cancelled
      FROM inv_stock_entry WHERE voucher_type='sales.return' AND voucher_id=${voucherId}::uuid
      ORDER BY seq
    `.execute(db)
    return r.rows
  }
  async function glEntries(voucherId: string) {
    const r = await sql<{
      account_id: string
      debit: string
      credit: string
      party_type: string | null
      party_id: string | null
      is_cancelled: boolean
    }>`
      SELECT account_id::text, debit::text, credit::text, party_type, party_id::text, is_cancelled
      FROM acc_gl_entry WHERE voucher_type='sales.return' AND voucher_id=${voucherId}::uuid
      ORDER BY seq
    `.execute(db)
    return r.rows
  }

  test('整单创建：源单行快照随发货条目带入并落审计', async () => {
    const draft = await returns.createDraft(
      p('salReturns', 'create'),
      'sales',
      draftInput([{ idx: 1, qty: '5', deliveryItemId }]),
    )
    expect(draft.returnNo.length).toBeGreaterThan(0)
    expect(draft.status).toBe('DRAFT')
    expect(draft.items).toHaveLength(1)
    const item = draft.items[0]!
    expect(item.returnId).toBe(draft.id)
    expect(item.deliveryItemId).toBe(deliveryItemId)
    expect(item.orderItemId).toBe(orderItemId)
    expect(item.materialId).toBe(materialId)
    expect(item.materialCode).toBe('M' + suffix)
    expect(item.orderNo).toBe(prefix + '-SO')
    expect(item.orderBaseAmount).toBe('1000')
    expect(item.orderCurrencyCode).toBe('T' + suffix.slice(0, 2))
    expect(item.reconciledQty).toBe('0')

    const loaded = await returns.getDraft(p('salReturns', 'read'), 'sales', draft.id)
    expect(loaded.items).toHaveLength(1)
  })

  test('审核：库存正向回库 + GL 销售发货反转 + 已退累加 + 已发回减', async () => {
    const draft = await returns.createDraft(
      p('salReturns', 'create'),
      'sales',
      draftInput([
        { idx: 1, qty: '10', deliveryItemId },
        { idx: 2, qty: '20', deliveryItemId: deliveryItem2Id },
      ]),
    )
    const audited = await returns.auditHead(p('salReturns', 'audit'), 'sales', draft.id)
    expect(audited.status).toBe('AUDITED')

    // 库存：两行正向回库分录
    const stock = await stockEntries(draft.id)
    expect(stock).toHaveLength(2)
    expect(stock[0]).toMatchObject({
      warehouse_id: warehouseId,
      material_id: materialId,
      is_cancelled: false,
    })
    expect(Number(stock[0]!.quantity)).toBe(10)
    expect(stock[1]).toMatchObject({
      warehouse_id: warehouseId,
      material_id: material2Id,
      is_cancelled: false,
    })
    expect(Number(stock[1]!.quantity)).toBe(20)

    // GL：金额 = 10×1000/100 + 20×500/50 = 100 + 200 = 300；借选定（不带对手）/贷未开票应收（带对手）
    const gl = await glEntries(draft.id)
    expect(gl).toHaveLength(2)
    expect(gl[0]).toMatchObject({
      account_id: debitAccountId,
      party_type: null,
      party_id: null,
      is_cancelled: false,
    })
    expect(Number(gl[0]!.debit)).toBe(300)
    expect(Number(gl[0]!.credit)).toBe(0)
    expect(gl[1]).toMatchObject({
      account_id: creditAccountId,
      party_type: 'customer',
      party_id: customerId,
      is_cancelled: false,
    })
    expect(Number(gl[1]!.debit)).toBe(0)
    expect(Number(gl[1]!.credit)).toBe(300)

    // 投影：发货条目已退累加；订单条目已发回减（缺口重现）
    expect((await deliveryItemRow(deliveryItemId)).returned_qty).toBe('10')
    expect((await deliveryItemRow(deliveryItem2Id)).returned_qty).toBe('20')
    expect(await orderItemShipped(orderItemId)).toBe('90')
    expect(await orderItemShipped(orderItem2Id)).toBe('30')
  })

  test('审核硬校验：退货量超剩余可退即整单拦截', async () => {
    // 行一剩余可退 = 100 − 10（上一测已退）= 90；退 95 超出
    const draft = await returns.createDraft(
      p('salReturns', 'create'),
      'sales',
      draftInput([{ idx: 1, qty: '95', deliveryItemId }]),
    )
    await expect(returns.auditHead(p('salReturns', 'audit'), 'sales', draft.id)).rejects.toThrow(
      /超出剩余可退数量/,
    )
    // 拦截后无任何副作用
    expect(await stockEntries(draft.id)).toHaveLength(0)
    expect((await deliveryItemRow(deliveryItemId)).returned_qty).toBe('10')
    expect(await orderItemShipped(orderItemId)).toBe('90')
  })

  test('作废：库存/总账分录作废 + 已退已发全量回滚', async () => {
    const draft = await returns.createDraft(
      p('salReturns', 'create'),
      'sales',
      draftInput([{ idx: 1, qty: '5', deliveryItemId }]),
    )
    await returns.auditHead(p('salReturns', 'audit'), 'sales', draft.id)
    expect((await deliveryItemRow(deliveryItemId)).returned_qty).toBe('15')
    expect(await orderItemShipped(orderItemId)).toBe('85')

    const voided = await returns.voidHead(p('salReturns', 'void'), 'sales', draft.id)
    expect(voided.status).toBe('VOIDED')

    const stock = await stockEntries(draft.id)
    expect(stock).toHaveLength(1)
    expect(stock[0]!.is_cancelled).toBe(true)
    const gl = await glEntries(draft.id)
    expect(gl.length).toBeGreaterThan(0)
    expect(gl.every((e) => e.is_cancelled)).toBe(true)
    expect((await deliveryItemRow(deliveryItemId)).returned_qty).toBe('10')
    expect(await orderItemShipped(orderItemId)).toBe('90')
  })

  test('作废拦截：任一条目已对账（reconciled_qty>0）不可作废', async () => {
    const draft = await returns.createDraft(
      p('salReturns', 'create'),
      'sales',
      draftInput([{ idx: 1, qty: '3', deliveryItemId }]),
    )
    await returns.auditHead(p('salReturns', 'audit'), 'sales', draft.id)
    // 模拟对账单生效占用（对账票未落地，手工置数）
    await sql`
      UPDATE sal_return_item SET reconciled_qty=1 WHERE return_id=${draft.id}::uuid
    `.execute(db)
    await expect(returns.voidHead(p('salReturns', 'void'), 'sales', draft.id)).rejects.toThrow(
      /存在已对账退货条目,不可作废/,
    )
    // 清理占用后照常识作废
    await sql`
      UPDATE sal_return_item SET reconciled_qty=0 WHERE return_id=${draft.id}::uuid
    `.execute(db)
    await returns.voidHead(p('salReturns', 'void'), 'sales', draft.id)
    expect((await deliveryItemRow(deliveryItemId)).returned_qty).toBe('10')
    expect(await orderItemShipped(orderItemId)).toBe('90')
  })

  test('零金额整单跳过总账（科目仍必填）；缺科目草稿保存即拦截', async () => {
    const draft = await returns.createDraft(
      p('salReturns', 'create'),
      'sales',
      draftInput([{ idx: 1, qty: '2', deliveryItemId: zeroDeliveryItemId }]),
    )
    const audited = await returns.auditHead(p('salReturns', 'audit'), 'sales', draft.id)
    expect(audited.status).toBe('AUDITED')
    expect(await glEntries(draft.id)).toHaveLength(0)
    const stock = await stockEntries(draft.id)
    expect(stock).toHaveLength(1)
    expect(Number(stock[0]!.quantity)).toBe(2)
    // 回滚保持账面：零金额行已退 2、已发 8
    expect((await deliveryItemRow(zeroDeliveryItemId)).returned_qty).toBe('2')
    expect(await orderItemShipped(zeroOrderItemId)).toBe('8')
    await returns.voidHead(p('salReturns', 'void'), 'sales', draft.id)

    // 贷方科目非未开票应收角色 → 草稿保存即拦截
    const roleError = await returns
      .createDraft(p('salReturns', 'create'), 'sales', {
        ...draftInput([{ idx: 1, qty: '1', deliveryItemId }]),
        creditAccountId: debitAccountId,
      })
      .catch((err: unknown) => err)
    expect(roleError).toBeInstanceOf(ApiError)
    expect((roleError as ApiError).code).toBe('validation')
    expect((roleError as ApiError).fields?.['header.creditAccountId']).toEqual([
      '科目角色须为未开票应收',
    ])
  })

  test('对手/公司不一致与未审核发货单在保存期拦截', async () => {
    // 草稿发货单（未审核）不可作源单
    const draftDeliveryId = crypto.randomUUID()
    const draftDeliveryItemId = crypto.randomUUID()
    await sql`
      INSERT INTO sal_delivery(id,delivery_no,delivery_date,party_type,party_id,status,company_id,
        warehouse_id,debit_account_id,credit_account_id)
      VALUES (${draftDeliveryId}::uuid,${prefix + '-DR'},'2026-07-27','customer',${customerId}::uuid,
        'draft',${companyId}::uuid,${warehouseId}::uuid,${creditAccountId}::uuid,${debitAccountId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sal_delivery_item(
        id,idx,qty,base_qty,material_code,material_name,unit_name,order_no,
        order_qty,order_base_qty,order_unit_name,order_price,order_amount,
        order_base_price,order_base_amount,order_tax_rate,order_currency_code,
        delivery_id,company_id,order_item_id,material_id,unit_id,warehouse_id,reconciled_qty
      ) VALUES
        (${draftDeliveryItemId}::uuid,1,1,1,${'M' + suffix},${prefix + '物料'},${prefix + '件'},${prefix + '-SO'},
          100,100,${prefix + '件'},10,1000,10,1000,0,${'T' + suffix.slice(0, 2)},
          ${draftDeliveryId}::uuid,${companyId}::uuid,${orderItemId}::uuid,${materialId}::uuid,${unitId}::uuid,${warehouseId}::uuid,0)
    `.execute(db)
    const statusError = await returns
      .createDraft(
        p('salReturns', 'create'),
        'sales',
        draftInput([{ idx: 1, qty: '1', deliveryItemId: draftDeliveryItemId }]),
      )
      .catch((err: unknown) => err)
    expect(statusError).toBeInstanceOf(ApiError)
    expect((statusError as ApiError).fields?.['items[0].deliveryItemId']).toEqual([
      '发货单须已审核未作废',
    ])
    await sql`DELETE FROM sal_delivery WHERE id=${draftDeliveryId}::uuid`.execute(db)
  })

  test('手工行：快照随物料冻结（订单号留空），缺省头原币/汇率按公司代入', async () => {
    const input = draftInput([{ idx: 1, qty: '4', deliveryItemId: null }])
    // 手工行：手填物料/价税；头不传原币与汇率 → 服务端按公司本币 + 1 代入
    const { currencyId: _omit, ...headNoCurrency } = input
    const draft = await returns.createDraft(p('salReturns', 'create'), 'sales', {
      ...headNoCurrency,
      items: [
        {
          idx: 1,
          qty: '4',
          deliveryItemId: null,
          materialId,
          orderPrice: '12.5',
          orderTaxRate: '0.13',
          warehouseId,
        },
      ],
    })
    expect(draft.currencyId).toBe(currencyId)
    expect(draft.exchangeRate).toBe('1')
    const item = draft.items[0]!
    expect(item.deliveryItemId).toBeNull()
    expect(item.materialCode).toBe('M' + suffix)
    expect(item.materialName).toBe(prefix + '物料')
    expect(item.unitName).toBe(prefix + '件')
    expect(item.orderNo).toBeNull()
    expect(item.orderItemId).toBeNull()
    expect(item.orderPrice).toBe('12.5')
    expect(item.orderTaxRate).toBe('0.13')
    expect(item.orderCurrencyCode).toBe('T' + suffix.slice(0, 2))
    // 剩余可对账口径对手工行 = 自身 base_qty − 已对账
    expect(item.baseQty).toBe('4')
    expect(item.reconciledQty).toBe('0')
    expect(item.remainingReconcilableQty).toBe('4')
  })

  test('手工行审核：库存回库 + GL 含手工行口径（价×汇率），不动任何订单投影', async () => {
    // 混合行：源单行（行二，余可退 30）退 5 → 5×500/50=50；手工行 4×12.5×汇率 2=100；合计 150
    const draft = await returns.createDraft(p('salReturns', 'create'), 'sales', {
      ...draftInput([]),
      exchangeRate: '2',
      items: [
        { idx: 1, qty: '5', deliveryItemId: deliveryItem2Id, warehouseId },
        {
          idx: 2,
          qty: '4',
          deliveryItemId: null,
          materialId,
          orderPrice: '12.5',
          orderTaxRate: '0.13',
          warehouseId,
        },
      ],
    })
    const shippedBefore = await orderItemShipped(orderItem2Id)
    const returnedBefore = (await deliveryItemRow(deliveryItem2Id)).returned_qty

    const audited = await returns.auditHead(p('salReturns', 'audit'), 'sales', draft.id)
    expect(audited.status).toBe('AUDITED')

    // 库存：两行（含手工行）正向回库
    const stock = await stockEntries(draft.id)
    expect(stock).toHaveLength(2)
    expect(stock.map((s) => Number(s.quantity)).sort((a, b) => a - b)).toEqual([4, 5])

    // GL：50 + 100 = 150
    const gl = await glEntries(draft.id)
    expect(gl).toHaveLength(2)
    expect(Number(gl[0]!.debit)).toBe(150)
    expect(Number(gl[1]!.credit)).toBe(150)

    // 源单行投影动；手工行无锚点不额外动（本单源行退 5）
    expect(await orderItemShipped(orderItem2Id)).toBe(String(Number(shippedBefore) - 5))
    expect((await deliveryItemRow(deliveryItem2Id)).returned_qty).toBe(
      String(Number(returnedBefore) + 5),
    )
    // 订单行一（本单未涉）保持
    expect(await orderItemShipped(orderItemId)).toBe('90')

    // 作废：手工行只回滚库存/总账，源单行投影还原
    await returns.voidHead(p('salReturns', 'void'), 'sales', draft.id)
    expect(await orderItemShipped(orderItem2Id)).toBe(shippedBefore)
    expect((await deliveryItemRow(deliveryItem2Id)).returned_qty).toBe(returnedBefore)
    const cancelledStock = await stockEntries(draft.id)
    expect(cancelledStock.every((s) => s.is_cancelled)).toBe(true)
  })

  test('混合行一致性：源行发货快照原币与单头原币不一致即拒绝', async () => {
    const err = await returns
      .createDraft(p('salReturns', 'create'), 'sales', {
        ...draftInput([]),
        currencyId: currency2Id,
        items: [
          { idx: 1, qty: '1', deliveryItemId, warehouseId },
          {
            idx: 2,
            qty: '1',
            deliveryItemId: null,
            materialId,
            orderPrice: '10',
            orderTaxRate: '0',
            warehouseId,
          },
        ],
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).fields?.['items[0].deliveryItemId']).toEqual([
      '发货条目原币与单头原币不一致',
    ])
  })

  test('手工行校验：缺物料/价/税拒绝；库存类缺行仓拒绝；虚拟物料行仓可空不写库存', async () => {
    const noMaterial = await returns
      .createDraft(p('salReturns', 'create'), 'sales', {
        ...draftInput([]),
        items: [
          {
            idx: 1,
            qty: '1',
            deliveryItemId: null,
            orderPrice: '10',
            orderTaxRate: '0',
            warehouseId,
          },
        ],
      })
      .catch((e: unknown) => e)
    expect((noMaterial as ApiError).fields?.['items[0].materialId']).toEqual(['必填'])

    const noWarehouse = await returns
      .createDraft(p('salReturns', 'create'), 'sales', {
        ...draftInput([]),
        items: [
          {
            idx: 1,
            qty: '1',
            deliveryItemId: null,
            materialId,
            orderPrice: '10',
            orderTaxRate: '0',
            warehouseId: null,
          },
        ],
      })
      .catch((e: unknown) => e)
    expect((noWarehouse as ApiError).fields?.['items[0].warehouseId']).toEqual([
      '库存类物料必须填写行仓',
    ])

    // 虚拟物料：行仓可空，审核不写库存分录但过总账
    const draft = await returns.createDraft(p('salReturns', 'create'), 'sales', {
      ...draftInput([]),
      items: [
        {
          idx: 1,
          qty: '2',
          deliveryItemId: null,
          materialId: virtualMaterialId,
          orderPrice: '30',
          orderTaxRate: '0',
          warehouseId: null,
        },
      ],
    })
    await returns.auditHead(p('salReturns', 'audit'), 'sales', draft.id)
    expect(await stockEntries(draft.id)).toHaveLength(0)
    const gl = await glEntries(draft.id)
    expect(gl).toHaveLength(2)
    expect(Number(gl[0]!.debit)).toBe(60)
    await returns.voidHead(p('salReturns', 'void'), 'sales', draft.id)
  })

  test('已有条目时不可修改单头原币', async () => {
    const draft = await returns.createDraft(
      p('salReturns', 'create'),
      'sales',
      draftInput([{ idx: 1, qty: '1', deliveryItemId }]),
    )
    const err = await returns
      .replaceDraft(p('salReturns', 'update'), 'sales', draft.id, {
        ...draftInput([{ idx: 1, qty: '1', deliveryItemId, id: draft.items[0]!.id }]),
        no: draft.returnNo,
        currencyId: currency2Id,
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).fields?.['header.currencyId']).toEqual(['已有条目时不可修改'])
  })

  test('HTTP：整单三连与条目只读面、无权限 fail-closed', async () => {
    const headers = { authorization: 'Bearer test', 'content-type': 'application/json' }
    const input = draftInput([{ idx: 1, qty: '1', deliveryItemId }])
    const { documentDate: returnDate, ...wire } = input
    const createdResponse = await http.request('/api/v1/sales/returns', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...wire, returnDate }),
    })
    expect(createdResponse.status).toBe(201)
    const created = (await createdResponse.json()) as {
      id: string
      returnNo: string
      items: Array<{ id: string }>
    }
    expect(created.returnNo.length).toBeGreaterThan(0)

    const loadedResponse = await http.request(`/api/v1/sales/returns/${created.id}/draft`, {
      headers: { authorization: 'Bearer test' },
    })
    expect(loadedResponse.status).toBe(200)

    const queryResponse = await http.request('/api/v1/sales/return-items/query', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        limit: 10,
        offset: 0,
        filter: { returnId: { kind: 'fk', op: 'in', values: [created.id], labels: [] } },
      }),
    })
    expect(queryResponse.status).toBe(200)
    const queried = (await queryResponse.json()) as { count: number }
    expect(queried.count).toBe(1)

    // 子资源无独立写入口
    expect(
      (await http.request('/api/v1/sales/return-items', {
        method: 'POST',
        headers,
        body: '{}',
      })).status,
    ).toBe(404)

    const denied = await http.request(`/api/v1/sales/returns/${created.id}/draft`, {
      headers: { authorization: 'Bearer no-read' },
    })
    expect(denied.status).toBe(403)
  })
})
