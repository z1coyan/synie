/**
 * 委外退货 PG 集成：纯数量单——审核出仓/已退已收投影、无总账、已对账拦截（真实对账确认链路）、
 * 超剩余可退、作废回滚、手工行（仅物料/单位/数量/行仓）。
 * 门控 SYNIE_TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { createInventoryEngine } from '~/engines/inventory/index.ts'
import type { Actor } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { createReconciliationService } from '../reconciliation/service.ts'
import { createReturnsService, type ReturnDraftInput } from './service.ts'

/** 编号服务与授权判定共用同一份 sealed registry（授权归宿解析） */
const registry = createSealedResourceRegistry()
const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（委外退货）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db, buildNumberingCatalog(registry), registry)
  const authz = createAuthzEnforcer(registry)
  const gl = createGlEngine()
  const returns = createReturnsService(
    db,
    numbering,
    { inventory: createInventoryEngine(), gl },
    registry,
  )
  const reconciliations = createReconciliationService(db, numbering, gl, registry)
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const prefix = `OT${suffix}`

  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const supplierId = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const material2Id = crypto.randomUUID()
  const warehouseId = crypto.randomUUID()
  const outsourcedWarehouseId = crypto.randomUUID()
  const receiptDebitId = crypto.randomUUID()
  const receiptCreditId = crypto.randomUUID()
  const reconDebitId = crypto.randomUUID()
  const reconCreditId = crypto.randomUUID()
  const orderId = crypto.randomUUID()
  const orderItemId = crypto.randomUUID()
  const orderItem2Id = crypto.randomUUID()
  const receiptId = crypto.randomUUID()
  const receiptItemId = crypto.randomUUID()
  const receiptItem2Id = crypto.randomUUID()

  const actor: Actor = testActor({
    userId: '',
    username: 'out-return-test',
    name: '委外退货测试',
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

  function draftInput(
    items: Array<{
      id?: string
      idx: number
      qty: string
      outsourcedReceiptItemId?: string | null
      materialId?: string | null
      unitId?: string | null
      warehouseId?: string | null
      remarks?: string | null
    }>,
  ): ReturnDraftInput {
    return {
      companyId,
      documentDate: '2026-08-10',
      partyType: 'supplier',
      partyId: supplierId,
      items: items.map((i) => ({ warehouseId: warehouseId, ...i })),
    }
  }

  const createdRuleIds: string[] = []

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${currencyId}::uuid, ${prefix + '币'}, ${'V' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
      VALUES (${companyId}::uuid, ${'J' + suffix}, ${prefix + '公司'}, 'OT', ${currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO pur_supplier(id,code,name,short_name)
      VALUES (${supplierId}::uuid, ${'SU' + suffix}, ${prefix + '协作方'}, 'SU')
    `.execute(db)
    await sql`
      INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
      VALUES (${unitId}::uuid, ${'ot-' + suffix}, true, ${prefix + '件'}, ${'u' + suffix.slice(0, 8)}, 1)
    `.execute(db)
    await sql`
      INSERT INTO inv_material_category(id,code,name,is_leaf,active)
      VALUES (${categoryId}::uuid, ${'MC' + suffix}, ${prefix + '分类'}, true, true)
    `.execute(db)
    await sql`
      INSERT INTO inv_material(id,code,name,category_id,default_unit_id,active,material_type) VALUES
        (${materialId}::uuid, ${'M' + suffix}, ${prefix + '成品'}, ${categoryId}::uuid, ${unitId}::uuid, true, 'STOCK'),
        (${material2Id}::uuid, ${'N' + suffix}, ${prefix + '成品二'}, ${categoryId}::uuid, ${unitId}::uuid, true, 'STOCK')
    `.execute(db)
    await sql`
      INSERT INTO inv_warehouse(id,name,code,company_id,active,is_leaf) VALUES
        (${warehouseId}::uuid, ${prefix + '仓'}, ${'W' + suffix}, ${companyId}::uuid, true, true),
        (${outsourcedWarehouseId}::uuid, ${prefix + '外协仓'}, ${'WO' + suffix}, ${companyId}::uuid, true, true)
    `.execute(db)
    await sql`
      INSERT INTO bas_account(id,code,name,direction,is_group,active,company_id,currency_id,role) VALUES
        (${receiptDebitId}::uuid, ${'OD' + suffix}, ${prefix + '委外借'}, 'debit', false, true, ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${receiptCreditId}::uuid, ${'OC' + suffix}, ${prefix + '委外贷'}, 'credit', false, true, ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${reconDebitId}::uuid, ${'RD' + suffix}, ${prefix + '未开应付'}, 'debit', false, true, ${companyId}::uuid, ${currencyId}::uuid, 'unbilled_payable'),
        (${reconCreditId}::uuid, ${'RC' + suffix}, ${prefix + '采贷'}, 'credit', false, true, ${companyId}::uuid, ${currencyId}::uuid, NULL)
    `.execute(db)
    await sql`
      INSERT INTO pur_order(id,order_no,order_date,party_type,party_id,status,company_id,exchange_rate,currency_id,is_outsourced)
      VALUES (${orderId}::uuid, ${prefix + '-PO'}, '2026-07-20', 'supplier', ${supplierId}::uuid,
        'audited', ${companyId}::uuid, 1, ${currencyId}::uuid, true)
    `.execute(db)
    // 已收数量投影：两行全收
    await sql`
      INSERT INTO pur_order_item(id,idx,qty,price,amount,order_id,company_id,material_id,unit_id,
        material_code,material_name,unit_name,base_qty,base_price,base_amount,tax_rate,received_qty) VALUES
        (${orderItemId}::uuid,1,100,10,1000,${orderId}::uuid,${companyId}::uuid,
          ${materialId}::uuid,${unitId}::uuid,${'M' + suffix},${prefix + '成品'},${prefix + '件'},100,10,1000,0,100),
        (${orderItem2Id}::uuid,2,50,10,500,${orderId}::uuid,${companyId}::uuid,
          ${material2Id}::uuid,${unitId}::uuid,${'N' + suffix},${prefix + '成品二'},${prefix + '件'},50,10,500,0,50)
    `.execute(db)
    await sql`
      INSERT INTO pur_outsourced_receipt(id,receipt_no,receipt_date,party_type,party_id,status,company_id,
        warehouse_id,outsourced_warehouse_id,debit_account_id,credit_account_id)
      VALUES (${receiptId}::uuid,${prefix + '-OR'},'2026-07-25','supplier',${supplierId}::uuid,
        'audited',${companyId}::uuid,${warehouseId}::uuid,${outsourcedWarehouseId}::uuid,
        ${receiptDebitId}::uuid,${receiptCreditId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO pur_outsourced_receipt_item(
        id,idx,qty,base_qty,material_code,material_name,unit_name,order_no,
        order_qty,order_base_qty,order_unit_name,order_price,order_amount,
        order_base_price,order_base_amount,order_tax_rate,order_currency_code,
        receipt_id,company_id,order_item_id,material_id,unit_id,warehouse_id,reconciled_qty
      ) VALUES
        (${receiptItemId}::uuid,1,100,100,${'M' + suffix},${prefix + '成品'},${prefix + '件'},${prefix + '-PO'},
          100,100,${prefix + '件'},10,1000,10,1000,0,${'V' + suffix.slice(0, 2)},
          ${receiptId}::uuid,${companyId}::uuid,${orderItemId}::uuid,${materialId}::uuid,${unitId}::uuid,${warehouseId}::uuid,0),
        (${receiptItem2Id}::uuid,2,50,50,${'N' + suffix},${prefix + '成品二'},${prefix + '件'},${prefix + '-PO'},
          50,50,${prefix + '件'},10,500,10,500,0,${'V' + suffix.slice(0, 2)},
          ${receiptId}::uuid,${companyId}::uuid,${orderItem2Id}::uuid,${material2Id}::uuid,${unitId}::uuid,${warehouseId}::uuid,0)
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

    for (const [resource, tag] of [
      ['purchase.outsourced_return', 'OT'],
      ['purchase.reconciliation', 'RC'],
    ] as const) {
      const existing = await db
        .selectFrom('sys_numbering_rule')
        .select('id')
        .where('resource', '=', resource)
        .where('enabled', '=', true)
        .executeTakeFirst()
      if (!existing) {
        const rule = await numbering.create(p('sysNumberingRules', 'create'), {
          resource,
          name: `${prefix}${tag}规则`,
          segments: [
            { type: 'text', value: `V${suffix}${tag}-` },
            { type: 'seq', padding: 4 },
          ],
          perCompany: false,
          enabled: true,
        })
        createdRuleIds.push(rule.id)
      }
    }
  })

  afterAll(async () => {
    for (const id of createdRuleIds) {
      await db.deleteFrom('sys_numbering_rule').where('id', '=', id).execute()
    }
    await sql`DELETE FROM sys_todo WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_gl_entry WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM inv_stock_entry WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sys_audit_log WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_reconciliation WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_outsourced_return WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_outsourced_receipt WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_order_item WHERE order_id=${orderId}::uuid`.execute(db)
    await sql`DELETE FROM pur_order WHERE id=${orderId}::uuid`.execute(db)
    await sql`DELETE FROM bas_account WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM inv_warehouse WHERE id IN (${warehouseId}::uuid, ${outsourcedWarehouseId}::uuid)`.execute(db)
    await sql`DELETE FROM inv_material WHERE id IN (${materialId}::uuid, ${material2Id}::uuid)`.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id=${categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id=${unitId}::uuid`.execute(db)
    await sql`DELETE FROM pur_supplier WHERE id=${supplierId}::uuid`.execute(db)
    await sql`DELETE FROM bas_company WHERE id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id=${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  async function receiptItemRow(id: string) {
    const r = await sql<{ base_qty: string; returned_qty: string; reconciled_qty: string }>`
      SELECT base_qty::text, returned_qty::text, reconciled_qty::text
      FROM pur_outsourced_receipt_item WHERE id=${id}::uuid
    `.execute(db)
    return r.rows[0]!
  }
  async function orderItemReceived(id: string) {
    const r = await sql<{ received_qty: string }>`
      SELECT received_qty::text FROM pur_order_item WHERE id=${id}::uuid
    `.execute(db)
    return r.rows[0]!.received_qty
  }
  async function stockEntries(voucherId: string) {
    const r = await sql<{
      warehouse_id: string
      material_id: string
      quantity: string
      is_cancelled: boolean
    }>`
      SELECT warehouse_id::text, material_id::text, quantity::text, is_cancelled
      FROM inv_stock_entry
      WHERE voucher_type='purchase.outsourced_return' AND voucher_id=${voucherId}::uuid
      ORDER BY seq
    `.execute(db)
    return r.rows
  }

  test('审核：成品负向出仓 + 已退累加 + 已收回减；无任何总账分录', async () => {
    const draft = await returns.createDraft(p('purOutsourcedReturns', 'create'), 'outsourced', draftInput([
      { idx: 1, qty: '10', outsourcedReceiptItemId: receiptItemId },
      { idx: 2, qty: '20', outsourcedReceiptItemId: receiptItem2Id },
    ]))
    expect(draft.returnNo.length).toBeGreaterThan(0)
    // 纯数量单：无科目/原币/过账日期
    expect(draft.debitAccountId).toBeNull()
    expect(draft.currencyId).toBeNull()
    expect(draft.items[0]!.orderItemId).toBe(orderItemId)

    const audited = await returns.auditHead(p('purOutsourcedReturns', 'audit'), 'outsourced', draft.id)
    expect(audited.status).toBe('AUDITED')

    // 库存：两行负向出仓（本公司仓；不动外协仓）
    const stock = await stockEntries(draft.id)
    expect(stock).toHaveLength(2)
    expect(stock.map((s) => Number(s.quantity)).sort((a, b) => a - b)).toEqual([-20, -10])
    expect(stock.every((s) => s.warehouse_id === warehouseId)).toBe(true)

    // 不过总账
    const glCount = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM acc_gl_entry
      WHERE voucher_type='purchase.outsourced_return' AND voucher_id=${draft.id}::uuid
    `.execute(db)
    expect(glCount.rows[0]!.c).toBe('0')

    // 投影
    expect((await receiptItemRow(receiptItemId)).returned_qty).toBe('10')
    expect((await receiptItemRow(receiptItem2Id)).returned_qty).toBe('20')
    expect(await orderItemReceived(orderItemId)).toBe('90')
    expect(await orderItemReceived(orderItem2Id)).toBe('30')
  })

  test('已对账拦截：委外入库行进采购对账确认后禁止退货，撤回后可退', async () => {
    // 先建退货草稿（此时源行未对账，保存放行）
    const draft = await returns.createDraft(p('purOutsourcedReturns', 'create'), 'outsourced', draftInput([
      { idx: 1, qty: '2', outsourcedReceiptItemId: receiptItem2Id },
    ]))

    // 委外入库行进采购对账并确认 → 源行已对账数量 > 0
    const recon = await reconciliations.createDraft(p('purReconciliations', 'create'), 'purchase', {
      companyId,
      reconciliationType: 'REGULAR',
      partyType: 'SUPPLIER',
      partyId: supplierId,
      debitAccountId: reconDebitId,
      creditAccountId: reconCreditId,
      items: [{ idx: 1, qty: '1', outsourcedReceiptItemId: receiptItem2Id }],
    })
    await reconciliations.confirm(p('purReconciliations', 'confirm'), 'purchase', recon.id)
    expect((await receiptItemRow(receiptItem2Id)).reconciled_qty).toBe('1')

    // 保存期拦截
    const saveErr = await returns
      .createDraft(p('purOutsourcedReturns', 'create'), 'outsourced', draftInput([
        { idx: 1, qty: '1', outsourcedReceiptItemId: receiptItem2Id },
      ]))
      .catch((e: unknown) => e)
    expect(saveErr).toBeInstanceOf(ApiError)
    expect((saveErr as ApiError).fields?.['items[0].outsourcedReceiptItemId']).toEqual([
      '源入库条目已对账,须先撤回/作废相关采购对账单',
    ])

    // 审核复检拦截（草稿先于对账确认创建）
    await expect(
      returns.auditHead(p('purOutsourcedReturns', 'audit'), 'outsourced', draft.id),
    ).rejects.toThrow(/源入库条目已对账,须先撤回\/作废相关采购对账单/)

    // 撤回对账释放占用后可审
    await reconciliations.unconfirm(p('purReconciliations', 'unconfirm'), 'purchase', recon.id)
    await reconciliations.deleteHead(p('purReconciliations', 'delete'), 'purchase', recon.id)
    const audited = await returns.auditHead(p('purOutsourcedReturns', 'audit'), 'outsourced', draft.id)
    expect(audited.status).toBe('AUDITED')
    expect((await receiptItemRow(receiptItem2Id)).returned_qty).toBe('22')
    expect(await orderItemReceived(orderItem2Id)).toBe('28')
  })

  test('审核硬校验：退货量超剩余可退即整单拦截', async () => {
    // 行一剩余可退 = 100 − 10 = 90；退 95 超出
    const draft = await returns.createDraft(p('purOutsourcedReturns', 'create'), 'outsourced', draftInput([
      { idx: 1, qty: '95', outsourcedReceiptItemId: receiptItemId },
    ]))
    await expect(
      returns.auditHead(p('purOutsourcedReturns', 'audit'), 'outsourced', draft.id),
    ).rejects.toThrow(/超出剩余可退数量/)
    expect(await stockEntries(draft.id)).toHaveLength(0)
    expect((await receiptItemRow(receiptItemId)).returned_qty).toBe('10')
  })

  test('作废：库存分录作废 + 已退已收全量回滚', async () => {
    const draft = await returns.createDraft(p('purOutsourcedReturns', 'create'), 'outsourced', draftInput([
      { idx: 1, qty: '5', outsourcedReceiptItemId: receiptItemId },
    ]))
    await returns.auditHead(p('purOutsourcedReturns', 'audit'), 'outsourced', draft.id)
    expect((await receiptItemRow(receiptItemId)).returned_qty).toBe('15')
    expect(await orderItemReceived(orderItemId)).toBe('85')

    const voided = await returns.voidHead(p('purOutsourcedReturns', 'void'), 'outsourced', draft.id)
    expect(voided.status).toBe('VOIDED')
    const stock = await stockEntries(draft.id)
    expect(stock.length).toBeGreaterThan(0)
    expect(stock.every((s) => s.is_cancelled)).toBe(true)
    expect((await receiptItemRow(receiptItemId)).returned_qty).toBe('10')
    expect(await orderItemReceived(orderItemId)).toBe('90')
  })

  test('手工行：仅物料/单位/数量/行仓；审核出仓无总账', async () => {
    const draft = await returns.createDraft(p('purOutsourcedReturns', 'create'), 'outsourced', draftInput([
      { idx: 1, qty: '3', outsourcedReceiptItemId: null, materialId, warehouseId },
    ]))
    const item = draft.items[0]!
    expect(item.materialCode).toBe('M' + suffix)
    expect(item.unitName).toBe(prefix + '件')
    expect(item.orderNo).toBeNull()
    expect(item.orderItemId).toBeNull()

    await returns.auditHead(p('purOutsourcedReturns', 'audit'), 'outsourced', draft.id)
    const stock = await stockEntries(draft.id)
    expect(stock).toHaveLength(1)
    expect(Number(stock[0]!.quantity)).toBe(-3)
    const glCount = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM acc_gl_entry
      WHERE voucher_type='purchase.outsourced_return' AND voucher_id=${draft.id}::uuid
    `.execute(db)
    expect(glCount.rows[0]!.c).toBe('0')
    // 手工行不动任何投影
    expect(await orderItemReceived(orderItemId)).toBe('90')
  })
})
