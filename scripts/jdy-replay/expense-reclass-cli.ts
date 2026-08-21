/**
 * 简道云挂票误建供应商 → 费用报销发票（对手颜智豪，往来 2241，金额 560299）。
 * 缺省 dry-run；写生产必须 --apply --allow-prod。
 *
 * bun scripts/jdy-replay/expense_reclass.ts
 * bun scripts/jdy-replay/expense_reclass.ts --allow-prod
 * bun scripts/jdy-replay/expense_reclass.ts --apply --allow-prod
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from 'kysely'
import { decimal } from '@synie/shared'
import { withTx, type DbHandle } from '../../server/src/db/tx.ts'
import type { GlEngine } from '../../server/src/engines/gl/index.ts'
import {
  invoiceGLEntries,
  type VatInvoice,
} from '../../server/src/modules/finance/invoice-service.ts'
import {
  assertReplayUrl,
  createMigrationWorld,
  dsnHost,
  MIGRATION_ACTOR_ID as ACTOR,
  resolveBackfillDatabaseUrl,
} from './bootstrap.ts'

const VOUCHER_TYPE = 'acc.vat_invoice'
const DEFAULT_PLAN = '.scratch/jdy-migration/state/expense_reclass_plan.json'

interface Plan {
  employee_code: string
  employee_name: string
  note?: string
  supplier_codes: string[]
}

interface InvoiceRow {
  id: string
  doc_no: string | null
  direction: string
  invoice_date: string | null
  posting_date: string | null
  party_type: string
  party_id: string
  invoice_kind: string
  invoice_no: string | null
  net_total: string
  tax_total: string
  gross_total: string
  remarks: string | null
  status: string
  company_id: string
  party_account_id: string | null
  amount_account_id: string | null
  tax_account_id: string | null
  sal_reconciliation_id: string | null
  pur_reconciliation_id: string | null
  supplier_code: string
  supplier_name: string
}

interface Accts {
  payable: string
  otherPayable: string
  otherExpense: string
}

function parseArgs(argv: string[]): { apply: boolean; allowProd: boolean; planPath: string } {
  let apply = false
  let dry = false
  let allowProd = false
  let planPath = DEFAULT_PLAN
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--apply') apply = true
    else if (arg === '--dry-run') dry = true
    else if (arg === '--allow-prod') allowProd = true
    else if (arg === '--plan') {
      const next = argv[++i]
      if (!next || next.startsWith('--')) throw new Error('--plan 需要路径')
      planPath = next
    } else {
      throw new Error(`不支持的参数：${arg}（只认 --apply / --dry-run / --allow-prod / --plan）`)
    }
  }
  if (apply && dry) throw new Error('不能同时 --apply 与 --dry-run')
  return { apply, allowProd, planPath }
}

function loadPlan(planPath: string): Plan {
  const raw = JSON.parse(readFileSync(resolve(planPath), 'utf8')) as Plan
  if (!raw.employee_code || !Array.isArray(raw.supplier_codes) || raw.supplier_codes.length === 0) {
    throw new Error(`计划文件不完整：${planPath}`)
  }
  return raw
}

async function accountMap(db: DbHandle): Promise<Map<string, Accts>> {
  const rows = await sql<{ company_id: string; code: string; id: string }>`
    SELECT company_id::text, code, id::text
    FROM bas_account
    WHERE code IN ('2202', '2241', '560299')
  `.execute(db)
  const byCo = new Map<string, Partial<Accts>>()
  for (const r of rows.rows) {
    const cur = byCo.get(r.company_id) ?? {}
    if (r.code === '2202') cur.payable = r.id
    if (r.code === '2241') cur.otherPayable = r.id
    if (r.code === '560299') cur.otherExpense = r.id
    byCo.set(r.company_id, cur)
  }
  const out = new Map<string, Accts>()
  for (const [companyId, cur] of byCo) {
    if (!cur.payable || !cur.otherPayable || !cur.otherExpense) {
      throw new Error(`公司 ${companyId} 缺 2202/2241/560299`)
    }
    out.set(companyId, cur as Accts)
  }
  return out
}

async function loadInvoices(db: DbHandle, codes: string[]): Promise<InvoiceRow[]> {
  const rows = await sql<InvoiceRow>`
    SELECT
      i.id::text,
      i.doc_no,
      i.direction,
      i.invoice_date::text,
      i.posting_date::text,
      i.party_type,
      i.party_id::text,
      i.invoice_kind,
      i.invoice_no,
      i.net_total::text,
      i.tax_total::text,
      i.gross_total::text,
      i.remarks,
      i.status,
      i.company_id::text,
      i.party_account_id::text,
      i.amount_account_id::text,
      i.tax_account_id::text,
      i.sal_reconciliation_id::text,
      i.pur_reconciliation_id::text,
      s.code AS supplier_code,
      s.name AS supplier_name
    FROM acc_vat_invoice i
    JOIN pur_supplier s ON s.id = i.party_id AND i.party_type = 'supplier'
    WHERE s.code = ANY(${codes}::text[])
    ORDER BY s.code::int, i.invoice_date, i.doc_no
  `.execute(db)
  return rows.rows
}

async function assertNoSupplierJournals(db: DbHandle, codes: string[]): Promise<void> {
  const rows = await sql<{ code: string; n: string }>`
    SELECT s.code, count(*)::text AS n
    FROM acc_gl_entry e
    JOIN pur_supplier s ON s.id = e.party_id AND e.party_type = 'supplier'
    WHERE s.code = ANY(${codes}::text[])
      AND e.voucher_type <> ${VOUCHER_TYPE}
      AND NOT e.is_cancelled
    GROUP BY s.code
    ORDER BY s.code
  `.execute(db)
  if (rows.rows.length > 0) {
    const sample = rows.rows
      .slice(0, 8)
      .map((r) => `${r.code}×${r.n}`)
      .join(', ')
    throw new Error(`计划内供应商仍有非发票分录，禁止改挂：${sample}`)
  }
}

function remarkOf(row: InvoiceRow, employeeName: string): string {
  const tag = `期初改挂费用报销 ${employeeName} 原供应商${row.supplier_code} ${row.supplier_name}`
  const cur = (row.remarks ?? '').trim()
  if (cur.includes('期初改挂费用报销')) return cur
  return cur ? `${cur} | ${tag}` : tag
}

function asInvoice(
  row: InvoiceRow,
  employeeId: string,
  accts: Accts,
): VatInvoice {
  return {
    id: row.id,
    docNo: row.doc_no,
    direction: 'INBOUND',
    invoiceDate: row.invoice_date,
    postingDate: row.posting_date ?? row.invoice_date,
    partyType: 'EMPLOYEE',
    partyId: employeeId,
    invoiceKind: row.invoice_kind,
    invoiceCode: '',
    invoiceNo: row.invoice_no,
    sellerName: null,
    sellerTaxNo: null,
    sellerAddressPhone: null,
    sellerBankAccount: null,
    buyerName: null,
    buyerTaxNo: null,
    buyerAddressPhone: null,
    buyerBankAccount: null,
    items: [],
    netTotal: row.net_total,
    taxTotal: row.tax_total,
    grossTotal: row.gross_total,
    issuer: null,
    reviewer: null,
    payee: null,
    remarks: row.remarks,
    redInvoiceNo: null,
    status: 'AUDITED',
    auditedAt: null,
    insertedAt: new Date(),
    updatedAt: new Date(),
    companyId: row.company_id,
    partyAccountId: accts.otherPayable,
    amountAccountId: accts.otherExpense,
    taxAccountId: row.tax_account_id,
    mirrorInvoiceId: null,
    createdById: null,
    auditedById: null,
    salReconciliationId: null,
    purReconciliationId: null,
  }
}

async function convertOne(
  gl: GlEngine,
  db: DbHandle,
  row: InvoiceRow,
  employeeId: string,
  employeeName: string,
  accts: Accts,
): Promise<'ok' | 'skip'> {
  return withTx(db, async (trx) => {
    const locked = await sql<{
      party_type: string
      status: string
      sal_reconciliation_id: string | null
      pur_reconciliation_id: string | null
    }>`
      SELECT party_type, status, sal_reconciliation_id::text, pur_reconciliation_id::text
      FROM acc_vat_invoice
      WHERE id = ${row.id}::uuid
      FOR UPDATE
    `.execute(trx)
    const cur = locked.rows[0]
    if (!cur) throw new Error(`发票不存在 ${row.id}`)
    if (cur.party_type === 'employee') return 'skip'
    if (cur.party_type !== 'supplier') {
      throw new Error(`${row.doc_no} 对手类型=${cur.party_type}，不是供应商`)
    }
    if (cur.status !== 'audited') throw new Error(`${row.doc_no} 状态=${cur.status}`)
    if (cur.sal_reconciliation_id || cur.pur_reconciliation_id) {
      throw new Error(`${row.doc_no} 已关联对账单`)
    }

    const invoice = asInvoice(row, employeeId, accts)
    const postingDate = invoice.postingDate
    if (!postingDate) throw new Error(`${row.doc_no} 无过账/开票日期`)
    const entries = invoiceGLEntries(invoice)
    const gross = decimal(invoice.grossTotal ?? '0')

    await gl.cancel(trx, { type: VOUCHER_TYPE, id: row.id })
    const remarks = remarkOf(row, employeeName)
    await sql`
      UPDATE acc_vat_invoice SET
        party_type = 'employee',
        party_id = ${employeeId}::uuid,
        party_account_id = ${accts.otherPayable}::uuid,
        amount_account_id = ${accts.otherExpense}::uuid,
        remarks = ${remarks},
        updated_at = (now() AT TIME ZONE 'utc')
      WHERE id = ${row.id}::uuid
    `.execute(trx)
    await gl.post(
      trx,
      {
        type: VOUCHER_TYPE,
        id: invoice.id,
        no: invoice.docNo || invoice.invoiceNo || invoice.id,
        companyId: invoice.companyId,
        postingDate,
      },
      entries,
      { allowNegative: gross.isNegative() },
    )
    const changes = JSON.stringify({
      from: {
        party_type: 'supplier',
        party_id: row.party_id,
        supplier_code: row.supplier_code,
        supplier_name: row.supplier_name,
        party_account_id: row.party_account_id,
        amount_account_id: row.amount_account_id,
      },
      to: {
        party_type: 'employee',
        party_id: employeeId,
        employee_name: employeeName,
        party_account_id: accts.otherPayable,
        amount_account_id: accts.otherExpense,
      },
    })
    await sql`
      INSERT INTO sys_audit_log (resource, record_id, record_label, action_type, action_name, actor_id, company_id, changes)
      VALUES (
        'accVatInvoices', ${row.id}::uuid, ${row.doc_no ?? row.id},
        'update', '期初改挂费用报销', ${ACTOR}::uuid, ${row.company_id}::uuid, ${changes}::jsonb
      )
    `.execute(trx)
    return 'ok'
  })
}

export async function main(argv: string[]): Promise<void> {
  const { apply, allowProd, planPath } = parseArgs(argv)
  const plan = loadPlan(planPath)
  const url = resolveBackfillDatabaseUrl()
  assertReplayUrl(url, allowProd)
  const world = createMigrationWorld(url)
  const db = world.db
  try {
    const emp = await sql<{ id: string; name: string }>`
      SELECT id::text, name FROM hr_employees WHERE code = ${plan.employee_code}
    `.execute(db)
    const employee = emp.rows[0]
    if (!employee) throw new Error(`员工不存在 ${plan.employee_code}`)
    if (employee.name !== plan.employee_name) {
      throw new Error(`员工姓名不符：库=${employee.name} 计划=${plan.employee_name}`)
    }

    const accts = await accountMap(db)
    await assertNoSupplierJournals(db, plan.supplier_codes)
    const invoices = await loadInvoices(db, plan.supplier_codes)
    const missing = plan.supplier_codes.filter(
      (c) => !invoices.some((i) => i.supplier_code === c),
    )

    let gross = decimal(0)
    const byCo = new Map<string, { n: number; gross: ReturnType<typeof decimal> }>()
    for (const inv of invoices) {
      const g = decimal(inv.gross_total)
      gross = gross.plus(g)
      const cur = byCo.get(inv.company_id) ?? { n: 0, gross: decimal(0) }
      cur.n += 1
      cur.gross = cur.gross.plus(g)
      byCo.set(inv.company_id, cur)
      if (inv.status !== 'audited') throw new Error(`${inv.doc_no} 非已审核`)
      if (inv.sal_reconciliation_id || inv.pur_reconciliation_id) {
        throw new Error(`${inv.doc_no} 已关联对账单`)
      }
      if (!accts.get(inv.company_id)) throw new Error(`无科目 ${inv.company_id}`)
    }

    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'expense_reclass_plan',
        apply,
        allowProd,
        dsn: dsnHost(url),
        employee: { code: plan.employee_code, name: employee.name, id: employee.id },
        suppliers: plan.supplier_codes.length,
        invoices: invoices.length,
        missing_suppliers_no_invoice: missing,
        gross: gross.toFixed(2),
        note: plan.note,
      }),
    )

    if (!apply) {
      console.log(JSON.stringify({ level: 'info', msg: 'dry_run', would_convert: invoices.length }))
      return
    }

    let ok = 0
    let skip = 0
    for (const [idx, inv] of invoices.entries()) {
      const companyAccts = accts.get(inv.company_id)!
      const result = await convertOne(world.gl, db, inv, employee.id, employee.name, companyAccts)
      if (result === 'skip') skip += 1
      else ok += 1
      if ((idx + 1) % 50 === 0 || idx + 1 === invoices.length) {
        console.log(
          JSON.stringify({
            level: 'info',
            msg: 'expense_reclass_progress',
            done: idx + 1,
            total: invoices.length,
            ok,
            skip,
          }),
        )
      }
    }

    const live = await sql<{ n: string; gross: string }>`
      SELECT count(*)::text AS n, round(sum(gross_total), 2)::text AS gross
      FROM acc_vat_invoice
      WHERE party_type = 'employee' AND party_id = ${employee.id}::uuid
        AND remarks LIKE '%期初改挂费用报销%'
    `.execute(db)
    const ap = await sql<{ company: string; acct: string; bal: string }>`
      SELECT c.code AS company, a.code AS acct,
             round(sum(e.credit - e.debit), 2)::text AS bal
      FROM acc_gl_entry e
      JOIN bas_account a ON a.id = e.account_id
      JOIN bas_company c ON c.id = e.company_id
      WHERE NOT e.is_cancelled
        AND e.party_type = 'employee' AND e.party_id = ${employee.id}::uuid
        AND a.code IN ('2241', '2202')
      GROUP BY 1, 2
      ORDER BY 1, 2
    `.execute(db)

    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'expense_reclass_done',
        ok,
        skip,
        live_invoices: live.rows[0],
        employee_ap: ap.rows,
      }),
    )
  } finally {
    await db.destroy()
  }
}
