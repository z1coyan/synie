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
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { onError } from '~/platform/http/errors.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
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
import {
  fulfillmentItemMeta,
  fulfillmentSpec,
  packBoxMeta,
  packLineMeta,
  PACK_BOX_RESOURCE,
  PACK_LINE_RESOURCE,
} from './spec.ts'
import { testActor } from '~/platform/authz/testing.ts'


/** 编号服务与授权判定共用同一份 sealed registry（授权归宿解析） */
const registry = createSealedResourceRegistry()
const SAL_HEAD = fulfillmentSpec('sales').headResource
const SAL_ITEM = fulfillmentSpec('sales').itemResource
const PUR_HEAD = fulfillmentSpec('purchase').headResource
const PUR_ITEM = fulfillmentSpec('purchase').itemResource
const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（履约聚合草稿）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db, buildNumberingCatalog(registry), registry)
  const authz = createAuthzEnforcer(registry)
  const fulfillment = createFulfillmentService(db, numbering, {
    inventory: createInventoryEngine(),
    gl: createGlEngine(),
  }, registry)
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

  const actor: Actor = testActor({
    userId: '',
    username: 'packbox-test',
    name: '装箱箱测试',
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })
  const readOnlyActor: Actor = testActor({
    ...actor,
    username: 'packbox-read-only',
    superAdmin: false,
    permissions: new Set(['sales.delivery:read']),
  })
  const noReadActor: Actor = testActor({
    ...actor,
    username: 'packbox-no-read',
    superAdmin: false,
    permissions: new Set(),
  })
  type LimitedAction = 'read' | 'update' | 'create' | 'delete' | 'audit' | 'void'
  function limitedActor(prefix: string, actions: LimitedAction[]): Actor {
    return testActor({
      ...actor,
      username: `${prefix}-${actions.join('-')}`,
      superAdmin: false,
      permissions: new Set(actions.map((action) => `${prefix}:${action}`)),
    })
  }
  /**
   * 别名回归专用：非 superAdmin 的公司域 actor。superAdmin 的 rowFilter 是 bypass，
   * 编译成 `true`，listAuthorized 的 alias 写错测不出来。
   */
  const scopedActor: Actor = testActor({
    userId: '',
    username: 'packbox-scoped',
    superAdmin: false,
    allCompanies: false,
    companyIds: [companyId],
    permissions: new Set(['sales.delivery:read', 'purchase.receipt:read']),
  })
  /** 跨公司：授权公司集合不含本单公司 → 单条一律 not_found，列表空集 */
  const foreignActor: Actor = testActor({
    userId: '',
    username: 'packbox-foreign',
    superAdmin: false,
    allCompanies: false,
    companyIds: [crypto.randomUUID()],
    permissions: new Set(['sales.delivery:read', 'purchase.receipt:read']),
  })
  /** 服务级凭证每次现取（actor 在夹具间可换；缺码 403 一律在 HTTP 层验） */
  function p(resource: string, action: string, who: Actor = actor) {
    const decision = authz.decideFor(who, resource, action)
    if (decision.outcome !== 'permit') {
      throw new Error(`夹具应当 permit: ${resource}:${action}`)
    }
    return decision.permit
  }
  const tokens: Record<string, Actor> = {
    'read-only': readOnlyActor,
    'no-read': noReadActor,
    'sal-update-only': limitedActor('sales.delivery', ['read', 'update']),
    'sal-replace': limitedActor('sales.delivery', ['read', 'update', 'create', 'delete']),
    'pur-update-only': limitedActor('purchase.receipt', ['read', 'update']),
    'pur-replace': limitedActor('purchase.receipt', ['read', 'update', 'create', 'delete']),
    foreign: foreignActor,
  }
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
    .route('/api/v1/sales/deliveries', salesFulfillmentHeadRoutes({ auth, authz, fulfillment }))
    .route('/api/v1/sales/delivery-items', salesFulfillmentItemRoutes({ auth, authz, fulfillment }))
    .route('/api/v1/sales/delivery-pack-boxes', packBoxRoutes({ auth, authz, fulfillment }))
    .route('/api/v1/sales/delivery-pack-lines', packLineRoutes({ auth, authz, fulfillment }))
    .route(
      '/api/v1/purchase/receipts',
      purchaseFulfillmentHeadRoutes({ auth, authz, fulfillment }),
    )
  http.onError(onError)

  /** 编号由系统按规则生成：create 入参不再携带 no（手填即 400「编号由系统生成,不接受手填」） */
  function draftInput(itemQty = '10', packQty = '10', remarks: string | null = null) {
    return {
      companyId,
      documentDate: '2026-07-25',
      postingDate: '2026-07-25',
      partyType: 'customer',
      partyId: customerId,
      remarks,
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
  function httpDraftInput(itemQty = '10', packQty = '10') {
    const input = draftInput(itemQty, packQty)
    const { documentDate: deliveryDate, ...rest } = input
    return { ...rest, deliveryDate }
  }
  function purchaseReceiptDraftInput(items = [{
    idx: 1,
    qty: '10',
    orderItemId: purchaseOrderItemId,
    warehouseId,
  }], remarks: string | null = null) {
    return {
      companyId,
      documentDate: '2026-07-25',
      postingDate: '2026-07-25',
      partyType: 'supplier',
      partyId: supplierId,
      remarks,
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

  /** 本测自建的编号规则（afterAll 回收；复用的他人规则不动） */
  const createdRuleIds: string[] = []

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
      INSERT INTO inv_warehouse(id,name,code,company_id)
      VALUES (${warehouseId}::uuid, ${prefix + '仓'}, ${'W' + suffix}, ${companyId}::uuid)
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

    // 单据编号规则不由迁移播种：已有启用规则则复用，否则建本测前缀规则
    for (const [resource, tag] of [
      ['sales.delivery', 'SD'],
      ['purchase.receipt', 'PR'],
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
            { type: 'text', value: `T${suffix}${tag}-` },
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
    const draft = await fulfillment.createSalesDraft(p(SAL_HEAD, 'create'), draftInput())

    // 编号由系统按规则生成
    expect(draft.deliveryNo.length).toBeGreaterThan(0)
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

  test('装箱箱/装箱行写路径落审计：创建、改行、删行删箱', async () => {
    const draft = await fulfillment.createSalesDraft(p(SAL_HEAD, 'create'), draftInput())
    const box = draft.packBoxes[0]!
    const line = box.lines[0]!

    const packAudit = (recordId: string) => sql<{
      action_name: string
      record_label: string | null
      changes: string
    }>`
      SELECT action_name, record_label, changes::text AS changes
      FROM sys_audit_log
      WHERE resource IN ('sal_delivery_pack_box', 'sal_delivery_pack_line')
        AND record_id=${recordId}::uuid
      ORDER BY inserted_at
    `.execute(db)

    // 整单创建：箱与行各留 create
    const boxCreated = await packAudit(box.id)
    expect(boxCreated.rows.map((r) => r.action_name)).toEqual(['create'])
    expect(boxCreated.rows[0]?.record_label).toBe('1')
    const lineCreated = await packAudit(line.id)
    expect(lineCreated.rows.map((r) => r.action_name)).toEqual(['create'])
    expect(lineCreated.rows[0]?.record_label).toBe('1')
    const createChanges = JSON.parse(lineCreated.rows[0]!.changes) as Record<
      string,
      { to?: unknown }
    >
    expect(createChanges.qty?.to).toBe('10')
    expect(createChanges.pack_box_id?.to).toBe(box.id)

    // 全量替换但快照未变：不追加装箱审计
    const unchanged = salesReplaceInput(await fulfillment.getSalesDraft(p(SAL_HEAD, 'read'), draft.id))
    await fulfillment.replaceSalesDraft(p(SAL_HEAD, 'update'), draft.id, unchanged)
    expect((await packAudit(line.id)).rows).toHaveLength(1)

    // 替换改行数量：update 留 diff
    const modified = salesReplaceInput(await fulfillment.getSalesDraft(p(SAL_HEAD, 'read'), draft.id))
    modified.packBoxes[0]!.lines[0]!.qty = '6'
    await fulfillment.replaceSalesDraft(p(SAL_HEAD, 'update'), draft.id, modified)
    const lineUpdated = await packAudit(line.id)
    expect(lineUpdated.rows.map((r) => r.action_name)).toEqual(['create', 'update'])
    const updateChanges = JSON.parse(lineUpdated.rows[1]!.changes) as Record<
      string,
      { from?: unknown; to?: unknown }
    >
    expect(updateChanges.qty).toEqual({ from: '10', to: '6' })

    // 替换清空装箱：行与箱各留 destroy
    const cleared = salesReplaceInput(await fulfillment.getSalesDraft(p(SAL_HEAD, 'read'), draft.id))
    cleared.packBoxes = []
    await fulfillment.replaceSalesDraft(p(SAL_HEAD, 'update'), draft.id, cleared)
    const lineFinal = await packAudit(line.id)
    expect(lineFinal.rows.map((r) => r.action_name)).toEqual(['create', 'update', 'destroy'])
    const destroyChanges = JSON.parse(lineFinal.rows[2]!.changes) as Record<
      string,
      { from?: unknown }
    >
    expect(destroyChanges.qty?.from).toBe('6')
    const boxFinal = await packAudit(box.id)
    expect(boxFinal.rows.map((r) => r.action_name)).toEqual(['create', 'destroy'])
  })

  test('采购入库完整草稿经 Hono seam 整单创建、读取与替换', async () => {
    const serviceInput = purchaseReceiptDraftInput()
    const { documentDate: receiptDate, ...wireInput } = serviceInput
    const headers = {
      authorization: 'Bearer test',
      'content-type': 'application/json',
    }
    const createdResponse = await http.request('/api/v1/purchase/receipts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...wireInput, receiptDate }),
    })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as {
      id: string
      receiptNo: string
      items: Array<{ id: string; qty: string; receiptId: string }>
    }
    // 编号由系统按规则生成
    expect(created.receiptNo.length).toBeGreaterThan(0)
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
          receiptNo: created.receiptNo,
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
    // 系统编号无法预知失败单的单号：用唯一备注做残留探针
    const marker = `${prefix}-PUR-ROLLBACK`
    await expect(
      fulfillment.createPurchaseReceiptDraft(
        p(PUR_HEAD, 'create'),
        purchaseReceiptDraftInput([
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
        ], marker),
      ),
    ).rejects.toThrow(/入库条目参数不合法/)

    const heads = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM pur_receipt
      WHERE company_id=${companyId}::uuid AND remarks=${marker}
    `.execute(db)
    expect(heads.rows[0]?.count).toBe('0')
    const items = await sql<{ count: string }>`
      SELECT count(*)::text AS count
      FROM pur_receipt_item i
      JOIN pur_receipt h ON h.id=i.receipt_id
      WHERE h.company_id=${companyId}::uuid AND h.remarks=${marker}
    `.execute(db)
    expect(items.rows[0]?.count).toBe('0')
  })

  test('完整草稿读取覆盖超过默认分页的子记录且无静默截断', async () => {
    const created = await fulfillment.createSalesDraft(p(SAL_HEAD, 'create'), draftInput())
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

    const full = await fulfillment.getSalesDraft(p(SAL_HEAD, 'read'), created.id)
    expect(full.items).toHaveLength(expectedItems)
    expect(full.packBoxes).toHaveLength(1)
    expect(full.packBoxes[0]?.lines).toHaveLength(1)

    // 对照：列表分页会截断
    const paged = await fulfillment.listItems(p(SAL_ITEM, 'read'), 'sales', {
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
    // 系统编号无法预知失败单的单号：用唯一备注做残留探针（审计 changes 含 remarks 快照）
    const marker = `${prefix}-ATOMIC-ROLLBACK`
    await expect(
      fulfillment.createSalesDraft(p(SAL_HEAD, 'create'), draftInput('10', '0', marker)),
    ).rejects.toThrow(/装箱行参数不合法/)

    const heads = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM sal_delivery
      WHERE company_id=${companyId}::uuid AND remarks=${marker}
    `.execute(db)
    const items = await sql<{ n: string }>`
      SELECT count(*)::text AS n
      FROM sal_delivery_item i
      JOIN sal_delivery h ON h.id=i.delivery_id
      WHERE h.company_id=${companyId}::uuid AND h.remarks=${marker}
    `.execute(db)
    const logs = await sql<{ n: string }>`
      SELECT count(*)::text AS n
      FROM sys_audit_log
      WHERE company_id=${companyId}::uuid AND resource='sal_delivery'
        AND changes::text LIKE ${'%' + marker + '%'}
    `.execute(db)
    expect(heads.rows[0]?.n).toBe('0')
    expect(items.rows[0]?.n).toBe('0')
    expect(logs.rows[0]?.n).toBe('0')
  })

  test('整单 HTTP 的结构错误与领域错误使用同一 bracket 索引路径', async () => {
    const structureInput = {
      ...httpDraftInput(),
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

    // 手填编号行为用例：create 传 deliveryNo 一律拒绝（编号由系统按规则生成）
    const headerResponse = await http.request('/api/v1/sales/deliveries', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...httpDraftInput(), deliveryNo: 'X'.repeat(33) }),
    })
    expect(headerResponse.status).toBe(400)
    const headerBody = await headerResponse.json() as {
      error: { message: string; fields?: Record<string, string[]> }
    }
    expect(headerBody.error.message).toBe('编号由系统生成,不接受手填')
    expect(headerBody.error.fields?.['header.deliveryNo']).toEqual(['编号由系统生成,不接受手填'])
  })

  test('整单 HTTP 创建与替换返回完整权威草稿', async () => {
    const createResponse = await http.request('/api/v1/sales/deliveries', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify(httpDraftInput()),
    })
    expect(createResponse.status).toBe(201)
    const created = await createResponse.json() as {
      id: string
      deliveryNo: string
      items: Array<{ id: string }>
      packBoxes: Array<{ id: string; boxNo: string; lines: Array<{ id: string }> }>
    }
    expect(created.deliveryNo.length).toBeGreaterThan(0)
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
        ...httpDraftInput(),
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
        ...httpDraftInput(),
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
      body: JSON.stringify(httpDraftInput()),
    })
    expect(deniedCreate.status).toBe(403)

    const created = await fulfillment.createSalesDraft(
      p(SAL_HEAD, 'create'),
      draftInput(),
    )
    const deniedReplace = await http.request(`/api/v1/sales/deliveries/${created.id}`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer read-only',
        'content-type': 'application/json',
      },
      body: JSON.stringify(httpDraftInput()),
    })
    expect(deniedReplace.status).toBe(403)
  })

  test('销售发货子资源只保留 query/get，Meta 不再声明细粒度写能力', async () => {
    const created = await fulfillment.createSalesDraft(
      p(SAL_HEAD, 'create'),
      draftInput(),
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
    const created = await fulfillment.createSalesDraft(p(SAL_HEAD, 'create'), {
      ...draftInput(),
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

    const replaced = await fulfillment.replaceSalesDraft(p(SAL_HEAD, 'update'), created.id, {
      ...draftInput(),
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
    await expect(fulfillment.getItem(p(SAL_ITEM, 'read'), 'sales', removedItem.id)).rejects.toThrow(/不存在/)
    await expect(fulfillment.getPackLine(p(PACK_LINE_RESOURCE, 'read'), removedLine.id)).rejects.toThrow(/不存在/)

    const cleared = await fulfillment.replaceSalesDraft(p(SAL_HEAD, 'update'), created.id, {
      ...draftInput(),
      items: [],
      packBoxes: [],
    })
    expect(cleared.items).toEqual([])
    expect(cleared.packBoxes).toEqual([])
  })

  test('整单替换先移除旧来源条目，允许同步切换往来方与新来源', async () => {
    const sales = await fulfillment.createSalesDraft(
      p(SAL_HEAD, 'create'),
      draftInput(),
    )
    const replacedSales = await fulfillment.replaceSalesDraft(p(SAL_HEAD, 'update'), sales.id, {
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
      p(PUR_HEAD, 'create'),
      purchaseReceiptDraftInput(),
    )
    const replacedPurchase = await fulfillment.replacePurchaseReceiptDraft(
      p(PUR_HEAD, 'update'),
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
      p(SAL_HEAD, 'create'),
      draftInput(),
    )
    const salesBefore = await fulfillment.getSalesDraft(p(SAL_HEAD, 'read'), sales.id)
    await expect(
      fulfillment.replaceSalesDraft(p(SAL_HEAD, 'update'), sales.id, {
        ...salesReplaceInput(salesBefore),
        partyId: customer2Id,
        items: [
          { idx: 1, qty: '5', orderItemId: order2ItemId, warehouseId },
          { idx: 2, qty: '0', orderItemId: order2ItemId, warehouseId },
        ],
        packBoxes: [],
      }),
    ).rejects.toThrow(/发货条目参数不合法/)
    expect(await fulfillment.getSalesDraft(p(SAL_HEAD, 'read'), sales.id)).toEqual(salesBefore)

    const purchase = await fulfillment.createPurchaseReceiptDraft(
      p(PUR_HEAD, 'create'),
      purchaseReceiptDraftInput(),
    )
    const purchaseBefore = await fulfillment.getPurchaseReceiptDraft(p(PUR_HEAD, 'read'), purchase.id)
    await expect(
      fulfillment.replacePurchaseReceiptDraft(p(PUR_HEAD, 'update'), purchase.id, {
        ...purchaseReplaceInput(purchaseBefore),
        partyId: supplier2Id,
        items: [
          { idx: 1, qty: '5', orderItemId: purchaseOrder2ItemId, warehouseId },
          { idx: 2, qty: '0', orderItemId: purchaseOrder2ItemId, warehouseId },
        ],
      }),
    ).rejects.toThrow(/入库条目参数不合法/)
    expect(await fulfillment.getPurchaseReceiptDraft(p(PUR_HEAD, 'read'), purchase.id)).toEqual(purchaseBefore)
  })

  test('整单替换的子树增删不再在服务层判权（服务层零 forbidden）', async () => {
    // 语义变化：旧实现按子项差异动态 requirePerm 并抛 forbidden；
    // 新形态由路由 guard(update, allOf[create, delete]) 承担，服务层只收 Permit。
    const sales = await fulfillment.createSalesDraft(
      p(SAL_HEAD, 'create'),
      draftInput(),
    )
    const replacedSales = await fulfillment.replaceSalesDraft(
      p(SAL_HEAD, 'update'),
      sales.id,
      {
        ...salesReplaceInput(sales),
        items: [{ idx: 1, qty: '3', orderItemId: orderItem2Id, warehouseId }],
        packBoxes: [],
      },
    )
    expect(replacedSales.items).toHaveLength(1)
    expect(replacedSales.items[0]?.id).not.toBe(sales.items[0]?.id)
    expect(replacedSales.packBoxes).toEqual([])

    const purchase = await fulfillment.createPurchaseReceiptDraft(
      p(PUR_HEAD, 'create'),
      purchaseReceiptDraftInput(),
    )
    // 只带 update 码的主体也能拿到凭证（allOf 由路由声明，不在服务层）
    const updateOnlyPermit = p(PUR_HEAD, 'update', limitedActor('purchase.receipt', ['update']))
    const added = await fulfillment.replacePurchaseReceiptDraft(updateOnlyPermit, purchase.id, {
      ...purchaseReplaceInput(purchase),
      items: [
        ...purchaseReplaceInput(purchase).items,
        { idx: 2, qty: '2', orderItemId: purchaseOrderItemId, warehouseId },
      ],
    })
    expect(added.items).toHaveLength(2)

    const removed = await fulfillment.replacePurchaseReceiptDraft(updateOnlyPermit, purchase.id, {
      ...purchaseReplaceInput(added),
      items: purchaseReplaceInput(added).items.filter((item) => item.id === purchase.items[0]?.id),
    })
    expect(removed.items.map((item) => item.id)).toEqual([purchase.items[0]!.id])
  })

  test('缺码 403：整单 PUT 要求 update ∧ create ∧ delete（HTTP 层）', async () => {
    const jsonHeaders = (token: string) => ({
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    })

    const sales = await fulfillment.createSalesDraft(
      p(SAL_HEAD, 'create'),
      draftInput(),
    )
    const salesBody = JSON.stringify({
      ...httpDraftInput(),
      items: [],
      packBoxes: [],
    })
    expect(
      (await http.request(`/api/v1/sales/deliveries/${sales.id}`, {
        method: 'PUT',
        headers: jsonHeaders('sal-update-only'),
        body: salesBody,
      })).status,
    ).toBe(403)
    expect(
      (await http.request(`/api/v1/sales/deliveries/${sales.id}`, {
        method: 'PUT',
        headers: jsonHeaders('sal-replace'),
        body: salesBody,
      })).status,
    ).toBe(200)

    const purchase = await fulfillment.createPurchaseReceiptDraft(
      p(PUR_HEAD, 'create'),
      purchaseReceiptDraftInput(),
    )
    const purchaseWire = purchaseReceiptDraftInput()
    const purchaseBody = JSON.stringify({
      companyId: purchaseWire.companyId,
      receiptNo: purchase.receiptNo,
      receiptDate: purchase.receiptDate,
      postingDate: purchase.postingDate,
      partyType: purchaseWire.partyType,
      partyId: purchaseWire.partyId,
      warehouseId: purchaseWire.warehouseId,
      debitAccountId: purchaseWire.debitAccountId,
      creditAccountId: purchaseWire.creditAccountId,
      items: [],
    })
    expect(
      (await http.request(`/api/v1/purchase/receipts/${purchase.id}`, {
        method: 'PUT',
        headers: jsonHeaders('pur-update-only'),
        body: purchaseBody,
      })).status,
    ).toBe(403)
    expect(
      (await http.request(`/api/v1/purchase/receipts/${purchase.id}`, {
        method: 'PUT',
        headers: jsonHeaders('pur-replace'),
        body: purchaseBody,
      })).status,
    ).toBe(200)
  })

  test('整单替换的嵌套行失败时保持保存前的完整草稿', async () => {
    const created = await fulfillment.createSalesDraft(p(SAL_HEAD, 'create'), draftInput())
    const item = created.items[0]!
    const box = created.packBoxes[0]!
    const line = box.lines[0]!

    await expect(
      fulfillment.replaceSalesDraft(p(SAL_HEAD, 'update'), created.id, {
        ...draftInput(),
        remarks: '不应落库',
        items: [{ id: item.id, idx: 1, qty: '99', orderItemId, warehouseId }],
        packBoxes: [{
          id: box.id,
          lines: [{ id: line.id, idx: 1, qty: '0', materialId }],
        }],
      }),
    ).rejects.toThrow(/装箱行参数不合法/)

    expect((await fulfillment.getHead(p(SAL_HEAD, 'read'), 'sales', created.id)).remarks).toBeNull()
    expect((await fulfillment.getItem(p(SAL_ITEM, 'read'), 'sales', item.id)).qty).toBe('10')
    expect((await fulfillment.getPackLine(p(PACK_LINE_RESOURCE, 'read'), line.id)).qty).toBe('10')
  })

  test('整单替换拒绝未知、跨单和重复的子记录身份并返回索引路径', async () => {
    const first = await fulfillment.createSalesDraft(
      p(SAL_HEAD, 'create'),
      draftInput(),
    )
    const second = await fulfillment.createSalesDraft(
      p(SAL_HEAD, 'create'),
      draftInput(),
    )
    const firstItem = first.items[0]!
    const firstBox = first.packBoxes[0]!
    const firstLine = firstBox.lines[0]!

    const invalidDrafts = [
      {
        input: {
          ...draftInput(),
          items: [{ id: crypto.randomUUID(), idx: 1, qty: '10', orderItemId, warehouseId }],
          packBoxes: [],
        },
        field: 'items[0].id',
      },
      {
        input: {
          ...draftInput(),
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
          ...draftInput(),
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
          ...draftInput(),
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
          ...draftInput(),
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
        .replaceSalesDraft(p(SAL_HEAD, 'update'), first.id, invalid.input)
        .then(
          () => null,
          (caught) => caught as { fields?: Record<string, string[]> },
        )
      expect(error?.fields?.[invalid.field]).toBeDefined()
    }
  })

  test('发货单删除级联删除箱与装箱行', async () => {
    const draft = await fulfillment.createSalesDraft(
      p(SAL_HEAD, 'create'),
      draftInput(),
    )
    const box = draft.packBoxes[0]!
    const line = box.lines[0]!
    await fulfillment.deleteHead(p(SAL_HEAD, 'delete'), 'sales', draft.id)
    await expect(fulfillment.getPackBox(p(PACK_BOX_RESOURCE, 'read'), box.id)).rejects.toThrow(/不存在/)
    await expect(fulfillment.getPackLine(p(PACK_LINE_RESOURCE, 'read'), line.id)).rejects.toThrow(/不存在/)
  })

  test('状态守卫 409：审核后整单替换锁死（领域不变量不进权限系统）', async () => {
    const input = draftInput()
    const draft = await fulfillment.createSalesDraft(p(SAL_HEAD, 'create'), input)
    const audited = await fulfillment.auditHead(p(SAL_HEAD, 'audit'), 'sales', draft.id)
    expect(audited.status).toBe('AUDITED')
    const conflict = await fulfillment
      .replaceSalesDraft(p(SAL_HEAD, 'update'), draft.id, input)
      .then(() => null, (caught) => caught as { code?: string; message?: string })
    expect(conflict?.code).toBe('conflict')
    expect(conflict?.message).toMatch(/仅草稿销售发货单可编辑/)

    const replaceResponse = await http.request(`/api/v1/sales/deliveries/${draft.id}`, {
      method: 'PUT',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify(httpDraftInput()),
    })
    expect(replaceResponse.status).toBe(409)
  })

  test('全有或全无回归：装箱与发货不一致拒审、一致放行', async () => {
    const bad = await fulfillment.createSalesDraft(
      p(SAL_HEAD, 'create'),
      draftInput('10', '8'),
    )
    await expect(fulfillment.auditHead(p(SAL_HEAD, 'audit'), 'sales', bad.id)).rejects.toThrow(
      /装箱清单与发货量不一致/,
    )

    const good = await fulfillment.createSalesDraft(
      p(SAL_HEAD, 'create'),
      draftInput(),
    )
    const audited = await fulfillment.auditHead(p(SAL_HEAD, 'audit'), 'sales', good.id)
    expect(audited.status).toBe('AUDITED')
  })

  test('可先装箱后补条目：装箱行物料不强制属于本单发货条目', async () => {
    const draft = await fulfillment.createSalesDraft(p(SAL_HEAD, 'create'), {
      ...draftInput(),
      items: [],
      packBoxes: [{
        lines: [{ idx: 1, qty: '3', materialId: material2Id }],
      }],
    })
    expect(draft.packBoxes[0]?.lines[0]?.materialId).toBe(material2Id)
  })

  /**
   * 别名回归：六条列表路径各一条，正负成对。
   * 必须用非 superAdmin 的公司域 actor——superAdmin 的 rowFilter 是 bypass，
   * 编译成 `true`，alias / via 链写错测不出来。正向断言「本公司的行在结果里」
   * （只断言别人不在对空集永真），反向断言跨公司主体拿不到同一行。
   */
  test('别名回归：六条列表路径正负成对（本公司可见 / 跨公司空集）', async () => {
    const sales = await fulfillment.createSalesDraft(
      p(SAL_HEAD, 'create'),
      draftInput(),
    )
    const purchase = await fulfillment.createPurchaseReceiptDraft(
      p(PUR_HEAD, 'create'),
      purchaseReceiptDraftInput(),
    )
    // 前提自检：本用例必须跑在非 bypass 的行过滤上
    expect(p(SAL_HEAD, 'read', scopedActor).rowFilter.company).not.toBe('bypass')

    const companyFilter = {
      companyId: { kind: 'fk' as const, op: 'in' as const, values: [companyId], labels: [] },
    }
    const deliveryFilter = {
      deliveryId: { kind: 'fk' as const, op: 'in' as const, values: [sales.id], labels: [] },
    }
    const receiptFilter = {
      receiptId: { kind: 'fk' as const, op: 'in' as const, values: [purchase.id], labels: [] },
    }
    type Listed = { results: Array<{ id: string }> }
    const probes: Array<{ label: string; rowId: string; list: (who: Actor) => Promise<Listed> }> = [
      {
        // company 形态，alias = sal_delivery
        label: '销售发货头',
        rowId: sales.id,
        list: (who) =>
          fulfillment.listHeads(p(SAL_HEAD, 'read', who), 'sales', {
            limit: 200,
            filter: companyFilter,
          }),
      },
      {
        // via salDeliveries，alias = fulfillment_items（子查询别名）
        label: '销售发货条目',
        rowId: sales.items[0]!.id,
        list: (who) =>
          fulfillment.listItems(p(SAL_ITEM, 'read', who), 'sales', {
            limit: 200,
            filter: deliveryFilter,
          }),
      },
      {
        // via salDeliveries，alias = sal_delivery_pack_box
        label: '装箱箱',
        rowId: sales.packBoxes[0]!.id,
        list: (who) =>
          fulfillment.listPackBoxes(p(PACK_BOX_RESOURCE, 'read', who), {
            limit: 200,
            filter: deliveryFilter,
          }),
      },
      {
        // 两级 via：pack_box → sal_delivery，alias = sal_delivery_pack_line
        label: '装箱行',
        rowId: sales.packBoxes[0]!.lines[0]!.id,
        list: (who) =>
          fulfillment.listPackLines(p(PACK_LINE_RESOURCE, 'read', who), {
            limit: 200,
            filter: deliveryFilter,
          }),
      },
      {
        // company 形态，alias = pur_receipt
        label: '采购入库头',
        rowId: purchase.id,
        list: (who) =>
          fulfillment.listHeads(p(PUR_HEAD, 'read', who), 'purchase', {
            limit: 200,
            filter: companyFilter,
          }),
      },
      {
        // via purReceipts，同一份 fulfillment_items 投影
        label: '采购入库条目',
        rowId: purchase.items[0]!.id,
        list: (who) =>
          fulfillment.listItems(p(PUR_ITEM, 'read', who), 'purchase', {
            limit: 200,
            filter: receiptFilter,
          }),
      },
    ]

    for (const probe of probes) {
      const mine = await probe.list(scopedActor)
      const theirs = await probe.list(foreignActor)
      expect({
        path: probe.label,
        visibleToOwner: mine.results.some((row) => row.id === probe.rowId),
        visibleToForeign: theirs.results.some((row) => row.id === probe.rowId),
      }).toEqual({ path: probe.label, visibleToOwner: true, visibleToForeign: false })
    }
  })

  test('跨公司：单条一律 not_found，列表为空集', async () => {
    const sales = await fulfillment.createSalesDraft(
      p(SAL_HEAD, 'create'),
      draftInput(),
    )
    const purchase = await fulfillment.createPurchaseReceiptDraft(
      p(PUR_HEAD, 'create'),
      purchaseReceiptDraftInput(),
    )
    const notFound = { code: 'not_found' }

    await expect(
      fulfillment.getHead(p(SAL_HEAD, 'read', foreignActor), 'sales', sales.id),
    ).rejects.toMatchObject(notFound)
    await expect(
      fulfillment.getSalesDraft(p(SAL_HEAD, 'read', foreignActor), sales.id),
    ).rejects.toMatchObject(notFound)
    await expect(
      fulfillment.getItem(p(SAL_ITEM, 'read', foreignActor), 'sales', sales.items[0]!.id),
    ).rejects.toMatchObject(notFound)
    await expect(
      fulfillment.getPackBox(p(PACK_BOX_RESOURCE, 'read', foreignActor), sales.packBoxes[0]!.id),
    ).rejects.toMatchObject(notFound)
    await expect(
      fulfillment.getPackLine(
        p(PACK_LINE_RESOURCE, 'read', foreignActor),
        sales.packBoxes[0]!.lines[0]!.id,
      ),
    ).rejects.toMatchObject(notFound)
    await expect(
      fulfillment.getHead(p(PUR_HEAD, 'read', foreignActor), 'purchase', purchase.id),
    ).rejects.toMatchObject(notFound)
    await expect(
      fulfillment.getPurchaseReceiptDraft(p(PUR_HEAD, 'read', foreignActor), purchase.id),
    ).rejects.toMatchObject(notFound)
    await expect(
      fulfillment.getItem(p(PUR_ITEM, 'read', foreignActor), 'purchase', purchase.items[0]!.id),
    ).rejects.toMatchObject(notFound)

    // HTTP 层同语义：码满足但行不可达 → 404（403 只剩「码不满足」一种成因）
    for (const path of [
      `/api/v1/sales/deliveries/${sales.id}`,
      `/api/v1/sales/deliveries/${sales.id}/draft`,
      `/api/v1/sales/delivery-items/${sales.items[0]!.id}`,
      `/api/v1/sales/delivery-pack-boxes/${sales.packBoxes[0]!.id}`,
      `/api/v1/sales/delivery-pack-lines/${sales.packBoxes[0]!.lines[0]!.id}`,
      `/api/v1/purchase/receipts/${purchase.id}`,
      `/api/v1/purchase/receipts/${purchase.id}/draft`,
    ]) {
      const res = await http.request(path, { headers: { authorization: 'Bearer foreign' } })
      expect({ path, status: res.status }).toEqual({ path, status: 404 })
    }
  })
})
