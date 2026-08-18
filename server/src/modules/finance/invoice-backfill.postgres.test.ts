/**
 * 已审核无对账单发票补过账：invoiceGLEntries / backfillPostedGL。
 * 门控 SYNIE_TEST_DATABASE_URL。正规 audit 冲回组回归见 invoice.postgres.test.ts。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { systemPermit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { createReconciliationService } from '~/modules/trading/reconciliation/service.ts'
import {
  auditInputFromPersisted,
  createVatInvoiceService,
  invoiceGLEntries,
  normalizeInput,
  toInput,
  type VatInvoice,
} from './invoice-service.ts'

const numberingRegistry = createSealedResourceRegistry()
const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（发票补过账）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db, buildNumberingCatalog(numberingRegistry), numberingRegistry)
  const gl = createGlEngine()
  const reconciliations = createReconciliationService(db, numbering, gl, numberingRegistry)
  const svc = createVatInvoiceService(db, numbering, {
    gl,
    reconciliations,
    registry: numberingRegistry,
  })
  const permit = () => systemPermit('accVatInvoices', 'audit')

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const prefix = `IBF${suffix}`
  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  const partyAccountId = crypto.randomUUID()
  const amountAccountId = crypto.randomUUID()
  const taxAccountId = crypto.randomUUID()
  const unbilledAccountId = crypto.randomUUID()
  const reconId = crypto.randomUUID()
  const today = '2098-06-18'

  async function insertInvoice(opts: {
    id?: string
    status: 'audited' | 'draft'
    invoiceNo: string
    salReconciliationId?: string | null
    tax?: boolean
  }): Promise<string> {
    const id = opts.id ?? crypto.randomUUID()
    const tax = opts.tax !== false
    await sql`
      INSERT INTO acc_vat_invoice (
        id, doc_no, direction, invoice_date, posting_date, party_type, party_id,
        invoice_kind, invoice_code, invoice_no, net_total, tax_total, gross_total,
        status, company_id, party_account_id, amount_account_id, tax_account_id,
        sal_reconciliation_id
      ) VALUES (
        ${id}::uuid, ${`${prefix}-${opts.invoiceNo}`}, 'outbound', ${today}::date, ${today}::date,
        'customer', ${customerId}::uuid, 'normal', ${`${prefix}${opts.invoiceNo}`}, ${opts.invoiceNo},
        ${tax ? '100' : '113'}, ${tax ? '13' : '0'}, '113',
        ${opts.status}, ${companyId}::uuid, ${partyAccountId}::uuid, ${amountAccountId}::uuid,
        ${taxAccountId}::uuid, ${opts.salReconciliationId ?? null}::uuid
      )
    `.execute(db)
    return id
  }

  async function glRows(invoiceId: string) {
    return sql<{
      account_id: string
      debit: string
      credit: string
      is_cancelled: boolean
      role: string | null
    }>`
      SELECT e.account_id::text, e.debit::text, e.credit::text, e.is_cancelled, a.role
      FROM acc_gl_entry e
      JOIN bas_account a ON a.id = e.account_id
      WHERE e.voucher_type = 'acc.vat_invoice' AND e.voucher_id = ${invoiceId}::uuid
      ORDER BY e.seq
    `.execute(db)
  }

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${currencyId}::uuid, ${prefix + '币'}, ${'B' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
      VALUES (${companyId}::uuid, ${'B' + suffix}, ${prefix + '公司'}, 'BF', ${currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sal_customers(id,code,name,short_name)
      VALUES (${customerId}::uuid, ${'CU' + suffix}, ${prefix + '客户'}, 'CU')
    `.execute(db)
    await sql`
      INSERT INTO bas_account(id,code,name,direction,is_group,active,company_id,currency_id,role) VALUES
        (${partyAccountId}::uuid, ${'1122' + suffix.slice(0, 4)}, ${prefix + '应收'}, 'debit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, 'receivable'),
        (${amountAccountId}::uuid, ${'6001' + suffix.slice(0, 4)}, ${prefix + '收入'}, 'credit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${taxAccountId}::uuid, ${'2221' + suffix.slice(0, 4)}, ${prefix + '销项税'}, 'credit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${unbilledAccountId}::uuid, ${'1124' + suffix.slice(0, 4)}, ${prefix + '未开票'}, 'debit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, 'unbilled_receivable')
    `.execute(db)
    await sql`
      INSERT INTO sal_reconciliation(
        id, reconciliation_no, reconciliation_type, status,
        company_id, party_type, party_id, debit_account_id, credit_account_id
      ) VALUES (
        ${reconId}::uuid, ${prefix + 'SR'}, 'regular', 'confirmed',
        ${companyId}::uuid, 'customer', ${customerId}::uuid,
        ${unbilledAccountId}::uuid, ${partyAccountId}::uuid
      )
    `.execute(db)
  })

  afterAll(async () => {
    await sql`DELETE FROM acc_gl_entry WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_vat_invoice WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_reconciliation WHERE id=${reconId}::uuid`.execute(db)
    await sql`DELETE FROM bas_account WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_customers WHERE id=${customerId}::uuid`.execute(db)
    await sql`DELETE FROM bas_company WHERE id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id=${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  test('SQL 直插 AUDITED 无对账单开出 → 补过账 3 行、无 1124、状态仍 AUDITED', async () => {
    const id = await insertInvoice({ status: 'audited', invoiceNo: `${prefix}A1` })
    const out = await svc.backfillPostedGL(permit(), id)
    expect(out.status).toBe('AUDITED')
    expect(out.salReconciliationId).toBeNull()

    const rows = await glRows(id)
    const live = rows.rows.filter((r) => !r.is_cancelled)
    expect(live).toHaveLength(3)
    expect(live.some((r) => r.role === 'unbilled_receivable')).toBe(false)
    expect(live.map((r) => r.account_id).sort()).toEqual(
      [partyAccountId, amountAccountId, taxAccountId].sort(),
    )
    const persisted = await svc.get(permit(), id)
    expect(persisted.status).toBe('AUDITED')
  })

  test('再调一次幂等，未作废分录数不变', async () => {
    const id = await insertInvoice({ status: 'audited', invoiceNo: `${prefix}A2` })
    await svc.backfillPostedGL(permit(), id)
    const first = await glRows(id)
    await svc.backfillPostedGL(permit(), id)
    const second = await glRows(id)
    expect(second.rows.filter((r) => !r.is_cancelled)).toHaveLength(
      first.rows.filter((r) => !r.is_cancelled).length,
    )
    expect(second.rows).toHaveLength(first.rows.length)
  })

  test('仅有已作废旧行仍允许补过一组未作废分录', async () => {
    const id = await insertInvoice({ status: 'audited', invoiceNo: `${prefix}A3` })
    await sql`
      INSERT INTO acc_gl_entry (
        company_id, account_id, posting_date, debit, credit,
        voucher_type, voucher_id, voucher_no, is_cancelled, party_type, party_id
      ) VALUES
        (${companyId}::uuid, ${partyAccountId}::uuid, ${today}::date, 113, 0,
          'acc.vat_invoice', ${id}::uuid, ${`${prefix}-A3`}, true, 'customer', ${customerId}::uuid),
        (${companyId}::uuid, ${amountAccountId}::uuid, ${today}::date, 0, 113,
          'acc.vat_invoice', ${id}::uuid, ${`${prefix}-A3`}, true, NULL, NULL)
    `.execute(db)
    await svc.backfillPostedGL(permit(), id)
    const rows = await glRows(id)
    expect(rows.rows.filter((r) => r.is_cancelled)).toHaveLength(2)
    expect(rows.rows.filter((r) => !r.is_cancelled)).toHaveLength(3)
  })

  test('带 salReconciliationId 拒绝', async () => {
    const id = await insertInvoice({
      status: 'audited',
      invoiceNo: `${prefix}A4`,
      salReconciliationId: reconId,
    })
    const err = await svc.backfillPostedGL(permit(), id).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('conflict')
    const rows = await glRows(id)
    expect(rows.rows).toHaveLength(0)
  })

  test('DRAFT 拒绝', async () => {
    const id = await insertInvoice({ status: 'draft', invoiceNo: `${prefix}A5` })
    const err = await svc.backfillPostedGL(permit(), id).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('conflict')
    const rows = await glRows(id)
    expect(rows.rows).toHaveLength(0)
  })

  test('无对账单票 toInput/normalizeInput 必 400；正式路径不得调用', async () => {
    const id = await insertInvoice({ status: 'audited', invoiceNo: `${prefix}A6` })
    const invoice = await svc.get(permit(), id)
    expect(() => toInput(invoice)).toThrow(ApiError)
    try {
      toInput(invoice)
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).code).toBe('validation')
      expect((e as ApiError).fields?.['salReconciliationId']).toEqual(['开出发票必须且仅关联销售对账单'])
    }
    expect(() =>
      normalizeInput({
        companyId,
        direction: 'OUTBOUND',
        partyType: 'CUSTOMER',
        partyId: customerId,
        invoiceKind: 'NORMAL',
      }),
    ).toThrow(ApiError)
    const assembled = auditInputFromPersisted(invoice)
    expect(assembled.salReconciliationId).toBeNull()
    expect(assembled.direction).toBe('OUTBOUND')

    const src = readFileSync(new URL('./invoice-service.ts', import.meta.url), 'utf8')
    const persistedStart = src.indexOf('export function auditInputFromPersisted')
    const persistedEnd = src.indexOf('\ntype ReconSeam', persistedStart)
    expect(persistedStart).toBeGreaterThan(-1)
    expect(persistedEnd).toBeGreaterThan(persistedStart)
    const persistedBody = src.slice(persistedStart, persistedEnd)
    expect(persistedBody).not.toMatch(/\btoInput\s*\(/)
    expect(persistedBody).not.toMatch(/\bnormalizeInput\s*\(/)

    const backfillStart = src.indexOf('async function backfillPostedGL')
    const backfillEnd = src.indexOf('\n  return {', backfillStart)
    expect(backfillStart).toBeGreaterThan(-1)
    expect(backfillEnd).toBeGreaterThan(backfillStart)
    const backfillBody = src.slice(backfillStart, backfillEnd)
    expect(backfillBody).not.toMatch(/\btoInput\s*\(/)
    expect(backfillBody).not.toMatch(/\bnormalizeInput\s*\(/)

    await svc.backfillPostedGL(permit(), id)
    const rows = await glRows(id)
    expect(rows.rows.filter((r) => !r.is_cancelled)).toHaveLength(3)
  })

  test('invoiceGLEntries 开出三行且不含未开票应收科目', () => {
    const entries = invoiceGLEntries({
      id: crypto.randomUUID(),
      direction: 'OUTBOUND',
      partyType: 'CUSTOMER',
      partyId: customerId,
      netTotal: '100',
      taxTotal: '13',
      grossTotal: '113',
      partyAccountId,
      amountAccountId,
      taxAccountId,
    } as VatInvoice)
    expect(entries).toHaveLength(3)
    expect(entries.map((e) => e.accountId).sort()).toEqual(
      [partyAccountId, amountAccountId, taxAccountId].sort(),
    )
    expect(entries.some((e) => e.accountId === unbilledAccountId)).toBe(false)
  })
})
