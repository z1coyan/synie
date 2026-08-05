/**
 * 委外发料/入库 PG 集成：审核三副作用、发料投影、比例带出、作废回滚。
 * 授权面：六条列表路径的别名回归、跨公司单条 404、HTTP 缺码 403、状态守卫 409。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { decimal } from '@synie/shared'
import { Hono } from 'hono'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { createInventoryEngine } from '~/engines/inventory/index.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { testActor } from '~/platform/authz/testing.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { onError } from '~/platform/http/errors.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { createOutsourcedConfigService } from '../order/outsourced-config.ts'
import {
  createOutsourcedService,
  ISSUE_ITEM_RESOURCE,
  ISSUE_RESOURCE,
  RECEIPT_BYPRODUCT_RESOURCE,
  RECEIPT_ITEM_RESOURCE,
  RECEIPT_MATERIAL_RESOURCE,
  RECEIPT_RESOURCE,
} from './service.ts'
import {
  outsourcedIssueItemRoutes,
  outsourcedIssueRoutes,
  outsourcedReceiptByproductRoutes,
  outsourcedReceiptItemRoutes,
  outsourcedReceiptMaterialRoutes,
  outsourcedReceiptRoutes,
} from './routes.ts'

function expectQty(got: string | undefined, want: string) {
  expect(decimal(got ?? 'NaN').equals(decimal(want))).toBe(true)
}

const ISSUE_CODES = [
  'purchase.outsourced_issue:read',
  'purchase.outsourced_issue:create',
  'purchase.outsourced_issue:update',
  'purchase.outsourced_issue:delete',
  'purchase.outsourced_issue:audit',
  'purchase.outsourced_issue:void',
]
const RECEIPT_CODES = [
  'purchase.outsourced_receipt:read',
  'purchase.outsourced_receipt:create',
  'purchase.outsourced_receipt:update',
  'purchase.outsourced_receipt:delete',
  'purchase.outsourced_receipt:audit',
  'purchase.outsourced_receipt:void',
]

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（委外发料/入库生命周期）', () => {
  const db = createDb(url!)
  const registry = createSealedResourceRegistry()
  const authz = createAuthzEnforcer(registry)
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const otherCompanyId = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const finishedId = crypto.randomUUID()
  const byproductMatId = crypto.randomUUID()
  const supplierId = crypto.randomUUID()
  const mainWhId = crypto.randomUUID()
  const outWhId = crypto.randomUUID()
  const debitId = crypto.randomUUID()
  const creditId = crypto.randomUUID()
  const orderId = crypto.randomUUID()
  const orderItemId = crypto.randomUUID()
  const orderMaterialId = crypto.randomUUID()
  const orderByproductId = crypto.randomUUID()
  const numberer = {
    nextInTx: async () => `AUTO-${suffix}-${crypto.randomUUID().slice(0, 4)}`,
  }
  const outsourcedConfig = createOutsourcedConfigService(db, registry)
  const outsourced = createOutsourcedService(
    db,
    numberer as never,
    { inventory: createInventoryEngine(), gl: createGlEngine() },
    registry,
  )

  const actor: Actor = testActor({
    userId: '',
    username: 'admin',
    name: 'admin',
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })

  /** 取一张真凭证（走 decide，与路由 guard 同一路径）；actor 可能改写，故每次现取 */
  function permitOf(who: Actor, resource: string, action: string): Permit {
    const decision = authz.decideFor(who, resource, action)
    if (decision.outcome !== 'permit') throw new Error(`夹具应当 permit: ${resource}:${action}`)
    return decision.permit
  }
  const permit = (resource: string, action: string) => permitOf(actor, resource, action)

  /**
   * 别名回归必须用非 superAdmin 的公司域 actor：superAdmin 的 rowFilter 是 bypass，
   * 编译成 true，别名写错测不出来。
   */
  const scopedActor: Actor = testActor({
    username: 'outsourced-scoped',
    superAdmin: false,
    companyIds: [companyId],
    permissions: [...ISSUE_CODES, ...RECEIPT_CODES],
  })
  const otherActor: Actor = testActor({
    username: 'outsourced-other-company',
    superAdmin: false,
    companyIds: [otherCompanyId],
    permissions: [...ISSUE_CODES, ...RECEIPT_CODES],
  })
  const noCodeActor: Actor = testActor({
    username: 'outsourced-no-code',
    superAdmin: false,
    companyIds: [companyId],
    permissions: [],
  })
  const scoped = (resource: string, action: string) => permitOf(scopedActor, resource, action)
  const other = (resource: string, action: string) => permitOf(otherActor, resource, action)

  const byToken = (token: string | null) => {
    if (token === 'no-code') return noCodeActor
    if (token === 'scoped') return scopedActor
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
  const routeDeps = { auth, authz, outsourced }
  const http = new Hono<AppEnv>()
    .route('/api/v1/purchase/outsourced-issues', outsourcedIssueRoutes(routeDeps))
    .route('/api/v1/purchase/outsourced-issue-items', outsourcedIssueItemRoutes(routeDeps))
    .route('/api/v1/purchase/outsourced-receipts', outsourcedReceiptRoutes(routeDeps))
    .route('/api/v1/purchase/outsourced-receipt-items', outsourcedReceiptItemRoutes(routeDeps))
    .route(
      '/api/v1/purchase/outsourced-receipt-materials',
      outsourcedReceiptMaterialRoutes(routeDeps),
    )
    .route(
      '/api/v1/purchase/outsourced-receipt-byproducts',
      outsourcedReceiptByproductRoutes(routeDeps),
    )
  http.onError(onError)

  const query = (path: string, token: string) =>
    http.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 5 }),
    })

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency(id, name, iso_code, symbol, active)
      VALUES (${currencyId}::uuid, ${'委外币' + suffix}, ${'O' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id, code, name, short_name, base_currency_id)
      VALUES
        (${companyId}::uuid, ${'OC' + suffix}, ${'委外公司' + suffix}, ${'OC' + suffix.slice(0, 4)}, ${currencyId}::uuid),
        (${otherCompanyId}::uuid, ${'OX' + suffix}, ${'旁观公司' + suffix}, ${'OX' + suffix.slice(0, 4)}, ${currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO bas_unit(id, unit_type, is_base, name, symbol, ratio)
      VALUES (${unitId}::uuid, 'quantity', false, ${'单位' + suffix}, ${'u' + suffix.slice(0, 4)}, 1)
    `.execute(db)
    await sql`
      INSERT INTO inv_material_category(id, code, name, is_leaf, active)
      VALUES (${categoryId}::uuid, ${'CAT' + suffix}, ${'分类' + suffix}, true, true)
    `.execute(db)
    await sql`
      INSERT INTO inv_material(id, code, name, category_id, default_unit_id, active)
      VALUES
        (${materialId}::uuid, ${'MAT' + suffix}, ${'材料' + suffix}, ${categoryId}::uuid, ${unitId}::uuid, true),
        (${finishedId}::uuid, ${'FIN' + suffix}, ${'成品' + suffix}, ${categoryId}::uuid, ${unitId}::uuid, true),
        (${byproductMatId}::uuid, ${'BYP' + suffix}, ${'副产' + suffix}, ${categoryId}::uuid, ${unitId}::uuid, true)
    `.execute(db)
    await sql`
      INSERT INTO pur_supplier(id, code, name, short_name)
      VALUES (${supplierId}::uuid, ${'SU' + suffix}, ${'供应商' + suffix}, ${'SU' + suffix.slice(0, 4)})
    `.execute(db)
    await sql`
      INSERT INTO inv_warehouse(id, name, is_leaf, active, is_outsourced, company_id)
      VALUES (${mainWhId}::uuid, ${'主仓' + suffix}, true, true, false, ${companyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO inv_warehouse(id, name, is_leaf, active, is_outsourced, party_type, party_id, company_id)
      VALUES (${outWhId}::uuid, ${'外协仓' + suffix}, true, true, true, 'supplier', ${supplierId}::uuid, ${companyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO bas_account(id, code, name, direction, is_group, active, company_id, currency_id, role)
      VALUES
        (${debitId}::uuid, ${'D' + suffix}, ${'存货' + suffix}, 'debit', false, true, ${companyId}::uuid, ${currencyId}::uuid, null),
        (${creditId}::uuid, ${'C' + suffix}, ${'未开票应付' + suffix}, 'credit', false, true, ${companyId}::uuid, ${currencyId}::uuid, 'unbilled_payable')
    `.execute(db)
    await sql`
      INSERT INTO pur_order(
        id, order_no, order_date, order_type, is_outsourced, party_type, party_id,
        exchange_rate, status, company_id, currency_id
      ) VALUES (
        ${orderId}::uuid, ${'PO-' + suffix}, CURRENT_DATE, 'regular', true, 'supplier', ${supplierId}::uuid,
        1, 'audited', ${companyId}::uuid, ${currencyId}::uuid
      )
    `.execute(db)
    await sql`
      INSERT INTO pur_order_item(
        id, idx, qty, base_qty, price, amount, base_price, base_amount, tax_rate,
        material_code, material_name, unit_name, order_id, company_id, material_id, unit_id, received_qty
      ) VALUES (
        ${orderItemId}::uuid, 1, 10, 10, 20, 200, 20, 200, 0,
        ${'FIN' + suffix}, ${'成品' + suffix}, ${'单位' + suffix},
        ${orderId}::uuid, ${companyId}::uuid, ${finishedId}::uuid, ${unitId}::uuid, 0
      )
    `.execute(db)
    await sql`
      INSERT INTO pur_order_item_material(
        id, quantity, issued_qty, order_item_id, company_id, material_id, unit_id
      ) VALUES (
        ${orderMaterialId}::uuid, 8, 0, ${orderItemId}::uuid, ${companyId}::uuid, ${materialId}::uuid, ${unitId}::uuid
      )
    `.execute(db)
    await sql`
      INSERT INTO pur_order_item_byproduct(
        id, quantity, order_item_id, company_id, material_id, unit_id
      ) VALUES (
        ${orderByproductId}::uuid, 2, ${orderItemId}::uuid, ${companyId}::uuid, ${byproductMatId}::uuid, ${unitId}::uuid
      )
    `.execute(db)
    // seed stock in main warehouse for issue
    await sql`
      INSERT INTO inv_stock_entry(
        voucher_type, voucher_id, voucher_no, company_id, posting_date,
        warehouse_id, material_id, quantity, remarks
      ) VALUES (
        'seed', ${crypto.randomUUID()}::uuid, ${'SEED-' + suffix}, ${companyId}::uuid, CURRENT_DATE,
        ${mainWhId}::uuid, ${materialId}::uuid, 100, 'fixture'
      )
    `.execute(db)
  })

  afterAll(async () => {
    await sql`DELETE FROM inv_stock_entry WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_gl_entry WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_outsourced_issue WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_outsourced_receipt WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_order_item_byproduct WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_order_item_material WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_order_item WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_order WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_account WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM inv_warehouse WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_supplier WHERE id=${supplierId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material WHERE id IN (${materialId}::uuid, ${finishedId}::uuid, ${byproductMatId}::uuid)`.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id=${categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id=${unitId}::uuid`.execute(db)
    await sql`DELETE FROM bas_company WHERE id IN (${companyId}::uuid, ${otherCompanyId}::uuid)`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id=${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  test('发料审核：库存双分录 + issued_qty；入库审核：三库存+投影+总账；作废全回滚', async () => {
    const issue = await outsourced.createIssue(permit(ISSUE_RESOURCE, 'create'), {
      companyId,
      issueNo: `OI-${suffix}`,
      partyType: 'SUPPLIER',
      partyId: supplierId,
      fromWarehouseId: mainWhId,
      outsourcedWarehouseId: outWhId,
    })
    expect(issue.status).toBe('DRAFT')

    const issueItem = await outsourced.createIssueItem(permit(ISSUE_ITEM_RESOURCE, 'create'), {
      issueId: issue.id,
      idx: 1,
      qty: '4',
      orderItemMaterialId: orderMaterialId,
    })
    expectQty(issueItem.baseQty, '4')
    expect(issueItem.materialId).toBe(materialId)

    const auditedIssue = await outsourced.auditIssue(permit(ISSUE_RESOURCE, 'audit'), issue.id)
    expect(auditedIssue.status).toBe('AUDITED')

    const issued = await sql<{ issued_qty: string }>`
      SELECT issued_qty::text AS issued_qty FROM pur_order_item_material WHERE id=${orderMaterialId}::uuid
    `.execute(db)
    expectQty(issued.rows[0]?.issued_qty, '4')

    const issueStock = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM inv_stock_entry
      WHERE voucher_type='purchase.outsourced_issue' AND voucher_id=${issue.id}::uuid
        AND is_cancelled = false
    `.execute(db)
    expect(Number(issueStock.rows[0]?.c)).toBe(2)

    const receipt = await outsourced.createReceipt(permit(RECEIPT_RESOURCE, 'create'), {
      companyId,
      receiptNo: `OR-${suffix}`,
      partyType: 'SUPPLIER',
      partyId: supplierId,
      warehouseId: mainWhId,
      outsourcedWarehouseId: outWhId,
      debitAccountId: debitId,
      creditAccountId: creditId,
    })

    const receiptItem = await outsourced.createReceiptItem(permit(RECEIPT_ITEM_RESOURCE, 'create'), {
      receiptId: receipt.id,
      idx: 1,
      qty: '5',
      orderItemId,
      warehouseId: mainWhId,
    })
    expectQty(receiptItem.baseQty, '5')
    // 比例带出：材料 8*(5/10)=4，副产 2*(5/10)=1
    const mats = await outsourced.listReceiptMaterials(permit(RECEIPT_MATERIAL_RESOURCE, 'read'), {
      filter: {
        receiptItemId: { kind: 'fk', values: [receiptItem.id] },
      } as never,
      limit: 20,
    })
    expect(mats.count).toBeGreaterThanOrEqual(1)
    const mat = mats.results.find(
      (r) => String((r as { orderItemMaterialId: string }).orderItemMaterialId) === orderMaterialId,
    )
    expect(mat).toBeTruthy()
    expectQty(String((mat as { qty: string }).qty), '4')

    const byps = await outsourced.listReceiptByproducts(permit(RECEIPT_BYPRODUCT_RESOURCE, 'read'), {
      filter: {
        receiptItemId: { kind: 'fk', values: [receiptItem.id] },
      } as never,
      limit: 20,
    })
    expect(byps.count).toBeGreaterThanOrEqual(1)

    // 补全子行外协仓（带出可能已填默认）
    for (const m of mats.results) {
      const row = m as { id: string; outsourcedWarehouseId: string | null }
      if (!row.outsourcedWarehouseId) {
        await outsourced.updateReceiptMaterial(permit(RECEIPT_MATERIAL_RESOURCE, 'update'), row.id, {
          outsourcedWarehouseId: outWhId,
          outsourcedWarehouseIdPresent: true,
        })
      }
    }
    for (const b of byps.results) {
      const row = b as { id: string; warehouseId: string | null }
      if (!row.warehouseId) {
        await outsourced.updateReceiptByproduct(permit(RECEIPT_BYPRODUCT_RESOURCE, 'update'), row.id, {
          warehouseId: mainWhId,
          warehouseIdPresent: true,
        })
      }
    }

    const auditedReceipt = await outsourced.auditReceipt(permit(RECEIPT_RESOURCE, 'audit'), receipt.id)
    expect(auditedReceipt.status).toBe('AUDITED')

    const received = await sql<{ received_qty: string }>`
      SELECT received_qty::text AS received_qty FROM pur_order_item WHERE id=${orderItemId}::uuid
    `.execute(db)
    expectQty(received.rows[0]?.received_qty, '5')

    const receiptStock = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM inv_stock_entry
      WHERE voucher_type='purchase.outsourced_receipt' AND voucher_id=${receipt.id}::uuid
        AND is_cancelled = false
    `.execute(db)
    // 成品1 + 材料1 + 副产1
    expect(Number(receiptStock.rows[0]?.c)).toBe(3)

    const glCount = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM acc_gl_entry
      WHERE voucher_type='purchase.outsourced_receipt' AND voucher_id=${receipt.id}::uuid
        AND is_cancelled = false
    `.execute(db)
    // 本币金额 200*(5/10)=100 > 0 → 借贷 2 行
    expect(Number(glCount.rows[0]?.c)).toBe(2)

    await outsourced.voidReceipt(permit(RECEIPT_RESOURCE, 'void'), receipt.id)
    const receivedAfter = await sql<{ received_qty: string }>`
      SELECT received_qty::text AS received_qty FROM pur_order_item WHERE id=${orderItemId}::uuid
    `.execute(db)
    expectQty(receivedAfter.rows[0]?.received_qty, '0')

    const glAfter = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM acc_gl_entry
      WHERE voucher_type='purchase.outsourced_receipt' AND voucher_id=${receipt.id}::uuid
        AND is_cancelled = false
    `.execute(db)
    expect(Number(glAfter.rows[0]?.c)).toBe(0)

    await outsourced.voidIssue(permit(ISSUE_RESOURCE, 'void'), issue.id)
    const issuedAfter = await sql<{ issued_qty: string }>`
      SELECT issued_qty::text AS issued_qty FROM pur_order_item_material WHERE id=${orderMaterialId}::uuid
    `.execute(db)
    expectQty(issuedAfter.rows[0]?.issued_qty, '0')
  })

  test('BOM expand 理论耗用口径：quantity×(1+loss)×条目数量', async () => {
    const bomId = crypto.randomUUID()
    await sql`
      INSERT INTO mfg_bom(id, code, material_id)
      VALUES (${bomId}::uuid, ${'BOM' + suffix}, ${finishedId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO mfg_bom_component(bom_id, material_id, unit_id, quantity, loss_rate)
      VALUES (${bomId}::uuid, ${materialId}::uuid, ${unitId}::uuid, 2, 0.1)
    `.execute(db)
    await sql`
      INSERT INTO mfg_bom_byproduct(bom_id, material_id, unit_id, quantity)
      VALUES (${bomId}::uuid, ${byproductMatId}::uuid, ${unitId}::uuid, 0.5)
    `.execute(db)

    const expanded = await outsourcedConfig.expandBom(permit('purOrders', 'read'), { bomId, quantity: '10' })
    // 2 * 1.1 * 10 = 22
    expectQty(expanded.materials[0]?.quantity, '22')
    // 0.5 * 10 = 5
    expectQty(expanded.byproducts[0]?.quantity, '5')

    await sql`DELETE FROM mfg_bom_byproduct WHERE bom_id=${bomId}::uuid`.execute(db)
    await sql`DELETE FROM mfg_bom_component WHERE bom_id=${bomId}::uuid`.execute(db)
    await sql`DELETE FROM mfg_bom WHERE id=${bomId}::uuid`.execute(db)
  })

  /** 六条列表路径各建一条草稿数据（发料头/行、入库头/成品行、带出的材料/副产物） */
  async function seedAuthzFixture() {
    const issue = await outsourced.createIssue(permit(ISSUE_RESOURCE, 'create'), {
      companyId,
      issueNo: `AZ-I-${suffix}-${crypto.randomUUID().slice(0, 4)}`,
      partyType: 'SUPPLIER',
      partyId: supplierId,
      fromWarehouseId: mainWhId,
      outsourcedWarehouseId: outWhId,
    })
    const issueItem = await outsourced.createIssueItem(permit(ISSUE_ITEM_RESOURCE, 'create'), {
      issueId: issue.id,
      idx: 1,
      qty: '1',
      orderItemMaterialId: orderMaterialId,
    })
    const receipt = await outsourced.createReceipt(permit(RECEIPT_RESOURCE, 'create'), {
      companyId,
      receiptNo: `AZ-R-${suffix}-${crypto.randomUUID().slice(0, 4)}`,
      partyType: 'SUPPLIER',
      partyId: supplierId,
      warehouseId: mainWhId,
      outsourcedWarehouseId: outWhId,
      debitAccountId: debitId,
      creditAccountId: creditId,
    })
    const receiptItem = await outsourced.createReceiptItem(permit(RECEIPT_ITEM_RESOURCE, 'create'), {
      receiptId: receipt.id,
      idx: 1,
      qty: '2',
      orderItemId,
      warehouseId: mainWhId,
    })
    // 比例带出的材料/副产物子行（两级 via 的被测行）
    const mats = await outsourced.listReceiptMaterials(permit(RECEIPT_MATERIAL_RESOURCE, 'read'), {
      filter: { receiptItemId: { kind: 'fk', values: [receiptItem.id] } } as never,
      limit: 20,
    })
    const byps = await outsourced.listReceiptByproducts(
      permit(RECEIPT_BYPRODUCT_RESOURCE, 'read'),
      {
        filter: { receiptItemId: { kind: 'fk', values: [receiptItem.id] } } as never,
        limit: 20,
      },
    )
    const materialId0 = String((mats.results[0] as { id: string }).id)
    const byproductId0 = String((byps.results[0] as { id: string }).id)
    return {
      issueId: issue.id as string,
      issueItemId: issueItem.id as string,
      receiptId: receipt.id as string,
      receiptItemId: receiptItem.id as string,
      materialId: materialId0,
      byproductId: byproductId0,
    }
  }

  /** 列表命中断言：按 id 过滤，断言「本公司的行在结果里」（只断言别人的不在对空集永真） */
  function hasId(result: { results: unknown[] }, id: string) {
    return result.results.some((r) => String((r as { id: string }).id) === id)
  }

  /** id 列不可筛选，按可筛的父外键收窄（issues/receipts 用 companyId） */
  const by = (field: string, value: string) => ({
    filter: { [field]: { kind: 'fk', values: [value] } } as never,
    limit: 50,
  })

  test('别名回归：六条列表路径在公司域 actor 下都能看到本公司的行', async () => {
    const f = await seedAuthzFixture()

    expect(
      hasId(
        await outsourced.listIssues(scoped(ISSUE_RESOURCE, 'read'), by('companyId', companyId)),
        f.issueId,
      ),
    ).toBe(true)
    expect(
      hasId(
        await outsourced.listIssueItems(
          scoped(ISSUE_ITEM_RESOURCE, 'read'),
          by('issueId', f.issueId),
        ),
        f.issueItemId,
      ),
    ).toBe(true)
    expect(
      hasId(
        await outsourced.listReceipts(scoped(RECEIPT_RESOURCE, 'read'), by('companyId', companyId)),
        f.receiptId,
      ),
    ).toBe(true)
    expect(
      hasId(
        await outsourced.listReceiptItems(
          scoped(RECEIPT_ITEM_RESOURCE, 'read'),
          by('receiptId', f.receiptId),
        ),
        f.receiptItemId,
      ),
    ).toBe(true)
    expect(
      hasId(
        await outsourced.listReceiptMaterials(
          scoped(RECEIPT_MATERIAL_RESOURCE, 'read'),
          by('receiptItemId', f.receiptItemId),
        ),
        f.materialId,
      ),
    ).toBe(true)
    expect(
      hasId(
        await outsourced.listReceiptByproducts(
          scoped(RECEIPT_BYPRODUCT_RESOURCE, 'read'),
          by('receiptItemId', f.receiptItemId),
        ),
        f.byproductId,
      ),
    ).toBe(true)

    // 反向：别的公司的 actor 一行都看不到（via 链递归母单公司谓词）
    expect(
      (
        await outsourced.listReceiptMaterials(
          other(RECEIPT_MATERIAL_RESOURCE, 'read'),
          by('receiptItemId', f.receiptItemId),
        )
      ).count,
    ).toBe(0)
    expect(
      (
        await outsourced.listIssueItems(
          other(ISSUE_ITEM_RESOURCE, 'read'),
          by('issueId', f.issueId),
        )
      ).count,
    ).toBe(0)
  })

  test('跨公司单条一律 not_found（含两级 via 的材料/副产物行）', async () => {
    const f = await seedAuthzFixture()
    await expect(outsourced.getIssue(other(ISSUE_RESOURCE, 'read'), f.issueId)).rejects.toThrow(
      '委外发料单不存在',
    )
    await expect(
      outsourced.getIssueItem(other(ISSUE_ITEM_RESOURCE, 'read'), f.issueItemId),
    ).rejects.toThrow('委外发料行不存在')
    await expect(
      outsourced.getReceipt(other(RECEIPT_RESOURCE, 'read'), f.receiptId),
    ).rejects.toThrow('委外入库单不存在')
    await expect(
      outsourced.getReceiptItem(other(RECEIPT_ITEM_RESOURCE, 'read'), f.receiptItemId),
    ).rejects.toThrow('委外入库成品行不存在')
    await expect(
      outsourced.getReceiptMaterial(other(RECEIPT_MATERIAL_RESOURCE, 'read'), f.materialId),
    ).rejects.toThrow('委外入库材料行不存在')
    await expect(
      outsourced.getReceiptByproduct(other(RECEIPT_BYPRODUCT_RESOURCE, 'read'), f.byproductId),
    ).rejects.toThrow('委外入库副产物行不存在')
    // 写侧同理：母单不可达即 not_found（不是 forbidden）
    await expect(
      outsourced.updateIssue(other(ISSUE_RESOURCE, 'update'), f.issueId, { remarks: 'x' }),
    ).rejects.toThrow('委外发料单不存在')
    await expect(
      outsourced.deleteReceiptMaterial(other(RECEIPT_MATERIAL_RESOURCE, 'delete'), f.materialId),
    ).rejects.toThrow('委外入库单不存在')
  })

  test('HTTP 缺码 403；有码 200（403 只由 guard 的码级判定产生）', async () => {
    const paths = [
      '/api/v1/purchase/outsourced-issues/query',
      '/api/v1/purchase/outsourced-issue-items/query',
      '/api/v1/purchase/outsourced-receipts/query',
      '/api/v1/purchase/outsourced-receipt-items/query',
      '/api/v1/purchase/outsourced-receipt-materials/query',
      '/api/v1/purchase/outsourced-receipt-byproducts/query',
    ]
    for (const path of paths) {
      expect((await query(path, 'no-code')).status).toBe(403)
      expect((await query(path, 'scoped')).status).toBe(200)
    }
  })

  test('状态守卫 409：非草稿发料单不可改（领域不变量不在权限系统里）', async () => {
    const issue = await outsourced.createIssue(permit(ISSUE_RESOURCE, 'create'), {
      companyId,
      issueNo: `AZ-S-${suffix}-${crypto.randomUUID().slice(0, 4)}`,
      partyType: 'SUPPLIER',
      partyId: supplierId,
      fromWarehouseId: mainWhId,
      outsourcedWarehouseId: outWhId,
    })
    // 直接置为已审核：只验状态门，不触发库存/总账副作用
    await sql`UPDATE pur_outsourced_issue SET status='audited' WHERE id=${issue.id}::uuid`.execute(db)
    await expect(
      outsourced.updateIssue(scoped(ISSUE_RESOURCE, 'update'), issue.id, { remarks: 'x' }),
    ).rejects.toThrow('仅草稿委外发料单可编辑')
    await expect(
      outsourced.deleteIssue(scoped(ISSUE_RESOURCE, 'delete'), issue.id),
    ).rejects.toThrow('仅草稿委外发料单可编辑')
  })
})
