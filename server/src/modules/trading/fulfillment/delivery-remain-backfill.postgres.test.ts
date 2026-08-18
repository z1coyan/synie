/**
 * W5 delivery-remain：全额 sales.delivery GL + 简道云出库备注 + 0008
 * → apply 后旧组作废、新组=剩余、0008 三表不在；闸失败整事务回滚。
 * 门控 SYNIE_TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { systemPermit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import {
  PLUG_0008_DATE,
  PLUG_0008_VOUCHER_NO,
  runDeliveryRemainBackfill,
} from './delivery-remain-backfill.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（发货剩余补过账）', () => {
  const db = createDb(url!)
  const permit = () => systemPermit('salDeliveries', 'audit')

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const prefix = `DR${suffix}`
  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const company2Id = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  const debitAccountId = crypto.randomUUID()
  const creditAccountId = crypto.randomUUID()
  const debit2Id = crypto.randomUUID()
  const credit2Id = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const warehouseId = crypto.randomUUID()
  const orderId = crypto.randomUUID()
  const orderItemId = crypto.randomUUID()

  async function insertDelivery(opts: {
    remarks: string | null
    qty: string
    reconciled: string
    price: string
    date?: string
    fullGl: boolean
  }): Promise<string> {
    const id = crypto.randomUUID()
    const date = opts.date ?? '2026-07-25'
    const no = `${prefix}-${id.slice(0, 8)}`
    await sql`
      INSERT INTO sal_delivery (
        id, delivery_no, delivery_date, posting_date, party_type, party_id, remarks,
        status, company_id, warehouse_id, debit_account_id, credit_account_id
      ) VALUES (
        ${id}::uuid, ${no}, ${date}::date, ${date}::date, 'customer', ${customerId}::uuid,
        ${opts.remarks}, 'audited', ${companyId}::uuid, ${warehouseId}::uuid,
        ${debitAccountId}::uuid, ${creditAccountId}::uuid
      )
    `.execute(db)
    await sql`
      INSERT INTO sal_delivery_item (
        idx, qty, base_qty, material_code, material_name, unit_name,
        order_no, order_qty, order_base_qty, order_unit_name, order_price, order_amount,
        order_base_price, order_base_amount, order_tax_rate, order_currency_code,
        delivery_id, company_id, order_item_id, material_id, unit_id, warehouse_id,
        reconciled_qty
      ) VALUES (
        1, ${opts.qty}, ${opts.qty}, ${'M' + suffix}, ${prefix + '物料'}, ${prefix + '件'},
        ${prefix + '-SO'}, 1000, 1000, ${prefix + '件'}, ${opts.price}, 0,
        ${opts.price}, 0, 0, 'CNY',
        ${id}::uuid, ${companyId}::uuid, ${orderItemId}::uuid, ${materialId}::uuid,
        ${unitId}::uuid, ${warehouseId}::uuid, ${opts.reconciled}
      )
    `.execute(db)
    if (opts.fullGl) {
      const full = (Number(opts.qty) * Number(opts.price)).toFixed(2)
      await insertDeliveryGl(id, no, date, full)
    }
    return id
  }

  async function insertDeliveryGl(id: string, no: string, date: string, amount: string) {
    await sql`
      INSERT INTO acc_gl_entry (
        company_id, account_id, posting_date, debit, credit,
        voucher_type, voucher_id, voucher_no, party_type, party_id
      ) VALUES
        (${companyId}::uuid, ${debitAccountId}::uuid, ${date}::date, ${amount}, 0,
          'sales.delivery', ${id}::uuid, ${no}, 'customer', ${customerId}::uuid),
        (${companyId}::uuid, ${creditAccountId}::uuid, ${date}::date, 0, ${amount},
          'sales.delivery', ${id}::uuid, ${no}, NULL, NULL)
    `.execute(db)
  }

  async function insertPlug0008(targetCompanyId: string, debitId: string, creditId: string) {
    const existing = await sql<{ id: string }>`
      SELECT id::text AS id FROM acc_gl_journal
      WHERE company_id = ${targetCompanyId}::uuid
        AND voucher_no = ${PLUG_0008_VOUCHER_NO}
        AND date = ${PLUG_0008_DATE}::date
    `.execute(db)
    if (existing.rows[0]) return existing.rows[0].id
    const journalId = crypto.randomUUID()
    await sql`
      INSERT INTO acc_gl_journal (id, voucher_no, date, posting_date, remarks, status, company_id)
      VALUES (
        ${journalId}::uuid, ${PLUG_0008_VOUCHER_NO}, ${PLUG_0008_DATE}::date,
        ${PLUG_0008_DATE}::date, '找平1124', 'audited', ${targetCompanyId}::uuid
      )
    `.execute(db)
    const line1 = crypto.randomUUID()
    const line2 = crypto.randomUUID()
    await sql`
      INSERT INTO acc_gl_journal_line (id, idx, debit, credit, journal_id, company_id, account_id)
      VALUES
        (${line1}::uuid, 1, 100, 0, ${journalId}::uuid, ${targetCompanyId}::uuid, ${debitId}::uuid),
        (${line2}::uuid, 2, 0, 100, ${journalId}::uuid, ${targetCompanyId}::uuid, ${creditId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO acc_gl_entry (
        company_id, account_id, posting_date, debit, credit,
        voucher_type, voucher_id, voucher_no
      ) VALUES
        (${targetCompanyId}::uuid, ${debitId}::uuid, ${PLUG_0008_DATE}::date, 100, 0,
          'acc.gl_journal', ${journalId}::uuid, ${PLUG_0008_VOUCHER_NO}),
        (${targetCompanyId}::uuid, ${creditId}::uuid, ${PLUG_0008_DATE}::date, 0, 100,
          'acc.gl_journal', ${journalId}::uuid, ${PLUG_0008_VOUCHER_NO})
    `.execute(db)
    await sql`
      INSERT INTO sys_audit_log (resource, record_id, action_type, action_name, changes, company_id)
      VALUES
        ('acc_gl_journal', ${journalId}::uuid, 'create', 'create', '{}'::jsonb, ${targetCompanyId}::uuid),
        ('acc_gl_journal_line', ${line1}::uuid, 'create', 'create', '{}'::jsonb, ${targetCompanyId}::uuid)
    `.execute(db)
    return journalId
  }

  async function deliveryGl(id: string) {
    return sql<{
      account_id: string
      debit: string
      credit: string
      is_cancelled: boolean
    }>`
      SELECT account_id::text, debit::text, credit::text, is_cancelled
      FROM acc_gl_entry
      WHERE voucher_type = 'sales.delivery' AND voucher_id = ${id}::uuid
      ORDER BY seq
    `.execute(db)
  }

  async function plugExists(): Promise<boolean> {
    const rows = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM acc_gl_journal
      WHERE voucher_no = ${PLUG_0008_VOUCHER_NO} AND date = ${PLUG_0008_DATE}::date
        AND company_id IN (${companyId}::uuid, ${company2Id}::uuid)
    `.execute(db)
    return Number(rows.rows[0]!.c) > 0
  }

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${currencyId}::uuid, ${prefix + '币'}, ${'D' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id) VALUES
        (${companyId}::uuid, ${'D' + suffix}, ${prefix + '公司'}, 'DR', ${currencyId}::uuid),
        (${company2Id}::uuid, ${'E' + suffix}, ${prefix + '公司二'}, 'D2', ${currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sal_customers(id,code,name,short_name)
      VALUES (${customerId}::uuid, ${'CU' + suffix}, ${prefix + '客户'}, 'CU')
    `.execute(db)
    await sql`
      INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
      VALUES (${unitId}::uuid, ${'dr-' + suffix}, true, ${prefix + '件'}, 'u', 1)
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
        (${debitAccountId}::uuid, '1124', ${prefix + '未开票'}, 'debit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, 'unbilled_receivable'),
        (${creditAccountId}::uuid, ${'6001' + suffix.slice(0, 4)}, ${prefix + '收入'}, 'credit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${debit2Id}::uuid, '1124', ${prefix + '未开票二'}, 'debit', false, true,
          ${company2Id}::uuid, ${currencyId}::uuid, 'unbilled_receivable'),
        (${credit2Id}::uuid, ${'6002' + suffix.slice(0, 4)}, ${prefix + '收入二'}, 'credit', false, true,
          ${company2Id}::uuid, ${currencyId}::uuid, NULL)
    `.execute(db)
    await sql`
      INSERT INTO sal_order(id,order_no,order_date,party_type,party_id,status,company_id,exchange_rate,currency_id,order_type)
      VALUES (
        ${orderId}::uuid, ${prefix + '-SO'}, '2026-07-20', 'customer', ${customerId}::uuid,
        'audited', ${companyId}::uuid, 1, ${currencyId}::uuid, 'regular'
      )
    `.execute(db)
    await sql`
      INSERT INTO sal_order_item(
        id,idx,qty,price,amount,order_id,company_id,material_id,unit_id,
        material_code,material_name,unit_name,base_qty,base_price,base_amount,tax_rate
      ) VALUES (
        ${orderItemId}::uuid,1,1000,10,10000,${orderId}::uuid,${companyId}::uuid,
        ${materialId}::uuid,${unitId}::uuid,${'M' + suffix},${prefix + '物料'},${prefix + '件'},1000,10,10000,0
      )
    `.execute(db)
  })

  afterAll(async () => {
    await sql`DELETE FROM acc_bank_reconciliation WHERE company_id IN (${companyId}::uuid, ${company2Id}::uuid)`.execute(db)
    await sql`DELETE FROM acc_bank_transaction WHERE company_id IN (${companyId}::uuid, ${company2Id}::uuid)`.execute(db)
    await sql`DELETE FROM acc_bank_account WHERE company_id IN (${companyId}::uuid, ${company2Id}::uuid)`.execute(db)
    await sql`DELETE FROM acc_gl_entry WHERE company_id IN (${companyId}::uuid, ${company2Id}::uuid)`.execute(db)
    await sql`DELETE FROM sys_audit_log WHERE company_id IN (${companyId}::uuid, ${company2Id}::uuid)`.execute(db)
    await sql`
      DELETE FROM acc_gl_journal_line WHERE journal_id IN (
        SELECT id FROM acc_gl_journal WHERE company_id IN (${companyId}::uuid, ${company2Id}::uuid)
      )
    `.execute(db)
    await sql`DELETE FROM acc_gl_journal WHERE company_id IN (${companyId}::uuid, ${company2Id}::uuid)`.execute(db)
    await sql`DELETE FROM sal_delivery WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_order_item WHERE id=${orderItemId}::uuid`.execute(db)
    await sql`DELETE FROM sal_order WHERE id=${orderId}::uuid`.execute(db)
    await sql`DELETE FROM bas_account WHERE company_id IN (${companyId}::uuid, ${company2Id}::uuid)`.execute(db)
    await sql`DELETE FROM inv_warehouse WHERE id=${warehouseId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material WHERE id=${materialId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id=${categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id=${unitId}::uuid`.execute(db)
    await sql`DELETE FROM sal_customers WHERE id=${customerId}::uuid`.execute(db)
    await sql`DELETE FROM bas_company WHERE id IN (${companyId}::uuid, ${company2Id}::uuid)`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id=${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  test('apply：旧组作废、新组两行=剩余、两公司 0008 删除', async () => {
    const id = await insertDelivery({
      remarks: '简道云出库:FO-1',
      qty: '10',
      reconciled: '4',
      price: '10',
      fullGl: true,
    })
    const j1 = await insertPlug0008(companyId, debitAccountId, creditAccountId)
    const j2 = await insertPlug0008(company2Id, debit2Id, credit2Id)

    const result = await runDeliveryRemainBackfill(db, permit(), { ids: [id], apply: true })
    expect(result.apply).toBe(true)
    expect(result.cancelled).toEqual([id])
    expect(result.posted).toEqual([{ id, amount: '60.00' }])
    expect(result.deletedJournals.sort()).toEqual([j1, j2].sort())

    const rows = await deliveryGl(id)
    const live = rows.rows.filter((r) => !r.is_cancelled)
    const cancelled = rows.rows.filter((r) => r.is_cancelled)
    expect(cancelled).toHaveLength(2)
    expect(live).toHaveLength(2)
    const debit = live.find((r) => r.account_id === debitAccountId)
    expect(Number(debit?.debit)).toBe(60)
    expect(Number(debit?.credit)).toBe(0)
    expect(await plugExists()).toBe(false)
    const leftoverEntry = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM acc_gl_entry
      WHERE voucher_type='acc.gl_journal' AND voucher_id IN (${j1}::uuid, ${j2}::uuid)
    `.execute(db)
    expect(leftoverEntry.rows[0]?.c).toBe('0')
    const leftoverLine = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM acc_gl_journal_line
      WHERE journal_id IN (${j1}::uuid, ${j2}::uuid)
    `.execute(db)
    expect(leftoverLine.rows[0]?.c).toBe('0')
  })

  test('同户两头：最后一头吸收 verify6 尾差', async () => {
    const a = await insertDelivery({
      remarks: '简道云出库:FO-tail-a',
      qty: '1',
      reconciled: '0',
      price: '10.004',
      date: '2026-07-20',
      fullGl: true,
    })
    const b = await insertDelivery({
      remarks: '简道云出库:FO-tail-b',
      qty: '1',
      reconciled: '0',
      price: '10.004',
      date: '2026-07-21',
      fullGl: true,
    })
    await insertPlug0008(companyId, debitAccountId, creditAccountId)

    const result = await runDeliveryRemainBackfill(db, permit(), { ids: [a, b], apply: true })
    const byId = new Map(result.posted.map((p) => [p.id, p.amount]))
    expect(byId.get(a)).toBe('10.00')
    expect(byId.get(b)).toBe('10.01')
  })

  test('非简道云备注却有未作废分录 → 整事务回滚', async () => {
    const id = await insertDelivery({
      remarks: '简道云出库:FO-gate',
      qty: '10',
      reconciled: '3',
      price: '10',
      fullGl: true,
    })
    const leak = await insertDelivery({
      remarks: '正规发货',
      qty: '2',
      reconciled: '0',
      price: '10',
      fullGl: true,
    })
    const journalId = await insertPlug0008(companyId, debitAccountId, creditAccountId)

    const err = await runDeliveryRemainBackfill(db, permit(), { ids: [id], apply: true }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('conflict')

    const rows = await deliveryGl(id)
    expect(rows.rows.every((r) => !r.is_cancelled)).toBe(true)
    expect(await plugExists()).toBe(true)

    await sql`DELETE FROM acc_gl_entry WHERE voucher_id=${leak}::uuid`.execute(db)
    await sql`DELETE FROM sal_delivery WHERE id=${leak}::uuid`.execute(db)
    await sql`DELETE FROM acc_gl_entry WHERE voucher_id=${journalId}::uuid`.execute(db)
    await sql`DELETE FROM acc_gl_journal_line WHERE journal_id=${journalId}::uuid`.execute(db)
    await sql`DELETE FROM sys_audit_log WHERE record_id=${journalId}::uuid`.execute(db)
    await sql`DELETE FROM acc_gl_journal WHERE id=${journalId}::uuid`.execute(db)
  })

  test('0008 被银行对账引用 → 整事务回滚', async () => {
    const id = await insertDelivery({
      remarks: '简道云出库:FO-recon',
      qty: '10',
      reconciled: '2',
      price: '10',
      fullGl: true,
    })
    const journalId = await insertPlug0008(companyId, debitAccountId, creditAccountId)
    const bankAccountId = crypto.randomUUID()
    const txnId = crypto.randomUUID()
    const reconId = crypto.randomUUID()
    await sql`
      INSERT INTO acc_bank_account (id, alias, bank_name, holder_name, account_no, company_id, currency_id)
      VALUES (${bankAccountId}::uuid, ${prefix + '户'}, '测试银行', '持有人', ${'BA' + suffix},
        ${companyId}::uuid, ${currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO acc_bank_transaction (
        id, occurred_at, income, company_id, bank_account_id
      ) VALUES (
        ${txnId}::uuid, '2020-01-02 00:00:00', 100, ${companyId}::uuid, ${bankAccountId}::uuid
      )
    `.execute(db)
    await sql`
      INSERT INTO acc_bank_reconciliation (
        id, amount, company_id, bank_transaction_id, voucher_type, voucher_id, voucher_no
      ) VALUES (
        ${reconId}::uuid, 100, ${companyId}::uuid, ${txnId}::uuid,
        'acc.gl_journal', ${journalId}::uuid, ${PLUG_0008_VOUCHER_NO}
      )
    `.execute(db)

    const err = await runDeliveryRemainBackfill(db, permit(), { ids: [id], apply: true }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).message).toMatch(/银行对账/)

    const rows = await deliveryGl(id)
    expect(rows.rows.filter((r) => !r.is_cancelled)).toHaveLength(2)
    expect(await plugExists()).toBe(true)

    await sql`DELETE FROM acc_bank_reconciliation WHERE id=${reconId}::uuid`.execute(db)
    await sql`DELETE FROM acc_bank_transaction WHERE id=${txnId}::uuid`.execute(db)
    await sql`DELETE FROM acc_bank_account WHERE id=${bankAccountId}::uuid`.execute(db)
  })

  test('空 ids 不 cancel/post；dry-run 不写', async () => {
    const id = await insertDelivery({
      remarks: '简道云出库:FO-dry',
      qty: '5',
      reconciled: '1',
      price: '10',
      fullGl: true,
    })
    await insertPlug0008(companyId, debitAccountId, creditAccountId)

    const preview = await runDeliveryRemainBackfill(db, permit(), { ids: [id], apply: false })
    expect(preview.apply).toBe(false)
    expect(preview.cancelled).toEqual([id])
    expect(preview.posted[0]?.amount).toBe('40.00')
    const before = await deliveryGl(id)
    expect(before.rows.every((r) => !r.is_cancelled)).toBe(true)
    expect(await plugExists()).toBe(true)

    const empty = await runDeliveryRemainBackfill(db, permit(), { ids: [], apply: false })
    expect(empty.cancelled).toEqual([])
    expect(empty.posted).toEqual([])
    expect(await plugExists()).toBe(true)
  })
})
