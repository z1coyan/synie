/**
 * 物料类型单据准入 PG 集成：报价/订单/委外清单按类型拦截，
 * 履约（销售发货/采购入库）非库存类行行仓可空、审核不落库存分录但投影照累加。
 * 门控 SYNIE_TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { createInventoryEngine } from '~/engines/inventory/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { createFulfillmentService } from './fulfillment/service.ts'
import { createOutsourcedConfigService } from './order/outsourced-config.ts'
import { createOrderService, type OrderDraftInput } from './order/service.ts'
import { createQuotationService } from './quotation/service.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（物料类型单据准入）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db, buildNumberingCatalog(createSealedResourceRegistry()))
  const quotations = createQuotationService(db, numbering)
  const outsourcedConfig = createOutsourcedConfigService(db)
  const orders = createOrderService(db, numbering, quotations, outsourcedConfig.draft)
  const fulfillment = createFulfillmentService(db, numbering, {
    inventory: createInventoryEngine(),
    gl: createGlEngine(),
  })

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const prefix = `MT${suffix}`

  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  const supplierId = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const stockMaterialId = crypto.randomUUID()
  const virtualMaterialId = crypto.randomUUID()
  const assetMaterialId = crypto.randomUUID()
  const warehouseId = crypto.randomUUID()
  const receivableAccountId = crypto.randomUUID()
  const salesCreditAccountId = crypto.randomUUID()
  const payableAccountId = crypto.randomUUID()
  const purchaseDebitAccountId = crypto.randomUUID()
  const salesOrderId = crypto.randomUUID()
  const salesVirtualItemId = crypto.randomUUID()
  const salesAssetItemId = crypto.randomUUID()
  const purchaseOrderId = crypto.randomUUID()
  const purchaseStockItemId = crypto.randomUUID()
  const purchaseAssetItemId = crypto.randomUUID()

  const actor: Actor = {
    userId: '',
    username: 'material-type-test',
    name: '物料类型测试',
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  }

  function orderDraftInput(
    side: 'sales' | 'purchase',
    orderNo: string,
    materialId: string,
    isOutsourced: boolean,
  ): OrderDraftInput {
    return {
      companyId,
      orderNo,
      orderDate: '2026-07-31',
      orderType: side === 'sales' ? 'SAMPLE' : 'SPOT',
      isOutsourced,
      partyType: side === 'sales' ? 'CUSTOMER' : 'SUPPLIER',
      partyId: side === 'sales' ? customerId : supplierId,
      currencyId,
      exchangeRate: '1',
      terms: null,
      remarks: null,
      items: [{
        idx: 1,
        qty: '10',
        materialId,
        unitId,
        price: '10',
        taxRate: '0.13',
        remarks: null,
        quotationItemId: null,
        bomId: null,
        demandLineId: null,
        demandDate: null,
        issueLines: [],
        byproductLines: [],
      }],
    }
  }


  /** ApiError.validation 的细节消息在 fields 里；聚合草稿路径会加 items[i] 前缀，故按值匹配 */
  async function expectValidation(promise: Promise<unknown>, detail: string): Promise<void> {
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toMatchObject({ code: 'validation' })
    const fields = (err as { fields?: Record<string, string[]> }).fields ?? {}
    expect(Object.values(fields).flat()).toContain(detail)
  }

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${currencyId}::uuid, ${prefix + '币'}, ${'T' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
      VALUES (${companyId}::uuid, ${'C' + suffix}, ${prefix + '公司'}, 'MT', ${currencyId}::uuid)
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
      VALUES (${unitId}::uuid, ${'mt-' + suffix}, true, ${prefix + '件'}, 'u', 1)
    `.execute(db)
    await sql`
      INSERT INTO inv_material_category(id,code,name,is_leaf,active)
      VALUES (${categoryId}::uuid, ${'MC' + suffix}, ${prefix + '分类'}, true, true)
    `.execute(db)
    await sql`
      INSERT INTO inv_material(id,code,name,category_id,default_unit_id,active,material_type) VALUES
        (${stockMaterialId}::uuid, ${'S' + suffix}, ${prefix + '库存料'}, ${categoryId}::uuid, ${unitId}::uuid, true, 'STOCK'),
        (${virtualMaterialId}::uuid, ${'V' + suffix}, ${prefix + '虚拟料'}, ${categoryId}::uuid, ${unitId}::uuid, true, 'VIRTUAL'),
        (${assetMaterialId}::uuid, ${'A' + suffix}, ${prefix + '资产料'}, ${categoryId}::uuid, ${unitId}::uuid, true, 'ASSET')
    `.execute(db)
    await sql`
      INSERT INTO inv_warehouse(id,name,company_id,is_leaf,active)
      VALUES (${warehouseId}::uuid, ${prefix + '仓'}, ${companyId}::uuid, true, true)
    `.execute(db)
    await sql`
      INSERT INTO bas_account(id,code,name,direction,is_group,active,company_id,currency_id,role) VALUES
        (${receivableAccountId}::uuid, ${'AR' + suffix}, ${prefix + '未开应收'}, 'debit', false, true, ${companyId}::uuid, ${currencyId}::uuid, 'unbilled_receivable'),
        (${salesCreditAccountId}::uuid, ${'SR' + suffix}, ${prefix + '销贷'}, 'credit', false, true, ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${payableAccountId}::uuid, ${'AP' + suffix}, ${prefix + '未开应付'}, 'credit', false, true, ${companyId}::uuid, ${currencyId}::uuid, 'unbilled_payable'),
        (${purchaseDebitAccountId}::uuid, ${'PD' + suffix}, ${prefix + '采借'}, 'debit', false, true, ${companyId}::uuid, ${currencyId}::uuid, NULL)
    `.execute(db)
    // 已审核销售订单：虚拟/资产条目（直插绕过订单层拦截，模拟历史/旁路数据）
    await sql`
      INSERT INTO sal_order(id,order_no,order_date,party_type,party_id,status,company_id,exchange_rate,currency_id,order_type)
      VALUES (${salesOrderId}::uuid, ${prefix + '-SO'}, '2026-07-20', 'customer', ${customerId}::uuid,
        'audited', ${companyId}::uuid, 1, ${currencyId}::uuid, 'sample')
    `.execute(db)
    await sql`
      INSERT INTO sal_order_item(id,idx,qty,price,amount,order_id,company_id,material_id,unit_id,
        material_code,material_name,unit_name,base_qty,base_price,base_amount,tax_rate) VALUES
        (${salesVirtualItemId}::uuid,1,100,10,1000,${salesOrderId}::uuid,${companyId}::uuid,
          ${virtualMaterialId}::uuid,${unitId}::uuid,${'V' + suffix},${prefix + '虚拟料'},${prefix + '件'},100,10,1000,0),
        (${salesAssetItemId}::uuid,2,100,10,1000,${salesOrderId}::uuid,${companyId}::uuid,
          ${assetMaterialId}::uuid,${unitId}::uuid,${'A' + suffix},${prefix + '资产料'},${prefix + '件'},100,10,1000,0)
    `.execute(db)
    // 已审核普通采购订单：库存/资产条目
    await sql`
      INSERT INTO pur_order(id,order_no,order_date,party_type,party_id,status,company_id,
        exchange_rate,currency_id,is_outsourced)
      VALUES (${purchaseOrderId}::uuid, ${prefix + '-PO'}, '2026-07-20', 'supplier',
        ${supplierId}::uuid, 'audited', ${companyId}::uuid, 1, ${currencyId}::uuid, false)
    `.execute(db)
    await sql`
      INSERT INTO pur_order_item(id,idx,qty,base_qty,price,amount,order_id,company_id,material_id,unit_id,
        material_code,material_name,unit_name) VALUES
        (${purchaseStockItemId}::uuid,1,100,100,8,800,${purchaseOrderId}::uuid,
          ${companyId}::uuid,${stockMaterialId}::uuid,${unitId}::uuid,
          ${'S' + suffix},${prefix + '库存料'},${prefix + '件'}),
        (${purchaseAssetItemId}::uuid,2,100,100,8,800,${purchaseOrderId}::uuid,
          ${companyId}::uuid,${assetMaterialId}::uuid,${unitId}::uuid,
          ${'A' + suffix},${prefix + '资产料'},${prefix + '件'})
    `.execute(db)
  })

  afterAll(async () => {
    await sql`DELETE FROM acc_gl_entry WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM inv_stock_entry WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sys_attachment WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sys_audit_log WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_delivery WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_receipt WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_quotation WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_quotation WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_order WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_order WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_account WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM inv_warehouse WHERE id=${warehouseId}::uuid`.execute(db)
    await sql`
      DELETE FROM inv_material WHERE id IN (
        ${stockMaterialId}::uuid, ${virtualMaterialId}::uuid, ${assetMaterialId}::uuid
      )
    `.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id=${categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id=${unitId}::uuid`.execute(db)
    await sql`DELETE FROM sal_customers WHERE id=${customerId}::uuid`.execute(db)
    await sql`DELETE FROM pur_supplier WHERE id=${supplierId}::uuid`.execute(db)
    await sql`DELETE FROM bas_company WHERE id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id=${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  test('销售报价/销售订单条目拦资产类物料，虚拟类可进', async () => {
    const quotation = await quotations.createHead(actor, 'sales', {
      companyId,
      quotationNo: `${prefix}-SQ`,
      quotationDate: '2026-07-20',
      validUntil: '2026-08-20',
      partyType: 'CUSTOMER',
      partyId: customerId,
      currencyId,
    })
    await expectValidation(
      quotations.createItem(actor, 'sales', {
        quotationId: quotation.id,
        idx: 1,
        materialId: assetMaterialId,
        unitId,
        price: '10',
        taxRate: '0.13',
      }),
      '资产类物料不能进该单据',
    )
    const virtualItem = await quotations.createItem(actor, 'sales', {
      quotationId: quotation.id,
      idx: 2,
      materialId: virtualMaterialId,
      unitId,
      price: '10',
      taxRate: '0.13',
    })
    expect(virtualItem.materialId).toBe(virtualMaterialId)

    await expectValidation(
      orders.createDraft(actor, 'sales', orderDraftInput('sales', `${prefix}-SO-A`, assetMaterialId, false)),
      '资产类物料不能进该单据',
    )
    const virtualOrder = await orders.createDraft(
      actor,
      'sales',
      orderDraftInput('sales', `${prefix}-SO-V`, virtualMaterialId, false),
    )
    expect(virtualOrder.items[0]?.materialId).toBe(virtualMaterialId)
  })

  test('委外采购订单条目与发料/副产物清单限库存类，普通采购订单放行资产类', async () => {
    await expectValidation(
      orders.createDraft(actor, 'purchase', orderDraftInput('purchase', `${prefix}-PO-OS-V`, virtualMaterialId, true)),
      '仅库存类物料可进该单据',
    )
    await expectValidation(
      orders.createDraft(actor, 'purchase', orderDraftInput('purchase', `${prefix}-PO-OS-A`, assetMaterialId, true)),
      '仅库存类物料可进该单据',
    )

    // 普通采购订单条目三类皆可
    const regular = await orders.createDraft(
      actor,
      'purchase',
      orderDraftInput('purchase', `${prefix}-PO-REG-A`, assetMaterialId, false),
    )
    expect(regular.items[0]?.materialId).toBe(assetMaterialId)

    // 委外订单（库存类条目）挂虚拟/资产发料清单行被拦
    const outsourced = await orders.createDraft(
      actor,
      'purchase',
      orderDraftInput('purchase', `${prefix}-PO-OS-OK`, stockMaterialId, true),
    )
    const orderItemId = outsourced.items[0]!.id
    await expectValidation(
      outsourcedConfig.createMaterial(actor, {
        orderItemId,
        materialId: virtualMaterialId,
        unitId,
        quantity: '5',
      }),
      '仅库存类物料可进该单据',
    )
    await expectValidation(
      outsourcedConfig.createByproduct(actor, {
        orderItemId,
        materialId: assetMaterialId,
        unitId,
        quantity: '1',
      }),
      '仅库存类物料可进该单据',
    )
    const issueLine = await outsourcedConfig.createMaterial(actor, {
      orderItemId,
      materialId: stockMaterialId,
      unitId,
      quantity: '20',
    })
    expect(issueLine.materialId).toBe(stockMaterialId)
  })

  test('销售发货行拦资产类；虚拟类行行仓可空、审核不落库存分录但已发数量照累加', async () => {
    await expectValidation(
      fulfillment.createSalesDraft(actor, {
        companyId,
        no: `${prefix}-SD-A`,
        documentDate: '2026-07-25',
        postingDate: '2026-07-25',
        partyType: 'customer',
        partyId: customerId,
        debitAccountId: receivableAccountId,
        creditAccountId: salesCreditAccountId,
        items: [{ idx: 1, qty: '5', orderItemId: salesAssetItemId, warehouseId }],
        packBoxes: [],
      }),
      '资产类物料不能进该单据',
    )

    const draft = await fulfillment.createSalesDraft(actor, {
      companyId,
      no: `${prefix}-SD-V`,
      documentDate: '2026-07-25',
      postingDate: '2026-07-25',
      partyType: 'customer',
      partyId: customerId,
      debitAccountId: receivableAccountId,
      creditAccountId: salesCreditAccountId,
      items: [{ idx: 1, qty: '5', orderItemId: salesVirtualItemId, warehouseId: null }],
      packBoxes: [],
    })
    expect(draft.items[0]?.warehouseId).toBeNull()

    const audited = await fulfillment.auditHead(actor, 'sales', draft.id)
    expect(audited.status).toBe('AUDITED')
    const entries = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM inv_stock_entry
      WHERE voucher_id=${draft.id}::uuid AND is_cancelled=false
    `.execute(db)
    expect(entries.rows[0]?.n).toBe('0')
    const projection = await sql<{ qty: string }>`
      SELECT shipped_qty::text AS qty FROM sal_order_item WHERE id=${salesVirtualItemId}::uuid
    `.execute(db)
    expect(projection.rows[0]?.qty).toBe('5')

    // 作废：无库存分录可回滚，投影回退
    const voided = await fulfillment.voidHead(actor, 'sales', draft.id)
    expect(voided.status).toBe('VOIDED')
    const afterVoid = await sql<{ qty: string }>`
      SELECT shipped_qty::text AS qty FROM sal_order_item WHERE id=${salesVirtualItemId}::uuid
    `.execute(db)
    expect(afterVoid.rows[0]?.qty).toBe('0')
  })

  test('采购入库库存类行仓必填；含资产类行审核后仅库存类落库存分录、已收数量照累加', async () => {
    await expectValidation(
      fulfillment.createPurchaseReceiptDraft(actor, {
        companyId,
        no: `${prefix}-PR-NOWH`,
        documentDate: '2026-07-25',
        postingDate: '2026-07-25',
        partyType: 'supplier',
        partyId: supplierId,
        debitAccountId: purchaseDebitAccountId,
        creditAccountId: payableAccountId,
        items: [{ idx: 1, qty: '5', orderItemId: purchaseStockItemId, warehouseId: null }],
      }),
      '库存类物料必须填写行仓',
    )

    const draft = await fulfillment.createPurchaseReceiptDraft(actor, {
      companyId,
      no: `${prefix}-PR-MIX`,
      documentDate: '2026-07-25',
      postingDate: '2026-07-25',
      partyType: 'supplier',
      partyId: supplierId,
      debitAccountId: purchaseDebitAccountId,
      creditAccountId: payableAccountId,
      items: [
        { idx: 1, qty: '5', orderItemId: purchaseStockItemId, warehouseId },
        { idx: 2, qty: '3', orderItemId: purchaseAssetItemId, warehouseId: null },
      ],
    })
    expect(draft.items[1]?.warehouseId).toBeNull()

    const audited = await fulfillment.auditHead(actor, 'purchase', draft.id)
    expect(audited.status).toBe('AUDITED')
    const entries = await sql<{ material_id: string; quantity: string }>`
      SELECT material_id, quantity::text FROM inv_stock_entry
      WHERE voucher_id=${draft.id}::uuid AND is_cancelled=false
    `.execute(db)
    expect(entries.rows).toHaveLength(1)
    expect(entries.rows[0]?.material_id).toBe(stockMaterialId)
    expect(entries.rows[0]?.quantity).toBe('5')
    const projections = await sql<{ id: string; qty: string }>`
      SELECT id, received_qty::text AS qty FROM pur_order_item
      WHERE id IN (${purchaseStockItemId}::uuid, ${purchaseAssetItemId}::uuid)
      ORDER BY idx
    `.execute(db)
    expect(projections.rows[0]?.qty).toBe('5')
    expect(projections.rows[1]?.qty).toBe('3')

    // 作废：只回滚已写的库存分录，投影全量回退
    const voided = await fulfillment.voidHead(actor, 'purchase', draft.id)
    expect(voided.status).toBe('VOIDED')
    const liveEntries = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM inv_stock_entry
      WHERE voucher_id=${draft.id}::uuid AND is_cancelled=false
    `.execute(db)
    expect(liveEntries.rows[0]?.n).toBe('0')
    const afterVoid = await sql<{ qty: string }>`
      SELECT received_qty::text AS qty FROM pur_order_item WHERE id=${purchaseAssetItemId}::uuid
    `.execute(db)
    expect(afterVoid.rows[0]?.qty).toBe('0')
  })
})
