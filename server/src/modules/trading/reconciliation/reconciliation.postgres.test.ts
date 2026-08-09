/**
 * 对账 PG 集成：金额链、确认占量/撤回、赠送结单/作废、尾差。
 * 授权四类回归：列表别名（销售/采购 × 头/条目）、跨公司单条 404、
 * 缺码 403（HTTP 层）、状态守卫 409（领域不变量不进权限系统）。
 * 门控 SYNIE_TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { decimal } from '@synie/shared'
import { Hono } from 'hono'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { withTx } from '~/db/tx.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { createInventoryEngine } from '~/engines/inventory/index.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { testActor } from '~/platform/authz/testing.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { ApiError, onError } from '~/platform/http/errors.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import type { TradingSide } from '../common.ts'
import { createFulfillmentService } from '../fulfillment/service.ts'
import { createOrderService } from '../order/service.ts'
import { createReturnsService } from '../returns/service.ts'
import { createQuotationService } from '../quotation/service.ts'
import { reconciliationHeadRoutes, reconciliationItemRoutes } from './routes.ts'
import { createReconciliationService } from './service.ts'
import { reconciliationSpec } from './spec.ts'

/** 编号服务与授权归宿解析共用同一份 sealed registry */
const registry = createSealedResourceRegistry()
const authz = createAuthzEnforcer(registry)
const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

/** 服务级凭证：actor 会中途改写，故每次现取 */
function permitFor(who: Actor, resource: string, action: string): Permit {
  const decision = authz.decideFor(who, resource, action)
  if (decision.outcome !== 'permit') {
    throw new Error(`测试凭证不足 ${resource}:${action}（缺 ${decision.missing.join(',')}）`)
  }
  return decision.permit
}

async function expectApiError(fn: () => Promise<unknown>, code: ApiError['code']) {
  let err: unknown
  try {
    await fn()
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(ApiError)
  expect((err as ApiError).code).toBe(code)
}

run('PG 集成（销售/采购对账）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db, buildNumberingCatalog(registry), registry)
  const gl = createGlEngine()
  const inventory = createInventoryEngine()
  const engines = { inventory, gl }
  const quotations = createQuotationService(db, numbering, registry)
  const orders = createOrderService(db, numbering, quotations, registry)
  const fulfillment = createFulfillmentService(db, numbering, engines, registry)
  const returns = createReturnsService(db, numbering, engines, registry)
  const svc = createReconciliationService(db, numbering, gl, registry)
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const prefix = `REC${suffix}`
  void orders

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
  const salesReturnId = crypto.randomUUID()
  const salesReturnItemId = crypto.randomUUID()
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

  /** 公司域 actor：别名写错时 rowFilter 不再是 bypass，能测出 via 链断裂 */
  const scoped: Actor = testActor({
    userId: '',
    username: 'recon-scoped',
    name: null,
    superAdmin: false,
    allCompanies: false,
    permissions: new Set([
      'sales.reconciliation:read',
      'sales.reconciliation:create',
      'sales.reconciliation:confirm',
      'purchase.reconciliation:read',
    ]),
    companyIds: [companyId],
  })

  /** 同码不同公司：单条一律 not_found、列表一律不含 */
  const foreign: Actor = testActor({ ...scoped, username: 'recon-foreign', companyIds: [otherCompanyId] })

  /** 只有 read 码：写动作与工作流动作在 HTTP 层 403 */
  const readOnly: Actor = testActor({
    ...scoped,
    username: 'recon-read-only',
    permissions: new Set(['sales.reconciliation:read']),
  })

  const headRes = (side: TradingSide) => reconciliationSpec(side).headResource
  const itemRes = (side: TradingSide) => reconciliationSpec(side).itemResource
  const headPermit = (side: TradingSide, action: string, who: Actor = actor) =>
    permitFor(who, headRes(side), action)
  const itemPermit = (side: TradingSide, action: string, who: Actor = actor) =>
    permitFor(who, itemRes(side), action)

  const byToken = (token: string | null): Actor => {
    if (token === 'scoped') return scoped
    if (token === 'read-only') return readOnly
    return actor
  }
  const auth = {
    authenticate: async (token: string) => byToken(token),
    authenticateRequest: async (headers: Headers) => {
      const header = headers.get('authorization')
      const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null
      return byToken(token)
    },
  } as unknown as AuthService
  const http = new Hono<AppEnv>()
    .route(
      '/api/v1/sales/reconciliations',
      reconciliationHeadRoutes({ auth, authz, reconciliations: svc, side: 'sales' }),
    )
    .route(
      '/api/v1/sales/reconciliation-items',
      reconciliationItemRoutes({ auth, authz, reconciliations: svc, side: 'sales' }),
    )
  http.onError(onError)

  const asToken = (token: string, path: string, body?: unknown) =>
    http.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  /** 本测自建的编号规则（afterAll 回收；复用的他人规则不动） */
  const createdRuleIds: string[] = []

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${currencyId}::uuid, ${prefix + '币'}, ${'R' + suffix.slice(0, 6)}, '¤', true)
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
    // symbol 全库唯一：并行套件共用测试库，故按 suffix 取唯一值
    await sql`
      INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
      VALUES (${unitId}::uuid, ${'recon-' + suffix}, true, ${prefix + '件'}, ${'u' + suffix.slice(0, 6)}, 1)
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
      INSERT INTO inv_warehouse(id,name,code,company_id)
      VALUES (${warehouseId}::uuid, ${prefix + '仓'}, ${'W' + suffix}, ${companyId}::uuid)
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
        10,20,${prefix + '件'},10,100,12,120,0.13,${'R' + suffix.slice(0, 6)},
        ${salesDeliveryId}::uuid,${companyId}::uuid,${salesOrderItemId}::uuid,
        ${materialId}::uuid,${unitId}::uuid,${warehouseId}::uuid,0
      )
    `.execute(db)
    // 已审核销售退货单（手工行口径：无源单锚点；快照价 10、币种与发货一致、汇率随单头 1.2）
    await sql`
      INSERT INTO sal_return(id,return_no,return_date,party_type,party_id,status,company_id,
        warehouse_id,debit_account_id,credit_account_id,currency_id,exchange_rate)
      VALUES (${salesReturnId}::uuid,${prefix + '-ST'},'2026-07-26','customer',${customerId}::uuid,
        'audited',${companyId}::uuid,${warehouseId}::uuid,${salesDebitId}::uuid,${salesCreditId}::uuid,
        ${currencyId}::uuid,1.2)
    `.execute(db)
    await sql`
      INSERT INTO sal_return_item(
        id,idx,qty,base_qty,material_code,material_name,unit_name,
        order_price,order_amount,order_base_price,order_base_amount,order_tax_rate,order_currency_code,
        return_id,company_id,material_id,unit_id,warehouse_id,reconciled_qty
      ) VALUES (
        ${salesReturnItemId}::uuid,1,4,4,${'M' + suffix},${prefix + '物料'},${prefix + '件'},
        10,40,12,48,0.13,${'R' + suffix.slice(0, 6)},
        ${salesReturnId}::uuid,${companyId}::uuid,
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
        10,10,${prefix + '件'},8,80,9.6,96,0.13,${'R' + suffix.slice(0, 6)},
        ${purchaseReceiptId}::uuid,${companyId}::uuid,${purchaseOrderItemId}::uuid,
        ${materialId}::uuid,${unitId}::uuid,${warehouseId}::uuid,0
      )
    `.execute(db)

    // 单据编号规则不由迁移播种：已有启用规则则复用，否则建本测前缀规则
    for (const [resource, tag] of [
      ['sales.reconciliation', 'SR'],
      ['purchase.reconciliation', 'PR'],
    ] as const) {
      const existing = await db
        .selectFrom('sys_numbering_rule')
        .select('id')
        .where('resource', '=', resource)
        .where('enabled', '=', true)
        .executeTakeFirst()
      if (!existing) {
        const rule = await numbering.create(permitFor(actor, 'sysNumberingRules', 'create'), {
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
    await sql`DELETE FROM sys_todo WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sys_audit_log WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_gl_entry WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_reconciliation WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_reconciliation WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_return WHERE company_id=${companyId}::uuid`.execute(db)
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
    const salesHead = await svc.createHead(headPermit('sales', 'create'), 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
    })
    const purchaseHead = await svc.createHead(headPermit('purchase', 'create'), 'purchase', {
      companyId,
      kind: 'REGULAR',
      partyType: 'SUPPLIER',
      partyId: supplierId,
    })
    const salesItem = await svc.createItem(itemPermit('sales', 'create'), 'sales', {
      reconciliationId: salesHead.id,
      idx: 1,
      qty: '1',
      deliveryItemId: salesDeliveryItemId,
    })
    const purchaseItem = await svc.createItem(itemPermit('purchase', 'create'), 'purchase', {
      reconciliationId: purchaseHead.id,
      idx: 1,
      qty: '1',
      receiptItemId: purchaseReceiptItemId,
    })

    try {
      const sales = await svc.listItems(itemPermit('sales', 'read'), 'sales', {
        limit: 20,
        offset: 0,
        sort: { column: 'deliveryDate', direction: 'descending' },
        filter: {
          deliveryDate: { kind: 'date', op: 'eq', value: '2026-07-25' },
        },
      })
      expect(sales.results.some((item) => item.id === salesItem.id)).toBe(true)

      const purchase = await svc.listItems(itemPermit('purchase', 'read'), 'purchase', {
        limit: 20,
        offset: 0,
        sort: { column: 'receiptDate', direction: 'descending' },
        filter: {
          receiptDate: { kind: 'date', op: 'eq', value: '2026-07-25' },
        },
      })
      expect(purchase.results.some((item) => item.id === purchaseItem.id)).toBe(true)
    } finally {
      await svc.deleteItem(itemPermit('sales', 'delete'), 'sales', salesItem.id)
      await svc.deleteItem(itemPermit('purchase', 'delete'), 'purchase', purchaseItem.id)
      await svc.deleteHead(headPermit('sales', 'delete'), 'sales', salesHead.id)
      await svc.deleteHead(headPermit('purchase', 'delete'), 'purchase', purchaseHead.id)
    }
  })

  test('默认科目代入 + 金额链 + 确认占量/撤回', async () => {
    const head = await svc.createHead(headPermit('sales', 'create'), 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
    })
    expect(head.debitAccountId).toBe(salesDebitId)
    expect(head.creditAccountId).toBe(salesCreditId)
    expect(head.status).toBe('DRAFT')

    const item = await svc.createItem(itemPermit('sales', 'create'), 'sales', {
      reconciliationId: head.id,
      idx: 1,
      qty: '2.005',
      deliveryItemId: salesDeliveryItemId,
    })
    // base = 2.005 * 20/10 = 4.01; amount = 2.005*10=20.05; baseAmount=20.05*1.2=24.06
    expect(decimal(item.baseQty).equals(decimal('4.01'))).toBe(true)
    expect(decimal(item.amount).equals(decimal('20.05'))).toBe(true)
    expect(decimal(item.baseAmount).equals(decimal('24.06'))).toBe(true)

    const confirmed = await svc.confirm(headPermit('sales', 'confirm'), 'sales', head.id)
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

    const unconfirmed = await svc.unconfirm(headPermit('sales', 'unconfirm'), 'sales', head.id)
    expect(unconfirmed.status).toBe('DRAFT')
    const recon2 = await sql<{ r: string }>`
      SELECT reconciled_qty::text AS r FROM sal_delivery_item WHERE id=${salesDeliveryItemId}::uuid
    `.execute(db)
    expect(decimal(recon2.rows[0]!.r).equals(decimal(0))).toBe(true)

    await svc.deleteItem(itemPermit('sales', 'delete'), 'sales', item.id)
    await svc.deleteHead(headPermit('sales', 'delete'), 'sales', head.id)
  })

  test('分次对账尾差不配平 + 超剩余冲突', async () => {
    const head = await svc.createHead(headPermit('sales', 'create'), 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    // 先对 9 行单位 (=18 base)，剩余 1 行单位 (=2 base)
    const item = await svc.createItem(itemPermit('sales', 'create'), 'sales', {
      reconciliationId: head.id,
      idx: 1,
      qty: '9',
      deliveryItemId: salesDeliveryItemId,
    })
    await svc.confirm(headPermit('sales', 'confirm'), 'sales', head.id)
    const recon = await sql<{ r: string; b: string }>`
      SELECT reconciled_qty::text AS r, base_qty::text AS b FROM sal_delivery_item WHERE id=${salesDeliveryItemId}::uuid
    `.execute(db)
    expect(decimal(recon.rows[0]!.r).equals(decimal('18'))).toBe(true)

    const head2 = await svc.createHead(headPermit('sales', 'create'), 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    await expectApiError(
      () =>
        svc.createItem(itemPermit('sales', 'create'), 'sales', {
          reconciliationId: head2.id,
          idx: 1,
          qty: '2', // 需要 4 base，仅剩 2
          deliveryItemId: salesDeliveryItemId,
        }),
      'conflict',
    )

    // 尾差 1 行单位可对
    const tail = await svc.createItem(itemPermit('sales', 'create'), 'sales', {
      reconciliationId: head2.id,
      idx: 1,
      qty: '1',
      deliveryItemId: salesDeliveryItemId,
    })
    expect(decimal(tail.baseQty).equals(decimal('2'))).toBe(true)

    await svc.unconfirm(headPermit('sales', 'unconfirm'), 'sales', head.id)
    await svc.deleteItem(itemPermit('sales', 'delete'), 'sales', item.id)
    await svc.deleteItem(itemPermit('sales', 'delete'), 'sales', tail.id)
    await svc.deleteHead(headPermit('sales', 'delete'), 'sales', head.id)
    await svc.deleteHead(headPermit('sales', 'delete'), 'sales', head2.id)
  })

  test('赠送/样品结单过账与作废回滚', async () => {
    const head = await svc.createHead(headPermit('sales', 'create'), 'sales', {
      companyId,
      kind: 'GIFT_SAMPLE',
      partyType: 'CUSTOMER',
      partyId: customerId,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    await svc.createItem(itemPermit('sales', 'create'), 'sales', {
      reconciliationId: head.id,
      idx: 1,
      qty: '1',
      deliveryItemId: salesDeliveryItemId,
    })
    const closed = await svc.audit(headPermit('sales', 'audit'), 'sales', head.id, {
      postingDate: '2026-07-26',
    })
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

    const voided = await svc.void(headPermit('sales', 'void'), 'sales', head.id)
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
    const head = await svc.createHead(headPermit('purchase', 'create'), 'purchase', {
      companyId,
      kind: 'REGULAR',
      partyType: 'SUPPLIER',
      partyId: supplierId,
      debitAccountId: purchaseDebitId,
      creditAccountId: purchaseCreditId,
    })
    const item = await svc.createItem(itemPermit('purchase', 'create'), 'purchase', {
      reconciliationId: head.id,
      idx: 1,
      qty: '3',
      receiptItemId: purchaseReceiptItemId,
    })
    expect(decimal(item.amount).equals(decimal('24'))).toBe(true) // 3*8
    expect(decimal(item.baseAmount).equals(decimal('28.8'))).toBe(true) // 24*1.2

    await svc.confirm(headPermit('purchase', 'confirm'), 'purchase', head.id)
    const recon = await sql<{ r: string }>`
      SELECT reconciled_qty::text AS r FROM pur_receipt_item WHERE id=${purchaseReceiptItemId}::uuid
    `.execute(db)
    expect(decimal(recon.rows[0]!.r).equals(decimal('3'))).toBe(true)
    await svc.unconfirm(headPermit('purchase', 'unconfirm'), 'purchase', head.id)
    await svc.deleteItem(itemPermit('purchase', 'delete'), 'purchase', item.id)
    await svc.deleteHead(headPermit('purchase', 'delete'), 'purchase', head.id)
  })

  test('列表别名回归：公司域 actor 能看到本公司的头与条目（销售/采购）', async () => {
    const salesHead = await svc.createHead(headPermit('sales', 'create'), 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    const purchaseHead = await svc.createHead(headPermit('purchase', 'create'), 'purchase', {
      companyId,
      kind: 'REGULAR',
      partyType: 'SUPPLIER',
      partyId: supplierId,
      debitAccountId: purchaseDebitId,
      creditAccountId: purchaseCreditId,
    })
    const salesItem = await svc.createItem(itemPermit('sales', 'create'), 'sales', {
      reconciliationId: salesHead.id,
      idx: 1,
      qty: '1',
      deliveryItemId: salesDeliveryItemId,
    })
    const purchaseItem = await svc.createItem(itemPermit('purchase', 'create'), 'purchase', {
      reconciliationId: purchaseHead.id,
      idx: 1,
      qty: '1',
      receiptItemId: purchaseReceiptItemId,
    })
    const page = { limit: 200, offset: 0 }
    try {
      // 头：company 形态，别名须与 headListSource 的子查询别名一致
      const salesHeads = await svc.listHeads(headPermit('sales', 'read', scoped), 'sales', page)
      expect(salesHeads.results.some((r) => r.id === salesHead.id)).toBe(true)
      const purchaseHeads = await svc.listHeads(
        headPermit('purchase', 'read', scoped),
        'purchase',
        page,
      )
      expect(purchaseHeads.results.some((r) => r.id === purchaseHead.id)).toBe(true)

      // 条目：via 链落在子查询别名上，别名写错则 EXISTS 收不到宿主行
      const salesItems = await svc.listItems(itemPermit('sales', 'read', scoped), 'sales', page)
      expect(salesItems.results.some((r) => r.id === salesItem.id)).toBe(true)
      const purchaseItems = await svc.listItems(
        itemPermit('purchase', 'read', scoped),
        'purchase',
        page,
      )
      expect(purchaseItems.results.some((r) => r.id === purchaseItem.id)).toBe(true)

      // 对照：他司 actor 的列表不含本公司行（对空集不永真，因为上面已断言可见）
      const foreignHeads = await svc.listHeads(headPermit('sales', 'read', foreign), 'sales', page)
      expect(foreignHeads.results.some((r) => r.id === salesHead.id)).toBe(false)
      const foreignItems = await svc.listItems(itemPermit('sales', 'read', foreign), 'sales', page)
      expect(foreignItems.results.some((r) => r.id === salesItem.id)).toBe(false)
    } finally {
      await svc.deleteItem(itemPermit('sales', 'delete'), 'sales', salesItem.id)
      await svc.deleteItem(itemPermit('purchase', 'delete'), 'purchase', purchaseItem.id)
      await svc.deleteHead(headPermit('sales', 'delete'), 'sales', salesHead.id)
      await svc.deleteHead(headPermit('purchase', 'delete'), 'purchase', purchaseHead.id)
    }
  })

  test('条目改量：母单先行加锁，金额链重算并写审计 diff', async () => {
    const head = await svc.createHead(headPermit('sales', 'create'), 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    const item = await svc.createItem(itemPermit('sales', 'create'), 'sales', {
      reconciliationId: head.id,
      idx: 1,
      qty: '1',
      deliveryItemId: salesDeliveryItemId,
    })
    try {
      const updated = await svc.updateItem(itemPermit('sales', 'update'), 'sales', item.id, {
        qty: '2',
      })
      expect(decimal(updated.qty).equals(decimal('2'))).toBe(true)
      expect(decimal(updated.baseQty).equals(decimal('4'))).toBe(true)
      expect(decimal(updated.amount).equals(decimal('20'))).toBe(true)
      expect(decimal(updated.baseAmount).equals(decimal('24'))).toBe(true)
      const audits = await sql<{ c: string }>`
        SELECT count(*)::text AS c FROM sys_audit_log
        WHERE resource='sal_reconciliation_item' AND record_id=${item.id}::uuid
          AND action_name='update'
      `.execute(db)
      expect(Number(audits.rows[0]!.c)).toBe(1)
    } finally {
      await svc.deleteItem(itemPermit('sales', 'delete'), 'sales', item.id)
      await svc.deleteHead(headPermit('sales', 'delete'), 'sales', head.id)
    }
  })

  test('跨公司单条：头/条目读与写一律 not_found', async () => {
    const head = await svc.createHead(headPermit('sales', 'create'), 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    const item = await svc.createItem(itemPermit('sales', 'create'), 'sales', {
      reconciliationId: head.id,
      idx: 1,
      qty: '1',
      deliveryItemId: salesDeliveryItemId,
    })
    try {
      // 有公司的 actor 读得到
      const ok = await svc.getHead(headPermit('sales', 'read', scoped), 'sales', head.id)
      expect(ok.id).toBe(head.id)
      const okItem = await svc.getItem(itemPermit('sales', 'read', scoped), 'sales', item.id)
      expect(okItem.id).toBe(item.id)

      // 他司 actor：存在但不可达 → not_found（不再是 forbidden）
      await expectApiError(
        () => svc.getHead(headPermit('sales', 'read', foreign), 'sales', head.id),
        'not_found',
      )
      await expectApiError(
        () => svc.getItem(itemPermit('sales', 'read', foreign), 'sales', item.id),
        'not_found',
      )
      await expectApiError(
        () => svc.confirm(headPermit('sales', 'confirm', foreign), 'sales', head.id),
        'not_found',
      )
      // create：目标公司未授权 → not_found（公司不存在）
      await expectApiError(
        () =>
          svc.createHead(headPermit('sales', 'create', foreign), 'sales', {
            companyId,
            kind: 'REGULAR',
            partyType: 'CUSTOMER',
            partyId: customerId,
          }),
        'not_found',
      )
    } finally {
      await svc.deleteItem(itemPermit('sales', 'delete'), 'sales', item.id)
      await svc.deleteHead(headPermit('sales', 'delete'), 'sales', head.id)
    }
  })

  test('状态守卫 409：非草稿不可改、重复确认冲突', async () => {
    const head = await svc.createHead(headPermit('sales', 'create'), 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    const item = await svc.createItem(itemPermit('sales', 'create'), 'sales', {
      reconciliationId: head.id,
      idx: 1,
      qty: '1',
      deliveryItemId: salesDeliveryItemId,
    })
    await svc.confirm(headPermit('sales', 'confirm'), 'sales', head.id)
    try {
      await expectApiError(
        () =>
          svc.updateHead(headPermit('sales', 'update'), 'sales', head.id, {
            remarks: '改不动',
            remarksPresent: true,
          }),
        'conflict',
      )
      await expectApiError(
        () => svc.confirm(headPermit('sales', 'confirm'), 'sales', head.id),
        'conflict',
      )
      await expectApiError(
        () =>
          svc.updateItem(itemPermit('sales', 'update'), 'sales', item.id, {
            qty: '2',
          }),
        'conflict',
      )
    } finally {
      await svc.unconfirm(headPermit('sales', 'unconfirm'), 'sales', head.id)
      await svc.deleteItem(itemPermit('sales', 'delete'), 'sales', item.id)
      await svc.deleteHead(headPermit('sales', 'delete'), 'sales', head.id)
    }
  })

  test('HTTP 缺码 403：工作流动作与条目写各自持码', async () => {
    const head = await svc.createHead(headPermit('sales', 'create'), 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    const item = await svc.createItem(itemPermit('sales', 'create'), 'sales', {
      reconciliationId: head.id,
      idx: 1,
      qty: '1',
      deliveryItemId: salesDeliveryItemId,
    })
    try {
      // 只有 read 码：confirm / 条目 create（via → 母资源 create 码）均 403
      const denyConfirm = await asToken('read-only', `/api/v1/sales/reconciliations/${head.id}/confirm`)
      expect(denyConfirm.status).toBe(403)
      const denyItem = await asToken('read-only', '/api/v1/sales/reconciliation-items', {
        reconciliationId: head.id,
        idx: 2,
        qty: '1',
        deliveryItemId: salesDeliveryItemId,
      })
      expect(denyItem.status).toBe(403)
      // read 码可读列表
      const okQuery = await asToken('read-only', '/api/v1/sales/reconciliations/query', {
        limit: 20,
        offset: 0,
      })
      expect(okQuery.status).toBe(200)

      // 持 confirm 码放行；再次 confirm 是领域冲突 409（不是权限问题）
      const okConfirm = await asToken('scoped', `/api/v1/sales/reconciliations/${head.id}/confirm`)
      expect(okConfirm.status).toBe(200)
      expect(((await okConfirm.json()) as { status: string }).status).toBe('CONFIRMED')
      const again = await asToken('scoped', `/api/v1/sales/reconciliations/${head.id}/confirm`)
      expect(again.status).toBe(409)
    } finally {
      await svc.unconfirm(headPermit('sales', 'unconfirm'), 'sales', head.id)
      await svc.deleteItem(itemPermit('sales', 'delete'), 'sales', item.id)
      await svc.deleteHead(headPermit('sales', 'delete'), 'sales', head.id)
    }
  })

  test('有已对账数量时发货不可作废（履约侧约束）', async () => {
    const head = await svc.createHead(headPermit('sales', 'create'), 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    await svc.createItem(itemPermit('sales', 'create'), 'sales', {
      reconciliationId: head.id,
      idx: 1,
      qty: '1',
      deliveryItemId: salesDeliveryItemId,
    })
    await svc.confirm(headPermit('sales', 'confirm'), 'sales', head.id)
    const recon = await sql<{ r: string }>`
      SELECT reconciled_qty::text AS r FROM sal_delivery_item WHERE id=${salesDeliveryItemId}::uuid
    `.execute(db)
    expect(decimal(recon.rows[0]!.r).gt(0)).toBe(true)

    let voidErr: unknown
    try {
      await fulfillment.voidHead(permitFor(actor, 'salDeliveries', 'void'), 'sales', salesDeliveryId)
    } catch (e) {
      voidErr = e
    }
    expect(voidErr).toBeInstanceOf(ApiError)
    expect((voidErr as ApiError).code).toBe('conflict')
    expect((voidErr as ApiError).message).toContain('已对账')

    await svc.unconfirm(headPermit('sales', 'unconfirm'), 'sales', head.id)
    await svc.deleteHead(headPermit('sales', 'delete'), 'sales', head.id)
  })

  test('退货条目同池混勾：行金额取负、头合计为净额', async () => {
    const draft = await svc.createDraft(headPermit('sales', 'create'), 'sales', {
      companyId,
      reconciliationType: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      items: [
        // 发货行：5 行单位 ×10 = 50（base 10，×汇率 1.2 = 60）
        { idx: 1, qty: '5', deliveryItemId: salesDeliveryItemId },
        // 退货行：2 行单位 ×10 = 20 取负（base 2，×1.2 = 24 取负）
        { idx: 2, qty: '2', returnItemId: salesReturnItemId },
      ],
    })
    const deliveryLine = draft.items.find((i) => i.deliveryItemId != null)!
    const returnLine = draft.items.find((i) => i.returnItemId != null)!
    expect(decimal(deliveryLine.amount).equals(decimal('50'))).toBe(true)
    expect(decimal(deliveryLine.baseAmount).equals(decimal('60'))).toBe(true)
    expect(decimal(returnLine.amount).equals(decimal('-20'))).toBe(true)
    expect(decimal(returnLine.baseAmount).equals(decimal('-24'))).toBe(true)
    // 退货行数量/折算数量仍为正（占量口径）
    expect(decimal(returnLine.qty).equals(decimal('2'))).toBe(true)
    expect(decimal(returnLine.baseQty).equals(decimal('2'))).toBe(true)
    // 头合计 = 同池净额
    expect(decimal(draft.grossTotal).equals(decimal('30'))).toBe(true)
    expect(decimal(draft.baseGrossTotal).equals(decimal('36'))).toBe(true)
    // 来源单号/日期 COALESCE 投影：退货行回退货单号
    expect(returnLine.deliveryNo).toBe(prefix + '-ST')
    expect(returnLine.deliveryDate).toBe('2026-07-26')

    await svc.deleteHead(headPermit('sales', 'delete'), 'sales', draft.id)
  })

  test('恰一校验：发货条目与退货条目必须恰选一个', async () => {
    const head = await svc.createHead(headPermit('sales', 'create'), 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    const neither = await svc
      .createItem(itemPermit('sales', 'create'), 'sales', {
        reconciliationId: head.id,
        idx: 1,
        qty: '1',
      })
      .catch((e: unknown) => e)
    expect((neither as ApiError).fields?.['source']).toEqual([
      '发货条目与销售退货条目必须恰选一个',
    ])
    const both = await svc
      .createItem(itemPermit('sales', 'create'), 'sales', {
        reconciliationId: head.id,
        idx: 1,
        qty: '1',
        deliveryItemId: salesDeliveryItemId,
        returnItemId: salesReturnItemId,
      })
      .catch((e: unknown) => e)
    expect((both as ApiError).fields?.['source']).toEqual([
      '发货条目与销售退货条目必须恰选一个',
    ])
    await svc.deleteHead(headPermit('sales', 'delete'), 'sales', head.id)
  })

  test('退货条目已对账数量随确认/撤回增减；超剩余可对账拦截', async () => {
    const head = await svc.createHead(headPermit('sales', 'create'), 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    const item = await svc.createItem(itemPermit('sales', 'create'), 'sales', {
      reconciliationId: head.id,
      idx: 1,
      qty: '3',
      returnItemId: salesReturnItemId,
    })
    // 保存期软校验：3 ≤ 剩余可对账 4
    expect(decimal(item.baseQty).equals(decimal('3'))).toBe(true)

    await svc.confirm(headPermit('sales', 'confirm'), 'sales', head.id)
    const recon = await sql<{ r: string }>`
      SELECT reconciled_qty::text AS r FROM sal_return_item WHERE id=${salesReturnItemId}::uuid
    `.execute(db)
    expect(decimal(recon.rows[0]!.r).equals(decimal('3'))).toBe(true)

    // 剩余可对账 = 4 − 3 = 1：再对 2 即拦截
    const head2 = await svc.createHead(headPermit('sales', 'create'), 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    await expectApiError(
      () =>
        svc.createItem(itemPermit('sales', 'create'), 'sales', {
          reconciliationId: head2.id,
          idx: 1,
          qty: '2',
          returnItemId: salesReturnItemId,
        }),
      'conflict',
    )

    await svc.deleteHead(headPermit('sales', 'delete'), 'sales', head2.id)
    await svc.unconfirm(headPermit('sales', 'unconfirm'), 'sales', head.id)
    const recon2 = await sql<{ r: string }>`
      SELECT reconciled_qty::text AS r FROM sal_return_item WHERE id=${salesReturnItemId}::uuid
    `.execute(db)
    expect(decimal(recon2.rows[0]!.r).equals(decimal(0))).toBe(true)
    await svc.deleteItem(itemPermit('sales', 'delete'), 'sales', item.id)
    await svc.deleteHead(headPermit('sales', 'delete'), 'sales', head.id)
  })

  test('有已对账数量时退货不可作废（须先撤回/作废相关对账单）', async () => {
    const head = await svc.createHead(headPermit('sales', 'create'), 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    await svc.createItem(itemPermit('sales', 'create'), 'sales', {
      reconciliationId: head.id,
      idx: 1,
      qty: '1',
      returnItemId: salesReturnItemId,
    })
    await svc.confirm(headPermit('sales', 'confirm'), 'sales', head.id)

    let voidErr: unknown
    try {
      await returns.voidHead(permitFor(actor, 'salReturns', 'void'), salesReturnId)
    } catch (e) {
      voidErr = e
    }
    expect(voidErr).toBeInstanceOf(ApiError)
    expect((voidErr as ApiError).code).toBe('conflict')
    expect((voidErr as ApiError).message).toContain('存在已对账退货条目,不可作废')

    // 撤回对账释放占用后，退货单照常识作废（本夹具退货为手工行口径：无库存/总账分录，幂等空转）
    await svc.unconfirm(headPermit('sales', 'unconfirm'), 'sales', head.id)
    await svc.deleteHead(headPermit('sales', 'delete'), 'sales', head.id)
    const voided = await returns.voidHead(permitFor(actor, 'salReturns', 'void'), salesReturnId)
    expect(voided.status).toBe('VOIDED')
  })

  test('发票结单/重开接缝：状态与待办关闭/复活', async () => {
    const head = await svc.createHead(headPermit('sales', 'create'), 'sales', {
      companyId,
      kind: 'REGULAR',
      partyType: 'CUSTOMER',
      partyId: customerId,
      debitAccountId: salesDebitId,
      creditAccountId: salesCreditId,
    })
    await svc.createItem(itemPermit('sales', 'create'), 'sales', {
      reconciliationId: head.id,
      idx: 1,
      qty: '1',
      deliveryItemId: salesDeliveryItemId,
    })
    await svc.confirm(headPermit('sales', 'confirm'), 'sales', head.id)

    // 发票联动接缝仍收 Actor（finance 内部事务，不做公司判定）
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

    await svc.unconfirm(headPermit('sales', 'unconfirm'), 'sales', head.id)
    await svc.deleteHead(headPermit('sales', 'delete'), 'sales', head.id)
  })
})
