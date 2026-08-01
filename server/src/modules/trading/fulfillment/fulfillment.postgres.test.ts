/**
 * 履约聚合草稿 PG 集成：销售发货装箱箱与采购入库整单事务。
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
import type { AppEnv } from '~/platform/http/context.ts'
import { onError } from '~/platform/http/errors.ts'
import { createNumberingService } from '~/platform/numbering/index.ts'
import {
  packBoxRoutes,
  packLineRoutes,
  purchaseFulfillmentHeadRoutes,
  salesFulfillmentHeadRoutes,
  salesFulfillmentItemRoutes,
} from './routes.ts'
import {
  createFulfillmentService,
  type PurchaseReceiptDraftDto,
  type PurchaseReceiptDraftInput,
  type SalesDraftDto,
  type SalesDraftInput,
} from './service.ts'
import { fulfillmentItemMeta, packBoxMeta, packLineMeta } from './spec.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（履约聚合草稿）', () => {
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
  const customer2Id = crypto.randomUUID()
  const supplierId = crypto.randomUUID()
  const supplier2Id = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const material2Id = crypto.randomUUID()
  const warehouseId = crypto.randomUUID()
  const debitAccountId = crypto.randomUUID()
  const creditAccountId = crypto.randomUUID()
  const payableAccountId = crypto.randomUUID()
  const orderId = crypto.randomUUID()
  const orderItemId = crypto.randomUUID()
  const orderItem2Id = crypto.randomUUID()
  const order2Id = crypto.randomUUID()
  const order2ItemId = crypto.randomUUID()
  const purchaseOrderId = crypto.randomUUID()
  const purchaseOrderItemId = crypto.randomUUID()
  const purchaseOrder2Id = crypto.randomUUID()
  const purchaseOrder2ItemId = crypto.randomUUID()

  const actor: Actor = {
    userId: '',
    username: 'packbox-test',
    name: '装箱箱测试',
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  }
  const readOnlyActor: Actor = {
    ...actor,
    username: 'packbox-read-only',
    superAdmin: false,
    permissions: new Set(['sales.delivery:read']),
  }
  const noReadActor: Actor = {
    ...actor,
    username: 'packbox-no-read',
    superAdmin: false,
    permissions: new Set(),
  }
  function limitedActor(prefix: string, actions: Array<'read' | 'update' | 'create' | 'delete'>): Actor {
    return {
      ...actor,
      username: `${prefix}-${actions.join('-')}`,
      superAdmin: false,
      permissions: new Set(actions.map((action) => `${prefix}:${action}`)),
    }
  }
  const auth = {
    authenticate: async (token: string) => {
      if (token === 'read-only') return readOnlyActor
      if (token === 'no-read') return noReadActor
      return actor
    },
  } as unknown as AuthService
  const http = new Hono<AppEnv>()
    .route('/api/v1/sales/deliveries', salesFulfillmentHeadRoutes({ auth, fulfillment }))
    .route('/api/v1/sales/delivery-items', salesFulfillmentItemRoutes({ auth, fulfillment }))
    .route('/api/v1/sales/delivery-pack-boxes', packBoxRoutes({ auth, fulfillment }))
    .route('/api/v1/sales/delivery-pack-lines', packLineRoutes({ auth, fulfillment }))
    .route(
      '/api/v1/purchase/receipts',
      purchaseFulfillmentHeadRoutes({ auth, fulfillment }),
    )
  http.onError(onError)

  function draftInput(no: string, itemQty = '10', packQty = '10') {
    return {
      companyId,
      no,
      documentDate: '2026-07-25',
      postingDate: '2026-07-25',
      partyType: 'customer',
      partyId: customerId,
      warehouseId,
      debitAccountId,
      creditAccountId,
      items: [{
        idx: 1,
        qty: itemQty,
        orderItemId,
        warehouseId,
      }],
      packBoxes: [{
        lines: [{
          idx: 1,
          qty: packQty,
          materialId,
        }],
      }],
    }
  }
  function httpDraftInput(no: string, itemQty = '10', packQty = '10') {
    const input = draftInput(no, itemQty, packQty)
    const { no: deliveryNo, documentDate: deliveryDate, ...rest } = input
    return { ...rest, deliveryNo, deliveryDate }
  }
  function purchaseReceiptDraftInput(no: string, items = [{
    idx: 1,
    qty: '10',
    orderItemId: purchaseOrderItemId,
    warehouseId,
  }]) {
    return {
      companyId,
      no,
      documentDate: '2026-07-25',
      postingDate: '2026-07-25',
      partyType: 'supplier',
      partyId: supplierId,
      warehouseId,
      debitAccountId,
      creditAccountId: payableAccountId,
      items,
    }
  }
  function salesReplaceInput(saved: SalesDraftDto): SalesDraftInput {
    return {
      companyId: saved.companyId,
      no: saved.deliveryNo,
      documentDate: saved.deliveryDate,
      postingDate: saved.postingDate,
      partyType: saved.partyType,
      partyId: saved.partyId,
      remarks: saved.remarks,
      warehouseId: saved.warehouseId,
      debitAccountId: saved.debitAccountId,
      creditAccountId: saved.creditAccountId,
      items: saved.items.map((item) => ({
        id: item.id,
        idx: item.idx,
        qty: item.qty,
        orderItemId: item.orderItemId,
        unitId: item.unitId,
        warehouseId: item.warehouseId,
        remarks: item.remarks,
      })),
      packBoxes: saved.packBoxes.map((box) => ({
        id: box.id,
        lines: box.lines.map((line) => ({
          id: line.id,
          idx: line.idx,
          qty: line.qty,
          materialId: line.materialId,
          unitId: line.unitId,
          remarks: line.remarks,
        })),
      })),
    }
  }
  function purchaseReplaceInput(saved: PurchaseReceiptDraftDto): PurchaseReceiptDraftInput {
    return {
      companyId: saved.companyId,
      no: saved.receiptNo,
      documentDate: saved.receiptDate,
      postingDate: saved.postingDate,
      partyType: saved.partyType,
      partyId: saved.partyId,
      remarks: saved.remarks,
      warehouseId: saved.warehouseId,
      debitAccountId: saved.debitAccountId,
      creditAccountId: saved.creditAccountId,
      items: saved.items.map((item) => ({
        id: item.id,
        idx: item.idx,
        qty: item.qty,
        orderItemId: item.orderItemId,
        unitId: item.unitId,
        warehouseId: item.warehouseId,
        remarks: item.remarks,
      })),
    }
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
      VALUES
        (${customerId}::uuid, ${'CU' + suffix}, ${prefix + '客户'}, 'CU'),
        (${customer2Id}::uuid, ${'CV' + suffix}, ${prefix + '客户二'}, 'CV')
    `.execute(db)
    await sql`
      INSERT INTO pur_supplier(id,code,name,short_name)
      VALUES
        (${supplierId}::uuid, ${'SU' + suffix}, ${prefix + '供应商'}, 'SU'),
        (${supplier2Id}::uuid, ${'SV' + suffix}, ${prefix + '供应商二'}, 'SV')
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
        (${creditAccountId}::uuid, ${'SC' + suffix}, ${prefix + '销贷'}, 'credit', false, true, ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${payableAccountId}::uuid, ${'PC' + suffix}, ${prefix + '未开应付'}, 'credit', false, true, ${companyId}::uuid, ${currencyId}::uuid, 'unbilled_payable')
    `.execute(db)
    await sql`
      INSERT INTO sal_order(id,order_no,order_date,party_type,party_id,status,company_id,exchange_rate,currency_id,order_type)
      VALUES
        (${orderId}::uuid, ${prefix + '-SO'}, '2026-07-20', 'customer', ${customerId}::uuid,
          'audited', ${companyId}::uuid, 1, ${currencyId}::uuid, 'regular'),
        (${order2Id}::uuid, ${prefix + '-SO2'}, '2026-07-20', 'customer', ${customer2Id}::uuid,
          'audited', ${companyId}::uuid, 1, ${currencyId}::uuid, 'regular')
    `.execute(db)
    await sql`
      INSERT INTO sal_order_item(id,idx,qty,price,amount,order_id,company_id,material_id,unit_id,
        material_code,material_name,unit_name,base_qty,base_price,base_amount,tax_rate) VALUES
        (${orderItemId}::uuid,1,1000,10,10000,${orderId}::uuid,${companyId}::uuid,
          ${materialId}::uuid,${unitId}::uuid,${'M' + suffix},${prefix + '物料'},${prefix + '件'},1000,10,10000,0),
        (${orderItem2Id}::uuid,2,500,10,5000,${orderId}::uuid,${companyId}::uuid,
          ${material2Id}::uuid,${unitId}::uuid,${'N' + suffix},${prefix + '物料二'},${prefix + '件'},500,10,5000,0),
        (${order2ItemId}::uuid,1,500,10,5000,${order2Id}::uuid,${companyId}::uuid,
          ${material2Id}::uuid,${unitId}::uuid,${'N' + suffix},${prefix + '物料二'},${prefix + '件'},500,10,5000,0)
    `.execute(db)
    await sql`
      INSERT INTO pur_order(id,order_no,order_date,party_type,party_id,status,company_id,
        exchange_rate,currency_id,is_outsourced)
      VALUES
        (${purchaseOrderId}::uuid, ${prefix + '-PO'}, '2026-07-20', 'supplier',
          ${supplierId}::uuid, 'audited', ${companyId}::uuid, 1, ${currencyId}::uuid, false),
        (${purchaseOrder2Id}::uuid, ${prefix + '-PO2'}, '2026-07-20', 'supplier',
          ${supplier2Id}::uuid, 'audited', ${companyId}::uuid, 1, ${currencyId}::uuid, false)
    `.execute(db)
    await sql`
      INSERT INTO pur_order_item(
        id,idx,qty,base_qty,price,amount,order_id,company_id,material_id,unit_id,
        material_code,material_name,unit_name
      ) VALUES
        (${purchaseOrderItemId}::uuid,1,1000,1000,8,8000,${purchaseOrderId}::uuid,
          ${companyId}::uuid,${materialId}::uuid,${unitId}::uuid,
          ${'M' + suffix},${prefix + '物料'},${prefix + '件'}),
        (${purchaseOrder2ItemId}::uuid,1,500,500,8,4000,${purchaseOrder2Id}::uuid,
          ${companyId}::uuid,${material2Id}::uuid,${unitId}::uuid,
          ${'N' + suffix},${prefix + '物料二'},${prefix + '件'})
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
    await sql`DELETE FROM pur_receipt WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_order_item WHERE order_id IN (${purchaseOrderId}::uuid, ${purchaseOrder2Id}::uuid)`.execute(db)
    await sql`DELETE FROM pur_order WHERE id IN (${purchaseOrderId}::uuid, ${purchaseOrder2Id}::uuid)`.execute(db)
    await sql`DELETE FROM sal_order_item WHERE order_id IN (${orderId}::uuid, ${order2Id}::uuid)`.execute(db)
    await sql`DELETE FROM sal_order WHERE id IN (${orderId}::uuid, ${order2Id}::uuid)`.execute(db)
    await sql`DELETE FROM bas_account WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM inv_warehouse WHERE id=${warehouseId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material WHERE id IN (${materialId}::uuid, ${material2Id}::uuid)`.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id=${categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id=${unitId}::uuid`.execute(db)
    await sql`DELETE FROM sal_customers WHERE id IN (${customerId}::uuid, ${customer2Id}::uuid)`.execute(db)
    await sql`DELETE FROM pur_supplier WHERE id IN (${supplierId}::uuid, ${supplier2Id}::uuid)`.execute(db)
    await sql`DELETE FROM bas_company WHERE id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id=${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  test('整单创建在一个事务中返回完整权威草稿', async () => {
    const no = `${prefix}-ATOMIC-CREATE`
    const draft = await fulfillment.createSalesDraft(actor, draftInput(no))

    expect(draft.deliveryNo).toBe(no)
    expect(draft.status).toBe('DRAFT')
    expect(draft.items).toHaveLength(1)
    expect(draft.items[0]?.deliveryId).toBe(draft.id)
    expect(draft.items[0]?.materialId).toBe(materialId)
    expect(draft.packBoxes).toHaveLength(1)
    expect(draft.packBoxes[0]?.boxNo).toBe('1')
    expect(draft.packBoxes[0]?.lines).toHaveLength(1)
    expect(draft.packBoxes[0]?.lines[0]?.deliveryId).toBe(draft.id)
    expect(draft.packBoxes[0]?.lines[0]?.packBoxId).toBe(draft.packBoxes[0]?.id)
  })

  test('采购入库完整草稿经 Hono seam 整单创建、读取与替换', async () => {
    const no = `${prefix}-PUR-DRAFT`
    const serviceInput = purchaseReceiptDraftInput(no)
    const { no: receiptNo, documentDate: receiptDate, ...wireInput } = serviceInput
    const headers = {
      authorization: 'Bearer test',
      'content-type': 'application/json',
    }
    const createdResponse = await http.request('/api/v1/purchase/receipts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...wireInput, receiptNo, receiptDate }),
    })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as {
      id: string
      receiptNo: string
      items: Array<{ id: string; qty: string; receiptId: string }>
    }
    expect(created.receiptNo).toBe(no)
    expect(created.items).toHaveLength(1)
    expect(created.items[0]?.receiptId).toBe(created.id)

    const loadedResponse = await http.request(
      `/api/v1/purchase/receipts/${created.id}/draft`,
      { headers: { authorization: 'Bearer test' } },
    )
    expect(loadedResponse.status).toBe(200)
    expect(((await loadedResponse.json()) as { items: unknown[] }).items).toHaveLength(1)

    const replacedResponse = await http.request(
      `/api/v1/purchase/receipts/${created.id}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          ...wireInput,
          receiptNo,
          receiptDate,
          remarks: '整单替换',
          items: [{ ...wireInput.items[0], id: created.items[0]!.id, qty: '12' }],
        }),
      },
    )
    expect(replacedResponse.status).toBe(200)
    const replaced = await replacedResponse.json() as {
      remarks: string
      items: Array<{ id: string; qty: string }>
    }
    expect(replaced.remarks).toBe('整单替换')
    expect(replaced.items[0]?.id).toBe(created.items[0]?.id)
    expect(replaced.items[0]?.qty).toBe('12')
  })

  test('采购入库第二条明细失败时回滚表头与第一条明细', async () => {
    const no = `${prefix}-PUR-ROLLBACK`
    await expect(
      fulfillment.createPurchaseReceiptDraft(
        actor,
        purchaseReceiptDraftInput(no, [
          {
            idx: 1,
            qty: '10',
            orderItemId: purchaseOrderItemId,
            warehouseId,
          },
          {
            idx: 2,
            qty: '0',
            orderItemId: purchaseOrderItemId,
            warehouseId,
          },
        ]),
      ),
    ).rejects.toThrow(/入库条目参数不合法/)

    const heads = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM pur_receipt WHERE receipt_no=${no}
    `.execute(db)
    expect(heads.rows[0]?.count).toBe('0')
    const items = await sql<{ count: string }>`
      SELECT count(*)::text AS count
      FROM pur_receipt_item i
      JOIN pur_receipt h ON h.id=i.receipt_id
      WHERE h.receipt_no=${no}
    `.execute(db)
    expect(items.rows[0]?.count).toBe('0')
  })

  test('完整草稿读取覆盖超过默认分页的子记录且无静默截断', async () => {
    const no = `${prefix}-FULL-DRAFT`
    const created = await fulfillment.createSalesDraft(actor, draftInput(no))
    // 默认 list 上限 200；直接插入超过分页数量的条目，证明 getSalesDraft 不走分页
    const extra = 210
    for (let i = 0; i < extra; i++) {
      const itemId = crypto.randomUUID()
      await sql`
        INSERT INTO sal_delivery_item(
          id, idx, qty, base_qty, delivery_id, company_id, order_item_id,
          material_id, unit_id, warehouse_id,
          material_code, material_name, unit_name, order_no, order_unit_name,
          order_currency_code, reconciled_qty
        ) VALUES (
          ${itemId}::uuid, ${i + 2}, 1, 1, ${created.id}::uuid, ${companyId}::uuid,
          ${orderItemId}::uuid, ${materialId}::uuid, ${unitId}::uuid, ${warehouseId}::uuid,
          ${'M' + suffix}, ${prefix + '物料'}, ${prefix + '件'}, ${prefix + '-SO'},
          ${prefix + '件'}, ${'P' + suffix.slice(0, 2)}, 0
        )
      `.execute(db)
    }
    const expectedItems = 1 + extra

    const full = await fulfillment.getSalesDraft(actor, created.id)
    expect(full.items).toHaveLength(expectedItems)
    expect(full.packBoxes).toHaveLength(1)
    expect(full.packBoxes[0]?.lines).toHaveLength(1)

    // 对照：列表分页会截断
    const paged = await fulfillment.listItems(actor, 'sales', {
      limit: 50,
      offset: 0,
      filter: {
        deliveryId: { kind: 'fk', op: 'in', values: [created.id], labels: [] },
      },
    })
    expect(paged.count).toBe(expectedItems)
    expect(paged.results.length).toBe(50)
    expect(paged.results.length).toBeLessThan(expectedItems)

    // HTTP：GET /:id/draft 返回完整嵌套
    const res = await http.request(`/api/v1/sales/deliveries/${created.id}/draft`, {
      headers: { authorization: 'Bearer test' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[]; packBoxes: unknown[] }
    expect(body.items).toHaveLength(expectedItems)
    expect(body.packBoxes).toHaveLength(1)

    // 只读权限可读；无 read 权限拒绝
    const denied = await http.request(`/api/v1/sales/deliveries/${created.id}/draft`, {
      headers: { authorization: 'Bearer no-read' },
    })
    expect(denied.status).toBe(403)
  })

  test('整单创建的嵌套行失败时不残留表头、子记录或操作日志', async () => {
    const no = `${prefix}-ATOMIC-ROLLBACK`
    await expect(
      fulfillment.createSalesDraft(actor, draftInput(no, '10', '0')),
    ).rejects.toThrow(/装箱行参数不合法/)

    const heads = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM sal_delivery WHERE delivery_no=${no}
    `.execute(db)
    const items = await sql<{ n: string }>`
      SELECT count(*)::text AS n
      FROM sal_delivery_item i
      JOIN sal_delivery h ON h.id=i.delivery_id
      WHERE h.delivery_no=${no}
    `.execute(db)
    const logs = await sql<{ n: string }>`
      SELECT count(*)::text AS n
      FROM sys_audit_log
      WHERE company_id=${companyId}::uuid AND record_label=${no}
    `.execute(db)
    expect(heads.rows[0]?.n).toBe('0')
    expect(items.rows[0]?.n).toBe('0')
    expect(logs.rows[0]?.n).toBe('0')
  })

  test('整单 HTTP 的结构错误与领域错误使用同一 bracket 索引路径', async () => {
    const structureInput = {
      ...httpDraftInput(`${prefix}-HTTP-STRUCT`),
      packBoxes: [{ lines: [{ idx: 1, qty: 0, materialId }] }],
    }
    const structureResponse = await http.request('/api/v1/sales/deliveries', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify(structureInput),
    })
    expect(structureResponse.status).toBe(400)
    const structureBody = await structureResponse.json() as {
      error: { fields?: Record<string, string[]> }
    }
    expect(structureBody.error.fields?.['packBoxes[0].lines[0].qty']).toBeDefined()

    const domainInput = {
      ...structureInput,
      deliveryNo: `${prefix}-HTTP-DOMAIN`,
      packBoxes: [{ lines: [{ idx: 1, qty: '0', materialId }] }],
    }
    const domainResponse = await http.request('/api/v1/sales/deliveries', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify(domainInput),
    })
    expect(domainResponse.status).toBe(400)
    const domainBody = await domainResponse.json() as {
      error: { fields?: Record<string, string[]> }
    }
    expect(domainBody.error.fields?.['packBoxes[0].lines[0].qty']).toEqual(['必须大于 0'])

    const headerResponse = await http.request('/api/v1/sales/deliveries', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify(httpDraftInput('X'.repeat(33))),
    })
    expect(headerResponse.status).toBe(400)
    const headerBody = await headerResponse.json() as {
      error: { fields?: Record<string, string[]> }
    }
    expect(headerBody.error.fields?.['header.deliveryNo']).toBeDefined()
  })

  test('整单 HTTP 创建与替换返回完整权威草稿', async () => {
    const createResponse = await http.request('/api/v1/sales/deliveries', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify(httpDraftInput(`${prefix}-HTTP-SAVE`)),
    })
    expect(createResponse.status).toBe(201)
    const created = await createResponse.json() as {
      id: string
      items: Array<{ id: string }>
      packBoxes: Array<{ id: string; boxNo: string; lines: Array<{ id: string }> }>
    }
    expect(created.items[0]?.id).toBeTruthy()
    expect(created.packBoxes[0]?.boxNo).toBe('1')
    expect(created.packBoxes[0]?.lines[0]?.id).toBeTruthy()

    const partyResponse = await http.request(`/api/v1/sales/deliveries/${created.id}`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...httpDraftInput(`${prefix}-HTTP-SAVE`),
        partyType: 'COMPANY',
        partyId: companyId,
      }),
    })
    expect(partyResponse.status).toBe(400)
    const partyBody = await partyResponse.json() as {
      error: { fields?: Record<string, string[]> }
    }
    expect(partyBody.error.fields?.['header.partyType']).toBeUndefined()
    expect(partyBody.error.fields?.['header.partyId']).toBeDefined()

    const replaceResponse = await http.request(`/api/v1/sales/deliveries/${created.id}`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...httpDraftInput(`${prefix}-HTTP-SAVE`),
        remarks: 'HTTP 替换',
        items: [],
        packBoxes: [],
      }),
    })
    expect(replaceResponse.status).toBe(200)
    const replaced = await replaceResponse.json() as {
      remarks: string
      items: unknown[]
      packBoxes: unknown[]
    }
    expect(replaced.remarks).toBe('HTTP 替换')
    expect(replaced.items).toEqual([])
    expect(replaced.packBoxes).toEqual([])
  })

  test('整单创建与替换分别执行父单 create/update 权限', async () => {
    const deniedCreate = await http.request('/api/v1/sales/deliveries', {
      method: 'POST',
      headers: {
        authorization: 'Bearer read-only',
        'content-type': 'application/json',
      },
      body: JSON.stringify(httpDraftInput(`${prefix}-DENIED-CREATE`)),
    })
    expect(deniedCreate.status).toBe(403)

    const created = await fulfillment.createSalesDraft(
      actor,
      draftInput(`${prefix}-DENIED-UPDATE`),
    )
    const deniedReplace = await http.request(`/api/v1/sales/deliveries/${created.id}`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer read-only',
        'content-type': 'application/json',
      },
      body: JSON.stringify(httpDraftInput(created.deliveryNo)),
    })
    expect(deniedReplace.status).toBe(403)
  })

  test('销售发货子资源只保留 query/get，Meta 不再声明细粒度写能力', async () => {
    const created = await fulfillment.createSalesDraft(
      actor,
      draftInput(`${prefix}-READ-ONLY`),
    )
    const tokenHeaders = { authorization: 'Bearer test' }
    const jsonHeaders = { ...tokenHeaders, 'content-type': 'application/json' }

    expect(
      (await http.request(`/api/v1/sales/delivery-items/${created.items[0]!.id}`, {
        headers: tokenHeaders,
      })).status,
    ).toBe(200)
    expect(
      (await http.request(`/api/v1/sales/delivery-pack-boxes/${created.packBoxes[0]!.id}`, {
        headers: tokenHeaders,
      })).status,
    ).toBe(200)
    expect(
      (await http.request(
        `/api/v1/sales/delivery-pack-lines/${created.packBoxes[0]!.lines[0]!.id}`,
        { headers: tokenHeaders },
      )).status,
    ).toBe(200)

    for (const path of [
      '/api/v1/sales/delivery-items',
      '/api/v1/sales/delivery-pack-boxes',
      '/api/v1/sales/delivery-pack-lines',
    ]) {
      expect((await http.request(path, {
        method: 'POST',
        headers: jsonHeaders,
        body: '{}',
      })).status).toBe(404)
    }
    for (const path of [
      `/api/v1/sales/delivery-items/${created.items[0]!.id}`,
      `/api/v1/sales/delivery-pack-boxes/${created.packBoxes[0]!.id}`,
      `/api/v1/sales/delivery-pack-lines/${created.packBoxes[0]!.lines[0]!.id}`,
    ]) {
      expect((await http.request(path, { method: 'DELETE', headers: tokenHeaders })).status).toBe(404)
    }

    // contract：聚合草稿的子资源只读；采购入库旧 create/delete 语义由整单 diff 鉴权保留
    expect(fulfillmentItemMeta('sales').actions.some((a) => a.key === 'delete')).toBe(false)
    expect(packBoxMeta().actions.some((a) => a.key === 'delete')).toBe(false)
    expect(packLineMeta().actions.some((a) => a.key === 'delete')).toBe(false)
    expect(fulfillmentItemMeta('purchase').actions.some((a) => a.key === 'delete')).toBe(false)
  })

  test('整单替换以完整快照同时新增、修改和删除子记录', async () => {
    const no = `${prefix}-ATOMIC-REPLACE`
    const created = await fulfillment.createSalesDraft(actor, {
      ...draftInput(no),
      items: [
        { idx: 1, qty: '10', orderItemId, warehouseId },
        { idx: 2, qty: '5', orderItemId: orderItem2Id, warehouseId },
      ],
      packBoxes: [
        { lines: [{ idx: 1, qty: '10', materialId }] },
        { lines: [{ idx: 2, qty: '5', materialId: material2Id }] },
      ],
    })
    const keptItem = created.items[0]!
    const removedItem = created.items[1]!
    const keptBox = created.packBoxes[0]!
    const removedBox = created.packBoxes[1]!
    const keptLine = keptBox.lines[0]!
    const removedLine = removedBox.lines[0]!

    const replaced = await fulfillment.replaceSalesDraft(actor, created.id, {
      ...draftInput(no),
      remarks: '完整快照已替换',
      items: [
        { id: keptItem.id, idx: 1, qty: '12', orderItemId, warehouseId },
        { idx: 3, qty: '7', orderItemId: orderItem2Id, warehouseId },
      ],
      packBoxes: [
        {
          id: keptBox.id,
          lines: [
            { id: keptLine.id, idx: 1, qty: '12', materialId },
            { idx: 2, qty: '3', materialId: material2Id },
          ],
        },
        { lines: [{ idx: 3, qty: '4', materialId: material2Id }] },
      ],
    })

    expect(replaced.remarks).toBe('完整快照已替换')
    expect(replaced.items.map((item) => item.id)).toContain(keptItem.id)
    expect(replaced.items.find((item) => item.id === keptItem.id)?.qty).toBe('12')
    expect(replaced.items.map((item) => item.id)).not.toContain(removedItem.id)
    expect(replaced.items).toHaveLength(2)
    expect(replaced.packBoxes.map((box) => box.id)).toContain(keptBox.id)
    expect(replaced.packBoxes.map((box) => box.id)).not.toContain(removedBox.id)
    expect(replaced.packBoxes).toHaveLength(2)
    expect(replaced.packBoxes[0]?.lines.map((line) => line.id)).toContain(keptLine.id)
    await expect(fulfillment.getItem(actor, 'sales', removedItem.id)).rejects.toThrow(/不存在/)
    await expect(fulfillment.getPackLine(actor, removedLine.id)).rejects.toThrow(/不存在/)

    const cleared = await fulfillment.replaceSalesDraft(actor, created.id, {
      ...draftInput(no),
      items: [],
      packBoxes: [],
    })
    expect(cleared.items).toEqual([])
    expect(cleared.packBoxes).toEqual([])
  })

  test('整单替换先移除旧来源条目，允许同步切换往来方与新来源', async () => {
    const sales = await fulfillment.createSalesDraft(
      actor,
      draftInput(`${prefix}-SALES-PARTY-SWITCH`),
    )
    const replacedSales = await fulfillment.replaceSalesDraft(actor, sales.id, {
      ...salesReplaceInput(sales),
      partyId: customer2Id,
      items: [{ idx: 1, qty: '5', orderItemId: order2ItemId, warehouseId }],
      packBoxes: [],
    })
    expect(replacedSales.partyId).toBe(customer2Id)
    expect(replacedSales.items).toHaveLength(1)
    expect(replacedSales.items[0]?.id).not.toBe(sales.items[0]?.id)
    expect(replacedSales.items[0]?.orderItemId).toBe(order2ItemId)

    const purchase = await fulfillment.createPurchaseReceiptDraft(
      actor,
      purchaseReceiptDraftInput(`${prefix}-PUR-PARTY-SWITCH`),
    )
    const replacedPurchase = await fulfillment.replacePurchaseReceiptDraft(
      actor,
      purchase.id,
      {
        ...purchaseReplaceInput(purchase),
        partyId: supplier2Id,
        items: [{ idx: 1, qty: '5', orderItemId: purchaseOrder2ItemId, warehouseId }],
      },
    )
    expect(replacedPurchase.partyId).toBe(supplier2Id)
    expect(replacedPurchase.items).toHaveLength(1)
    expect(replacedPurchase.items[0]?.id).not.toBe(purchase.items[0]?.id)
    expect(replacedPurchase.items[0]?.orderItemId).toBe(purchaseOrder2ItemId)
  })

  test('切换往来方后若新子项失败，销售与采购完整草稿均回滚', async () => {
    const sales = await fulfillment.createSalesDraft(
      actor,
      draftInput(`${prefix}-S-PTY-RB`),
    )
    const salesBefore = await fulfillment.getSalesDraft(actor, sales.id)
    await expect(
      fulfillment.replaceSalesDraft(actor, sales.id, {
        ...salesReplaceInput(salesBefore),
        partyId: customer2Id,
        items: [
          { idx: 1, qty: '5', orderItemId: order2ItemId, warehouseId },
          { idx: 2, qty: '0', orderItemId: order2ItemId, warehouseId },
        ],
        packBoxes: [],
      }),
    ).rejects.toThrow(/发货条目参数不合法/)
    expect(await fulfillment.getSalesDraft(actor, sales.id)).toEqual(salesBefore)

    const purchase = await fulfillment.createPurchaseReceiptDraft(
      actor,
      purchaseReceiptDraftInput(`${prefix}-PUR-PARTY-ROLLBACK`),
    )
    const purchaseBefore = await fulfillment.getPurchaseReceiptDraft(actor, purchase.id)
    await expect(
      fulfillment.replacePurchaseReceiptDraft(actor, purchase.id, {
        ...purchaseReplaceInput(purchaseBefore),
        partyId: supplier2Id,
        items: [
          { idx: 1, qty: '5', orderItemId: purchaseOrder2ItemId, warehouseId },
          { idx: 2, qty: '0', orderItemId: purchaseOrder2ItemId, warehouseId },
        ],
      }),
    ).rejects.toThrow(/入库条目参数不合法/)
    expect(await fulfillment.getPurchaseReceiptDraft(actor, purchase.id)).toEqual(purchaseBefore)
  })

  test('销售发货保持既有 Aggregate Draft 授权：update 可同时增删子树', async () => {
    const created = await fulfillment.createSalesDraft(
      actor,
      draftInput(`${prefix}-SALES-UPDATE-ONLY`),
    )
    const replaced = await fulfillment.replaceSalesDraft(
      limitedActor('sales.delivery', ['update']),
      created.id,
      {
        ...salesReplaceInput(created),
        items: [{ idx: 1, qty: '3', orderItemId: orderItem2Id, warehouseId }],
        packBoxes: [],
      },
    )
    expect(replaced.items).toHaveLength(1)
    expect(replaced.items[0]?.id).not.toBe(created.items[0]?.id)
    expect(replaced.packBoxes).toEqual([])
  })

  test('采购入库替换按子项差异追加 create/delete 权限', async () => {
    const created = await fulfillment.createPurchaseReceiptDraft(
      actor,
      purchaseReceiptDraftInput(`${prefix}-PUR-DIFF-RBAC`),
    )
    const updateOnly = limitedActor('purchase.receipt', ['update'])
    const pureUpdate = await fulfillment.replacePurchaseReceiptDraft(
      updateOnly,
      created.id,
      { ...purchaseReplaceInput(created), remarks: '只改现有内容' },
    )
    expect(pureUpdate.remarks).toBe('只改现有内容')

    const addItem = {
      ...purchaseReplaceInput(pureUpdate),
      items: [
        ...purchaseReplaceInput(pureUpdate).items,
        { idx: 2, qty: '2', orderItemId: purchaseOrderItemId, warehouseId },
      ],
    }
    await expect(
      fulfillment.replacePurchaseReceiptDraft(updateOnly, created.id, addItem),
    ).rejects.toMatchObject({ code: 'forbidden' })

    const withAdded = await fulfillment.replacePurchaseReceiptDraft(
      limitedActor('purchase.receipt', ['update', 'create']),
      created.id,
      addItem,
    )
    expect(withAdded.items).toHaveLength(2)

    const removeAdded = {
      ...purchaseReplaceInput(withAdded),
      items: purchaseReplaceInput(withAdded).items.filter(
        (item) => item.id === created.items[0]?.id,
      ),
    }
    await expect(
      fulfillment.replacePurchaseReceiptDraft(updateOnly, created.id, removeAdded),
    ).rejects.toMatchObject({ code: 'forbidden' })

    const withoutAdded = await fulfillment.replacePurchaseReceiptDraft(
      limitedActor('purchase.receipt', ['update', 'delete']),
      created.id,
      removeAdded,
    )
    expect(withoutAdded.items.map((item) => item.id)).toEqual([created.items[0]!.id])
  })

  test('整单替换的嵌套行失败时保持保存前的完整草稿', async () => {
    const no = `${prefix}-ARR`
    const created = await fulfillment.createSalesDraft(actor, draftInput(no))
    const item = created.items[0]!
    const box = created.packBoxes[0]!
    const line = box.lines[0]!

    await expect(
      fulfillment.replaceSalesDraft(actor, created.id, {
        ...draftInput(no),
        remarks: '不应落库',
        items: [{ id: item.id, idx: 1, qty: '99', orderItemId, warehouseId }],
        packBoxes: [{
          id: box.id,
          lines: [{ id: line.id, idx: 1, qty: '0', materialId }],
        }],
      }),
    ).rejects.toThrow(/装箱行参数不合法/)

    expect((await fulfillment.getHead(actor, 'sales', created.id)).remarks).toBeNull()
    expect((await fulfillment.getItem(actor, 'sales', item.id)).qty).toBe('10')
    expect((await fulfillment.getPackLine(actor, line.id)).qty).toBe('10')
  })

  test('整单替换拒绝未知、跨单和重复的子记录身份并返回索引路径', async () => {
    const first = await fulfillment.createSalesDraft(
      actor,
      draftInput(`${prefix}-ATOMIC-ID-A`),
    )
    const second = await fulfillment.createSalesDraft(
      actor,
      draftInput(`${prefix}-ATOMIC-ID-B`),
    )
    const firstItem = first.items[0]!
    const firstBox = first.packBoxes[0]!
    const firstLine = firstBox.lines[0]!

    const invalidDrafts = [
      {
        input: {
          ...draftInput(first.deliveryNo),
          items: [{ id: crypto.randomUUID(), idx: 1, qty: '10', orderItemId, warehouseId }],
          packBoxes: [],
        },
        field: 'items[0].id',
      },
      {
        input: {
          ...draftInput(first.deliveryNo),
          items: [{
            id: second.items[0]!.id,
            idx: 1,
            qty: '10',
            orderItemId,
            warehouseId,
          }],
          packBoxes: [],
        },
        field: 'items[0].id',
      },
      {
        input: {
          ...draftInput(first.deliveryNo),
          items: [
            { id: firstItem.id, idx: 1, qty: '10', orderItemId, warehouseId },
            { id: firstItem.id, idx: 2, qty: '10', orderItemId, warehouseId },
          ],
          packBoxes: [],
        },
        field: 'items[1].id',
      },
      {
        input: {
          ...draftInput(first.deliveryNo),
          items: [{ id: firstItem.id, idx: 1, qty: '10', orderItemId, warehouseId }],
          packBoxes: [
            { id: firstBox.id, lines: [] },
            { id: firstBox.id, lines: [] },
          ],
        },
        field: 'packBoxes[1].id',
      },
      {
        input: {
          ...draftInput(first.deliveryNo),
          items: [{ id: firstItem.id, idx: 1, qty: '10', orderItemId, warehouseId }],
          packBoxes: [{
            id: firstBox.id,
            lines: [
              { id: firstLine.id, idx: 1, qty: '10', materialId },
              { id: firstLine.id, idx: 2, qty: '10', materialId },
            ],
          }],
        },
        field: 'packBoxes[0].lines[1].id',
      },
    ]

    for (const invalid of invalidDrafts) {
      const error = await fulfillment
        .replaceSalesDraft(actor, first.id, invalid.input)
        .then(
          () => null,
          (caught) => caught as { fields?: Record<string, string[]> },
        )
      expect(error?.fields?.[invalid.field]).toBeDefined()
    }
  })

  test('发货单删除级联删除箱与装箱行', async () => {
    const draft = await fulfillment.createSalesDraft(
      actor,
      draftInput(`${prefix}-CASCADE`),
    )
    const box = draft.packBoxes[0]!
    const line = box.lines[0]!
    await fulfillment.deleteHead(actor, 'sales', draft.id)
    await expect(fulfillment.getPackBox(actor, box.id)).rejects.toThrow(/不存在/)
    await expect(fulfillment.getPackLine(actor, line.id)).rejects.toThrow(/不存在/)
  })

  test('审核后整单替换锁死', async () => {
    const input = draftInput(`${prefix}-LOCKED`)
    const draft = await fulfillment.createSalesDraft(actor, input)
    const audited = await fulfillment.auditHead(actor, 'sales', draft.id)
    expect(audited.status).toBe('AUDITED')
    await expect(fulfillment.replaceSalesDraft(actor, draft.id, input)).rejects.toThrow(
      /仅草稿销售发货单可编辑/,
    )
  })

  test('全有或全无回归：装箱与发货不一致拒审、一致放行', async () => {
    const bad = await fulfillment.createSalesDraft(
      actor,
      draftInput(`${prefix}-BAD-PACK`, '10', '8'),
    )
    await expect(fulfillment.auditHead(actor, 'sales', bad.id)).rejects.toThrow(
      /装箱清单与发货量不一致/,
    )

    const good = await fulfillment.createSalesDraft(
      actor,
      draftInput(`${prefix}-GOOD-PACK`),
    )
    const audited = await fulfillment.auditHead(actor, 'sales', good.id)
    expect(audited.status).toBe('AUDITED')
  })

  test('可先装箱后补条目：装箱行物料不强制属于本单发货条目', async () => {
    const draft = await fulfillment.createSalesDraft(actor, {
      ...draftInput(`${prefix}-PACK-FIRST`),
      items: [],
      packBoxes: [{
        lines: [{ idx: 1, qty: '3', materialId: material2Id }],
      }],
    })
    expect(draft.packBoxes[0]?.lines[0]?.materialId).toBe(material2Id)
  })
})
