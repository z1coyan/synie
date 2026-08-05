/**
 * 对账 PG 集成：金额链、确认占量/撤回、赠送结单/作废、尾差与权限隔离。
 * 门控 SYNIE_TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { decimal } from '@synie/shared'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { withTx } from '~/db/tx.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { createInventoryEngine } from '~/engines/inventory/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { createFulfillmentService } from '../fulfillment/service.ts'
import { createOrderService } from '../order/service.ts'
import { createQuotationService } from '../quotation/service.ts'
import { createReconciliationService } from './service.ts'
import { testActor } from '~/platform/authz/testing.ts'


/** 编号服务需要 sealed registry（授权归宿解析） */
const numberingRegistry = createSealedResourceRegistry()
const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（销售/采购对账）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db, buildNumberingCatalog(numberingRegistry), numberingRegistry)
  const gl = createGlEngine()
  const inventory = createInventoryEngine()
  const engines = { inventory, gl }
  const quotations = createQuotationService(db, numbering)
  const orders = createOrderService(db, numbering, quotations)
  const fulfillment = createFulfillmentService(db, numbering, engines)
  const svc = createReconciliationService(db, numbering, gl)
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const prefix = `REC${suffix}`

  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const otherCompanyId = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  const supplierId = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const warehouseId = crypto.randomUUID()
  const salesDebitId = crypto.randomUUID()
  const salesCreditId = crypto.randomUUID()
  const purchaseDebitId = crypto.randomUUID()
  const purchaseCreditId = crypto.randomUUID()
  const salesOrderId = crypto.randomUUID()
  const salesOrderItemId = crypto.randomUUID()
  const salesDeliveryId = crypto.randomUUID()
  const salesDeliveryItemId = crypto.randomUUID()
  const purchaseOrderId = crypto.randomUUID()
  const purchaseOrderItemId = crypto.randomUUID()
  const purchaseReceiptId = crypto.randomUUID()
  const purchaseReceiptItemId = crypto.randomUUID()

  const actor: Actor = testActor({
    userId: '',
    username: 'recon-test',
    name: '对账测试',
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })

  const limited: Actor = testActor({
    userId: '',
    username: 'recon-limited',
    name: null,
    superAdmin: false,
    allCompanies: false,
    permissions: new Set([
      'sales.reconciliation:read',
      'sales.reconciliation:create',
      'sales.reconciliation:confirm',
    ]),
    companyIds: [companyId],
  })

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${currencyId}::uuid, ${prefix + '币'}, ${'R' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id) VALUES
        (${companyId}::uuid, ${'C' + suffix}, ${prefix + '公司'}, 'RC', ${currencyId}::uuid),
        (${otherCompanyId}::uuid, ${'O' + suffix}, ${prefix + '他司'}, 'RO', ${currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sal_customers(id,code,name,short_name)
      VALUES (${customerId}::uuid, ${'CU' + suffix}, ${prefix + '客户'}, 'CU')
    `.execute(db)
    await sql`
      INSERT INTO pur_supplier(id,code,name,short_name)
      VALUES (${supplierId}::uuid, ${'SU' + suffix}, ${prefix + '供应商'}, 'SU')
    `.execute(db)
    await sql`
      INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
      VALUES (${unitId}::uuid, ${'recon-' + suffix}, true, ${prefix + '件'}, 'u', 1)
    `.execute(db)
    await sql`
      INSERT INTO inv_material_category(id,code,name,is_leaf,active)
      VALUES (${categoryId}::uuid, ${'MC' + suffix}, ${prefix + '分类'}, true, true)
    `.execute(db)
    await sql`
      INSERT INTO inv_material(id,code,name,category_id,default_unit_id,active)
      VALUES (${materialId}::uuid, ${'M' + suffix}, ${prefix + '物料'}, ${categoryId}::uuid, ${unitId}::uuid, true)
    `.execute(db)
    await sql`
      INSERT INTO inv_warehouse(id,name,company_id)
      VALUES (${warehouseId}::uuid, ${prefix + '仓'}, ${companyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO bas_account(id,code,name,direction,is_group,active,company_id,currency_id,role) VALUES
        (${salesDebitId}::uuid, ${'SD' + suffix}, ${prefix + '销借'}, 'debit', false, true, ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${salesCreditId}::uuid, ${'SC' + suffix}, ${prefix + '未开应收'}, 'credit', false, true, ${companyId}::uuid, ${currencyId}::uuid, 'unbilled_receivable'),
        (${purchaseDebitId}::uuid, ${'PD' + suffix}, ${prefix + '未开应付'}, 'debit', false, true, ${companyId}::uuid, ${currencyId}::uuid, 'unbilled_payable'),
        (${purchaseCreditId}::uuid, ${'PC' + suffix}, ${prefix + '采贷'}, 'credit', false, true, ${companyId}::uuid, ${currencyId}::uuid, NULL)
    `.execute(db)
    await sql`
      INSERT INTO sal_company_account_default(
        company_id, delivery_debit_account_id, delivery_credit_account_id,
        receipt_debit_account_id, receipt_credit_account_id
      ) VALUES (
        ${companyId}::uuid, ${salesCreditId}::uuid, ${salesDebitId}::uuid,
        ${purchaseCreditId}::uuid, ${purchaseDebitId}::uuid
      )
    `.execute(db)
    await sql`
      INSERT INTO sal_order(id,order_no,order_date,party_type,party_id,status,company_id,exchange_rate,currency_id,order_type)
      VALUES (${salesOrderId}::uuid, ${prefix + '-SO'}, '2026-07-20', 'customer', ${customerId}::uuid,
        'audited', ${companyId}::uuid, 1.2, ${currencyId}::uuid, 'regular')
    `.execute(db)
    await sql`
      INSERT INTO sal_order_item(id,idx,qty,price,amount,order_id,company_id,material_id,unit_id,
        material_code,material_name,unit_name,base_qty)
      VALUES (${salesOrderItemId}::uuid,1,10,10,100,${salesOrderId}::uuid,${companyId}::uuid,
        ${materialId}::uuid,${unitId}::uuid,${'M' + suffix},${prefix + '物料'},${prefix + '件'},20)
    `.execute(db)
    await sql`
      INSERT INTO sal_delivery(id,delivery_no,delivery_date,party_type,party_id,status,company_id,
        warehouse_id,debit_account_id,credit_account_id)
      VALUES (${salesDeliveryId}::uuid,${prefix + '-SD'},'2026-07-25','customer',${customerId}::uuid,
        'audited',${companyId}::uuid,${warehouseId}::uuid,${salesCreditId}::uuid,${salesDebitId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sal_delivery_item(
        id,idx,qty,base_qty,material_code,material_name,unit_name,order_no,
        order_qty,order_base_qty,order_unit_name,order_price,order_amount,
        order_base_price,order_base_amount,order_tax_rate,order_currency_code,
        delivery_id,company_id,order_item_id,material_id,unit_id,warehouse_id,reconciled_qty
      ) VALUES (
        ${salesDeliveryItemId}::uuid,1,10,20,${'M' + suffix},${prefix + '物料'},${prefix + '件'},${prefix + '-SO'},
        10,20,${prefix + '件'},10,100,12,120,0.13,${'R' + suffix.slice(0, 2)},
        ${salesDeliveryId}::uuid,${companyId}::uuid,${salesOrderItemId}::uuid,
        ${materialId}::uuid,${unitId}::uuid,${warehouseId}::uuid,0
      )
    `.execute(db)
    await sql`
      INSERT INTO pur_order(id,order_no,order_date,party_type,party_id,status,company_id,exchange_rate,currency_id,is_outsourced)
      VALUES (${purchaseOrderId}::uuid,${prefix + '-PO'},'2026-07-20','supplier',${supplierId}::uuid,
        'audited',${companyId}::uuid,1.2,${currencyId}::uuid,false)
    `.execute(db)
    await sql`
      INSERT INTO pur_order_item(id,idx,qty,base_qty,price,amount,order_id,company_id,material_id,unit_id,
        material_code,material_name,unit_name)
      VALUES (${purchaseOrderItemId}::uuid,1,10,10,8,80,${purchaseOrderId}::uuid,${companyId}::uuid,
        ${materialId}::uuid,${unitId}::uuid,${'M' + suffix},${prefix + '物料'},${prefix + '件'})
    `.execute(db)
    await sql`
      INSERT INTO pur_receipt(id,receipt_no,receipt_date,party_type,party_id,status,company_id,
        warehouse_id,debit_account_id,credit_account_id)
      VALUES (${purchaseReceiptId}::uuid,${prefix + '-PR'},'2026-07-25','supplier',${supplierId}::uuid,
        'audited',${companyId}::uuid,${warehouseId}::uuid,${purchaseCreditId}::uuid,${purchaseDebitId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO pur_receipt_item(
        id,idx,qty,base_qty,material_code,material_name,unit_name,order_no,
        order_qty,order_base_qty,order_unit_name,order_price,order_amount,
        order_base_price,order_base_amount,order_tax_rate,order_currency_code,
        receipt_id,company_id,order_item_id,material_id,unit_id,warehouse_id,reconciled_qty
      ) VALUES (
        ${purchaseReceiptItemId}::uuid,1,10,10,${'M' + suffix},${prefix + '物料'},${prefix + '件'},${prefix + '-PO'},
        10,10,${prefix + '件'},8,80,9.6,96,0.13,${'R' + suffix.slice(0, 2)},
        ${purchaseReceiptId}::uuid,${companyId}::uuid,${purchaseOrderItemId}::uuid,
        ${materialId}::uuid,${unitId}::uuid,${warehouseId}::uuid,0
      )
    `.execute(db)
  })

  afterAll(async () => {
    await sql`DELETE FROM sys_todo WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sys_audit_log WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_gl_entry WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_reconciliation WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_reconciliation WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_company_account_default WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_delivery WHERE id=${salesDeliveryId}::uuid`.execute(db)
    await sql`DELETE FROM pur_receipt WHERE id=${purchaseReceiptId}::uuid`.execute(db)
    await sql`DELETE FROM sal_order WHERE id=${salesOrderId}::uuid`.execute(db)
    await sql`DELETE FROM pur_order WHERE id=${purchaseOrderId}::uuid`.execute(db)
    await sql`DELETE FROM inv_warehouse WHERE id=${warehouseId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material WHERE id=${materialId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id=${categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id=${unitId}::uuid`.execute(db)
    await sql`DELETE FROM bas_account WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_customers WHERE id=${customerId}::uuid`.execute(db)
    await sql`DELETE FROM pur_supplier WHERE id=${supplierId}::uuid`.execute(db)
    await sql`DELETE FROM bas_company WHERE id IN (${companyId}::uuid, ${otherCompanyId}::uuid)`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id=${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  test('对账条目按来源日期排序和筛选', async () => {
    const salesHead = await svc.createHead(actor, 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      no: `${prefix}-SR-LIST`,
    })
    const purchaseHead = await svc.createHead(actor, 'purchase', {
      companyId,
      kind: 'REGULAR',
      partyType: 'SUPPLIER',
      partyId: supplierId,
      no: `${prefix}-PR-LIST`,
    })
    const salesItem = await svc.createItem(actor, 'sales', {
      reconciliationId: salesHead.id,
      idx: 1,
      qty: '1',
      deliveryItemId: salesDeliveryItemId,
    })
    const purchaseItem = await svc.createItem(actor, 'purchase', {
      reconciliationId: purchaseHead.id,
      idx: 1,
      qty: '1',
      receiptItemId: purchaseReceiptItemId,
    })

    try {
      const sales = await svc.listItems(actor, 'sales', {
        limit: 20,
        offset: 0,
        sort: { column: 'deliveryDate', direction: 'descending' },
        filter: {
          deliveryDate: { kind: 'date', op: 'eq', value: '2026-07-25' },
        },
      })
      expect(sales.results.some((item) => item.id === salesItem.id)).toBe(true)

      const purchase = await svc.listItems(actor, 'purchase', {
        limit: 20,
        offset: 0,
        sort: { column: 'receiptDate', direction: 'descending' },
        filter: {
          receiptDate: { kind: 'date', op: 'eq', value: '2026-07-25' },
        },
      })
      expect(purchase.results.some((item) => item.id === purchaseItem.id)).toBe(true)
    } finally {
      await svc.deleteItem(actor, 'sales', salesItem.id)
      await svc.deleteItem(actor, 'purchase', purchaseItem.id)
      await svc.deleteHead(actor, 'sales', salesHead.id)
      await svc.deleteHead(actor, 'purchase', purchaseHead.id)
    }
  })

  test('默认科目代入 + 金额链 + 确认占量/撤回', async () => {
    const head = await svc.createHead(actor, 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      no: `${prefix}-SR-REG`,
    })
    expect(head.debitAccountId).toBe(salesDebitId)
    expect(head.creditAccountId).toBe(salesCreditId)
    expect(head.status).toBe('DRAFT')

    const item = await svc.createItem(actor, 'sales', {
      reconciliationId: head.id,
      idx: 1,
      qty: '2.005',
      deliveryItemId: salesDeliveryItemId,
    })
    // base = 2.005 * 20/10 = 4.01; amount = 2.005*10=20.05; baseAmount=20.05*1.2=24.06
    expect(decimal(item.baseQty).equals(decimal('4.01'))).toBe(true)
    expect(decimal(item.amount).equals(decimal('20.05'))).toBe(true)
    expect(decimal(item.baseAmount).equals(decimal('24.06'))).toBe(true)

    const confirmed = await svc.confirm(actor, 'sales', head.id)
    expect(confirmed.status).toBe('CONFIRMED')
    const recon = await sql<{ r: string }>`
      SELECT reconciled_qty::text AS r FROM sal_delivery_item WHERE id=${salesDeliveryItemId}::uuid
    `.execute(db)
    expect(decimal(recon.rows[0]!.r).equals(decimal('4.01'))).toBe(true)

    const todos = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM sys_todo
      WHERE source_type='sales.reconciliation' AND source_id=${head.id}::uuid AND status='active'
    `.execute(db)
    expect(Number(todos.rows[0]!.c)).toBe(1)

    const unconfirmed = await svc.unconfirm(actor, 'sales', head.id)
    expect(unconfirmed.status).toBe('DRAFT')
    const recon2 = await sql<{ r: string }>`
      SELECT reconciled_qty::text AS r FROM sal_delivery_item WHERE id=${salesDeliveryItemId}::uuid
    `.execute(db)
    expect(decimal(recon2.rows[0]!.r).equals(decimal(0))).toBe(true)

    await svc.deleteItem(actor, 'sales', item.id)
    await svc.deleteHead(actor, 'sales', head.id)
  })

  test('分次对账尾差不配平 + 超剩余冲突', async () => {
    const head = await svc.createHead(actor, 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      no: `${prefix}-SR-PART`,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    // 先对 9 行单位 (=18 base)，剩余 1 行单位 (=2 base)
    const item = await svc.createItem(actor, 'sales', {
      reconciliationId: head.id,
      idx: 1,
      qty: '9',
      deliveryItemId: salesDeliveryItemId,
    })
    await svc.confirm(actor, 'sales', head.id)
    const recon = await sql<{ r: string; b: string }>`
      SELECT reconciled_qty::text AS r, base_qty::text AS b FROM sal_delivery_item WHERE id=${salesDeliveryItemId}::uuid
    `.execute(db)
    expect(decimal(recon.rows[0]!.r).equals(decimal('18'))).toBe(true)

    const head2 = await svc.createHead(actor, 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      no: `${prefix}-SR-OVER`,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    let overErr: unknown
    try {
      await svc.createItem(actor, 'sales', {
        reconciliationId: head2.id,
        idx: 1,
        qty: '2', // 需要 4 base，仅剩 2
        deliveryItemId: salesDeliveryItemId,
      })
    } catch (e) {
      overErr = e
    }
    expect(overErr).toBeInstanceOf(ApiError)
    expect((overErr as ApiError).code).toBe('conflict')

    // 尾差 1 行单位可对
    const tail = await svc.createItem(actor, 'sales', {
      reconciliationId: head2.id,
      idx: 1,
      qty: '1',
      deliveryItemId: salesDeliveryItemId,
    })
    expect(decimal(tail.baseQty).equals(decimal('2'))).toBe(true)

    await svc.unconfirm(actor, 'sales', head.id)
    await svc.deleteItem(actor, 'sales', item.id)
    await svc.deleteItem(actor, 'sales', tail.id)
    await svc.deleteHead(actor, 'sales', head.id)
    await svc.deleteHead(actor, 'sales', head2.id)
  })

  test('赠送/样品结单过账与作废回滚', async () => {
    const head = await svc.createHead(actor, 'sales', {
      companyId,
      kind: 'GIFT_SAMPLE',
      partyType: 'CUSTOMER',
      partyId: customerId,
      no: `${prefix}-SR-GIFT`,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    await svc.createItem(actor, 'sales', {
      reconciliationId: head.id,
      idx: 1,
      qty: '1',
      deliveryItemId: salesDeliveryItemId,
    })
    const closed = await svc.audit(actor, 'sales', head.id, { postingDate: '2026-07-26' })
    expect(closed.status).toBe('CLOSED')
    expect(closed.postingDate).toBe('2026-07-26')

    const glRows = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM acc_gl_entry
      WHERE voucher_type='sales.reconciliation' AND voucher_id=${head.id}::uuid AND is_cancelled=false
    `.execute(db)
    expect(Number(glRows.rows[0]!.c)).toBe(2)

    const recon = await sql<{ r: string }>`
      SELECT reconciled_qty::text AS r FROM sal_delivery_item WHERE id=${salesDeliveryItemId}::uuid
    `.execute(db)
    expect(decimal(recon.rows[0]!.r).gt(0)).toBe(true)

    const voided = await svc.void(actor, 'sales', head.id)
    expect(voided.status).toBe('VOIDED')
    const recon2 = await sql<{ r: string }>`
      SELECT reconciled_qty::text AS r FROM sal_delivery_item WHERE id=${salesDeliveryItemId}::uuid
    `.execute(db)
    expect(decimal(recon2.rows[0]!.r).equals(decimal(0))).toBe(true)
    const glCancelled = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM acc_gl_entry
      WHERE voucher_type='sales.reconciliation' AND voucher_id=${head.id}::uuid AND is_cancelled=false
    `.execute(db)
    expect(Number(glCancelled.rows[0]!.c)).toBe(0)
  })

  test('采购镜像确认/撤回', async () => {
    const head = await svc.createHead(actor, 'purchase', {
      companyId,
      kind: 'REGULAR',
      partyType: 'SUPPLIER',
      partyId: supplierId,
      no: `${prefix}-PR-REG`,
      debitAccountId: purchaseDebitId,
      creditAccountId: purchaseCreditId,
    })
    const item = await svc.createItem(actor, 'purchase', {
      reconciliationId: head.id,
      idx: 1,
      qty: '3',
      receiptItemId: purchaseReceiptItemId,
    })
    expect(decimal(item.amount).equals(decimal('24'))).toBe(true) // 3*8
    expect(decimal(item.baseAmount).equals(decimal('28.8'))).toBe(true) // 24*1.2

    await svc.confirm(actor, 'purchase', head.id)
    const recon = await sql<{ r: string }>`
      SELECT reconciled_qty::text AS r FROM pur_receipt_item WHERE id=${purchaseReceiptItemId}::uuid
    `.execute(db)
    expect(decimal(recon.rows[0]!.r).equals(decimal('3'))).toBe(true)
    await svc.unconfirm(actor, 'purchase', head.id)
    await svc.deleteItem(actor, 'purchase', item.id)
    await svc.deleteHead(actor, 'purchase', head.id)
  })

  test('公司隔离：无权公司 not_found', async () => {
    const head = await svc.createHead(actor, 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      no: `${prefix}-SR-SCOPE`,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    let err: unknown
    try {
      await svc.getHead(limited, 'sales', head.id)
    } catch (e) {
      // limited can access companyId — should succeed
    }
    const ok = await svc.getHead(limited, 'sales', head.id)
    expect(ok.id).toBe(head.id)

    const outsider: Actor = testActor({
      ...limited,
      companyIds: [otherCompanyId],
    })
    try {
      await svc.getHead(outsider, 'sales', head.id)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('not_found')
    await svc.deleteHead(actor, 'sales', head.id)
  })

  test('有已对账数量时发货不可作废（履约侧约束）', async () => {
    const head = await svc.createHead(actor, 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      no: `${prefix}-SR-LOCK`,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    await svc.createItem(actor, 'sales', {
      reconciliationId: head.id,
      idx: 1,
      qty: '1',
      deliveryItemId: salesDeliveryItemId,
    })
    await svc.confirm(actor, 'sales', head.id)
    const recon = await sql<{ r: string }>`
      SELECT reconciled_qty::text AS r FROM sal_delivery_item WHERE id=${salesDeliveryItemId}::uuid
    `.execute(db)
    expect(decimal(recon.rows[0]!.r).gt(0)).toBe(true)

    let voidErr: unknown
    try {
      await fulfillment.voidHead(actor, 'sales', salesDeliveryId)
    } catch (e) {
      voidErr = e
    }
    expect(voidErr).toBeInstanceOf(ApiError)
    expect((voidErr as ApiError).code).toBe('conflict')
    expect((voidErr as ApiError).message).toContain('已对账')

    await svc.unconfirm(actor, 'sales', head.id)
    await svc.deleteHead(actor, 'sales', head.id)
  })

  test('发票结单/重开接缝：状态与待办关闭/复活', async () => {
    const head = await svc.createHead(actor, 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      no: `${prefix}-SR-INV`,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    await svc.createItem(actor, 'sales', {
      reconciliationId: head.id,
      idx: 1,
      qty: '1',
      deliveryItemId: salesDeliveryItemId,
    })
    await svc.confirm(actor, 'sales', head.id)

    const closed = await withTx(db, async (trx) =>
      svc.closeFromInvoice(trx, actor, 'sales', head.id),
    )
    expect(closed.status).toBe('CLOSED')
    const closedTodos = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM sys_todo
      WHERE source_type='sales.reconciliation' AND source_id=${head.id}::uuid AND status='active'
    `.execute(db)
    expect(Number(closedTodos.rows[0]!.c)).toBe(0)

    const reopened = await withTx(db, async (trx) =>
      svc.reopenFromInvoice(trx, actor, 'sales', head.id),
    )
    expect(reopened.status).toBe('CONFIRMED')
    const activeTodos = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM sys_todo
      WHERE source_type='sales.reconciliation' AND source_id=${head.id}::uuid AND status='active'
    `.execute(db)
    expect(Number(activeTodos.rows[0]!.c)).toBe(1)

    // 投影未因发票接缝回滚
    const recon = await sql<{ r: string }>`
      SELECT reconciled_qty::text AS r FROM sal_delivery_item WHERE id=${salesDeliveryItemId}::uuid
    `.execute(db)
    expect(decimal(recon.rows[0]!.r).gt(0)).toBe(true)

    await svc.unconfirm(actor, 'sales', head.id)
    await svc.deleteHead(actor, 'sales', head.id)
  })
})
