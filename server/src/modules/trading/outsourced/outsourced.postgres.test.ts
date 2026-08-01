/**
 * 委外发料/入库 PG 集成：审核三副作用、发料投影、比例带出、作废回滚。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { decimal } from '@synie/shared'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { createInventoryEngine } from '~/engines/inventory/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { createOutsourcedConfigService } from '../order/outsourced-config.ts'
import { createOutsourcedService } from './service.ts'

function expectQty(got: string | undefined, want: string) {
  expect(decimal(got ?? 'NaN').equals(decimal(want))).toBe(true)
}

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（委外发料/入库生命周期）', () => {
  const db = createDb(url!)
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
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
  const outsourcedConfig = createOutsourcedConfigService(db)
  const outsourced = createOutsourcedService(db, numberer as never, {
    inventory: createInventoryEngine(),
    gl: createGlEngine(),
  })

  const actor: Actor = {
    userId: '',
    username: 'admin',
    name: 'admin',
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  }

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency(id, name, iso_code, symbol, active)
      VALUES (${currencyId}::uuid, ${'委外币' + suffix}, ${'O' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id, code, name, short_name, base_currency_id)
      VALUES (${companyId}::uuid, ${'OC' + suffix}, ${'委外公司' + suffix}, ${'OC' + suffix.slice(0, 4)}, ${currencyId}::uuid)
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
    await sql`DELETE FROM bas_company WHERE id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id=${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  test('发料审核：库存双分录 + issued_qty；入库审核：三库存+投影+总账；作废全回滚', async () => {
    const issue = await outsourced.createIssue(actor, {
      companyId,
      issueNo: `OI-${suffix}`,
      partyType: 'SUPPLIER',
      partyId: supplierId,
      fromWarehouseId: mainWhId,
      outsourcedWarehouseId: outWhId,
    })
    expect(issue.status).toBe('DRAFT')

    const issueItem = await outsourced.createIssueItem(actor, {
      issueId: issue.id,
      idx: 1,
      qty: '4',
      orderItemMaterialId: orderMaterialId,
    })
    expectQty(issueItem.baseQty, '4')
    expect(issueItem.materialId).toBe(materialId)

    const auditedIssue = await outsourced.auditIssue(actor, issue.id)
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

    const receipt = await outsourced.createReceipt(actor, {
      companyId,
      receiptNo: `OR-${suffix}`,
      partyType: 'SUPPLIER',
      partyId: supplierId,
      warehouseId: mainWhId,
      outsourcedWarehouseId: outWhId,
      debitAccountId: debitId,
      creditAccountId: creditId,
    })

    const receiptItem = await outsourced.createReceiptItem(actor, {
      receiptId: receipt.id,
      idx: 1,
      qty: '5',
      orderItemId,
      warehouseId: mainWhId,
    })
    expectQty(receiptItem.baseQty, '5')
    // 比例带出：材料 8*(5/10)=4，副产 2*(5/10)=1
    const mats = await outsourced.listReceiptMaterials(actor, {
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

    const byps = await outsourced.listReceiptByproducts(actor, {
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
        await outsourced.updateReceiptMaterial(actor, row.id, {
          outsourcedWarehouseId: outWhId,
          outsourcedWarehouseIdPresent: true,
        })
      }
    }
    for (const b of byps.results) {
      const row = b as { id: string; warehouseId: string | null }
      if (!row.warehouseId) {
        await outsourced.updateReceiptByproduct(actor, row.id, {
          warehouseId: mainWhId,
          warehouseIdPresent: true,
        })
      }
    }

    const auditedReceipt = await outsourced.auditReceipt(actor, receipt.id)
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

    await outsourced.voidReceipt(actor, receipt.id)
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

    await outsourced.voidIssue(actor, issue.id)
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

    const expanded = await outsourcedConfig.expandBom(actor, { bomId, quantity: '10' })
    // 2 * 1.1 * 10 = 22
    expectQty(expanded.materials[0]?.quantity, '22')
    // 0.5 * 10 = 5
    expectQty(expanded.byproducts[0]?.quantity, '5')

    await sql`DELETE FROM mfg_bom_byproduct WHERE bom_id=${bomId}::uuid`.execute(db)
    await sql`DELETE FROM mfg_bom_component WHERE bom_id=${bomId}::uuid`.execute(db)
    await sql`DELETE FROM mfg_bom WHERE id=${bomId}::uuid`.execute(db)
  })
})
