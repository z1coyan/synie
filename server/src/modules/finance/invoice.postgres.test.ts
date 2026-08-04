/**
 * 增值税发票 PG 集成：费用票审核/作废/红冲 GL、对账结单/重开与待办联动。
 * 门控 SYNIE_TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { withTx } from '~/db/tx.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { createReconciliationService } from '~/modules/trading/reconciliation/service.ts'
import { createVatInvoiceService } from './invoice-service.ts'
import { testActor } from '~/platform/authz/testing.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（增值税发票）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db, buildNumberingCatalog(createSealedResourceRegistry()))
  const gl = createGlEngine()
  const reconciliations = createReconciliationService(db, numbering, gl)
  const svc = createVatInvoiceService(db, numbering, { gl, reconciliations })
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const prefix = `INV${suffix}`

  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const employeeId = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  const partyAccountId = crypto.randomUUID()
  const amountAccountId = crypto.randomUUID()
  const taxAccountId = crypto.randomUUID()
  const salesDebitId = crypto.randomUUID()
  const salesCreditId = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const warehouseId = crypto.randomUUID()
  const salesOrderId = crypto.randomUUID()
  const salesOrderItemId = crypto.randomUUID()
  const salesDeliveryId = crypto.randomUUID()
  const salesDeliveryItemId = crypto.randomUUID()
  const reconId = crypto.randomUUID()
  const reconItemId = crypto.randomUUID()
  const userId = crypto.randomUUID()

  const actor: Actor = testActor({
    userId,
    username: 'inv-test',
    name: '发票测试',
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })

  const today = '2099-03-15'

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${currencyId}::uuid, ${prefix + '币'}, ${'I' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
      VALUES (${companyId}::uuid, ${'C' + suffix}, ${prefix + '公司'}, 'IC', ${currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sys_user(id,username,name,hashed_password)
      VALUES (${userId}::uuid, ${'u' + suffix}, '发票用户', 'x')
    `.execute(db)
    await sql`
      INSERT INTO hr_employees(id,code,name)
      VALUES (${employeeId}::uuid, ${'E' + suffix}, ${prefix + '员工'})
    `.execute(db)
    await sql`
      INSERT INTO sal_customers(id,code,name,short_name)
      VALUES (${customerId}::uuid, ${'CU' + suffix}, ${prefix + '客户'}, 'CU')
    `.execute(db)
    await sql`
      INSERT INTO bas_account(id,code,name,direction,is_group,active,company_id,currency_id,role) VALUES
        (${partyAccountId}::uuid, ${'P' + suffix}, ${prefix + '应付'}, 'credit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, 'other_payable'),
        (${amountAccountId}::uuid, ${'A' + suffix}, ${prefix + '费用'}, 'debit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${taxAccountId}::uuid, ${'T' + suffix}, ${prefix + '税额'}, 'debit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${salesDebitId}::uuid, ${'SD' + suffix}, ${prefix + '销借'}, 'debit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${salesCreditId}::uuid, ${'SC' + suffix}, ${prefix + '应收'}, 'credit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, 'receivable')
    `.execute(db)
    await sql`
      INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
      VALUES (${unitId}::uuid, ${'inv-' + suffix}, true, ${prefix + '件'}, 'u', 1)
    `.execute(db)
    await sql`
      INSERT INTO inv_material_category(id,code,name,is_leaf,active)
      VALUES (${categoryId}::uuid, ${'MC' + suffix}, ${prefix + '类'}, true, true)
    `.execute(db)
    await sql`
      INSERT INTO inv_material(id,code,name,default_unit_id,category_id,active)
      VALUES (
        ${materialId}::uuid, ${'M' + suffix}, ${prefix + '料'},
        ${unitId}::uuid, ${categoryId}::uuid, true
      )
    `.execute(db)
    await sql`
      INSERT INTO inv_warehouse(id,name,company_id)
      VALUES (${warehouseId}::uuid, ${prefix + '仓'}, ${companyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sal_order(id,order_no,order_date,party_type,party_id,status,company_id,exchange_rate,currency_id,order_type)
      VALUES (
        ${salesOrderId}::uuid, ${prefix + '-SO'}, ${today}::date, 'customer', ${customerId}::uuid,
        'audited', ${companyId}::uuid, 1, ${currencyId}::uuid, 'regular'
      )
    `.execute(db)
    await sql`
      INSERT INTO sal_order_item(
        id,idx,qty,price,amount,order_id,company_id,material_id,unit_id,
        material_code,material_name,unit_name,base_qty
      ) VALUES (
        ${salesOrderItemId}::uuid,1,10,10,100,${salesOrderId}::uuid,${companyId}::uuid,
        ${materialId}::uuid,${unitId}::uuid,${'M' + suffix},${prefix + '料'},${prefix + '件'},10
      )
    `.execute(db)
    await sql`
      INSERT INTO sal_delivery(
        id,delivery_no,delivery_date,party_type,party_id,status,company_id,
        warehouse_id,debit_account_id,credit_account_id
      ) VALUES (
        ${salesDeliveryId}::uuid,${prefix + '-SD'},${today}::date,'customer',${customerId}::uuid,
        'audited',${companyId}::uuid,${warehouseId}::uuid,${salesCreditId}::uuid,${salesDebitId}::uuid
      )
    `.execute(db)
    await sql`
      INSERT INTO sal_delivery_item(
        id,idx,qty,base_qty,material_code,material_name,unit_name,order_no,
        order_qty,order_base_qty,order_unit_name,order_price,order_amount,
        order_base_price,order_base_amount,order_tax_rate,order_currency_code,
        delivery_id,company_id,order_item_id,material_id,unit_id,warehouse_id,reconciled_qty
      ) VALUES (
        ${salesDeliveryItemId}::uuid,1,10,10,${'M' + suffix},${prefix + '料'},${prefix + '件'},${prefix + '-SO'},
        10,10,${prefix + '件'},10,100,10,100,0,${'I' + suffix.slice(0, 2)},
        ${salesDeliveryId}::uuid,${companyId}::uuid,${salesOrderItemId}::uuid,
        ${materialId}::uuid,${unitId}::uuid,${warehouseId}::uuid,0
      )
    `.execute(db)
    await sql`
      INSERT INTO sal_reconciliation(
        id, reconciliation_no, reconciliation_type, status,
        company_id, party_type, party_id, debit_account_id, credit_account_id
      ) VALUES (
        ${reconId}::uuid, ${prefix + 'SR'}, 'regular', 'confirmed',
        ${companyId}::uuid, 'customer', ${customerId}::uuid,
        ${salesDebitId}::uuid, ${salesCreditId}::uuid
      )
    `.execute(db)
    await sql`
      INSERT INTO sal_reconciliation_item(
        id, idx, qty, base_qty, amount, base_amount, reconciliation_id, company_id,
        delivery_item_id
      ) VALUES (
        ${reconItemId}::uuid, 1, 10, 10, 100, 100, ${reconId}::uuid, ${companyId}::uuid,
        ${salesDeliveryItemId}::uuid
      )
    `.execute(db)
    await sql`
      INSERT INTO sys_todo(
        type, source_type, source_id, source_no, party_type, party_id, amount,
        status, source_changed_at, company_id, created_by_id
      ) VALUES (
        'issue_invoice', 'sales.reconciliation', ${reconId}::uuid, ${prefix + 'SR'},
        'customer', ${customerId}::uuid, 100, 'active',
        (now() AT TIME ZONE 'utc'), ${companyId}::uuid, ${userId}::uuid
      )
    `.execute(db)
  })

  afterAll(async () => {
    await sql`DELETE FROM sys_audit_log WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_gl_entry WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sys_todo_state WHERE todo_id IN (
      SELECT id FROM sys_todo WHERE company_id=${companyId}::uuid
    )`.execute(db)
    await sql`DELETE FROM sys_todo WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_vat_invoice WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_reconciliation_item WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_reconciliation WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_delivery_item WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_delivery WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_order_item WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_order WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM inv_warehouse WHERE id=${warehouseId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material WHERE id=${materialId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id=${categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id=${unitId}::uuid`.execute(db)
    await sql`DELETE FROM bas_account WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_customers WHERE id=${customerId}::uuid`.execute(db)
    await sql`DELETE FROM hr_employees WHERE id=${employeeId}::uuid`.execute(db)
    await sql`DELETE FROM sys_user WHERE id=${userId}::uuid`.execute(db)
    await sql`DELETE FROM bas_company WHERE id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id=${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  test('费用票：手填编号 + 审核过账 + 作废冲销', async () => {
    const inv = await svc.create(actor, {
      companyId,
      docNo: `${prefix}EXP`,
      direction: 'INBOUND',
      invoiceDate: today,
      partyType: 'EMPLOYEE',
      partyId: employeeId,
      invoiceKind: 'NORMAL',
      invoiceCode: `${prefix}IC`,
      invoiceNo: `${prefix}IN`,
      items: [{ name: '项目', quantity: '1', net_amount: '100' }],
      netTotal: '100',
      taxTotal: '0',
      grossTotal: '100',
      partyAccountId,
      amountAccountId,
    })
    expect(inv.status).toBe('DRAFT')
    const audited = await svc.audit(actor, inv.id, today)
    expect(audited.status).toBe('AUDITED')
    expect(audited.postingDate).toBe(today)
    expect(audited.auditedById).toBe(userId)

    const gl = await sql<{ c: string; debit: string }>`
      SELECT count(*)::text AS c, COALESCE(sum(debit),0)::text AS debit
      FROM acc_gl_entry
      WHERE voucher_type='acc.vat_invoice' AND voucher_id=${inv.id}::uuid
        AND is_cancelled=false AND is_reversal=false
    `.execute(db)
    expect(Number(gl.rows[0]!.c)).toBe(2)
    expect(Number(gl.rows[0]!.debit)).toBe(100)

    const voided = await svc.void(actor, inv.id)
    expect(voided.status).toBe('VOIDED')
    const cancelled = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM acc_gl_entry
      WHERE voucher_type='acc.vat_invoice' AND voucher_id=${inv.id}::uuid
        AND is_cancelled=true
    `.execute(db)
    expect(Number(cancelled.rows[0]!.c)).toBeGreaterThan(0)
  })

  test('费用票红冲产生原分录 + 红冲分录', async () => {
    const inv = await svc.create(actor, {
      companyId,
      docNo: `${prefix}REV`,
      direction: 'INBOUND',
      invoiceDate: today,
      partyType: 'EMPLOYEE',
      partyId: employeeId,
      invoiceKind: 'SPECIAL',
      invoiceCode: `${prefix}RC`,
      invoiceNo: `${prefix}RN`,
      items: [],
      netTotal: '90',
      taxTotal: '10',
      grossTotal: '100',
      partyAccountId,
      amountAccountId,
      taxAccountId,
    })
    await svc.audit(actor, inv.id, today)
    const reversed = await svc.reverse(actor, inv.id, {
      postingDate: today,
      redInvoiceNo: `${prefix}RED`,
    })
    expect(reversed.status).toBe('REVERSED')
    expect(reversed.redInvoiceNo).toBe(`${prefix}RED`)
    const gl = await sql<{ originals: string; reversals: string }>`
      SELECT
        count(*) FILTER (WHERE is_reversed)::text AS originals,
        count(*) FILTER (WHERE is_reversal)::text AS reversals
      FROM acc_gl_entry
      WHERE voucher_type='acc.vat_invoice' AND voucher_id=${inv.id}::uuid
    `.execute(db)
    expect(Number(gl.rows[0]!.originals)).toBeGreaterThan(0)
    expect(Number(gl.rows[0]!.reversals)).toBeGreaterThan(0)
  })

  test('销项发票审核结单对账 + 关闭待办；作废 reopen + 复活待办', async () => {
    const inv = await svc.create(actor, {
      companyId,
      docNo: `${prefix}SAL`,
      direction: 'OUTBOUND',
      invoiceDate: today,
      partyType: 'CUSTOMER',
      partyId: customerId,
      invoiceKind: 'NORMAL',
      invoiceCode: `${prefix}SC`,
      invoiceNo: `${prefix}SN`,
      items: [],
      netTotal: '100',
      taxTotal: '0',
      grossTotal: '100',
      partyAccountId: salesCreditId,
      amountAccountId: salesDebitId,
      salReconciliationId: reconId,
    })
    const audited = await svc.audit(actor, inv.id, today)
    expect(audited.status).toBe('AUDITED')

    const head = await sql<{ status: string }>`
      SELECT status FROM sal_reconciliation WHERE id=${reconId}::uuid
    `.execute(db)
    expect(head.rows[0]!.status).toBe('closed')

    const todosClosed = await sql<{ c: string; reason: string | null }>`
      SELECT count(*)::text AS c, max(closed_reason) AS reason FROM sys_todo
      WHERE source_type='sales.reconciliation' AND source_id=${reconId}::uuid
        AND status='closed'
    `.execute(db)
    expect(Number(todosClosed.rows[0]!.c)).toBeGreaterThanOrEqual(1)
    expect(todosClosed.rows[0]!.reason).toBe('invoice_audit')

    // 主票 3 行（往来+金额）+ 对账 2 行 = 5（税额为 0 时无税行）
    const gl = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM acc_gl_entry
      WHERE voucher_type='acc.vat_invoice' AND voucher_id=${inv.id}::uuid
        AND is_cancelled=false AND is_reversal=false
    `.execute(db)
    expect(Number(gl.rows[0]!.c)).toBe(4)

    const voided = await svc.void(actor, inv.id)
    expect(voided.status).toBe('VOIDED')
    expect(voided.salReconciliationId).toBeNull()

    const reopened = await sql<{ status: string }>`
      SELECT status FROM sal_reconciliation WHERE id=${reconId}::uuid
    `.execute(db)
    expect(reopened.rows[0]!.status).toBe('confirmed')

    const todosActive = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM sys_todo
      WHERE source_type='sales.reconciliation' AND source_id=${reconId}::uuid
        AND status='active'
    `.execute(db)
    expect(Number(todosActive.rows[0]!.c)).toBe(1)
  })

  test('仅草稿可改删；对账关联缺失校验', async () => {
    const inv = await svc.create(actor, {
      companyId,
      docNo: `${prefix}DR`,
      direction: 'INBOUND',
      partyType: 'EMPLOYEE',
      partyId: employeeId,
      invoiceKind: 'NORMAL',
      invoiceDate: today,
      invoiceNo: `${prefix}DRN`,
      netTotal: '10',
      taxTotal: '0',
      grossTotal: '10',
      partyAccountId,
      amountAccountId,
    })
    await svc.audit(actor, inv.id, today)
    await expect(
      svc.update(actor, inv.id, { remarks: 'x', remarksPresent: true }),
    ).rejects.toBeInstanceOf(ApiError)
    await expect(svc.remove(actor, inv.id)).rejects.toBeInstanceOf(ApiError)

    await expect(
      svc.create(actor, {
        companyId,
        direction: 'OUTBOUND',
        partyType: 'CUSTOMER',
        partyId: customerId,
        invoiceKind: 'NORMAL',
      }),
    ).rejects.toBeInstanceOf(ApiError)
  })

  test('closeFromInvoice / reopenFromInvoice 接缝在 withTx 内可调用', async () => {
    await sql`
      UPDATE sal_reconciliation SET status='confirmed'
      WHERE id=${reconId}::uuid
    `.execute(db)
    await withTx(db, async (trx) => {
      await reconciliations.closeFromInvoice(trx, actor, 'sales', reconId)
    })
    const closed = await sql<{ status: string }>`
      SELECT status FROM sal_reconciliation WHERE id=${reconId}::uuid
    `.execute(db)
    expect(closed.rows[0]!.status).toBe('closed')
    await withTx(db, async (trx) => {
      await reconciliations.reopenFromInvoice(trx, actor, 'sales', reconId)
    })
    const open = await sql<{ status: string }>`
      SELECT status FROM sal_reconciliation WHERE id=${reconId}::uuid
    `.execute(db)
    expect(open.rows[0]!.status).toBe('confirmed')
  })
})
