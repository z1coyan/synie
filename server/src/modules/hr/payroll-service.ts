/**
 * 工资：工资单 / 发放 / 员工借款。
 */
import {
  decimal,
  roundAmount,
  type ListQuery,
  toDecimalString,
} from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import { requirePermission, type Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { listFromSource } from '~/db/list.ts'
import {
  employeeLoanResourceMeta,
  payrollPaymentResourceMeta,
  payrollResourceMeta,
} from './meta.ts'
import {
  applyPayment,
  FULL_DAY_HOURS_SQL,
  LOAN_BORROW,
  LOAN_REPAY,
  lowerWire,
  PAYMENT_NORMAL,
  PAYMENT_SUPPLEMENT,
  PAYROLL_PAID,
  PAYROLL_PENDING,
  reversePayment,
  upperWire,
} from './rules.ts'
import {
  asDate,
  asDateOnly,
  numStr,
  nullableNumStr,
  parseDate,
  parseMonth,
  addMonth,
  parseDecimal,
  writeErr,
} from './helpers.ts'
import type {
  EmployeeLoan,
  EmployeeLoanBalance,
  Payroll,
  PayrollInput,
  PayrollPayment,
} from './types.ts'

export type {
  EmployeeLoan,
  EmployeeLoanBalance,
  Payroll,
  PayrollInput,
  PayrollPayment,
} from './types.ts'

const PAYROLL_AUDIT = [
  'month',
  'workdays',
  'attendance_days',
  'missing_days',
  'overtime_hours',
  'daily_wage',
  'base_amount',
  'allowance',
  'bonus',
  'fine',
  'loan_deduction',
  'payable',
  'status',
  'remarks',
  'employee_id',
] as const

const PAYMENT_AUDIT = [
  'month',
  'paid_on',
  'amount',
  'kind',
  'remarks',
  'payroll_id',
  'employee_id',
  'created_by_id',
] as const

const LOAN_AUDIT = [
  'kind',
  'occurred_on',
  'amount',
  'remarks',
  'employee_id',
  'payroll_id',
  'created_by_id',
] as const

export interface PayrollServiceDeps {
  db: Kysely<Database>
}

export function createPayrollService(deps: PayrollServiceDeps) {
  const { db } = deps

  // ── payrolls ───────────────────────────────────────────────────────────

  async function listPayrolls(query: Partial<ListQuery>) {
    return listFromSource({
      db,
      resource: payrollResourceMeta(),
      source: sql` FROM hr_payroll p`,
      select: sql`SELECT p.id, p.month, p.workdays, p.attendance_days, p.missing_days,
        p.overtime_hours, p.daily_wage, p.base_amount, p.allowance, p.bonus, p.fine,
        p.loan_deduction, p.payable, p.status, p.remarks, p.inserted_at, p.updated_at,
        p.employee_id,
        (SELECT sum(payment.amount) FROM hr_payroll_payment payment
          WHERE payment.payroll_id = p.id) AS paid_total`,
      defaultOrder: sql`"month" DESC, "id" ASC`,
      query,
      mapRow: mapPayrollRow,
    })
  }

  async function getPayroll(handle: DbHandle, id: string): Promise<Payroll> {
    const row = await sql<Record<string, unknown>>`
      SELECT p.id, p.month, p.workdays, p.attendance_days, p.missing_days,
        p.overtime_hours, p.daily_wage, p.base_amount, p.allowance, p.bonus, p.fine,
        p.loan_deduction, p.payable, p.status, p.remarks, p.inserted_at, p.updated_at,
        p.employee_id,
        (SELECT sum(payment.amount) FROM hr_payroll_payment payment
          WHERE payment.payroll_id = p.id) AS paid_total
        FROM hr_payroll p WHERE p.id = ${id}::uuid
    `.execute(handle)
    const r = row.rows[0]
    if (!r) throw new ApiError('not_found', '工资单不存在')
    return mapPayrollRow(r)
  }

  async function createPayroll(actor: Actor, input: PayrollInput): Promise<Payroll> {
    requirePermission(actor, 'hr.payroll:create')
    const normalized = normalizePayrollInput(input)
    return withTx(db, async (trx) => {
      const item = await insertPayroll(trx, normalized)
      await writeAudit(trx, actor, {
        resource: 'hr_payroll',
        recordId: item.id,
        recordLabel: item.month,
        actionType: 'create',
        actionName: 'create',
        changes: auditCreated(payrollSnap(item), PAYROLL_AUDIT),
      })
      return item
    })
  }

  async function updatePayroll(
    actor: Actor,
    id: string,
    input: {
      workdays?: string
      attendanceDays?: number
      missingDays?: number
      overtimeHours?: string
      dailyWage?: string
      allowance?: string
      bonus?: string
      fine?: string
      loanDeduction?: string
      remarks?: string | null
      remarksPresent?: boolean
    },
  ): Promise<Payroll> {
    requirePermission(actor, 'hr.payroll:update')
    return withTx(db, async (trx) => {
      const before = await lockPayroll(trx, id)
      if (before.status !== upperWire(PAYROLL_PENDING)) {
        throw new ApiError('conflict', '仅待发放工资单可修改或删除,差错请走补发')
      }
      const normalized = normalizePayrollInput({
        employeeId: before.employeeId,
        month: before.month,
        workdays: input.workdays ?? before.workdays,
        attendanceDays: input.attendanceDays ?? before.attendanceDays,
        missingDays: input.missingDays ?? before.missingDays,
        overtimeHours: input.overtimeHours ?? before.overtimeHours,
        dailyWage: input.dailyWage ?? before.dailyWage,
        allowance: input.allowance ?? before.allowance,
        bonus: input.bonus ?? before.bonus,
        fine: input.fine ?? before.fine,
        loanDeduction: input.loanDeduction ?? before.loanDeduction,
        remarks: input.remarksPresent ? (input.remarks ?? null) : before.remarks,
      })
      try {
        await trx
          .updateTable('hr_payroll')
          .set({
            workdays: normalized.workdays,
            attendance_days: String(normalized.attendanceDays),
            missing_days: String(normalized.missingDays),
            overtime_hours: normalized.overtimeHours,
            daily_wage: normalized.dailyWage,
            base_amount: normalized.baseAmount,
            allowance: normalized.allowance,
            bonus: normalized.bonus,
            fine: normalized.fine,
            loan_deduction: normalized.loanDeduction,
            payable: normalized.payable,
            remarks: normalized.remarks,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .execute()
      } catch (err) {
        throw writeErr(err, '更新工资单失败')
      }
      const item = await getPayroll(trx, id)
      const changes = auditDiff(payrollSnap(before), payrollSnap(item), PAYROLL_AUDIT)
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, actor, {
          resource: 'hr_payroll',
          recordId: id,
          recordLabel: item.month,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
      }
      return item
    })
  }

  async function refreshPayroll(actor: Actor, id: string): Promise<Payroll> {
    requirePermission(actor, 'hr.payroll:update')
    return withTx(db, async (trx) => {
      const before = await lockPayroll(trx, id)
      if (before.status !== upperWire(PAYROLL_PENDING)) {
        throw new ApiError('conflict', '仅待发放工资单可重取快照')
      }
      const snapshot = await payrollSnapshotForEmployee(trx, before.month, before.employeeId)
      const normalized = normalizePayrollInput({
        employeeId: before.employeeId,
        month: before.month,
        workdays: snapshot.workdays,
        attendanceDays: snapshot.attendanceDays,
        missingDays: snapshot.missingDays,
        overtimeHours: snapshot.overtimeHours,
        dailyWage: snapshot.dailyWage,
        allowance: snapshot.allowance,
        bonus: before.bonus,
        fine: before.fine,
        loanDeduction: before.loanDeduction,
        remarks: before.remarks,
      })
      try {
        await trx
          .updateTable('hr_payroll')
          .set({
            workdays: normalized.workdays,
            attendance_days: String(normalized.attendanceDays),
            missing_days: String(normalized.missingDays),
            overtime_hours: normalized.overtimeHours,
            daily_wage: normalized.dailyWage,
            base_amount: normalized.baseAmount,
            allowance: normalized.allowance,
            bonus: normalized.bonus,
            fine: normalized.fine,
            loan_deduction: normalized.loanDeduction,
            payable: normalized.payable,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .execute()
      } catch (err) {
        throw writeErr(err, '重取工资单快照失败')
      }
      const item = await getPayroll(trx, id)
      const changes = auditDiff(payrollSnap(before), payrollSnap(item), PAYROLL_AUDIT)
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, actor, {
          resource: 'hr_payroll',
          recordId: id,
          recordLabel: item.month,
          actionType: 'update',
          actionName: 'refresh',
          changes,
        })
      }
      return item
    })
  }

  async function deletePayroll(actor: Actor, id: string): Promise<void> {
    requirePermission(actor, 'hr.payroll:delete')
    await withTx(db, async (trx) => {
      const before = await lockPayroll(trx, id)
      if (before.status !== upperWire(PAYROLL_PENDING)) {
        throw new ApiError('conflict', '仅待发放工资单可修改或删除,差错请走补发')
      }
      try {
        await trx.deleteFrom('hr_payroll').where('id', '=', id).execute()
      } catch (err) {
        throw writeErr(err, '删除工资单失败')
      }
      await writeAudit(trx, actor, {
        resource: 'hr_payroll',
        recordId: id,
        recordLabel: before.month,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(payrollSnap(before), PAYROLL_AUDIT),
      })
    })
  }

  async function generatePayrolls(
    actor: Actor,
    month: string,
  ): Promise<{ created: number; skipped: number }> {
    requirePermission(actor, 'hr.payroll:create')
    const first = parseMonth(month)
    const next = addMonth(first)
    return withTx(db, async (trx) => {
      const skippedRow = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM hr_payroll WHERE month = ${month}
      `.execute(trx)
      const skipped = Number(skippedRow.rows[0]?.count ?? 0)
      const rows = await sql<Record<string, unknown>>`
        SELECT d.employee_id,
               COALESCE(sum(d.normal_hours),0)/${sql.raw(FULL_DAY_HOURS_SQL)}
                 + COALESCE(sum(d.bonus_workday),0) AS workdays,
               count(*)::bigint AS attendance_days,
               count(*) FILTER (WHERE d.status='missing')::bigint AS missing_days,
               COALESCE(sum(d.overtime_hours),0) AS overtime_hours,
               COALESCE(e.daily_wage,0) AS daily_wage,
               COALESCE(e.monthly_allowance,0) AS allowance
          FROM hr_attendance_day d
          JOIN hr_employees e ON e.id = d.employee_id
         WHERE d.date >= ${first}::date AND d.date < ${next}::date
           AND NOT EXISTS(
             SELECT 1 FROM hr_payroll p
              WHERE p.employee_id = d.employee_id AND p.month = ${month}
           )
         GROUP BY d.employee_id, e.daily_wage, e.monthly_allowance
         ORDER BY d.employee_id
      `.execute(trx)
      let created = 0
      for (const r of rows.rows) {
        const normalized = normalizePayrollInput({
          employeeId: String(r.employee_id),
          month,
          workdays: numStr(r.workdays),
          attendanceDays: Number(r.attendance_days),
          missingDays: Number(r.missing_days),
          overtimeHours: numStr(r.overtime_hours),
          dailyWage: numStr(r.daily_wage),
          allowance: numStr(r.allowance),
        })
        const item = await insertPayroll(trx, normalized)
        await writeAudit(trx, actor, {
          resource: 'hr_payroll',
          recordId: item.id,
          recordLabel: item.month,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(payrollSnap(item), PAYROLL_AUDIT),
        })
        created++
      }
      return { created, skipped }
    })
  }

  async function payrollMonthStats(month: string): Promise<{
    count: number
    pendingCount: number
    payableTotal: string
    paidTotal: string
  }> {
    parseMonth(month)
    const row = await sql<Record<string, unknown>>`
      SELECT count(*)::bigint AS count,
             count(*) FILTER (WHERE p.status='pending')::bigint AS pending_count,
             COALESCE(sum(p.payable),0) AS payable_total,
             COALESCE((
               SELECT sum(payment.amount)
                 FROM hr_payroll_payment payment
                 JOIN hr_payroll linked ON linked.id = payment.payroll_id
                WHERE linked.month = ${month}
             ),0) AS paid_total
        FROM hr_payroll p WHERE p.month = ${month}
    `.execute(db)
    const r = row.rows[0]!
    return {
      count: Number(r.count),
      pendingCount: Number(r.pending_count),
      payableTotal: numStr(r.payable_total),
      paidTotal: numStr(r.paid_total),
    }
  }

  // ── payments ───────────────────────────────────────────────────────────

  async function listPayments(query: Partial<ListQuery>) {
    return listFromSource({
      db,
      resource: payrollPaymentResourceMeta(),
      source: sql` FROM hr_payroll_payment`,
      select: sql`SELECT id, month, paid_on, amount, kind, remarks, inserted_at, updated_at,
        payroll_id, employee_id, created_by_id`,
      defaultOrder: sql`"paid_on" DESC, "id" ASC`,
      query,
      mapRow: mapPaymentRow,
    })
  }

  async function getPayment(handle: DbHandle, id: string): Promise<PayrollPayment> {
    const row = await sql<Record<string, unknown>>`
      SELECT id, month, paid_on, amount, kind, remarks, inserted_at, updated_at,
        payroll_id, employee_id, created_by_id
        FROM hr_payroll_payment WHERE id = ${id}::uuid
    `.execute(handle)
    const r = row.rows[0]
    if (!r) throw new ApiError('not_found', '工资发放记录不存在')
    return mapPaymentRow(r)
  }

  async function createPayment(
    actor: Actor,
    input: { payrollId: string; paidOn: string; amount: string; remarks?: string | null },
  ): Promise<PayrollPayment> {
    requirePermission(actor, 'hr.payroll_payment:create')
    const amount = parseDecimal(input.amount, 'amount', false, true)
    const paidOn = parseDate(input.paidOn, 'paidOn')
    return withTx(db, async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.payrollId}, 0))`.execute(trx)
      const payroll = await lockPayroll(trx, input.payrollId)
      return createPaymentInTx(trx, actor, payroll, paidOn, amount, input.remarks ?? null)
    })
  }

  async function payRemaining(
    actor: Actor,
    input: { payrollId: string; paidOn: string; remarks?: string | null },
  ): Promise<PayrollPayment> {
    requirePermission(actor, 'hr.payroll_payment:create')
    const paidOn = parseDate(input.paidOn, 'paidOn')
    return withTx(db, async (trx) => {
      // 事务级 advisory lock：串行化同工资单发放，避免并发 payRemaining 双成功
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.payrollId}, 0))`.execute(trx)
      const payroll = await lockPayroll(trx, input.payrollId)
      const paidRow = await sql<{ paid: string | null }>`
        SELECT COALESCE(sum(amount),0)::text AS paid
          FROM hr_payroll_payment WHERE payroll_id = ${payroll.id}::uuid
      `.execute(trx)
      const paid = decimal(paidRow.rows[0]?.paid ?? '0')
      const remaining = decimal(payroll.payable).sub(paid)
      if (!remaining.gt(0)) {
        throw new ApiError('conflict', '该工资单已无未发差额')
      }
      return createPaymentInTx(trx, actor, payroll, paidOn, remaining, input.remarks ?? null)
    })
  }

  async function createPaymentInTx(
    trx: DbHandle,
    actor: Actor,
    payroll: Payroll,
    paidOn: Date,
    amount: ReturnType<typeof decimal>,
    remarks: string | null,
  ): Promise<PayrollPayment> {
    // 读员工借款台账 → 纯核决策 kind / 联动 effects；落库归本 adapter
    const loanRows = await sql<{ kind: string; amount: string }>`
      SELECT kind, amount::text AS amount FROM hr_employee_loan
       WHERE employee_id = ${payroll.employeeId}::uuid
    `.execute(trx)
    let plan: ReturnType<typeof applyPayment>
    try {
      plan = applyPayment(
        {
          id: payroll.id,
          employeeId: payroll.employeeId,
          status: payroll.status,
          loanDeduction: payroll.loanDeduction,
        },
        loanRows.rows,
      )
    } catch (err) {
      if (err instanceof Error && err.message === '借款抵扣超过员工借款余额') {
        throw new ApiError('conflict', err.message)
      }
      throw err
    }
    const kind = plan.kind
    let id: string
    try {
      const inserted = await trx
        .insertInto('hr_payroll_payment')
        .values({
          month: payroll.month,
          paid_on: asDateOnly(paidOn),
          amount: toDecimalString(amount),
          kind,
          remarks,
          payroll_id: payroll.id,
          employee_id: payroll.employeeId,
          created_by_id: actor.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      id = inserted.id
    } catch (err) {
      throw writeErr(err, '创建工资发放失败')
    }
    const value = await getPayment(trx, id)
    await writeAudit(trx, actor, {
      resource: 'hr_payroll_payment',
      recordId: id,
      recordLabel: payroll.month,
      actionType: 'create',
      actionName: 'create',
      changes: auditCreated(paymentSnap(value), PAYMENT_AUDIT),
    })
    for (const effect of plan.effects) {
      if (effect.op === 'set_payroll_status' && effect.status === PAYROLL_PAID) {
        try {
          await trx
            .updateTable('hr_payroll')
            .set({ status: PAYROLL_PAID, updated_at: sql`(now() AT TIME ZONE 'utc')` })
            .where('id', '=', payroll.id)
            .execute()
        } catch (err) {
          throw writeErr(err, '更新工资单状态失败')
        }
        await writeAudit(trx, actor, {
          resource: 'hr_payroll',
          recordId: payroll.id,
          recordLabel: payroll.month,
          actionType: 'update',
          actionName: 'mark_paid',
          changes: { status: { from: PAYROLL_PENDING, to: PAYROLL_PAID } },
        })
      } else if (effect.op === 'create_auto_repay') {
        try {
          const loanIns = await trx
            .insertInto('hr_employee_loan')
            .values({
              kind: LOAN_REPAY,
              occurred_on: asDateOnly(paidOn),
              amount: effect.amount,
              employee_id: payroll.employeeId,
              payroll_id: payroll.id,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
          const loan = await getLoan(trx, loanIns.id)
          await writeAudit(trx, actor, {
            resource: 'hr_employee_loan',
            recordId: loan.id,
            recordLabel: loan.occurredOn,
            actionType: 'create',
            actionName: 'auto_repay',
            changes: auditCreated(loanSnap(loan), LOAN_AUDIT),
          })
        } catch (err) {
          throw writeErr(err, '写入自动借款归还失败')
        }
      }
    }
    return value
  }

  async function deletePayment(actor: Actor, id: string): Promise<void> {
    requirePermission(actor, 'hr.payroll_payment:delete')
    await withTx(db, async (trx) => {
      const payRow = await sql<{ payroll_id: string }>`
        SELECT payroll_id FROM hr_payroll_payment WHERE id = ${id}::uuid
      `.execute(trx)
      if (!payRow.rows[0]) throw new ApiError('not_found', '工资发放记录不存在')
      const payroll = await lockPayroll(trx, payRow.rows[0].payroll_id)
      const value = await getPayment(trx, id)
      try {
        await trx.deleteFrom('hr_payroll_payment').where('id', '=', id).execute()
      } catch (err) {
        throw writeErr(err, '删除工资发放失败')
      }
      const remaining = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM hr_payroll_payment
         WHERE payroll_id = ${payroll.id}::uuid
      `.execute(trx)
      const remainingCount = Number(remaining.rows[0]?.count ?? 0)
      const effects = reversePayment(value.kind ?? '', payroll.status, remainingCount)
      for (const effect of effects) {
        if (effect.op === 'set_payroll_status' && effect.status === PAYROLL_PENDING) {
          try {
            await trx
              .updateTable('hr_payroll')
              .set({ status: PAYROLL_PENDING, updated_at: sql`(now() AT TIME ZONE 'utc')` })
              .where('id', '=', payroll.id)
              .execute()
          } catch (err) {
            throw writeErr(err, '回退工资单状态失败')
          }
          await writeAudit(trx, actor, {
            resource: 'hr_payroll',
            recordId: payroll.id,
            recordLabel: payroll.month,
            actionType: 'update',
            actionName: 'mark_pending',
            changes: { status: { from: PAYROLL_PAID, to: PAYROLL_PENDING } },
          })
        } else if (effect.op === 'destroy_linked_loans') {
          const loans = await sql<Record<string, unknown>>`
            SELECT id, kind, occurred_on, amount, remarks, inserted_at, updated_at,
              employee_id, payroll_id, created_by_id
              FROM hr_employee_loan WHERE payroll_id = ${payroll.id}::uuid FOR UPDATE
          `.execute(trx)
          for (const raw of loans.rows) {
            const loan = mapLoanRow(raw)
            try {
              await trx.deleteFrom('hr_employee_loan').where('id', '=', loan.id).execute()
            } catch (err) {
              throw writeErr(err, '删除自动借款归还失败')
            }
            await writeAudit(trx, actor, {
              resource: 'hr_employee_loan',
              recordId: loan.id,
              recordLabel: loan.occurredOn,
              actionType: 'destroy',
              actionName: 'auto_destroy',
              changes: auditDestroyed(loanSnap(loan), LOAN_AUDIT),
            })
          }
        }
      }
      await writeAudit(trx, actor, {
        resource: 'hr_payroll_payment',
        recordId: id,
        recordLabel: payroll.month,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(paymentSnap(value), PAYMENT_AUDIT),
      })
    })
  }

  // ── loans ──────────────────────────────────────────────────────────────

  async function listLoans(query: Partial<ListQuery>) {
    return listFromSource({
      db,
      resource: employeeLoanResourceMeta(),
      source: sql` FROM hr_employee_loan`,
      select: sql`SELECT id, kind, occurred_on, amount, remarks, inserted_at, updated_at,
        employee_id, payroll_id, created_by_id`,
      defaultOrder: sql`"occurred_on" DESC, "id" ASC`,
      query,
      mapRow: mapLoanRow,
    })
  }

  async function getLoan(handle: DbHandle, id: string): Promise<EmployeeLoan> {
    const row = await sql<Record<string, unknown>>`
      SELECT id, kind, occurred_on, amount, remarks, inserted_at, updated_at,
        employee_id, payroll_id, created_by_id
        FROM hr_employee_loan WHERE id = ${id}::uuid
    `.execute(handle)
    const r = row.rows[0]
    if (!r) throw new ApiError('not_found', '员工借款记录不存在')
    return mapLoanRow(r)
  }

  async function createLoan(
    actor: Actor,
    input: {
      employeeId: string
      kind: string
      occurredOn: string
      amount: string
      remarks?: string | null
    },
  ): Promise<EmployeeLoan> {
    requirePermission(actor, 'hr.employee_loan:create')
    const { kind, occurredOn, amount } = normalizeLoanInput(
      input.kind,
      input.occurredOn,
      input.amount,
    )
    return withTx(db, async (trx) => {
      try {
        const inserted = await trx
          .insertInto('hr_employee_loan')
          .values({
            kind,
            occurred_on: asDateOnly(occurredOn),
            amount: toDecimalString(amount),
            remarks: input.remarks ?? null,
            employee_id: input.employeeId,
            created_by_id: actor.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        const item = await getLoan(trx, inserted.id)
        await writeAudit(trx, actor, {
          resource: 'hr_employee_loan',
          recordId: item.id,
          recordLabel: item.occurredOn,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(loanSnap(item), LOAN_AUDIT),
        })
        return item
      } catch (err) {
        throw writeErr(err, '创建员工借款失败')
      }
    })
  }

  async function updateLoan(
    actor: Actor,
    id: string,
    input: {
      employeeId?: string
      kind?: string
      occurredOn?: string
      amount?: string
      remarks?: string | null
      remarksPresent?: boolean
    },
  ): Promise<EmployeeLoan> {
    requirePermission(actor, 'hr.employee_loan:update')
    return withTx(db, async (trx) => {
      const before = await getLoan(trx, id)
      if (before.payrollId) {
        throw new ApiError(
          'conflict',
          '工资发放联动生成的归还记录不可修改或删除,请从发放记录侧处理',
        )
      }
      const { kind, occurredOn, amount } = normalizeLoanInput(
        input.kind ?? before.kind,
        input.occurredOn ?? before.occurredOn,
        input.amount ?? before.amount,
      )
      const employeeId = input.employeeId ?? before.employeeId
      const remarks = input.remarksPresent ? (input.remarks ?? null) : before.remarks
      try {
        await trx
          .updateTable('hr_employee_loan')
          .set({
            kind,
            occurred_on: asDateOnly(occurredOn),
            amount: toDecimalString(amount),
            remarks,
            employee_id: employeeId,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .execute()
      } catch (err) {
        throw writeErr(err, '更新员工借款失败')
      }
      const item = await getLoan(trx, id)
      const changes = auditDiff(loanSnap(before), loanSnap(item), LOAN_AUDIT)
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, actor, {
          resource: 'hr_employee_loan',
          recordId: id,
          recordLabel: item.occurredOn,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
      }
      return item
    })
  }

  async function deleteLoan(actor: Actor, id: string): Promise<void> {
    requirePermission(actor, 'hr.employee_loan:delete')
    await withTx(db, async (trx) => {
      const before = await getLoan(trx, id)
      if (before.payrollId) {
        throw new ApiError(
          'conflict',
          '工资发放联动生成的归还记录不可修改或删除,请从发放记录侧处理',
        )
      }
      try {
        await trx.deleteFrom('hr_employee_loan').where('id', '=', id).execute()
      } catch (err) {
        throw writeErr(err, '删除员工借款失败')
      }
      await writeAudit(trx, actor, {
        resource: 'hr_employee_loan',
        recordId: id,
        recordLabel: before.occurredOn,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(loanSnap(before), LOAN_AUDIT),
      })
    })
  }

  async function loanBalances(): Promise<EmployeeLoanBalance[]> {
    const rows = await sql<Record<string, unknown>>`
      SELECT l.employee_id, e.code, e.name,
             COALESCE(sum(l.amount) FILTER (WHERE l.kind='borrow'),0) AS borrowed,
             COALESCE(sum(l.amount) FILTER (WHERE l.kind='repay'),0) AS repaid
        FROM hr_employee_loan l
        JOIN hr_employees e ON e.id = l.employee_id
       GROUP BY l.employee_id, e.code, e.name
       ORDER BY e.code, e.name
    `.execute(db)
    return rows.rows.map((r) => {
      const borrowed = numStr(r.borrowed)
      const repaid = numStr(r.repaid)
      return {
        employeeId: String(r.employee_id),
        employeeCode: String(r.code),
        employeeName: String(r.name),
        borrowed,
        repaid,
        balance: toDecimalString(decimal(borrowed).sub(decimal(repaid))),
      }
    })
  }

  // ── internal helpers ───────────────────────────────────────────────────

  async function insertPayroll(
    trx: DbHandle,
    n: ReturnType<typeof normalizePayrollInput>,
  ): Promise<Payroll> {
    try {
      const inserted = await trx
        .insertInto('hr_payroll')
        .values({
          month: n.month,
          workdays: n.workdays,
          attendance_days: String(n.attendanceDays),
          missing_days: String(n.missingDays),
          overtime_hours: n.overtimeHours,
          daily_wage: n.dailyWage,
          base_amount: n.baseAmount,
          allowance: n.allowance,
          bonus: n.bonus,
          fine: n.fine,
          loan_deduction: n.loanDeduction,
          payable: n.payable,
          remarks: n.remarks,
          employee_id: n.employeeId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return getPayroll(trx, inserted.id)
    } catch (err) {
      throw writeErr(err, '创建工资单失败')
    }
  }

  async function lockPayroll(trx: DbHandle, id: string): Promise<Payroll> {
    const row = await sql<Record<string, unknown>>`
      SELECT p.id, p.month, p.workdays, p.attendance_days, p.missing_days,
        p.overtime_hours, p.daily_wage, p.base_amount, p.allowance, p.bonus, p.fine,
        p.loan_deduction, p.payable, p.status, p.remarks, p.inserted_at, p.updated_at,
        p.employee_id,
        (SELECT sum(payment.amount) FROM hr_payroll_payment payment
          WHERE payment.payroll_id = p.id) AS paid_total
        FROM hr_payroll p WHERE p.id = ${id}::uuid FOR UPDATE
    `.execute(trx)
    const r = row.rows[0]
    if (!r) throw new ApiError('not_found', '工资单不存在')
    return mapPayrollRow(r)
  }

  async function payrollSnapshotForEmployee(
    trx: DbHandle,
    month: string,
    employeeId: string,
  ): Promise<{
    workdays: string
    attendanceDays: number
    missingDays: number
    overtimeHours: string
    dailyWage: string
    allowance: string
  }> {
    const first = parseMonth(month)
    const next = addMonth(first)
    const row = await sql<Record<string, unknown>>`
      SELECT COALESCE(sum(d.normal_hours),0)/${sql.raw(FULL_DAY_HOURS_SQL)}
               + COALESCE(sum(d.bonus_workday),0) AS workdays,
             count(d.id)::bigint AS attendance_days,
             count(d.id) FILTER (WHERE d.status='missing')::bigint AS missing_days,
             COALESCE(sum(d.overtime_hours),0) AS overtime_hours,
             COALESCE(e.daily_wage,0) AS daily_wage,
             COALESCE(e.monthly_allowance,0) AS allowance
        FROM hr_employees e
        LEFT JOIN hr_attendance_day d
          ON d.employee_id = e.id AND d.date >= ${first}::date AND d.date < ${next}::date
       WHERE e.id = ${employeeId}::uuid
       GROUP BY e.id, e.daily_wage, e.monthly_allowance
    `.execute(trx)
    const r = row.rows[0]
    if (!r) throw new ApiError('conflict', '工资单员工不存在')
    return {
      workdays: numStr(r.workdays),
      attendanceDays: Number(r.attendance_days),
      missingDays: Number(r.missing_days),
      overtimeHours: numStr(r.overtime_hours),
      dailyWage: numStr(r.daily_wage),
      allowance: numStr(r.allowance),
    }
  }


  return {
    listPayrolls,
    getPayroll: (id: string) => getPayroll(db, id),
    createPayroll,
    updatePayroll,
    refreshPayroll,
    deletePayroll,
    generatePayrolls,
    payrollMonthStats,
    listPayments,
    getPayment: (id: string) => getPayment(db, id),
    createPayment,
    payRemaining,
    deletePayment,
    listLoans,
    getLoan: (id: string) => getLoan(db, id),
    createLoan,
    updateLoan,
    deleteLoan,
    loanBalances,
  }
}

export type PayrollService = ReturnType<typeof createPayrollService>

function normalizePayrollInput(input: PayrollInput) {
  if (!input.employeeId) {
    throw ApiError.validation('工资单参数不合法', { employeeId: ['不能为空'] })
  }
  parseMonth(input.month)
  const attendanceDays = input.attendanceDays ?? 0
  const missingDays = input.missingDays ?? 0
  if (attendanceDays < 0 || missingDays < 0) {
    throw ApiError.validation('工资单参数不合法', {
      attendanceDays: ['不能为负数'],
      missingDays: ['不能为负数'],
    })
  }
  const fields = [
    { key: 'workdays', value: input.workdays ?? '0' },
    { key: 'overtimeHours', value: input.overtimeHours ?? '0' },
    { key: 'dailyWage', value: input.dailyWage ?? '0' },
    { key: 'allowance', value: input.allowance ?? '0' },
    { key: 'bonus', value: input.bonus ?? '0' },
    { key: 'fine', value: input.fine ?? '0' },
    { key: 'loanDeduction', value: input.loanDeduction ?? '0' },
  ] as const
  const parsed = fields.map((f) => {
    const raw = f.value === '' ? '0' : f.value
    return parseDecimal(raw, f.key, true, false)
  })
  const workdays = parsed[0]!
  const overtimeHours = parsed[1]!
  const dailyWage = parsed[2]!
  const allowance = parsed[3]!
  const bonus = parsed[4]!
  const fine = parsed[5]!
  const loanDeduction = parsed[6]!
  const baseAmount = decimal(roundAmount(workdays.mul(dailyWage)))
  const payable = baseAmount.add(allowance).add(bonus).sub(fine).sub(loanDeduction)
  return {
    employeeId: input.employeeId,
    month: input.month,
    workdays: toDecimalString(workdays),
    attendanceDays,
    missingDays,
    overtimeHours: toDecimalString(overtimeHours),
    dailyWage: toDecimalString(dailyWage),
    baseAmount: toDecimalString(baseAmount),
    allowance: toDecimalString(allowance),
    bonus: toDecimalString(bonus),
    fine: toDecimalString(fine),
    loanDeduction: toDecimalString(loanDeduction),
    payable: toDecimalString(payable),
    remarks: input.remarks ?? null,
  }
}

function normalizeLoanInput(kindRaw: string, occurredOn: string, amountRaw: string) {
  const kind = lowerWire(kindRaw)
  if (kind !== LOAN_BORROW && kind !== LOAN_REPAY) {
    throw ApiError.validation('员工借款参数不合法', { kind: ['必须是 BORROW 或 REPAY'] })
  }
  const date = parseDate(occurredOn, 'occurredOn')
  const amount = parseDecimal(amountRaw, 'amount', false, false)
  if (!amount.gt(0)) {
    throw ApiError.validation('员工借款参数不合法', { amount: ['必须大于零'] })
  }
  return { kind, occurredOn: date, amount }
}

function mapPayrollRow(r: Record<string, unknown>): Payroll {
  return {
    id: String(r.id),
    month: String(r.month),
    workdays: numStr(r.workdays),
    attendanceDays: Number(r.attendance_days),
    missingDays: Number(r.missing_days),
    overtimeHours: numStr(r.overtime_hours),
    dailyWage: numStr(r.daily_wage),
    baseAmount: numStr(r.base_amount),
    allowance: numStr(r.allowance),
    bonus: numStr(r.bonus),
    fine: numStr(r.fine),
    loanDeduction: numStr(r.loan_deduction),
    payable: numStr(r.payable),
    status: upperWire(String(r.status)),
    remarks: r.remarks == null ? null : String(r.remarks),
    insertedAt: asDate(r.inserted_at as Date | string),
    updatedAt: asDate(r.updated_at as Date | string),
    employeeId: String(r.employee_id),
    paidTotal: nullableNumStr(r.paid_total),
  }
}

function mapPaymentRow(r: Record<string, unknown>): PayrollPayment {
  return {
    id: String(r.id),
    month: r.month == null ? null : String(r.month),
    paidOn: asDateOnly(r.paid_on as Date | string),
    amount: numStr(r.amount),
    kind: r.kind == null ? null : upperWire(String(r.kind)),
    remarks: r.remarks == null ? null : String(r.remarks),
    insertedAt: asDate(r.inserted_at as Date | string),
    updatedAt: asDate(r.updated_at as Date | string),
    payrollId: String(r.payroll_id),
    employeeId: r.employee_id == null ? null : String(r.employee_id),
    createdById: r.created_by_id == null ? null : String(r.created_by_id),
  }
}

function mapLoanRow(r: Record<string, unknown>): EmployeeLoan {
  return {
    id: String(r.id),
    kind: upperWire(String(r.kind)),
    occurredOn: asDateOnly(r.occurred_on as Date | string),
    amount: numStr(r.amount),
    remarks: r.remarks == null ? null : String(r.remarks),
    insertedAt: asDate(r.inserted_at as Date | string),
    updatedAt: asDate(r.updated_at as Date | string),
    employeeId: String(r.employee_id),
    payrollId: r.payroll_id == null ? null : String(r.payroll_id),
    createdById: r.created_by_id == null ? null : String(r.created_by_id),
  }
}

function payrollSnap(v: Payroll): Record<string, unknown> {
  return {
    month: v.month,
    workdays: v.workdays,
    attendance_days: v.attendanceDays,
    missing_days: v.missingDays,
    overtime_hours: v.overtimeHours,
    daily_wage: v.dailyWage,
    base_amount: v.baseAmount,
    allowance: v.allowance,
    bonus: v.bonus,
    fine: v.fine,
    loan_deduction: v.loanDeduction,
    payable: v.payable,
    status: lowerWire(v.status),
    remarks: v.remarks,
    employee_id: v.employeeId,
  }
}

function paymentSnap(v: PayrollPayment): Record<string, unknown> {
  return {
    month: v.month,
    paid_on: v.paidOn,
    amount: v.amount,
    kind: v.kind == null ? null : lowerWire(v.kind),
    remarks: v.remarks,
    payroll_id: v.payrollId,
    employee_id: v.employeeId,
    created_by_id: v.createdById,
  }
}

function loanSnap(v: EmployeeLoan): Record<string, unknown> {
  return {
    kind: lowerWire(v.kind),
    occurred_on: v.occurredOn,
    amount: v.amount,
    remarks: v.remarks,
    employee_id: v.employeeId,
    payroll_id: v.payrollId,
    created_by_id: v.createdById,
  }
}
