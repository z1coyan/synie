/**
 * 采购退货 PG 集成：整单草稿 + 审核（出仓/GL 反转/已退已收投影/需求行不反转）+ 作废回滚 + 拦截。
 * 门控 SYNIE_TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { createInventoryEngine } from '~/engines/inventory/index.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { Actor } from '~/platform/authz/core/index.ts'
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

run('PG 集成（采购退货）', () => {
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
  const prefix = `PT${suffix}`

  const currencyId = crypto.randomUUID()
  const currency2Id = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const supplierId = crypto.randomUUID()
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
  const receiptId = crypto.randomUUID()
  const receiptItemId = crypto.randomUUID()
  const receiptItem2Id = crypto.randomUUID()
  // 需求链夹具：订单条目三挂需求行（已收 5、已完成）
  const demandId = crypto.randomUUID()
  const demandItemId = crypto.randomUUID()
  const orderItem3Id = crypto.randomUUID()
  const receiptItem3Id = crypto.randomUUID()

  const actor: Actor = testActor({
    userId: '',
    username: 'pur-return-test',
    name: '采购退货测试',
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })
  function p(resource: string, action: string, who: Actor = actor) {
    const decision = authz.decideFor(who, resource, action)
    if (decision.outcome !== 'permit') {
      throw new Error(`夹具应当 permit: ${resource}:${action}`)
    }
    return decision.permit
  }
  const auth = {
    authenticate: async (_token: string) => actor,
    authenticateRequest: async (_headers: Headers) => actor,
  } as unknown as AuthService
  const http = new Hono<AppEnv>()
    .route('/api/v1/purchase/returns', returnHeadRoutes({ auth, authz, returns, side: 'purchase' }))
    .route('/api/v1/purchase/return-items', returnItemRoutes({ auth, authz, returns, side: 'purchase' }))
  http.onError(onError)

  function draftInput(
    items: Array<{
      id?: string
      idx: number
      qty: string
      receiptItemId?: string | null
      materialId?: string | null
      orderPrice?: string | null
      orderTaxRate?: string | null
      warehouseId?: string | null
      remarks?: string | null
    }>,
    remarks: string | null = null,
  ): ReturnDraftInput {
    return {
      companyId,
      documentDate: '2026-08-10',
      postingDate: '2026-08-10',
      partyType: 'supplier',
      partyId: supplierId,
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
      VALUES (${currencyId}::uuid, ${prefix + '币'}, ${'U' + suffix.slice(0, 2)}, '¤', true),
        (${currency2Id}::uuid, ${prefix + '外币'}, ${'X' + suffix.slice(0, 2)}, 'ξ', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
      VALUES (${companyId}::uuid, ${'U' + suffix}, ${prefix + '公司'}, 'PT', ${currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO pur_supplier(id,code,name,short_name)
      VALUES (${supplierId}::uuid, ${'SU' + suffix}, ${prefix + '供应商'}, 'SU')
    `.execute(db)
    await sql`
      INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
      VALUES (${unitId}::uuid, ${'pt-' + suffix}, true, ${prefix + '件'}, ${'u' + suffix.slice(0, 8)}, 1)
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
        (${debitAccountId}::uuid, ${'UD' + suffix}, ${prefix + '未开应付'}, 'debit', false, true, ${companyId}::uuid, ${currencyId}::uuid, 'unbilled_payable'),
        (${creditAccountId}::uuid, ${'UC' + suffix}, ${prefix + '采贷'}, 'credit', false, true, ${companyId}::uuid, ${currencyId}::uuid, NULL)
    `.execute(db)
    await sql`
      INSERT INTO pur_order(id,order_no,order_date,party_type,party_id,status,company_id,exchange_rate,currency_id,is_outsourced)
      VALUES (${orderId}::uuid, ${prefix + '-PO'}, '2026-07-20', 'supplier', ${supplierId}::uuid,
        'audited', ${companyId}::uuid, 1, ${currencyId}::uuid, false)
    `.execute(db)
    // 需求行：已收 5、已完成（采购退货回减不反转）
    await sql`
      INSERT INTO mfg_demand(id,demand_no,demand_date,status,company_id,assign_type)
      VALUES (${demandId}::uuid, ${prefix + '-MD'}, '2026-07-19', 'confirmed', ${companyId}::uuid, 'purchase')
    `.execute(db)
    await sql`
      INSERT INTO mfg_demand_item(id,idx,qty,base_qty,need_date,status,demand_id,company_id,
        material_id,unit_id,received_qty,completed_qty)
      VALUES (${demandItemId}::uuid,1,5,5,'2026-08-01','completed',${demandId}::uuid,${companyId}::uuid,
        ${materialId}::uuid,${unitId}::uuid,5,5)
    `.execute(db)
    // 已收数量投影：行一/行二全收；行三挂需求行、已收 5
    await sql`
      INSERT INTO pur_order_item(id,idx,qty,price,amount,order_id,company_id,material_id,unit_id,
        material_code,material_name,unit_name,base_qty,base_price,base_amount,tax_rate,received_qty,demand_line_id) VALUES
        (${orderItemId}::uuid,1,100,10,1000,${orderId}::uuid,${companyId}::uuid,
          ${materialId}::uuid,${unitId}::uuid,${'M' + suffix},${prefix + '物料'},${prefix + '件'},100,10,1000,0,100,NULL),
        (${orderItem2Id}::uuid,2,50,10,500,${orderId}::uuid,${companyId}::uuid,
          ${material2Id}::uuid,${unitId}::uuid,${'N' + suffix},${prefix + '物料二'},${prefix + '件'},50,10,500,0,50,NULL),
        (${orderItem3Id}::uuid,3,5,10,50,${orderId}::uuid,${companyId}::uuid,
          ${materialId}::uuid,${unitId}::uuid,${'M' + suffix},${prefix + '物料'},${prefix + '件'},5,10,50,0,5,${demandItemId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO pur_receipt(id,receipt_no,receipt_date,party_type,party_id,status,company_id,
        warehouse_id,debit_account_id,credit_account_id)
      VALUES (${receiptId}::uuid,${prefix + '-PR'},'2026-07-25','supplier',${supplierId}::uuid,
        'audited',${companyId}::uuid,${warehouseId}::uuid,${debitAccountId}::uuid,${creditAccountId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO pur_receipt_item(
        id,idx,qty,base_qty,material_code,material_name,unit_name,order_no,
        order_qty,order_base_qty,order_unit_name,order_price,order_amount,
        order_base_price,order_base_amount,order_tax_rate,order_currency_code,
        receipt_id,company_id,order_item_id,material_id,unit_id,warehouse_id,reconciled_qty
      ) VALUES
        (${receiptItemId}::uuid,1,100,100,${'M' + suffix},${prefix + '物料'},${prefix + '件'},${prefix + '-PO'},
          100,100,${prefix + '件'},10,1000,10,1000,0,${'U' + suffix.slice(0, 2)},
          ${receiptId}::uuid,${companyId}::uuid,${orderItemId}::uuid,${materialId}::uuid,${unitId}::uuid,${warehouseId}::uuid,0),
        (${receiptItem2Id}::uuid,2,50,50,${'N' + suffix},${prefix + '物料二'},${prefix + '件'},${prefix + '-PO'},
          50,50,${prefix + '件'},10,500,10,500,0,${'U' + suffix.slice(0, 2)},
          ${receiptId}::uuid,${companyId}::uuid,${orderItem2Id}::uuid,${material2Id}::uuid,${unitId}::uuid,${warehouseId}::uuid,0),
        (${receiptItem3Id}::uuid,3,5,5,${'M' + suffix},${prefix + '物料'},${prefix + '件'},${prefix + '-PO'},
          5,5,${prefix + '件'},10,50,10,50,0,${'U' + suffix.slice(0, 2)},
          ${receiptId}::uuid,${companyId}::uuid,${orderItem3Id}::uuid,${materialId}::uuid,${unitId}::uuid,${warehouseId}::uuid,0)
    `.execute(db)
    // 出仓负库存校验需要先有结存
    await sql`
      INSERT INTO inv_stock_entry(id,company_id,warehouse_id,material_id,quantity,
        posting_date,voucher_type,voucher_id,voucher_no)
      VALUES (${crypto.randomUUID()}::uuid, ${companyId}::uuid, ${warehouseId}::uuid, ${materialId}::uuid,
        100000, now(), 'test.seed', ${crypto.randomUUID()}::uuid, ${prefix + '-SEED1'}),
        (${crypto.randomUUID()}::uuid, ${companyId}::uuid, ${warehouseId}::uuid, ${material2Id}::uuid,
        100000, now(), 'test.seed', ${crypto.randomUUID()}::uuid, ${prefix + '-SEED2'})
    `.execute(db)

    const existing = await db
      .selectFrom('sys_numbering_rule')
      .select('id')
      .where('resource', '=', 'purchase.return')
      .where('enabled', '=', true)
      .executeTakeFirst()
    if (!existing) {
      const rule = await numbering.create(p('sysNumberingRules', 'create'), {
        resource: 'purchase.return',
        name: `${prefix}退货规则`,
        segments: [
          { type: 'text', value: `U${suffix}-` },
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
    await sql`DELETE FROM pur_return WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_receipt WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_order_item WHERE order_id=${orderId}::uuid`.execute(db)
    await sql`DELETE FROM pur_order WHERE id=${orderId}::uuid`.execute(db)
    await sql`DELETE FROM mfg_demand_item WHERE demand_id=${demandId}::uuid`.execute(db)
    await sql`DELETE FROM mfg_demand WHERE id=${demandId}::uuid`.execute(db)
    await sql`DELETE FROM bas_account WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM inv_warehouse WHERE id=${warehouseId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material WHERE id IN (${materialId}::uuid, ${material2Id}::uuid, ${virtualMaterialId}::uuid)`.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id=${categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id=${unitId}::uuid`.execute(db)
    await sql`DELETE FROM pur_supplier WHERE id=${supplierId}::uuid`.execute(db)
    await sql`DELETE FROM bas_company WHERE id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id IN (${currencyId}::uuid, ${currency2Id}::uuid)`.execute(db)
    await db.destroy()
  })

  async function receiptItemRow(id: string) {
    const r = await sql<{ base_qty: string; returned_qty: string }>`
      SELECT base_qty::text, returned_qty::text FROM pur_receipt_item WHERE id=${id}::uuid
    `.execute(db)
    return r.rows[0]!
  }
  async function orderItemReceived(id: string) {
    const r = await sql<{ received_qty: string }>`
      SELECT received_qty::text FROM pur_order_item WHERE id=${id}::uuid
    `.execute(db)
    return r.rows[0]!.received_qty
  }
  async function demandItemRow() {
    const r = await sql<{ received_qty: string; status: string }>`
      SELECT received_qty::text, status FROM mfg_demand_item WHERE id=${demandItemId}::uuid
    `.execute(db)
    return r.rows[0]!
  }
  async function stockEntries(voucherId: string) {
    const r = await sql<{
      warehouse_id: string
      material_id: string
      quantity: string
      is_cancelled: boolean
    }>`
      SELECT warehouse_id::text, material_id::text, quantity::text, is_cancelled
      FROM inv_stock_entry WHERE voucher_type='purchase.return' AND voucher_id=${voucherId}::uuid
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
      FROM acc_gl_entry WHERE voucher_type='purchase.return' AND voucher_id=${voucherId}::uuid
      ORDER BY seq
    `.execute(db)
    return r.rows
  }

  test('审核：库存负向出仓 + GL 采购入库反转 + 已退累加 + 已收回减；需求行不反转', async () => {
    const draft = await returns.createDraft(p('purReturns', 'create'), 'purchase', draftInput([
      { idx: 1, qty: '10', receiptItemId },
      { idx: 2, qty: '20', receiptItemId: receiptItem2Id },
      { idx: 3, qty: '2', receiptItemId: receiptItem3Id },
    ]))
    expect(draft.returnNo.length).toBeGreaterThan(0)
    expect(draft.items[0]!.orderItemId).toBe(orderItemId)
    expect(draft.items[0]!.orderNo).toBe(prefix + '-PO')

    const audited = await returns.auditHead(p('purReturns', 'audit'), 'purchase', draft.id)
    expect(audited.status).toBe('AUDITED')

    // 库存：三行负向出仓分录
    const stock = await stockEntries(draft.id)
    expect(stock).toHaveLength(3)
    expect(stock.map((s) => Number(s.quantity)).sort((a, b) => a - b)).toEqual([-20, -10, -2])
    expect(stock.every((s) => !s.is_cancelled)).toBe(true)

    // GL：金额 = 10×1000/100 + 20×500/50 + 2×50/5 = 100+200+20 = 320；
    // 借未开票应付（带对手）/ 贷选定科目
    const gl = await glEntries(draft.id)
    expect(gl).toHaveLength(2)
    expect(gl[0]).toMatchObject({
      account_id: debitAccountId,
      party_type: 'supplier',
      party_id: supplierId,
      is_cancelled: false,
    })
    expect(Number(gl[0]!.debit)).toBe(320)
    expect(Number(gl[0]!.credit)).toBe(0)
    expect(gl[1]).toMatchObject({
      account_id: creditAccountId,
      party_type: null,
      party_id: null,
      is_cancelled: false,
    })
    expect(Number(gl[1]!.credit)).toBe(320)

    // 投影：入库条目已退累加；订单条目已收回减
    expect((await receiptItemRow(receiptItemId)).returned_qty).toBe('10')
    expect((await receiptItemRow(receiptItem2Id)).returned_qty).toBe('20')
    expect((await receiptItemRow(receiptItem3Id)).returned_qty).toBe('2')
    expect(await orderItemReceived(orderItemId)).toBe('90')
    expect(await orderItemReceived(orderItem2Id)).toBe('30')
    expect(await orderItemReceived(orderItem3Id)).toBe('3')

    // 需求行不反转：已收/已完成纹丝不动
    const demand = await demandItemRow()
    expect(demand.received_qty).toBe('5')
    expect(demand.status).toBe('completed')
  })

  test('审核硬校验：退货量超剩余可退即整单拦截', async () => {
    // 行一剩余可退 = 100 − 10 = 90；退 95 超出
    const draft = await returns.createDraft(p('purReturns', 'create'), 'purchase', draftInput([
      { idx: 1, qty: '95', receiptItemId },
    ]))
    await expect(returns.auditHead(p('purReturns', 'audit'), 'purchase', draft.id)).rejects.toThrow(
      /超出剩余可退数量/,
    )
    expect(await stockEntries(draft.id)).toHaveLength(0)
    expect((await receiptItemRow(receiptItemId)).returned_qty).toBe('10')
    expect(await orderItemReceived(orderItemId)).toBe('90')
  })

  test('作废：库存/总账分录作废 + 已退已收全量回滚（需求行仍不反转）', async () => {
    const draft = await returns.createDraft(p('purReturns', 'create'), 'purchase', draftInput([
      { idx: 1, qty: '5', receiptItemId },
      { idx: 2, qty: '1', receiptItemId: receiptItem3Id },
    ]))
    await returns.auditHead(p('purReturns', 'audit'), 'purchase', draft.id)
    expect((await receiptItemRow(receiptItemId)).returned_qty).toBe('15')
    expect(await orderItemReceived(orderItemId)).toBe('85')
    expect(await orderItemReceived(orderItem3Id)).toBe('2')

    const voided = await returns.voidHead(p('purReturns', 'void'), 'purchase', draft.id)
    expect(voided.status).toBe('VOIDED')

    const stock = await stockEntries(draft.id)
    expect(stock.length).toBeGreaterThan(0)
    expect(stock.every((s) => s.is_cancelled)).toBe(true)
    const gl = await glEntries(draft.id)
    expect(gl.every((e) => e.is_cancelled)).toBe(true)
    expect((await receiptItemRow(receiptItemId)).returned_qty).toBe('10')
    expect(await orderItemReceived(orderItemId)).toBe('90')
    expect(await orderItemReceived(orderItem3Id)).toBe('3')
    const demand = await demandItemRow()
    expect(demand.received_qty).toBe('5')
    expect(demand.status).toBe('completed')
  })

  test('作废拦截：任一条目已对账（reconciled_qty>0）不可作废', async () => {
    const draft = await returns.createDraft(p('purReturns', 'create'), 'purchase', draftInput([
      { idx: 1, qty: '3', receiptItemId },
    ]))
    await returns.auditHead(p('purReturns', 'audit'), 'purchase', draft.id)
    await sql`
      UPDATE pur_return_item SET reconciled_qty=1 WHERE return_id=${draft.id}::uuid
    `.execute(db)
    await expect(returns.voidHead(p('purReturns', 'void'), 'purchase', draft.id)).rejects.toThrow(
      /存在已对账退货条目,不可作废/,
    )
    await sql`
      UPDATE pur_return_item SET reconciled_qty=0 WHERE return_id=${draft.id}::uuid
    `.execute(db)
    await returns.voidHead(p('purReturns', 'void'), 'purchase', draft.id)
    expect((await receiptItemRow(receiptItemId)).returned_qty).toBe('10')
  })

  test('手工行：手填价税过账 + 混合行原币一致性 + 虚拟物料不写库存', async () => {
    // 手工行 4×12.5×汇率 2 = 100；源单行 5×1000/100=50；合计 150
    const draft = await returns.createDraft(p('purReturns', 'create'), 'purchase', {
      ...draftInput([]),
      exchangeRate: '2',
      items: [
        { idx: 1, qty: '5', receiptItemId, warehouseId },
        {
          idx: 2,
          qty: '4',
          receiptItemId: null,
          materialId,
          orderPrice: '12.5',
          orderTaxRate: '0.13',
          warehouseId,
        },
        {
          idx: 3,
          qty: '2',
          receiptItemId: null,
          materialId: virtualMaterialId,
          orderPrice: '30',
          orderTaxRate: '0',
          warehouseId: null,
        },
      ],
    })
    const manual = draft.items.find((i) => i.receiptItemId == null && i.materialId === materialId)!
    expect(manual.materialCode).toBe('M' + suffix)
    expect(manual.orderNo).toBeNull()
    expect(manual.orderCurrencyCode).toBe('U' + suffix.slice(0, 2))

    const receivedBefore = await orderItemReceived(orderItemId)
    await returns.auditHead(p('purReturns', 'audit'), 'purchase', draft.id)
    // 库存：两行库存类出仓（虚拟行不写）；GL：50+100+2×30×2=270
    const stock = await stockEntries(draft.id)
    expect(stock).toHaveLength(2)
    const gl = await glEntries(draft.id)
    expect(gl).toHaveLength(2)
    expect(Number(gl[0]!.debit)).toBe(270)
    // 手工行不动投影：行一已收仅回减源行 5
    expect(await orderItemReceived(orderItemId)).toBe(String(Number(receivedBefore) - 5))
    await returns.voidHead(p('purReturns', 'void'), 'purchase', draft.id)

    // 混合行原币不一致：源行快照原币 ≠ 单头原币 → 拒
    const err = await returns
      .createDraft(p('purReturns', 'create'), 'purchase', {
        ...draftInput([]),
        currencyId: currency2Id,
        items: [
          { idx: 1, qty: '1', receiptItemId, warehouseId },
          {
            idx: 2,
            qty: '1',
            receiptItemId: null,
            materialId,
            orderPrice: '10',
            orderTaxRate: '0',
            warehouseId,
          },
        ],
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).fields?.['items[0].receiptItemId']).toEqual([
      '入库条目原币与单头原币不一致',
    ])
  })

  test('借方科目非未开票应付角色 → 草稿保存即拦截', async () => {
    const err = await returns
      .createDraft(p('purReturns', 'create'), 'purchase', {
        ...draftInput([{ idx: 1, qty: '1', receiptItemId }]),
        debitAccountId: creditAccountId,
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).fields?.['header.debitAccountId']).toEqual([
      '科目角色须为未开票应付',
    ])
  })

  test('HTTP：整单三连与条目只读面', async () => {
    const headers = { authorization: 'Bearer test', 'content-type': 'application/json' }
    const input = draftInput([{ idx: 1, qty: '1', receiptItemId }])
    const { documentDate: returnDate, ...wire } = input
    const createdResponse = await http.request('/api/v1/purchase/returns', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...wire, returnDate }),
    })
    expect(createdResponse.status).toBe(201)
    const created = (await createdResponse.json()) as { id: string; returnNo: string }
    expect(created.returnNo.length).toBeGreaterThan(0)

    const queryResponse = await http.request('/api/v1/purchase/return-items/query', {
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
  })
})
