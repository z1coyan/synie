/**
 * 费用报销单：挂票/无票行、审核过账、作废解除发票占用。
 */
import { decimal, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { createGlEngine, type GlEngine, type GlEntry } from '~/engines/gl/index.ts'
import {
  auditCreated, auditDiff, writeAudit,
} from '~/platform/audit/write.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { companyScopeWhere, listFromSource } from '~/db/list.ts'
import { mapWriteError } from '~/db/dberr.ts'
import {
  actorUserId, asDateOnly, asDateOnlyOrNull, asIso, asIsoOrNull, conflict, lower,
  notFound, parseDecimal, requireCompanyAccess, requireDate, requirePerm, upper,
  wireDec, wireEnum,
} from './common.ts'
import { expenseReportItemResourceMeta, expenseReportResourceMeta } from './meta.ts'

export interface ExpenseReport {
  id: string; docNo: string; expenseDate: string; postingDate: string | null
  remarks: string | null; status: string; auditedAt: string | null
  insertedAt: string; updatedAt: string; companyId: string; employeeId: string
  paymentAccountId: string; createdById: string | null; auditedById: string | null
}

export interface ExpenseReportItem {
  id: string; idx: number; kind: string; summary: string | null; amount: string | null
  remarks: string | null; insertedAt: string; updatedAt: string; reportId: string
  companyId: string; invoiceId: string | null; expenseAccountId: string | null
}

const REPORT_AUDIT = [
  'doc_no','expense_date','posting_date','remarks','status','company_id',
  'employee_id','payment_account_id',
] as const
const ITEM_AUDIT = [
  'idx','kind','summary','amount','remarks','report_id','company_id',
  'invoice_id','expense_account_id',
] as const
const WRITE_MAP = [
  { code: '23505', message: '报销单编号冲突' },
  { code: '23503', message: '报销单引用不存在' },
] as const
const VOUCHER = 'acc.expense_report'

function mapReport(row: Record<string, unknown>): ExpenseReport {
  return {
    id: String(row.id), docNo: String(row.doc_no),
    expenseDate: asDateOnly(row.expense_date),
    postingDate: asDateOnlyOrNull(row.posting_date),
    remarks: row.remarks == null ? null : String(row.remarks),
    status: wireEnum(row.status), auditedAt: asIsoOrNull(row.audited_at),
    insertedAt: asIso(row.inserted_at), updatedAt: asIso(row.updated_at),
    companyId: String(row.company_id), employeeId: String(row.employee_id),
    paymentAccountId: String(row.payment_account_id),
    createdById: row.created_by_id == null ? null : String(row.created_by_id),
    auditedById: row.audited_by_id == null ? null : String(row.audited_by_id),
  }
}

function mapItem(row: Record<string, unknown>): ExpenseReportItem {
  return {
    id: String(row.id), idx: Number(row.idx), kind: wireEnum(row.kind),
    summary: row.summary == null ? null : String(row.summary),
    amount: wireDec(row.amount),
    remarks: row.remarks == null ? null : String(row.remarks),
    insertedAt: asIso(row.inserted_at), updatedAt: asIso(row.updated_at),
    reportId: String(row.report_id), companyId: String(row.company_id),
    invoiceId: row.invoice_id == null ? null : String(row.invoice_id),
    expenseAccountId: row.expense_account_id == null ? null : String(row.expense_account_id),
  }
}

function reportSnap(r: ExpenseReport): Record<string, unknown> {
  return {
    doc_no: r.docNo, expense_date: r.expenseDate, posting_date: r.postingDate,
    remarks: r.remarks, status: r.status, company_id: r.companyId,
    employee_id: r.employeeId, payment_account_id: r.paymentAccountId,
  }
}

function itemSnap(i: ExpenseReportItem): Record<string, unknown> {
  return {
    idx: i.idx, kind: i.kind, summary: i.summary, amount: i.amount, remarks: i.remarks,
    report_id: i.reportId, company_id: i.companyId, invoice_id: i.invoiceId,
    expense_account_id: i.expenseAccountId,
  }
}

async function loadReport(db: DbHandle, id: string, lock: boolean): Promise<ExpenseReport> {
  const rows = await sql<Record<string, unknown>>`
    SELECT id,doc_no,expense_date,posting_date,remarks,status,audited_at,inserted_at,updated_at,
      company_id,employee_id,payment_account_id,created_by_id,audited_by_id
    FROM acc_expense_report WHERE id=${id}::uuid ${lock ? sql`FOR UPDATE` : sql``}
  `.execute(db)
  if (!rows.rows[0]) throw notFound('费用报销单')
  return mapReport(rows.rows[0])
}

async function loadItem(db: DbHandle, id: string): Promise<ExpenseReportItem> {
  const rows = await sql<Record<string, unknown>>`
    SELECT id,idx,kind,summary,amount,remarks,inserted_at,updated_at,report_id,company_id,invoice_id,expense_account_id
    FROM acc_expense_report_item WHERE id=${id}::uuid
  `.execute(db)
  if (!rows.rows[0]) throw notFound('报销行')
  return mapItem(rows.rows[0])
}

async function validateEmployeeAndAccount(
  db: DbHandle, companyId: string, employeeId: string, accountId: string,
) {
  const rows = await sql<{ employee: boolean; account: boolean }>`
    SELECT
      EXISTS(SELECT 1 FROM hr_employees WHERE id=${employeeId}::uuid) AS employee,
      EXISTS(SELECT 1 FROM bas_account WHERE id=${accountId}::uuid AND company_id=${companyId}::uuid
        AND active AND NOT is_group) AS account
  `.execute(db)
  if (!rows.rows[0]?.employee || !rows.rows[0]?.account) {
    throw ApiError.validation('费用报销单参数不合法', { references: ['员工或付款科目不合法'] })
  }
}

export type ExpenseService = ReturnType<typeof createExpenseService>

export function createExpenseService(
  db: Kysely<Database>,
  numbering: NumberingService,
  gl: GlEngine = createGlEngine(),
) {
  async function listReports(actor: Actor, query: Partial<ListQuery>) {
    requirePerm(actor, 'acc.expense_report:read')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as ExpenseReport[] }
    return listFromSource({
      db, resource: expenseReportResourceMeta(),
      source: sql` FROM acc_expense_report`,
      select: sql`SELECT id,doc_no,expense_date,posting_date,remarks,status,audited_at,inserted_at,updated_at,
        company_id,employee_id,payment_account_id,created_by_id,audited_by_id`,
      defaultOrder: sql`"id"`, query, extraWhere: scope.where, mapRow: mapReport,
    })
  }

  async function getReport(actor: Actor, id: string) {
    requirePerm(actor, 'acc.expense_report:read')
    const item = await loadReport(db, id, false)
    requireCompanyAccess(actor, item.companyId, '费用报销单')
    return item
  }

  async function createReport(actor: Actor, input: {
    companyId: string; docNo?: string | null; expenseDate: string
    postingDate?: string | null; remarks?: string | null
    employeeId: string; paymentAccountId: string
  }) {
    requirePerm(actor, 'acc.expense_report:create')
    requireCompanyAccess(actor, input.companyId, '费用报销单')
    const expenseDate = requireDate(input.expenseDate, 'expenseDate')
    if (!input.employeeId || !input.paymentAccountId) {
      throw ApiError.validation('费用报销单参数不合法', { references: ['员工与付款科目必填'] })
    }
    const postingDate = input.postingDate ? requireDate(input.postingDate, 'postingDate') : null
    return withTx(db, async (trx) => {
      await validateEmployeeAndAccount(trx, input.companyId, input.employeeId, input.paymentAccountId)
      let docNo = (input.docNo ?? '').trim()
      if (!docNo) {
        docNo = await numbering.nextInTx(trx, {
          resource: 'acc.expense_report',
          values: { company_id: input.companyId, posting_date: expenseDate },
        })
      }
      try {
        const ins = await sql<{ id: string }>`
          INSERT INTO acc_expense_report(doc_no,expense_date,posting_date,remarks,company_id,employee_id,payment_account_id,created_by_id)
          VALUES (${docNo},${expenseDate}::date,${postingDate}::date,${input.remarks ?? null},
            ${input.companyId}::uuid,${input.employeeId}::uuid,${input.paymentAccountId}::uuid,${actorUserId(actor)}::uuid)
          RETURNING id
        `.execute(trx)
        const result = await loadReport(trx, ins.rows[0]!.id, false)
        await writeAudit(trx, actor, {
          resource: 'acc_expense_report', recordId: result.id, recordLabel: docNo,
          companyId: result.companyId, actionType: 'create', actionName: 'create',
          changes: auditCreated(reportSnap(result), REPORT_AUDIT),
        })
        return result
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '创建费用报销单失败', WRITE_MAP)
      }
    })
  }

  async function updateReport(actor: Actor, id: string, input: {
    docNo?: string | null; docNoPresent?: boolean
    expenseDate?: string
    postingDate?: string | null; postingDatePresent?: boolean
    remarks?: string | null; remarksPresent?: boolean
    employeeId?: string; paymentAccountId?: string
  }) {
    requirePerm(actor, 'acc.expense_report:update')
    return withTx(db, async (trx) => {
      const before = await loadReport(trx, id, true)
      requireCompanyAccess(actor, before.companyId, '费用报销单')
      if (before.status !== 'DRAFT') throw conflict('仅草稿报销单可修改或删除')
      let docNo = before.docNo
      let expenseDate = before.expenseDate
      let postingDate = before.postingDate
      let remarks = before.remarks
      let employeeId = before.employeeId
      let paymentAccountId = before.paymentAccountId
      if (input.docNoPresent) {
        if (!input.docNo || !input.docNo.trim()) {
          throw ApiError.validation('费用报销单参数不合法', { docNo: ['不能为空'] })
        }
        docNo = input.docNo.trim()
      }
      if (input.expenseDate !== undefined) expenseDate = requireDate(input.expenseDate, 'expenseDate')
      if (input.postingDatePresent) {
        postingDate = input.postingDate ? requireDate(input.postingDate, 'postingDate') : null
      }
      if (input.remarksPresent) remarks = input.remarks ?? null
      if (input.employeeId !== undefined) employeeId = input.employeeId
      if (input.paymentAccountId !== undefined) paymentAccountId = input.paymentAccountId
      await validateEmployeeAndAccount(trx, before.companyId, employeeId, paymentAccountId)
      try {
        await sql`
          UPDATE acc_expense_report SET doc_no=${docNo},expense_date=${expenseDate}::date,
            posting_date=${postingDate}::date,remarks=${remarks},employee_id=${employeeId}::uuid,
            payment_account_id=${paymentAccountId}::uuid,updated_at=(now() AT TIME ZONE 'utc')
          WHERE id=${id}::uuid
        `.execute(trx)
        const result = await loadReport(trx, id, false)
        await writeAudit(trx, actor, {
          resource: 'acc_expense_report', recordId: id, recordLabel: result.docNo,
          companyId: result.companyId, actionType: 'update', actionName: 'update',
          changes: auditDiff(reportSnap(before), reportSnap(result), REPORT_AUDIT),
        })
        return result
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '更新费用报销单失败', WRITE_MAP)
      }
    })
  }

  async function deleteReport(actor: Actor, id: string) {
    requirePerm(actor, 'acc.expense_report:delete')
    return withTx(db, async (trx) => {
      const before = await loadReport(trx, id, true)
      requireCompanyAccess(actor, before.companyId, '费用报销单')
      if (before.status !== 'DRAFT') throw conflict('仅草稿报销单可修改或删除')
      try {
        await sql`DELETE FROM acc_expense_report WHERE id=${id}::uuid`.execute(trx)
        await writeAudit(trx, actor, {
          resource: 'acc_expense_report', recordId: id, recordLabel: before.docNo,
          companyId: before.companyId, actionType: 'delete', actionName: 'delete',
          changes: auditDiff(reportSnap(before), {}, REPORT_AUDIT),
        })
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '删除费用报销单失败', WRITE_MAP)
      }
    })
  }

  async function expenseEntries(trx: DbHandle, report: ExpenseReport): Promise<{ entries: GlEntry[]; total: ReturnType<typeof decimal> }> {
    const rows = await sql<{
      kind: string; amount: string | null; expense_account_id: string | null; invoice_id: string | null
    }>`
      SELECT i.kind,i.amount::text,i.expense_account_id,i.invoice_id
      FROM acc_expense_report_item i WHERE i.report_id=${report.id}::uuid
      ORDER BY i.idx,i.id FOR UPDATE OF i
    `.execute(trx)
    const entries: GlEntry[] = []
    let total = decimal(0)
    for (const item of rows.rows) {
      if (item.kind === 'invoiced') {
        if (!item.invoice_id) throw conflict('挂票行发票状态已变化')
        const inv = await sql<{ gross_total: string | null; party_account_id: string | null }>`
          SELECT gross_total::text, party_account_id FROM acc_vat_invoice
          WHERE id=${item.invoice_id}::uuid AND company_id=${report.companyId}::uuid
            AND party_type='employee' AND party_id=${report.employeeId}::uuid
            AND direction='inbound' AND status='audited' FOR UPDATE
        `.execute(trx)
        const row = inv.rows[0]
        if (!row?.party_account_id || row.gross_total == null) throw conflict('挂票行发票状态已变化')
        const claimed = await sql<{ e: boolean }>`
          SELECT EXISTS(
            SELECT 1 FROM acc_expense_report_item other
            JOIN acc_expense_report r ON r.id=other.report_id
            WHERE other.invoice_id=${item.invoice_id}::uuid AND other.report_id<>${report.id}::uuid AND r.status<>'voided'
          ) AS e
        `.execute(trx)
        if (claimed.rows[0]?.e) throw conflict('挂票发票已被其他报销单占用')
        const value = decimal(row.gross_total)
        entries.push({
          accountId: row.party_account_id, debit: value, credit: 0,
          partyType: 'employee', partyId: report.employeeId,
        })
        total = total.add(value)
      } else {
        if (!item.expense_account_id || item.amount == null) throw conflict('无票报销行不完整')
        const value = decimal(item.amount)
        entries.push({ accountId: item.expense_account_id, debit: value, credit: 0 })
        total = total.add(value)
      }
    }
    return { entries, total }
  }

  async function auditReport(actor: Actor, id: string, postingDate: string) {
    requirePerm(actor, 'acc.expense_report:audit')
    const posting = requireDate(postingDate, 'postingDate')
    return withTx(db, async (trx) => {
      const before = await loadReport(trx, id, true)
      requireCompanyAccess(actor, before.companyId, '费用报销单')
      if (before.status !== 'DRAFT') throw conflict('仅草稿报销单可审核')
      await validateEmployeeAndAccount(trx, before.companyId, before.employeeId, before.paymentAccountId)
      const { entries, total } = await expenseEntries(trx, before)
      if (total.isZero()) throw conflict('报销单必须至少有一行')
      const tag = await sql`
        UPDATE acc_expense_report SET status='audited', posting_date=${posting}::date,
          audited_at=timezone('utc',now()), audited_by_id=${actorUserId(actor)}::uuid,
          updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${id}::uuid AND status='draft'
      `.execute(trx)
      if (Number(tag.numAffectedRows) !== 1) throw conflict('报销单已被并发处理')
      entries.push({ accountId: before.paymentAccountId, debit: 0, credit: total })
      await gl.post(trx, {
        type: VOUCHER, id, no: before.docNo, companyId: before.companyId, postingDate: posting,
      }, entries)
      const result = await loadReport(trx, id, false)
      await writeAudit(trx, actor, {
        resource: 'acc_expense_report', recordId: id, recordLabel: result.docNo,
        companyId: result.companyId, actionType: 'update', actionName: 'audit',
        changes: auditDiff(reportSnap(before), reportSnap(result), REPORT_AUDIT),
      })
      return result
    })
  }

  async function voidReport(actor: Actor, id: string) {
    requirePerm(actor, 'acc.expense_report:void')
    return withTx(db, async (trx) => {
      const before = await loadReport(trx, id, true)
      requireCompanyAccess(actor, before.companyId, '费用报销单')
      if (before.status !== 'AUDITED') throw conflict('仅已审核报销单可作废')
      await gl.cancel(trx, { type: VOUCHER, id })
      await sql`
        UPDATE acc_expense_report SET status='voided', updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${id}::uuid
      `.execute(trx)
      const result = await loadReport(trx, id, false)
      await writeAudit(trx, actor, {
        resource: 'acc_expense_report', recordId: id, recordLabel: result.docNo,
        companyId: result.companyId, actionType: 'update', actionName: 'void',
        changes: auditDiff(reportSnap(before), reportSnap(result), REPORT_AUDIT),
      })
      return result
    })
  }

  async function validateExpenseItem(
    trx: DbHandle, report: ExpenseReport,
    input: {
      idx: number; kind: string; summary?: string | null; amount?: string | null
      invoiceId?: string | null; expenseAccountId?: string | null
    },
    ownId: string | null,
  ): Promise<{ kind: string; amount: string | null }> {
    const kind = upper(input.kind)
    if (input.idx < 1) throw ApiError.validation('报销行参数不合法', { idx: ['必须大于零'] })
    if (kind === 'INVOICED') {
      if (!input.invoiceId || input.summary != null || input.amount != null || input.expenseAccountId != null) {
        throw ApiError.validation('报销行参数不合法', { kind: ['挂票行仅允许发票与备注'] })
      }
      const inv = await sql<{
        company_id: string; party_type: string; party_id: string; direction: string; status: string; claimed: boolean
      }>`
        SELECT company_id,party_type,party_id,direction,status,
          EXISTS(SELECT 1 FROM acc_expense_report_item other
            JOIN acc_expense_report r ON r.id=other.report_id
            WHERE other.invoice_id=inv.id AND other.id<>${ownId ?? '00000000-0000-0000-0000-000000000000'}::uuid
              AND r.status<>'voided') AS claimed
        FROM acc_vat_invoice inv WHERE id=${input.invoiceId}::uuid FOR UPDATE
      `.execute(trx)
      const row = inv.rows[0]
      if (
        !row || row.company_id !== report.companyId || row.party_type !== 'employee' ||
        row.party_id !== report.employeeId || row.direction !== 'inbound' ||
        row.status !== 'audited' || row.claimed
      ) {
        throw conflict('挂票发票必须为同公司同员工的已审核未报销开入发票')
      }
      return { kind, amount: null }
    }
    if (kind === 'MANUAL') {
      if (input.invoiceId != null || !input.summary?.trim() || !input.amount || !input.expenseAccountId) {
        throw ApiError.validation('报销行参数不合法', { kind: ['无票行须填写摘要、正金额与费用科目'] })
      }
      const amount = parseDecimal(input.amount, 'amount', true, false)
      const valid = await sql<{ e: boolean }>`
        SELECT EXISTS(SELECT 1 FROM bas_account WHERE id=${input.expenseAccountId}::uuid
          AND company_id=${report.companyId}::uuid AND active AND NOT is_group) AS e
      `.execute(trx)
      if (!valid.rows[0]?.e) {
        throw ApiError.validation('报销行参数不合法', { expenseAccountId: ['费用科目不合法'] })
      }
      return { kind, amount: amount.toFixed() }
    }
    throw ApiError.validation('报销行参数不合法', { kind: ['只允许 INVOICED 或 MANUAL'] })
  }

  async function listItems(actor: Actor, query: Partial<ListQuery>) {
    requirePerm(actor, 'acc.expense_report:read')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as ExpenseReportItem[] }
    return listFromSource({
      db, resource: expenseReportItemResourceMeta(),
      source: sql` FROM acc_expense_report_item`,
      select: sql`SELECT id,idx,kind,summary,amount,remarks,inserted_at,updated_at,report_id,company_id,invoice_id,expense_account_id`,
      defaultOrder: sql`"id"`, query, extraWhere: scope.where, mapRow: mapItem,
    })
  }

  async function getItem(actor: Actor, id: string) {
    requirePerm(actor, 'acc.expense_report:read')
    const item = await loadItem(db, id)
    requireCompanyAccess(actor, item.companyId, '报销行')
    return item
  }

  async function createItem(actor: Actor, input: {
    reportId: string; idx: number; kind: string
    summary?: string | null; amount?: string | null; remarks?: string | null
    invoiceId?: string | null; expenseAccountId?: string | null
  }) {
    requirePerm(actor, 'acc.expense_report:create')
    return withTx(db, async (trx) => {
      const report = await loadReport(trx, input.reportId, true)
      requireCompanyAccess(actor, report.companyId, '费用报销单')
      if (report.status !== 'DRAFT') throw conflict('仅草稿报销单可增删改行')
      const normalized = await validateExpenseItem(trx, report, input, null)
      try {
        const ins = await sql<{ id: string }>`
          INSERT INTO acc_expense_report_item(idx,kind,summary,amount,remarks,report_id,company_id,invoice_id,expense_account_id)
          VALUES (${input.idx},${lower(normalized.kind)},${input.summary ?? null},${normalized.amount},
            ${input.remarks ?? null},${report.id}::uuid,${report.companyId}::uuid,
            ${input.invoiceId ?? null}::uuid,${input.expenseAccountId ?? null}::uuid)
          RETURNING id
        `.execute(trx)
        const result = await loadItem(trx, ins.rows[0]!.id)
        await writeAudit(trx, actor, {
          resource: 'acc_expense_report_item', recordId: result.id,
          recordLabel: `${report.docNo}#${result.idx}`,
          companyId: result.companyId, actionType: 'create', actionName: 'create',
          changes: auditCreated(itemSnap(result), ITEM_AUDIT),
        })
        return result
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '创建报销行失败', WRITE_MAP)
      }
    })
  }

  async function updateItem(actor: Actor, id: string, input: {
    idx?: number; kind?: string
    summary?: string | null; summaryPresent?: boolean
    amount?: string | null; amountPresent?: boolean
    remarks?: string | null; remarksPresent?: boolean
    invoiceId?: string | null; invoiceIdPresent?: boolean
    expenseAccountId?: string | null; expenseAccountIdPresent?: boolean
  }) {
    requirePerm(actor, 'acc.expense_report:update')
    return withTx(db, async (trx) => {
      const before = await loadItem(trx, id)
      const report = await loadReport(trx, before.reportId, true)
      requireCompanyAccess(actor, report.companyId, '费用报销单')
      if (report.status !== 'DRAFT') throw conflict('仅草稿报销单可增删改行')
      const merged = {
        idx: input.idx ?? before.idx,
        kind: input.kind ?? before.kind,
        summary: input.summaryPresent ? (input.summary ?? null) : before.summary,
        amount: input.amountPresent ? (input.amount ?? null) : before.amount,
        remarks: input.remarksPresent ? (input.remarks ?? null) : before.remarks,
        invoiceId: input.invoiceIdPresent ? (input.invoiceId ?? null) : before.invoiceId,
        expenseAccountId: input.expenseAccountIdPresent ? (input.expenseAccountId ?? null) : before.expenseAccountId,
      }
      const normalized = await validateExpenseItem(trx, report, merged, id)
      try {
        await sql`
          UPDATE acc_expense_report_item SET idx=${merged.idx},kind=${lower(normalized.kind)},
            summary=${merged.summary},amount=${normalized.amount},remarks=${merged.remarks},
            invoice_id=${merged.invoiceId}::uuid,expense_account_id=${merged.expenseAccountId}::uuid,
            updated_at=(now() AT TIME ZONE 'utc') WHERE id=${id}::uuid
        `.execute(trx)
        const result = await loadItem(trx, id)
        await writeAudit(trx, actor, {
          resource: 'acc_expense_report_item', recordId: id,
          recordLabel: `${report.docNo}#${result.idx}`,
          companyId: result.companyId, actionType: 'update', actionName: 'update',
          changes: auditDiff(itemSnap(before), itemSnap(result), ITEM_AUDIT),
        })
        return result
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '更新报销行失败', WRITE_MAP)
      }
    })
  }

  async function deleteItem(actor: Actor, id: string) {
    requirePerm(actor, 'acc.expense_report:delete')
    return withTx(db, async (trx) => {
      const before = await loadItem(trx, id)
      const report = await loadReport(trx, before.reportId, true)
      requireCompanyAccess(actor, report.companyId, '费用报销单')
      if (report.status !== 'DRAFT') throw conflict('仅草稿报销单可增删改行')
      try {
        await sql`DELETE FROM acc_expense_report_item WHERE id=${id}::uuid`.execute(trx)
        await writeAudit(trx, actor, {
          resource: 'acc_expense_report_item', recordId: id,
          recordLabel: `${report.docNo}#${before.idx}`,
          companyId: before.companyId, actionType: 'delete', actionName: 'delete',
          changes: auditDiff(itemSnap(before), {}, ITEM_AUDIT),
        })
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '删除报销行失败', WRITE_MAP)
      }
    })
  }

  return {
    listReports, getReport, createReport, updateReport, deleteReport, auditReport, voidReport,
    listItems, getItem, createItem, updateItem, deleteItem,
  }
}
