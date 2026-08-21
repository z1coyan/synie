/**
 * 增值税发票 PG 集成：费用票审核/作废/红冲 GL、对账结单/重开与待办联动。
 * 门控 SYNIE_TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { withTx } from '~/db/tx.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import type { Actor } from '~/platform/authz/core/index.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { createReconciliationService } from '~/modules/trading/reconciliation/service.ts'
import { createVatInvoiceService } from './invoice-service.ts'
import { testActor } from '~/platform/authz/testing.ts'


/** sealed registry 同时供编号与 authz 执行面消费（授权归宿解析） */
const numberingRegistry = createSealedResourceRegistry()
const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（增值税发票）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db, buildNumberingCatalog(numberingRegistry), numberingRegistry)
  const gl = createGlEngine()
  const reconciliations = createReconciliationService(db, numbering, gl, numberingRegistry)
  const authz = createAuthzEnforcer(numberingRegistry)
  const svc = createVatInvoiceService(db, numbering, {
    gl,
    reconciliations,
    registry: numberingRegistry,
  })
  /** 本文件只验领域行为；superAdmin 凭证 rowFilter 恒全集。凭证每次现取。 */
  const permit = (): Permit => {
    const decision = authz.decideFor(actor, 'accVatInvoices', 'read')
    if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
    return decision.permit
  }
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
  // 负合计链路夹具：销售退货 + 负合计销售对账单；采购入库 + 负合计采购对账单
  const salesReturnId = crypto.randomUUID()
  const salesReturnItemId = crypto.randomUUID()
  const negReconId = crypto.randomUUID()
  const negReconItemId = crypto.randomUUID()
  const supplierId = crypto.randomUUID()
  const purOrderId = crypto.randomUUID()
  const purOrderItemId = crypto.randomUUID()
  const purReceiptId = crypto.randomUUID()
  const purReceiptItemId = crypto.randomUUID()
  const purReconId = crypto.randomUUID()
  const purReconItemId = crypto.randomUUID()
  const purDebitId = crypto.randomUUID()
  const purCreditId = crypto.randomUUID()

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
    // 发票编号改系统生成后须持有启用规则（共享库规则可能被清；幂等补建）
    const existing = await db
      .selectFrom('sys_numbering_rule')
      .select('id')
      .where('resource', '=', 'acc.vat_invoice')
      .where('enabled', '=', true)
      .executeTakeFirst()
    if (!existing) {
      const decision = authz.decideFor(actor, 'sysNumberingRules', 'create')
      if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
      await numbering.create(decision.permit, {
        resource: 'acc.vat_invoice',
        name: `发票编号-T${suffix}`,
        segments: [{ type: 'text', value: `T(I)${suffix}-` }, { type: 'seq', padding: 4 }],
        perCompany: false,
      })
    }
  })

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
      INSERT INTO inv_warehouse(id,code,name,company_id)
      VALUES (${warehouseId}::uuid, ${'W' + suffix}, ${prefix + '仓'}, ${companyId}::uuid)
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

    // 负合计销售对账单（confirmed）：来源为退货条目（金额取负）
    await sql`
      INSERT INTO sal_return(id,return_no,return_date,party_type,party_id,status,company_id,
        warehouse_id,debit_account_id,credit_account_id,currency_id,exchange_rate)
      VALUES (${salesReturnId}::uuid,${prefix + '-ST'},${today}::date,'customer',${customerId}::uuid,
        'audited',${companyId}::uuid,${warehouseId}::uuid,${salesDebitId}::uuid,${salesCreditId}::uuid,
        ${currencyId}::uuid,1)
    `.execute(db)
    await sql`
      INSERT INTO sal_return_item(
        id,idx,qty,base_qty,material_code,material_name,unit_name,
        order_price,order_amount,order_base_price,order_base_amount,order_tax_rate,order_currency_code,
        return_id,company_id,material_id,unit_id,warehouse_id,reconciled_qty
      ) VALUES (
        ${salesReturnItemId}::uuid,1,4,4,${'M' + suffix},${prefix + '料'},${prefix + '件'},
        10,40,10,40,0,${'I' + suffix.slice(0, 2)},
        ${salesReturnId}::uuid,${companyId}::uuid,
        ${materialId}::uuid,${unitId}::uuid,${warehouseId}::uuid,0
      )
    `.execute(db)
    await sql`
      INSERT INTO sal_reconciliation(
        id, reconciliation_no, reconciliation_type, status,
        company_id, party_type, party_id, debit_account_id, credit_account_id
      ) VALUES (
        ${negReconId}::uuid, ${prefix + 'SRN'}, 'regular', 'confirmed',
        ${companyId}::uuid, 'customer', ${customerId}::uuid,
        ${salesDebitId}::uuid, ${salesCreditId}::uuid
      )
    `.execute(db)
    await sql`
      INSERT INTO sal_reconciliation_item(
        id, idx, qty, base_qty, amount, base_amount, reconciliation_id, company_id,
        return_item_id
      ) VALUES (
        ${negReconItemId}::uuid, 1, 4, 4, -40, -40, ${negReconId}::uuid, ${companyId}::uuid,
        ${salesReturnItemId}::uuid
      )
    `.execute(db)

    // 负合计采购对账单（confirmed）：采购退货条目未落地(#61)，负金额行直接种子
    await sql`
      INSERT INTO pur_supplier(id,code,name,short_name)
      VALUES (${supplierId}::uuid, ${'SU' + suffix}, ${prefix + '供应商'}, 'SU')
    `.execute(db)
    await sql`
      INSERT INTO bas_account(id,code,name,direction,is_group,active,company_id,currency_id,role) VALUES
        (${purDebitId}::uuid, ${'PD' + suffix}, ${prefix + '未开应付'}, 'debit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, 'unbilled_payable'),
        (${purCreditId}::uuid, ${'PC' + suffix}, ${prefix + '采贷'}, 'credit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, NULL)
    `.execute(db)
    await sql`
      INSERT INTO pur_order(id,order_no,order_date,party_type,party_id,status,company_id,exchange_rate,currency_id,is_outsourced)
      VALUES (${purOrderId}::uuid,${prefix + '-PO'},${today}::date,'supplier',${supplierId}::uuid,
        'audited',${companyId}::uuid,1,${currencyId}::uuid,false)
    `.execute(db)
    await sql`
      INSERT INTO pur_order_item(id,idx,qty,base_qty,price,amount,order_id,company_id,material_id,unit_id,
        material_code,material_name,unit_name)
      VALUES (${purOrderItemId}::uuid,1,3,3,10,30,${purOrderId}::uuid,${companyId}::uuid,
        ${materialId}::uuid,${unitId}::uuid,${'M' + suffix},${prefix + '料'},${prefix + '件'})
    `.execute(db)
    await sql`
      INSERT INTO pur_receipt(id,receipt_no,receipt_date,party_type,party_id,status,company_id,
        warehouse_id,debit_account_id,credit_account_id)
      VALUES (${purReceiptId}::uuid,${prefix + '-PR'},${today}::date,'supplier',${supplierId}::uuid,
        'audited',${companyId}::uuid,${warehouseId}::uuid,${purCreditId}::uuid,${purDebitId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO pur_receipt_item(
        id,idx,qty,base_qty,material_code,material_name,unit_name,order_no,
        order_qty,order_base_qty,order_unit_name,order_price,order_amount,
        order_base_price,order_base_amount,order_tax_rate,order_currency_code,
        receipt_id,company_id,order_item_id,material_id,unit_id,warehouse_id,reconciled_qty
      ) VALUES (
        ${purReceiptItemId}::uuid,1,3,3,${'M' + suffix},${prefix + '料'},${prefix + '件'},${prefix + '-PO'},
        3,3,${prefix + '件'},10,30,10,30,0,${'I' + suffix.slice(0, 2)},
        ${purReceiptId}::uuid,${companyId}::uuid,${purOrderItemId}::uuid,
        ${materialId}::uuid,${unitId}::uuid,${warehouseId}::uuid,0
      )
    `.execute(db)
    await sql`
      INSERT INTO pur_reconciliation(
        id, reconciliation_no, reconciliation_type, status,
        company_id, party_type, party_id, debit_account_id, credit_account_id
      ) VALUES (
        ${purReconId}::uuid, ${prefix + 'PRN'}, 'regular', 'confirmed',
        ${companyId}::uuid, 'supplier', ${supplierId}::uuid,
        ${purDebitId}::uuid, ${purCreditId}::uuid
      )
    `.execute(db)
    await sql`
      INSERT INTO pur_reconciliation_item(
        id, idx, qty, base_qty, amount, base_amount, reconciliation_id, company_id,
        receipt_item_id
      ) VALUES (
        ${purReconItemId}::uuid, 1, 3, 3, -30, -30, ${purReconId}::uuid, ${companyId}::uuid,
        ${purReceiptItemId}::uuid
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
    await sql`DELETE FROM pur_reconciliation_item WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_reconciliation WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_return_item WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_return WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_receipt_item WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_receipt WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_order_item WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_order WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_supplier WHERE id=${supplierId}::uuid`.execute(db)
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
    const inv = await svc.create(permit(), {
      companyId,
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
    const audited = await svc.audit(permit(), inv.id, today)
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

    const voided = await svc.void(permit(), inv.id)
    expect(voided.status).toBe('VOIDED')
    const cancelled = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM acc_gl_entry
      WHERE voucher_type='acc.vat_invoice' AND voucher_id=${inv.id}::uuid
        AND is_cancelled=true
    `.execute(db)
    expect(Number(cancelled.rows[0]!.c)).toBeGreaterThan(0)
  })

  test('费用票红冲产生原分录 + 红冲分录', async () => {
    const inv = await svc.create(permit(), {
      companyId,
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
    await svc.audit(permit(), inv.id, today)
    const reversed = await svc.reverse(permit(), inv.id, {
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
    const inv = await svc.create(permit(), {
      companyId,
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
    const audited = await svc.audit(permit(), inv.id, today)
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

    const voided = await svc.void(permit(), inv.id)
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
    const inv = await svc.create(permit(), {
      companyId,
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
    await svc.audit(permit(), inv.id, today)
    await expect(
      svc.update(permit(), inv.id, { remarks: 'x', remarksPresent: true }),
    ).rejects.toBeInstanceOf(ApiError)
    await expect(svc.remove(permit(), inv.id)).rejects.toBeInstanceOf(ApiError)

    await expect(
      svc.create(permit(), {
        companyId,
        direction: 'OUTBOUND',
        partyType: 'CUSTOMER',
        partyId: customerId,
        invoiceKind: 'NORMAL',
      }),
    ).rejects.toBeInstanceOf(ApiError)
  })

  test('负合计销售对账单全链路：负数相等关联 → 审核 → 分录金额为负且冲回方向正确', async () => {
    const inv = await svc.create(permit(), {
      companyId,
      direction: 'OUTBOUND',
      invoiceDate: today,
      partyType: 'CUSTOMER',
      partyId: customerId,
      invoiceKind: 'NORMAL',
      invoiceCode: `${prefix}NC`,
      invoiceNo: `${prefix}NN`,
      items: [],
      netTotal: '-40',
      taxTotal: '0',
      grossTotal: '-40',
      partyAccountId: salesCreditId,
      amountAccountId: salesDebitId,
      salReconciliationId: negReconId,
    })
    const audited = await svc.audit(permit(), inv.id, today)
    expect(audited.status).toBe('AUDITED')

    // 负数相等：对账单结单
    const head = await sql<{ status: string }>`
      SELECT status FROM sal_reconciliation WHERE id=${negReconId}::uuid
    `.execute(db)
    expect(head.rows[0]!.status).toBe('closed')

    // 主票 2 行 + 对账冲回 2 行 = 4，全部金额为负、借贷方向不变
    const gl = await sql<{
      account_id: string
      debit: string
      credit: string
      party_id: string | null
    }>`
      SELECT account_id::text, debit::text, credit::text, party_id::text
      FROM acc_gl_entry
      WHERE voucher_type='acc.vat_invoice' AND voucher_id=${inv.id}::uuid
        AND is_cancelled=false AND is_reversal=false
      ORDER BY seq
    `.execute(db)
    expect(gl.rows).toHaveLength(4)
    const sum = (key: 'debit' | 'credit') =>
      gl.rows.reduce((acc, r) => acc + Number(r[key]), 0)
    expect(sum('debit')).toBe(-80)
    expect(sum('credit')).toBe(-80)
    // 往来（应收）发票行：借 −40 带对手——应收余额被冲减
    const partyLine = gl.rows.find((r) => r.account_id === salesCreditId && r.party_id != null)
    expect(Number(partyLine!.debit)).toBe(-40)
    // 未开票应收冲回行（对账组贷方=未开票应收角色科目）：贷 −40 带对手
    const reconCredit = gl.rows.filter((r) => r.account_id === salesCreditId)
    expect(reconCredit).toHaveLength(2)
    expect(Number(reconCredit.find((r) => r.party_id != null && Number(r.credit) !== 0)!.credit)).toBe(-40)

    // 红冲负票：取负后回正，allowNegative 既有覆盖
    const reversed = await svc.reverse(permit(), inv.id, {
      postingDate: today,
      redInvoiceNo: `${prefix}NRED`,
    })
    expect(reversed.status).toBe('REVERSED')
    const rev = await sql<{ debit: string; credit: string }>`
      SELECT COALESCE(sum(debit),0)::text AS debit, COALESCE(sum(credit),0)::text AS credit
      FROM acc_gl_entry
      WHERE voucher_type='acc.vat_invoice' AND voucher_id=${inv.id}::uuid AND is_reversal=true
    `.execute(db)
    expect(Number(rev.rows[0]!.debit)).toBe(80)
    expect(Number(rev.rows[0]!.credit)).toBe(80)
    // 红冲后对账单重开
    const reopened = await sql<{ status: string }>`
      SELECT status FROM sal_reconciliation WHERE id=${negReconId}::uuid
    `.execute(db)
    expect(reopened.rows[0]!.status).toBe('confirmed')
  })

  test('负合计采购对账单 + 负的开入发票同口径', async () => {
    const inv = await svc.create(permit(), {
      companyId,
      direction: 'INBOUND',
      invoiceDate: today,
      partyType: 'SUPPLIER',
      partyId: supplierId,
      invoiceKind: 'NORMAL',
      invoiceCode: `${prefix}PC`,
      invoiceNo: `${prefix}PN`,
      items: [],
      netTotal: '-30',
      taxTotal: '0',
      grossTotal: '-30',
      partyAccountId,
      amountAccountId,
      purReconciliationId: purReconId,
    })
    const audited = await svc.audit(permit(), inv.id, today)
    expect(audited.status).toBe('AUDITED')

    const head = await sql<{ status: string }>`
      SELECT status FROM pur_reconciliation WHERE id=${purReconId}::uuid
    `.execute(db)
    expect(head.rows[0]!.status).toBe('closed')

    const gl = await sql<{ debit: string; credit: string; c: string }>`
      SELECT COALESCE(sum(debit),0)::text AS debit, COALESCE(sum(credit),0)::text AS credit,
        count(*)::text AS c
      FROM acc_gl_entry
      WHERE voucher_type='acc.vat_invoice' AND voucher_id=${inv.id}::uuid
        AND is_cancelled=false AND is_reversal=false
    `.execute(db)
    expect(Number(gl.rows[0]!.c)).toBe(4)
    expect(Number(gl.rows[0]!.debit)).toBe(-60)
    expect(Number(gl.rows[0]!.credit)).toBe(-60)

    // 作废负票照常（与符号无关）
    const voided = await svc.void(permit(), inv.id)
    expect(voided.status).toBe('VOIDED')
  })

  test('负票校验口径：价税合计不为零、税额符号随票向、税额科目按 tax≠0 必填', async () => {
    const base = {
      companyId,
      direction: 'INBOUND' as const,
      invoiceDate: today,
      partyType: 'EMPLOYEE' as const,
      partyId: employeeId,
      invoiceKind: 'NORMAL',
      partyAccountId,
      amountAccountId,
    }
    // 价税合计为零：拒
    const zero = await svc
      .create(permit(), {
        ...base,
        invoiceCode: `${prefix}Z1`,
        invoiceNo: `${prefix}Z1N`,
        netTotal: '0',
        taxTotal: '0',
        grossTotal: '0',
      })
      .then((inv) => svc.audit(permit(), inv.id, today))
      .catch((e: unknown) => e)
    expect((zero as ApiError).fields?.['grossTotal']).toEqual([
      '必须不为零且不含税金额+税额=价税合计',
    ])
    // 负票正税额：拒
    const badTax = await svc
      .create(permit(), {
        ...base,
        invoiceCode: `${prefix}Z2`,
        invoiceNo: `${prefix}Z2N`,
        netTotal: '-50',
        taxTotal: '10',
        grossTotal: '-40',
        taxAccountId,
      })
      .then((inv) => svc.audit(permit(), inv.id, today))
      .catch((e: unknown) => e)
    expect((badTax as ApiError).fields?.['taxTotal']).toEqual(['负票税额不能为正'])
    // 正票负税额：拒
    const badTax2 = await svc
      .create(permit(), {
        ...base,
        invoiceCode: `${prefix}Z3`,
        invoiceNo: `${prefix}Z3N`,
        netTotal: '50',
        taxTotal: '-10',
        grossTotal: '40',
        taxAccountId,
      })
      .then((inv) => svc.audit(permit(), inv.id, today))
      .catch((e: unknown) => e)
    expect((badTax2 as ApiError).fields?.['taxTotal']).toEqual(['正票税额不能为负'])
    // 正票负净额：拒（恒等式只锁合计，不锁单边）
    const badNet = await svc
      .create(permit(), {
        ...base,
        invoiceCode: `${prefix}Z3A`,
        invoiceNo: `${prefix}Z3AN`,
        netTotal: '-50',
        taxTotal: '90',
        grossTotal: '40',
        taxAccountId,
      })
      .then((inv) => svc.audit(permit(), inv.id, today))
      .catch((e: unknown) => e)
    expect((badNet as ApiError).fields?.['netTotal']).toEqual(['正票不含税金额不能为负'])
    // 负票正净额：拒
    const badNet2 = await svc
      .create(permit(), {
        ...base,
        invoiceCode: `${prefix}Z3B`,
        invoiceNo: `${prefix}Z3BN`,
        netTotal: '50',
        taxTotal: '-90',
        grossTotal: '-40',
        taxAccountId,
      })
      .then((inv) => svc.audit(permit(), inv.id, today))
      .catch((e: unknown) => e)
    expect((badNet2 as ApiError).fields?.['netTotal']).toEqual(['负票不含税金额不能为正'])
    // 负税额（tax≠0）缺税额科目：拒
    const noTaxAccount = await svc
      .create(permit(), {
        ...base,
        invoiceCode: `${prefix}Z4`,
        invoiceNo: `${prefix}Z4N`,
        netTotal: '-35',
        taxTotal: '-5',
        grossTotal: '-40',
      })
      .then((inv) => svc.audit(permit(), inv.id, today))
      .catch((e: unknown) => e)
    expect((noTaxAccount as ApiError).fields?.['taxAccountId']).toEqual(['有税额时必填'])
    // 负税额带税额科目：放行，税额行金额为负
    const ok = await svc.create(permit(), {
      ...base,
      invoiceCode: `${prefix}Z5`,
      invoiceNo: `${prefix}Z5N`,
      netTotal: '-35',
      taxTotal: '-5',
      grossTotal: '-40',
      taxAccountId,
    })
    await svc.audit(permit(), ok.id, today)
    const gl = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM acc_gl_entry
      WHERE voucher_type='acc.vat_invoice' AND voucher_id=${ok.id}::uuid
        AND is_cancelled=false AND is_reversal=false
    `.execute(db)
    expect(Number(gl.rows[0]!.c)).toBe(3)
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
