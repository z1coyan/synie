/**
 * 订单履约投影 PG 集成：超发容差硬拦、聚合同条目、采购需求已收同步。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { decimal } from '@synie/shared'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { withTx } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { postFulfillment, reverseFulfillment } from './projection.ts'

function expectQty(got: string | undefined, want: string) {
  expect(decimal(got ?? 'NaN').equals(decimal(want))).toBe(true)
}

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（订单履约投影 / 容差）', () => {
  const db = createDb(url!)
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  const supplierId = crypto.randomUUID()
  const demandId = crypto.randomUUID()
  const demandLineId = crypto.randomUUID()
  let prevOvership = '0'
  let prevOverreceive = '0'

  beforeAll(async () => {
    const prev = await sql<{ d: string; r: string }>`
      SELECT delivery_overship_ratio::text AS d, receipt_overreceive_ratio::text AS r
      FROM sal_setting LIMIT 1
    `.execute(db)
    prevOvership = prev.rows[0]?.d ?? '0'
    prevOverreceive = prev.rows[0]?.r ?? '0'

    await sql`
      INSERT INTO bas_currency(id, name, iso_code, symbol, active)
      VALUES (${currencyId}::uuid, ${'投影币' + suffix}, ${'P' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id, code, name, short_name, base_currency_id)
      VALUES (${companyId}::uuid, ${'PC' + suffix}, ${'投影公司' + suffix}, ${'PC' + suffix.slice(0, 4)}, ${currencyId}::uuid)
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
      VALUES (${materialId}::uuid, ${'MAT' + suffix}, ${'投影物料' + suffix}, ${categoryId}::uuid, ${unitId}::uuid, true)
    `.execute(db)
    await sql`
      INSERT INTO sal_customers(id, code, name, short_name)
      VALUES (${customerId}::uuid, ${'CU' + suffix}, ${'客户' + suffix}, ${'CU' + suffix.slice(0, 4)})
    `.execute(db)
    await sql`
      INSERT INTO pur_supplier(id, code, name, short_name)
      VALUES (${supplierId}::uuid, ${'SU' + suffix}, ${'供应商' + suffix}, ${'SU' + suffix.slice(0, 4)})
    `.execute(db)
    await sql`
      INSERT INTO mfg_demand(id, demand_no, demand_date, assign_type, status, company_id)
      VALUES (${demandId}::uuid, ${'DEM' + suffix}, CURRENT_DATE, 'purchase', 'confirmed', ${companyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO mfg_demand_item(
        id, idx, qty, base_qty, need_date, fulfillment_method, status,
        material_code, material_name, unit_name,
        demand_id, company_id, material_id, unit_id, received_qty
      ) VALUES (
        ${demandLineId}::uuid, 1, 5, 5, CURRENT_DATE, 'buy', 'pending',
        ${'MAT' + suffix}, ${'投影物料' + suffix}, ${'单位' + suffix},
        ${demandId}::uuid, ${companyId}::uuid, ${materialId}::uuid, ${unitId}::uuid, 0
      )
    `.execute(db)
  })

  afterAll(async () => {
    await sql`UPDATE sal_setting SET
      delivery_overship_ratio = ${prevOvership}::numeric,
      receipt_overreceive_ratio = ${prevOverreceive}::numeric
    `.execute(db)
    await sql`DELETE FROM pur_order_item WHERE company_id = ${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_order WHERE company_id = ${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_order_item WHERE company_id = ${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_order WHERE company_id = ${companyId}::uuid`.execute(db)
    await sql`DELETE FROM mfg_demand_item WHERE demand_id = ${demandId}::uuid`.execute(db)
    await sql`DELETE FROM mfg_demand WHERE id = ${demandId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material WHERE id = ${materialId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id = ${categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id = ${unitId}::uuid`.execute(db)
    await sql`DELETE FROM sal_customers WHERE id = ${customerId}::uuid`.execute(db)
    await sql`DELETE FROM pur_supplier WHERE id = ${supplierId}::uuid`.execute(db)
    await sql`DELETE FROM bas_company WHERE id = ${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id = ${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  test('销售：同条目聚合 + 容差内通过 + 超容差硬拦', async () => {
    await sql`UPDATE sal_setting SET delivery_overship_ratio = 0.1`.execute(db)
    const orderId = crypto.randomUUID()
    const itemId = crypto.randomUUID()
    await sql`
      INSERT INTO sal_order(id, order_no, party_type, party_id, status, company_id, currency_id)
      VALUES (${orderId}::uuid, ${'SO' + suffix}, 'CUSTOMER', ${customerId}::uuid, 'audited', ${companyId}::uuid, ${currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sal_order_item(
        id, idx, qty, base_qty, price, material_code, material_name, unit_name,
        order_id, company_id, material_id, unit_id, shipped_qty
      ) VALUES (
        ${itemId}::uuid, 1, 10, 10, 1, ${'MAT' + suffix}, ${'投影物料' + suffix}, ${'单位' + suffix},
        ${orderId}::uuid, ${companyId}::uuid, ${materialId}::uuid, ${unitId}::uuid, 0
      )
    `.execute(db)

    await withTx(db, async (trx) => {
      await postFulfillment(trx, 'sales', {
        companyId,
        partyType: 'customer',
        partyId: customerId,
        lines: [
          { orderItemId: itemId, baseQty: '6' },
          { orderItemId: itemId, baseQty: '5' },
        ],
      })
    })
    const afterAgg = await sql<{ q: string }>`
      SELECT shipped_qty::text AS q FROM sal_order_item WHERE id = ${itemId}::uuid
    `.execute(db)
    expectQty(afterAgg.rows[0]?.q, '11')

    let blocked: unknown
    try {
      await withTx(db, async (trx) => {
        await postFulfillment(trx, 'sales', {
          companyId,
          partyType: 'CUSTOMER',
          partyId: customerId,
          lines: [{ orderItemId: itemId, baseQty: '0.01' }],
        })
      })
    } catch (err) {
      blocked = err
    }
    expect(blocked).toBeInstanceOf(ApiError)
    expect((blocked as ApiError).code).toBe('conflict')
    expect((blocked as ApiError).message).toContain('超出订单条目可履约数量')

    const afterBlock = await sql<{ q: string }>`
      SELECT shipped_qty::text AS q FROM sal_order_item WHERE id = ${itemId}::uuid
    `.execute(db)
    expectQty(afterBlock.rows[0]?.q, '11')
  })

  test('采购：入库满量完成需求 + reverse 回落 pending', async () => {
    await sql`UPDATE sal_setting SET receipt_overreceive_ratio = 0`.execute(db)
    const orderId = crypto.randomUUID()
    const itemId = crypto.randomUUID()
    await sql`
      INSERT INTO pur_order(id, order_no, party_type, party_id, status, company_id, currency_id, is_outsourced)
      VALUES (${orderId}::uuid, ${'PO' + suffix}, 'supplier', ${supplierId}::uuid, 'audited', ${companyId}::uuid, ${currencyId}::uuid, false)
    `.execute(db)
    await sql`
      INSERT INTO pur_order_item(
        id, idx, qty, base_qty, price, material_code, material_name, unit_name,
        order_id, company_id, material_id, unit_id, demand_line_id, received_qty
      ) VALUES (
        ${itemId}::uuid, 1, 5, 5, 1, ${'MAT' + suffix}, ${'投影物料' + suffix}, ${'单位' + suffix},
        ${orderId}::uuid, ${companyId}::uuid, ${materialId}::uuid, ${unitId}::uuid, ${demandLineId}::uuid, 0
      )
    `.execute(db)
    // 审核占量等价：采购安排 + arranged/ordered 投影（本测直写分录，不经订单审核）
    await sql`
      INSERT INTO mfg_demand_arrangement(
        demand_item_id, company_id, arrangement_type, qty, base_qty, purchase_order_item_id
      ) VALUES (
        ${demandLineId}::uuid, ${companyId}::uuid, 'purchase', 5, 5, ${itemId}::uuid
      )
    `.execute(db)
    await sql`
      UPDATE mfg_demand_item
      SET ordered_qty = 5, arranged_qty = 5, status = 'scheduled'
      WHERE id = ${demandLineId}::uuid
    `.execute(db)

    await withTx(db, async (trx) => {
      await postFulfillment(trx, 'purchase', {
        companyId,
        partyType: 'SUPPLIER',
        partyId: supplierId,
        lines: [{ orderItemId: itemId, baseQty: '5' }],
      })
    })
    const recv = await sql<{ q: string }>`
      SELECT received_qty::text AS q FROM pur_order_item WHERE id = ${itemId}::uuid
    `.execute(db)
    expectQty(recv.rows[0]?.q, '5')
    const dem = await sql<{ q: string; s: string }>`
      SELECT received_qty::text AS q, status AS s FROM mfg_demand_item WHERE id = ${demandLineId}::uuid
    `.execute(db)
    expectQty(dem.rows[0]?.q, '5')
    expect(dem.rows[0]?.s).toBe('completed')

    await withTx(db, async (trx) => {
      await reverseFulfillment(trx, 'purchase', {
        companyId,
        partyType: 'supplier',
        partyId: supplierId,
        lines: [{ orderItemId: itemId, baseQty: '2' }],
      })
    })
    const dem2 = await sql<{ q: string; s: string }>`
      SELECT received_qty::text AS q, status AS s FROM mfg_demand_item WHERE id = ${demandLineId}::uuid
    `.execute(db)
    expectQty(dem2.rows[0]?.q, '3')
    expect(dem2.rows[0]?.s).toBe('scheduled')
  })
})
