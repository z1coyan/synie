/**
 * 销售发货装箱箱 PG 集成：箱实体生命周期（自增箱号/删箱级联/随单级联/审核锁死）、
 * 装箱行挂箱校验、全有或全无审核校验回归。门控 SYNIE_TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { createInventoryEngine } from '~/engines/inventory/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { createNumberingService } from '~/platform/numbering/index.ts'
import { createFulfillmentService } from './service.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（销售发货装箱箱）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db)
  const fulfillment = createFulfillmentService(db, numbering, {
    inventory: createInventoryEngine(),
    gl: createGlEngine(),
  })
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const prefix = `PB${suffix}`

  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const material2Id = crypto.randomUUID()
  const warehouseId = crypto.randomUUID()
  const debitAccountId = crypto.randomUUID()
  const creditAccountId = crypto.randomUUID()
  const orderId = crypto.randomUUID()
  const orderItemId = crypto.randomUUID()
  const orderItem2Id = crypto.randomUUID()

  const actor: Actor = {
    userId: '',
    username: 'packbox-test',
    name: '装箱箱测试',
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  }

  let seq = 0
  async function newDelivery() {
    seq += 1
    return fulfillment.createHead(actor, 'sales', {
      companyId,
      no: `${prefix}-SD${seq}`,
      documentDate: '2026-07-25',
      postingDate: '2026-07-25',
      partyType: 'customer',
      partyId: customerId,
      warehouseId,
      debitAccountId,
      creditAccountId,
    })
  }
  async function newDeliveryWithItem(qty = '10') {
    const head = await newDelivery()
    const item = await fulfillment.createItem(actor, 'sales', {
      headId: head.id,
      idx: 1,
      qty,
      orderItemId,
      warehouseId,
    })
    return { head, item }
  }

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${currencyId}::uuid, ${prefix + '币'}, ${'P' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
      VALUES (${companyId}::uuid, ${'C' + suffix}, ${prefix + '公司'}, 'PB', ${currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sal_customers(id,code,name,short_name)
      VALUES (${customerId}::uuid, ${'CU' + suffix}, ${prefix + '客户'}, 'CU')
    `.execute(db)
    await sql`
      INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
      VALUES (${unitId}::uuid, ${'pb-' + suffix}, true, ${prefix + '件'}, 'u', 1)
    `.execute(db)
    await sql`
      INSERT INTO inv_material_category(id,code,name,is_leaf,active)
      VALUES (${categoryId}::uuid, ${'MC' + suffix}, ${prefix + '分类'}, true, true)
    `.execute(db)
    await sql`
      INSERT INTO inv_material(id,code,name,category_id,default_unit_id,active) VALUES
        (${materialId}::uuid, ${'M' + suffix}, ${prefix + '物料'}, ${categoryId}::uuid, ${unitId}::uuid, true),
        (${material2Id}::uuid, ${'N' + suffix}, ${prefix + '物料二'}, ${categoryId}::uuid, ${unitId}::uuid, true)
    `.execute(db)
    await sql`
      INSERT INTO inv_warehouse(id,name,company_id)
      VALUES (${warehouseId}::uuid, ${prefix + '仓'}, ${companyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO bas_account(id,code,name,direction,is_group,active,company_id,currency_id,role) VALUES
        (${debitAccountId}::uuid, ${'SD' + suffix}, ${prefix + '未开应收'}, 'debit', false, true, ${companyId}::uuid, ${currencyId}::uuid, 'unbilled_receivable'),
        (${creditAccountId}::uuid, ${'SC' + suffix}, ${prefix + '销贷'}, 'credit', false, true, ${companyId}::uuid, ${currencyId}::uuid, NULL)
    `.execute(db)
    await sql`
      INSERT INTO sal_order(id,order_no,order_date,party_type,party_id,status,company_id,exchange_rate,currency_id,order_type)
      VALUES (${orderId}::uuid, ${prefix + '-SO'}, '2026-07-20', 'customer', ${customerId}::uuid,
        'audited', ${companyId}::uuid, 1, ${currencyId}::uuid, 'regular')
    `.execute(db)
    await sql`
      INSERT INTO sal_order_item(id,idx,qty,price,amount,order_id,company_id,material_id,unit_id,
        material_code,material_name,unit_name,base_qty,base_price,base_amount,tax_rate) VALUES
        (${orderItemId}::uuid,1,1000,10,10000,${orderId}::uuid,${companyId}::uuid,
          ${materialId}::uuid,${unitId}::uuid,${'M' + suffix},${prefix + '物料'},${prefix + '件'},1000,10,10000,0),
        (${orderItem2Id}::uuid,2,500,10,5000,${orderId}::uuid,${companyId}::uuid,
          ${material2Id}::uuid,${unitId}::uuid,${'N' + suffix},${prefix + '物料二'},${prefix + '件'},500,10,5000,0)
    `.execute(db)
    // 负库存校验需要先有结存
    await sql`
      INSERT INTO inv_stock_entry(id,company_id,warehouse_id,material_id,quantity,
        posting_date,voucher_type,voucher_id,voucher_no)
      VALUES (${crypto.randomUUID()}::uuid, ${companyId}::uuid, ${warehouseId}::uuid, ${materialId}::uuid,
        100000, now(), 'test.seed', ${crypto.randomUUID()}::uuid, ${prefix + '-SEED'})
    `.execute(db)
  })

  afterAll(async () => {
    await sql`DELETE FROM acc_gl_entry WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM inv_stock_entry WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sys_audit_log WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_delivery WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_order_item WHERE order_id=${orderId}::uuid`.execute(db)
    await sql`DELETE FROM sal_order WHERE id=${orderId}::uuid`.execute(db)
    await sql`DELETE FROM bas_account WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM inv_warehouse WHERE id=${warehouseId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material WHERE id IN (${materialId}::uuid, ${material2Id}::uuid)`.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id=${categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id=${unitId}::uuid`.execute(db)
    await sql`DELETE FROM sal_customers WHERE id=${customerId}::uuid`.execute(db)
    await sql`DELETE FROM bas_company WHERE id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id=${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  test('添加箱子：箱号单内自增、系统生成', async () => {
    const { head } = await newDeliveryWithItem()
    const b1 = await fulfillment.createPackBox(actor, { deliveryId: head.id })
    const b2 = await fulfillment.createPackBox(actor, { deliveryId: head.id })
    const b3 = await fulfillment.createPackBox(actor, { deliveryId: head.id })
    expect(b1.boxNo).toBe('1')
    expect(b2.boxNo).toBe('2')
    expect(b3.boxNo).toBe('3')
    // 另一张单从 1 重新计
    const other = await newDelivery()
    const ob = await fulfillment.createPackBox(actor, { deliveryId: other.id })
    expect(ob.boxNo).toBe('1')
  })

  test('装箱行必挂本单的箱', async () => {
    const { head } = await newDeliveryWithItem()
    const other = await newDelivery()
    const box = await fulfillment.createPackBox(actor, { deliveryId: head.id })
    const foreignBox = await fulfillment.createPackBox(actor, { deliveryId: other.id })
    const line = await fulfillment.createPackLine(actor, {
      deliveryId: head.id,
      idx: 1,
      packBoxId: box.id,
      qty: '5',
      materialId,
    })
    expect(line.packBoxId).toBe(box.id)
    const err = await fulfillment
      .createPackLine(actor, {
        deliveryId: head.id,
        idx: 2,
        packBoxId: foreignBox.id,
        qty: '5',
        materialId,
      })
      .then(
        () => null,
        (e) => e as { code?: string; fields?: Record<string, string[]> },
      )
    expect(err?.code).toBe('validation')
    expect(err?.fields?.packBoxId).toEqual(['须为本单的箱'])
  })

  test('删箱级联删除其装箱行', async () => {
    const { head } = await newDeliveryWithItem()
    const box = await fulfillment.createPackBox(actor, { deliveryId: head.id })
    const line = await fulfillment.createPackLine(actor, {
      deliveryId: head.id, idx: 1, packBoxId: box.id, qty: '5', materialId,
    })
    await fulfillment.deletePackBox(actor, box.id)
    await expect(fulfillment.getPackBox(actor, box.id)).rejects.toThrow(/不存在/)
    await expect(fulfillment.getPackLine(actor, line.id)).rejects.toThrow(/不存在/)
  })

  test('发货单删除级联删除箱与装箱行', async () => {
    const { head } = await newDeliveryWithItem()
    const box = await fulfillment.createPackBox(actor, { deliveryId: head.id })
    const line = await fulfillment.createPackLine(actor, {
      deliveryId: head.id, idx: 1, packBoxId: box.id, qty: '5', materialId,
    })
    await fulfillment.deleteHead(actor, 'sales', head.id)
    await expect(fulfillment.getPackBox(actor, box.id)).rejects.toThrow(/不存在/)
    await expect(fulfillment.getPackLine(actor, line.id)).rejects.toThrow(/不存在/)
  })

  test('审核后箱与装箱行锁死', async () => {
    const { head } = await newDeliveryWithItem('10')
    const box = await fulfillment.createPackBox(actor, { deliveryId: head.id })
    await fulfillment.createPackLine(actor, {
      deliveryId: head.id, idx: 1, packBoxId: box.id, qty: '10', materialId,
    })
    const audited = await fulfillment.auditHead(actor, 'sales', head.id)
    expect(audited.status).toBe('AUDITED')
    await expect(fulfillment.createPackBox(actor, { deliveryId: head.id })).rejects.toThrow()
    await expect(
      fulfillment.createPackLine(actor, {
        deliveryId: head.id, idx: 2, packBoxId: box.id, qty: '1', materialId,
      }),
    ).rejects.toThrow()
    await expect(fulfillment.deletePackBox(actor, box.id)).rejects.toThrow()
  })

  test('全有或全无回归：装箱与发货不一致拒审、一致放行', async () => {
    const bad = await newDeliveryWithItem('10')
    const badBox = await fulfillment.createPackBox(actor, { deliveryId: bad.head.id })
    await fulfillment.createPackLine(actor, {
      deliveryId: bad.head.id, idx: 1, packBoxId: badBox.id, qty: '8', materialId,
    })
    await expect(fulfillment.auditHead(actor, 'sales', bad.head.id)).rejects.toThrow(
      /装箱清单与发货量不一致/,
    )

    const good = await newDeliveryWithItem('10')
    const goodBox = await fulfillment.createPackBox(actor, { deliveryId: good.head.id })
    await fulfillment.createPackLine(actor, {
      deliveryId: good.head.id, idx: 1, packBoxId: goodBox.id, qty: '10', materialId,
    })
    const audited = await fulfillment.auditHead(actor, 'sales', good.head.id)
    expect(audited.status).toBe('AUDITED')
  })

  test('可先装箱后补条目：装箱行物料不强制属于本单发货条目', async () => {
    const { head } = await newDeliveryWithItem('10')
    const box = await fulfillment.createPackBox(actor, { deliveryId: head.id })
    // material2 不在本单发货条目上,草稿照常保存(一致性由审核全有或全无兜底)
    const line = await fulfillment.createPackLine(actor, {
      deliveryId: head.id, idx: 1, packBoxId: box.id, qty: '3', materialId: material2Id,
    })
    expect(line.materialId).toBe(material2Id)
  })

  test('全有或全无回归：漏装物料拒审', async () => {
    const { head } = await newDeliveryWithItem('10')
    await fulfillment.createItem(actor, 'sales', {
      headId: head.id, idx: 2, qty: '5', orderItemId: orderItem2Id, warehouseId,
    })
    const box = await fulfillment.createPackBox(actor, { deliveryId: head.id })
    await fulfillment.createPackLine(actor, {
      deliveryId: head.id, idx: 1, packBoxId: box.id, qty: '10', materialId,
    })
    await expect(fulfillment.auditHead(actor, 'sales', head.id)).rejects.toThrow(
      /发货有而装箱无/,
    )
  })

  test('全有或全无回归：含发货外物料拒审', async () => {
    const { head } = await newDeliveryWithItem('10')
    const box = await fulfillment.createPackBox(actor, { deliveryId: head.id })
    await fulfillment.createPackLine(actor, {
      deliveryId: head.id, idx: 1, packBoxId: box.id, qty: '10', materialId,
    })
    await fulfillment.createPackLine(actor, {
      deliveryId: head.id, idx: 2, packBoxId: box.id, qty: '3', materialId: material2Id,
    })
    await expect(fulfillment.auditHead(actor, 'sales', head.id)).rejects.toThrow(
      /装箱有而发货无/,
    )
  })

  test('装箱行可改挂同单另一箱', async () => {
    const { head } = await newDeliveryWithItem()
    const b1 = await fulfillment.createPackBox(actor, { deliveryId: head.id })
    const b2 = await fulfillment.createPackBox(actor, { deliveryId: head.id })
    const line = await fulfillment.createPackLine(actor, {
      deliveryId: head.id, idx: 1, packBoxId: b1.id, qty: '5', materialId,
    })
    const moved = await fulfillment.updatePackLine(actor, line.id, { packBoxId: b2.id })
    expect(moved.packBoxId).toBe(b2.id)
  })
})
