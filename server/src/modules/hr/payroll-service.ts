/**
 * 工资：工资单 / 发放 / 员工借款。
 *
 * 基础 CRUD 走标准动作内核（meta 声明 + 钩子派生），领域动作按动作弹射保留手写：
 * - 工资单：内核 list/get/create/update/remove。应发链是服务端派生列
 *   （base_amount/payable 恒 readonly，wire 不可写）：validate 算进 draft、
 *   create 经 insertColumns 随 INSERT 落库、update 经 afterWrite 同事务补齐。
 *   「仅待发放可修改或删除」由 workflow.mutableStatuses 表达（无转移端点）。
 * - 工资发放：只用内核 list/get；create/delete 是领域动作（锁内核算 + 借款联动），弹射。
 * - 员工借款：全套内核；created_by_id 经 insertColumns 盖章（不声明 owner 绑定，
 *   矩阵不得授出行级范围）；发放联动生成的归还记录由 validate/beforeDelete 挡改删。
 *
 * 弹射清单：按月生成、月度统计、重取考勤快照、创建/删除发放、一键发差额、借款余额。
 * 发放一键化的锁内核算顺序（advisory lock → 锁工资单 → 读借款台账 → 纯核决策）保持不变。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit。
 * 三张表都**无 company_id**（全局 HR 数据），故 meta 声明 `global`——
 * 行级过滤恒放行，`listAuthorized`/`loadAuthorized` 承担码级判定与统一 404。
 */
import {
  decimal,
  isDecimalString,
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
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import type { Actor, Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { loadAuthorized } from '~/db/load.ts'
import { mapRow, snapshot } from '~/platform/standard/fields.ts'
import { createStandardService } from '~/platform/standard/service.ts'
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
  PAYROLL_PAID,
  PAYROLL_PENDING,
  reversePayment,
  upperWire,
} from './rules.ts'
import {
  asDateOnly,
  numStr,
  nullableNumStr,
  parseDate,
  parseMonth,
  addMonth,
  parseDecimal,
  writeErr,
} from './helpers.ts'

export const PAYROLL_RESOURCE = 'hrPayrolls'
export const PAYROLL_PAYMENT_RESOURCE = 'hrPayrollPayments'
export const EMPLOYEE_LOAN_RESOURCE = 'hrEmployeeLoans'

const PAYROLL_TABLE = 'hr_payroll'
const PAYMENT_TABLE = 'hr_payroll_payment'
const LOAN_TABLE = 'hr_employee_loan'
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

/** 内核 item 约束（StandardItem 需要索引签名）；对外仍是 types.ts 的领域类型 */
type PayrollRow = Payroll & { [key: string]: unknown }
type PaymentRow = PayrollPayment & { [key: string]: unknown }
type LoanRow = EmployeeLoan & { [key: string]: unknown }

/** PATCH 载荷（present-key 语义：出现即写，缺省不动） */
export interface PayrollPatch {
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
}

export interface EmployeeLoanInput {
  employeeId: string
  kind: string
  occurredOn: string
  amount: string
  remarks?: string | null
}

export interface EmployeeLoanPatch {
  employeeId?: string
  kind?: string
  occurredOn?: string
  amount?: string
  remarks?: string | null
}

const PAYROLL_META = payrollResourceMeta()
const PAYMENT_META = payrollPaymentResourceMeta()
const LOAN_META = employeeLoanResourceMeta()

const PAYROLL_AUDIT = auditFieldsOf(PAYROLL_META)
const PAYMENT_AUDIT = auditFieldsOf(PAYMENT_META)
const LOAN_AUDIT = auditFieldsOf(LOAN_META)

/** 唯一/外键冲突文案（与迁移前 helpers.writeErr 的 GENERIC_WRITE 逐字同口径） */
const WRITE_ERRORS = [
  { code: '23505', message: '记录违反唯一约束' },
  { code: '23503', message: '记录已被引用或引用对象不存在' },
] as const

const PAYROLL_NOT_FOUND = '工资单不存在'
const PAYMENT_NOT_FOUND = '工资发放记录不存在'
const LOAN_NOT_FOUND = '员工借款记录不存在'
const PAYROLL_LOCKED = '仅待发放工资单可修改或删除,差错请走补发'
const LOAN_LINKED = '工资发放联动生成的归还记录不可修改或删除,请从发放记录侧处理'

/** 手填十进制字段：非负校验顺序 = 应发链输入顺序（与迁移前逐字一致） */
const PAYROLL_DECIMALS = [
  'workdays',
  'overtimeHours',
  'dailyWage',
  'allowance',
  'bonus',
  'fine',
  'loanDeduction',
] as const

export interface PayrollServiceDeps {
  db: Kysely<Database>
  /** 判定归宿解析（三个执行点共用） */
  registry: Registry
}

export function createPayrollService(deps: PayrollServiceDeps) {
  const { db, registry } = deps
  const payrollTarget = registry.authzTarget(PAYROLL_RESOURCE)
  const paymentTarget = registry.authzTarget(PAYROLL_PAYMENT_RESOURCE)

  // ── payrolls ───────────────────────────────────────────────────────────

  const payrollBase = createStandardService<PayrollRow>({
    db,
    registry,
    resource: PAYROLL_RESOURCE,
    notFound: PAYROLL_NOT_FOUND,
    defaultOrder: sql`"month" DESC, "id" ASC`,
    writeErrors: [...WRITE_ERRORS],
    // 实发合计投影（别名 p 与迁移前逐字一致）
    projection: {
      source: sql` FROM hr_payroll p`,
      alias: 'p',
      selectExtra: sql`(SELECT sum(payment.amount) FROM hr_payroll_payment payment
        WHERE payment.payroll_id = p.id) AS paid_total`,
      mapExtra: (row) => ({ paidTotal: nullableNumStr(row.paid_total) }),
    },
    workflow: {
      mutableStatuses: [upperWire(PAYROLL_PENDING)],
      mutableMessage: PAYROLL_LOCKED,
      // 状态翻转是发放/删除发放的联动效果，无独立转移端点
      transitions: [],
    },
    hooks: {
      validate: ({ action, draft }) => {
        if (action === 'create' && !draft.employeeId) {
          throw ApiError.validation('工资单参数不合法', { employeeId: ['不能为空'] })
        }
        parseMonth(String(draft.month ?? ''))
        const attendanceDays = Number(draft.attendanceDays ?? 0)
        const missingDays = Number(draft.missingDays ?? 0)
        if (attendanceDays < 0 || missingDays < 0) {
          throw ApiError.validation('工资单参数不合法', {
            attendanceDays: ['不能为负数'],
            missingDays: ['不能为负数'],
          })
        }
        const derived = derivePayrollAmounts(draft)
        // 派生列 readonly：写进 draft 只为审计 diff 与 insertColumns 取用
        draft.baseAmount = derived.baseAmount
        draft.payable = derived.payable
      },
      insertColumns: ({ draft }) => ({
        base_amount: draft.baseAmount,
        payable: draft.payable,
      }),
      afterWrite: async (trx, { action, item }) => {
        if (action !== 'update') return
        // 内核 UPDATE 只写 wire 可写列；派生金额列在同事务补齐（reload 在其后）
        const derived = derivePayrollAmounts(item)
        await sql`
          UPDATE hr_payroll
             SET base_amount = ${derived.baseAmount}, payable = ${derived.payable}
           WHERE id = ${String(item.id)}::uuid
        `.execute(trx)
      },
    },
  })

  /** 锁工资单（授权 + 行锁）；不命中一律 not_found。投影列不参与写决策，故取裸行 */
  async function lockPayroll(
    handle: DbHandle,
    permit: Permit,
    id: string,
  ): Promise<Record<string, unknown>> {
    const row = await loadAuthorized({
      db: handle,
      permit,
      target: payrollTarget,
      table: PAYROLL_TABLE,
      id,
      forUpdate: true,
      notFoundMessage: PAYROLL_NOT_FOUND,
    })
    return mapRow(PAYROLL_META, row)
  }

  /** 裸工资单行补上实发合计投影列（写路径返回值与内核投影同形） */
  async function withPaidTotal(
    handle: DbHandle,
    item: Record<string, unknown>,
  ): Promise<PayrollRow> {
    const result = await sql<{ paid_total: string | null }>`
      SELECT sum(amount) AS paid_total FROM hr_payroll_payment
       WHERE payroll_id = ${String(item.id)}::uuid
    `.execute(handle)
    return {
      ...item,
      paidTotal: nullableNumStr(result.rows[0]?.paid_total),
    } as unknown as PayrollRow
  }

  /**
   * 重取考勤快照（弹射）：非标准词表动作，守卫文案与审计 actionName 均自成一格。
   */
  async function refreshPayroll(permit: Permit, id: string): Promise<PayrollRow> {
    const actor = permit.actor
    return withTx(db, async (trx) => {
      const before = await lockPayroll(trx, permit, id)
      if (before.status !== upperWire(PAYROLL_PENDING)) {
        throw new ApiError('conflict', '仅待发放工资单可重取快照')
      }
      const snap = await payrollSnapshotForEmployee(
        trx,
        String(before.month),
        String(before.employeeId),
      )
      const derived = derivePayrollAmounts({ ...before, ...snap })
      let item: Record<string, unknown>
      try {
        const row = await trx
          .updateTable('hr_payroll')
          .set({
            workdays: snap.workdays,
            attendance_days: String(snap.attendanceDays),
            missing_days: String(snap.missingDays),
            overtime_hours: snap.overtimeHours,
            daily_wage: snap.dailyWage,
            base_amount: derived.baseAmount,
            allowance: snap.allowance,
            payable: derived.payable,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        item = mapRow(PAYROLL_META, row)
      } catch (err) {
        throw writeErr(err, '重取工资单快照失败')
      }
      const changes = auditDiff(
        snapshot(PAYROLL_META, before, PAYROLL_AUDIT),
        snapshot(PAYROLL_META, item, PAYROLL_AUDIT),
        PAYROLL_AUDIT,
      )
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, actor, {
          resource: PAYROLL_TABLE,
          recordId: id,
          recordLabel: String(item.month),
          actionType: 'update',
          actionName: 'refresh',
          changes,
        })
      }
      return withPaidTotal(trx, item)
    })
  }

  /**
   * 按月生成（弹射）：单事务批量建单 + 逐张 create 审计，非标准词表动作。
   */
  async function generatePayrolls(
    permit: Permit,
    month: string,
  ): Promise<{ created: number; skipped: number }> {
    const actor = permit.actor
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
        const item = await insertPayroll(trx, {
          employeeId: String(r.employee_id),
          month,
          workdays: numStr(r.workdays),
          attendanceDays: Number(r.attendance_days),
          missingDays: Number(r.missing_days),
          overtimeHours: numStr(r.overtime_hours),
          dailyWage: numStr(r.daily_wage),
          allowance: numStr(r.allowance),
        })
        await writeAudit(trx, actor, {
          resource: PAYROLL_TABLE,
          recordId: String(item.id),
          recordLabel: String(item.month),
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(snapshot(PAYROLL_META, item, PAYROLL_AUDIT), PAYROLL_AUDIT),
        })
        created++
      }
      return { created, skipped }
    })
  }

  // 月度聚合：只做码级门控，不套行过滤（聚合投影无绑定列）
  async function payrollMonthStats(
    _permit: Permit,
    month: string,
  ): Promise<{
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

  // 只用内核 list/get：create/delete 是跨资源编排（借款台账 + 工资单状态），弹射手写
  const paymentBase = createStandardService<PaymentRow>({
    db,
    registry,
    resource: PAYROLL_PAYMENT_RESOURCE,
    notFound: PAYMENT_NOT_FOUND,
    defaultOrder: sql`"paid_on" DESC, "id" ASC`,
    writeErrors: [...WRITE_ERRORS],
  })

  async function createPayment(
    permit: Permit,
    input: { payrollId: string; paidOn: string; amount: string; remarks?: string | null },
  ): Promise<PaymentRow> {
    const actor = permit.actor
    const amount = parseDecimal(input.amount, 'amount', false, true)
    const paidOn = parseDate(input.paidOn, 'paidOn')
    return withTx(db, async (trx) => {
      // 锁内核算顺序：advisory lock → 锁工资单 → 借款台账 → 纯核决策（顺序不可动）
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.payrollId}, 0))`.execute(trx)
      const payroll = await lockPayroll(trx, permit, input.payrollId)
      return createPaymentInTx(trx, actor, payroll, paidOn, amount, input.remarks ?? null)
    })
  }

  async function payRemaining(
    permit: Permit,
    input: { payrollId: string; paidOn: string; remarks?: string | null },
  ): Promise<PaymentRow> {
    const actor = permit.actor
    const paidOn = parseDate(input.paidOn, 'paidOn')
    return withTx(db, async (trx) => {
      // 事务级 advisory lock：串行化同工资单发放，避免并发 payRemaining 双成功
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.payrollId}, 0))`.execute(trx)
      const payroll = await lockPayroll(trx, permit, input.payrollId)
      const paidRow = await sql<{ paid: string | null }>`
        SELECT COALESCE(sum(amount),0)::text AS paid
          FROM hr_payroll_payment WHERE payroll_id = ${String(payroll.id)}::uuid
      `.execute(trx)
      const paid = decimal(paidRow.rows[0]?.paid ?? '0')
      const remaining = decimal(String(payroll.payable)).sub(paid)
      if (!remaining.gt(0)) {
        throw new ApiError('conflict', '该工资单已无未发差额')
      }
      return createPaymentInTx(trx, actor, payroll, paidOn, remaining, input.remarks ?? null)
    })
  }

  async function createPaymentInTx(
    trx: DbHandle,
    actor: Actor,
    payroll: Record<string, unknown>,
    paidOn: Date,
    amount: ReturnType<typeof decimal>,
    remarks: string | null,
  ): Promise<PaymentRow> {
    // 读员工借款台账 → 纯核决策 kind / 联动 effects；落库归本 adapter
    const loanRows = await sql<{ kind: string; amount: string }>`
      SELECT kind, amount::text AS amount FROM hr_employee_loan
       WHERE employee_id = ${String(payroll.employeeId)}::uuid
    `.execute(trx)
    let plan: ReturnType<typeof applyPayment>
    try {
      plan = applyPayment(
        {
          id: String(payroll.id),
          employeeId: String(payroll.employeeId),
          status: String(payroll.status),
          loanDeduction: String(payroll.loanDeduction),
        },
        loanRows.rows,
      )
    } catch (err) {
      if (err instanceof Error && err.message === '借款抵扣超过员工借款余额') {
        throw new ApiError('conflict', err.message)
      }
      throw err
    }
    let value: PaymentRow
    try {
      const row = await trx
        .insertInto('hr_payroll_payment')
        .values({
          month: String(payroll.month),
          paid_on: asDateOnly(paidOn),
          amount: toDecimalString(amount),
          kind: plan.kind,
          remarks,
          payroll_id: String(payroll.id),
          employee_id: String(payroll.employeeId),
          created_by_id: actor.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      value = mapRow(PAYMENT_META, row) as unknown as PaymentRow
    } catch (err) {
      throw writeErr(err, '创建工资发放失败')
    }
    await writeAudit(trx, actor, {
      resource: PAYMENT_TABLE,
      recordId: value.id,
      recordLabel: String(payroll.month),
      actionType: 'create',
      actionName: 'create',
      changes: auditCreated(snapshot(PAYMENT_META, value, PAYMENT_AUDIT), PAYMENT_AUDIT),
    })
    for (const effect of plan.effects) {
      if (effect.op === 'set_payroll_status' && effect.status === PAYROLL_PAID) {
        try {
          await trx
            .updateTable('hr_payroll')
            .set({ status: PAYROLL_PAID, updated_at: sql`(now() AT TIME ZONE 'utc')` })
            .where('id', '=', String(payroll.id))
            .execute()
        } catch (err) {
          throw writeErr(err, '更新工资单状态失败')
        }
        await writeAudit(trx, actor, {
          resource: PAYROLL_TABLE,
          recordId: String(payroll.id),
          recordLabel: String(payroll.month),
          actionType: 'update',
          actionName: 'mark_paid',
          changes: { status: { from: PAYROLL_PENDING, to: PAYROLL_PAID } },
        })
      } else if (effect.op === 'create_auto_repay') {
        try {
          const row = await trx
            .insertInto('hr_employee_loan')
            .values({
              kind: LOAN_REPAY,
              occurred_on: asDateOnly(paidOn),
              amount: effect.amount,
              employee_id: String(payroll.employeeId),
              payroll_id: String(payroll.id),
            })
            .returningAll()
            .executeTakeFirstOrThrow()
          const loan = mapRow(LOAN_META, row)
          await writeAudit(trx, actor, {
            resource: LOAN_TABLE,
            recordId: String(loan.id),
            recordLabel: String(loan.occurredOn),
            actionType: 'create',
            actionName: 'auto_repay',
            changes: auditCreated(snapshot(LOAN_META, loan, LOAN_AUDIT), LOAN_AUDIT),
          })
        } catch (err) {
          throw writeErr(err, '写入自动借款归还失败')
        }
      }
    }
    return value
  }

  async function deletePayment(permit: Permit, id: string): Promise<void> {
    const actor = permit.actor
    await withTx(db, async (trx) => {
      // 加锁顺序：先定位发放归属，再锁工资单（母行先行）
      const payRow = await loadAuthorized({
        db: trx,
        permit,
        target: paymentTarget,
        table: PAYMENT_TABLE,
        id,
        notFoundMessage: PAYMENT_NOT_FOUND,
      })
      const payroll = await lockPayroll(trx, permit, String(payRow.payroll_id))
      const value = mapRow(PAYMENT_META, payRow)
      try {
        await trx.deleteFrom('hr_payroll_payment').where('id', '=', id).execute()
      } catch (err) {
        throw writeErr(err, '删除工资发放失败')
      }
      const remaining = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM hr_payroll_payment
         WHERE payroll_id = ${String(payroll.id)}::uuid
      `.execute(trx)
      const remainingCount = Number(remaining.rows[0]?.count ?? 0)
      const effects = reversePayment(
        value.kind == null ? '' : String(value.kind),
        String(payroll.status),
        remainingCount,
      )
      for (const effect of effects) {
        if (effect.op === 'set_payroll_status' && effect.status === PAYROLL_PENDING) {
          try {
            await trx
              .updateTable('hr_payroll')
              .set({ status: PAYROLL_PENDING, updated_at: sql`(now() AT TIME ZONE 'utc')` })
              .where('id', '=', String(payroll.id))
              .execute()
          } catch (err) {
            throw writeErr(err, '回退工资单状态失败')
          }
          await writeAudit(trx, actor, {
            resource: PAYROLL_TABLE,
            recordId: String(payroll.id),
            recordLabel: String(payroll.month),
            actionType: 'update',
            actionName: 'mark_pending',
            changes: { status: { from: PAYROLL_PAID, to: PAYROLL_PENDING } },
          })
        } else if (effect.op === 'destroy_linked_loans') {
          const loans = await sql<Record<string, unknown>>`
            SELECT id, kind, occurred_on, amount, remarks, inserted_at, updated_at,
              employee_id, payroll_id, created_by_id
              FROM hr_employee_loan WHERE payroll_id = ${String(payroll.id)}::uuid FOR UPDATE
          `.execute(trx)
          for (const raw of loans.rows) {
            const loan = mapRow(LOAN_META, raw)
            try {
              await trx.deleteFrom('hr_employee_loan').where('id', '=', String(loan.id)).execute()
            } catch (err) {
              throw writeErr(err, '删除自动借款归还失败')
            }
            await writeAudit(trx, actor, {
              resource: LOAN_TABLE,
              recordId: String(loan.id),
              recordLabel: String(loan.occurredOn),
              actionType: 'destroy',
              actionName: 'auto_destroy',
              changes: auditDestroyed(snapshot(LOAN_META, loan, LOAN_AUDIT), LOAN_AUDIT),
            })
          }
        }
      }
      await writeAudit(trx, actor, {
        resource: PAYMENT_TABLE,
        recordId: id,
        recordLabel: String(payroll.month),
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(snapshot(PAYMENT_META, value, PAYMENT_AUDIT), PAYMENT_AUDIT),
      })
    })
  }

  // ── loans ──────────────────────────────────────────────────────────────

  const loanBase = createStandardService<LoanRow>({
    db,
    registry,
    resource: EMPLOYEE_LOAN_RESOURCE,
    notFound: LOAN_NOT_FOUND,
    defaultOrder: sql`"occurred_on" DESC, "id" ASC`,
    writeErrors: [...WRITE_ERRORS],
    hooks: {
      validate: ({ action, draft, before }) => {
        if (action === 'update' && before?.payrollId) {
          throw new ApiError('conflict', LOAN_LINKED)
        }
        const kind = String(draft.kind ?? '')
        if (kind !== upperWire(LOAN_BORROW) && kind !== upperWire(LOAN_REPAY)) {
          throw ApiError.validation('员工借款参数不合法', {
            kind: ['必须是 BORROW 或 REPAY'],
          })
        }
        if (!decimal(String(draft.amount ?? '0')).gt(0)) {
          throw ApiError.validation('员工借款参数不合法', { amount: ['必须大于零'] })
        }
      },
      beforeDelete: (_trx, { item }) => {
        if (item.payrollId) throw new ApiError('conflict', LOAN_LINKED)
      },
      // created_by_id 是 readonly 列且本资源不声明 owner 绑定（矩阵不得授出行级范围）
      insertColumns: ({ permit }) => ({ created_by_id: permit.actor.userId || null }),
    },
  })

  // 跨资源聚合（借款 × 员工）：只做码级门控，不套行过滤
  async function loanBalances(_permit: Permit): Promise<EmployeeLoanBalance[]> {
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

  /** 手写建单（按月生成用）：与内核 create 同口径的派生金额与列集 */
  async function insertPayroll(
    trx: DbHandle,
    draft: {
      employeeId: string
      month: string
      workdays: string
      attendanceDays: number
      missingDays: number
      overtimeHours: string
      dailyWage: string
      allowance: string
    },
  ): Promise<Record<string, unknown>> {
    const derived = derivePayrollAmounts(draft)
    try {
      const row = await trx
        .insertInto('hr_payroll')
        .values({
          month: draft.month,
          workdays: draft.workdays,
          attendance_days: String(draft.attendanceDays),
          missing_days: String(draft.missingDays),
          overtime_hours: draft.overtimeHours,
          daily_wage: draft.dailyWage,
          base_amount: derived.baseAmount,
          allowance: draft.allowance,
          payable: derived.payable,
          employee_id: draft.employeeId,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      return mapRow(PAYROLL_META, row)
    } catch (err) {
      throw writeErr(err, '创建工资单失败')
    }
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
    listPayrolls: (permit: Permit, query: Partial<ListQuery>) => payrollBase.list(permit, query),
    getPayroll: (permit: Permit, id: string) => payrollBase.get(permit, id),
    createPayroll: (permit: Permit, input: PayrollInput) => payrollBase.create(permit, { ...input }),
    updatePayroll: (permit: Permit, id: string, patch: PayrollPatch) =>
      payrollBase.update(permit, id, { ...patch }),
    refreshPayroll,
    deletePayroll: (permit: Permit, id: string) => payrollBase.remove(permit, id),
    generatePayrolls,
    payrollMonthStats,
    listPayments: (permit: Permit, query: Partial<ListQuery>) => paymentBase.list(permit, query),
    getPayment: (permit: Permit, id: string) => paymentBase.get(permit, id),
    createPayment,
    payRemaining,
    deletePayment,
    listLoans: (permit: Permit, query: Partial<ListQuery>) => loanBase.list(permit, query),
    getLoan: (permit: Permit, id: string) => loanBase.get(permit, id),
    createLoan: (permit: Permit, input: EmployeeLoanInput) => loanBase.create(permit, { ...input }),
    updateLoan: (permit: Permit, id: string, patch: EmployeeLoanPatch) =>
      loanBase.update(permit, id, { ...patch }),
    deleteLoan: (permit: Permit, id: string) => loanBase.remove(permit, id),
    loanBalances,
  }
}

export type PayrollService = ReturnType<typeof createPayrollService>

/** 单个手填十进制字段：缺省/空串按 0，非法与负数逐字沿用迁移前文案 */
function payrollDecimal(draft: Record<string, unknown>, key: string) {
  const raw = draft[key]
  const text = raw === undefined || raw === null || raw === '' ? '0' : String(raw)
  if (!isDecimalString(text)) {
    throw ApiError.validation('数值参数不合法', { [key]: ['必须是十进制字符串'] })
  }
  const value = decimal(text)
  if (value.isNegative()) {
    throw ApiError.validation('数值参数不合法', { [key]: ['不能为负数'] })
  }
  return value
}

/**
 * 应发链（唯一实现，内核钩子与手写路径共用）：
 * 基本工资 = 月工日 × 日薪（分位 half-up），应发 = 基本 + 补贴 + 奖金 − 罚款 − 借款抵扣。
 */
function derivePayrollAmounts(draft: Record<string, unknown>): {
  baseAmount: string
  payable: string
} {
  const values = new Map<string, ReturnType<typeof decimal>>()
  for (const key of PAYROLL_DECIMALS) values.set(key, payrollDecimal(draft, key))
  const at = (key: string) => values.get(key)!
  const baseAmount = decimal(roundAmount(at('workdays').mul(at('dailyWage'))))
  const payable = baseAmount
    .add(at('allowance'))
    .add(at('bonus'))
    .sub(at('fine'))
    .sub(at('loanDeduction'))
  return { baseAmount: toDecimalString(baseAmount), payable: toDecimalString(payable) }
}
