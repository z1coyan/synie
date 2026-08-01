import { Decimal, roundAmount, scaledInt64ToDecimal } from '@synie/shared'
import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import { v } from 'convex/values'
import { action, internalMutation } from '../../_generated/server'
import { internal } from '../../_generated/api'
import type { DataModel, Id } from '../../_generated/dataModel'
import { authComponent } from '../../auth'
import type { Actor } from '../../lib/actor'
import { actorForAppUser } from '../../lib/actor'
import { authedMutation, authedQuery } from '../../lib/auth'
import { synieError, validationError } from '../../lib/errors'
import { requirePermission } from '../../lib/permissions'
import {
  createDomainRecord,
  hydrateStored,
  patchDomainComputed,
  patchDomainStatus,
  removeDomainRecord,
  updateDomainRecord,
} from '../shared/records'

type QueryCtx = GenericQueryCtx<DataModel>
type MutationCtx = GenericMutationCtx<DataModel>
type Ctx = QueryCtx | MutationCtx
type Wire = Record<string, unknown>
type PayrollResource = 'hrPayrolls' | 'hrPayrollPayments' | 'hrEmployeeLoans'

const PAYROLL_PENDING = 'PENDING'
const PAYROLL_PAID = 'PAID'
const PAYMENT_NORMAL = 'NORMAL'
const PAYMENT_SUPPLEMENT = 'SUPPLEMENT'
const LOAN_BORROW = 'BORROW'
const LOAN_REPAY = 'REPAY'

function object(value: unknown): Wire {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw synieError('validation', '参数必须是对象')
  }
  return value as Wire
}

function month(value: unknown): string {
  const text = String(value ?? '').trim()
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) {
    throw validationError('月份参数不合法', { month: ['格式应为 YYYY-MM'] })
  }
  return text
}

function monthBounds(value: unknown): { month: string; from: string; to: string } {
  const normalized = month(value)
  const start = new Date(`${normalized}-01T00:00:00Z`)
  const next = new Date(start)
  next.setUTCMonth(next.getUTCMonth() + 1)
  return { month: normalized, from: `${normalized}-01`, to: next.toISOString().slice(0, 10) }
}

function dateOnly(value: unknown, field: string): string {
  const text = String(value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw validationError('日期参数不合法', { [field]: ['格式应为 YYYY-MM-DD'] })
  }
  return text
}

function decimal(value: unknown, field: string, options: { nonnegative?: boolean; nonzero?: boolean } = {}): Decimal {
  if (typeof value !== 'string') {
    throw validationError('数值参数不合法', { [field]: ['必须是十进制字符串'] })
  }
  let parsed: Decimal
  try {
    parsed = new Decimal(value.trim() || '0')
  } catch {
    throw validationError('数值参数不合法', { [field]: ['必须是十进制字符串'] })
  }
  if (options.nonnegative && parsed.isNegative()) {
    throw validationError('数值参数不合法', { [field]: ['不能为负数'] })
  }
  if (options.nonzero && parsed.isZero()) {
    throw validationError('数值参数不合法', { [field]: ['不能为零'] })
  }
  return parsed
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw validationError('工资单参数不合法', { [field]: ['必须是非负整数'] })
  }
  return value
}

async function loadHr(ctx: Ctx, resource: PayrollResource, id: string): Promise<Wire> {
  const normalized = ctx.db.normalizeId('hrDocuments', id)
  const row = normalized ? await ctx.db.get(normalized) : null
  if (!row || row.resource !== resource) {
    const labels: Record<PayrollResource, string> = {
      hrPayrolls: '工资单', hrPayrollPayments: '工资发放记录', hrEmployeeLoans: '员工借款记录',
    }
    throw synieError('not_found', `${labels[resource]}不存在`)
  }
  return hydrateStored(row)
}

async function indexedRows(
  ctx: Ctx,
  resource: PayrollResource,
  index: 'payroll' | 'employee' | 'month',
  value: string,
): Promise<Wire[]> {
  const rows = index === 'payroll'
    ? await ctx.db.query('hrPayrollIndex').withIndex('by_resource_payroll_date', (q) =>
        q.eq('resource', resource).eq('payrollId', value),
      ).collect()
    : index === 'employee'
      ? await ctx.db.query('hrPayrollIndex').withIndex('by_resource_employee_date', (q) =>
          q.eq('resource', resource).eq('employeeId', value),
        ).collect()
      : await ctx.db.query('hrPayrollIndex').withIndex('by_resource_month', (q) =>
          q.eq('resource', resource).eq('month', value),
        ).collect()
  const result: Wire[] = []
  for (const indexRow of rows) {
    const normalized = ctx.db.normalizeId('hrDocuments', indexRow.recordId)
    const row = normalized ? await ctx.db.get(normalized) : null
    if (row?.resource === resource) result.push(hydrateStored(row))
  }
  return result
}

export async function replacePayrollIndex(
  ctx: MutationCtx,
  resource: PayrollResource,
  recordId: string,
  wire: Wire | null,
): Promise<void> {
  const old = await ctx.db.query('hrPayrollIndex').withIndex('by_record', (q) =>
    q.eq('resource', resource).eq('recordId', recordId),
  ).collect()
  for (const row of old) await ctx.db.delete(row._id)
  if (!wire) return
  const employeeId = typeof wire.employeeId === 'string' ? wire.employeeId : null
  if (!employeeId) throw synieError('internal', `${resource} 缺少员工索引事实`)
  const monthValue = typeof wire.month === 'string' ? wire.month : null
  const payrollId = typeof wire.payrollId === 'string' ? wire.payrollId : null
  const date = resource === 'hrPayrolls'
    ? `${monthValue ?? '0000-00'}-01`
    : String(resource === 'hrPayrollPayments' ? wire.paidOn : wire.occurredOn)
  await ctx.db.insert('hrPayrollIndex', {
    resource,
    recordId,
    employeeId,
    month: monthValue,
    payrollId,
    date,
  })
}

function normalizePayroll(input: Wire, previous?: Wire): Wire {
  const employeeId = String(previous?.employeeId ?? input.employeeId ?? '').trim()
  if (!employeeId) throw validationError('工资单参数不合法', { employeeId: ['不能为空'] })
  const payrollMonth = month(previous?.month ?? input.month)
  const readDecimal = (field: string) => decimal(
    input[field] ?? previous?.[field] ?? '0', field, { nonnegative: true },
  )
  const workdays = readDecimal('workdays')
  const overtimeHours = readDecimal('overtimeHours')
  const dailyWage = readDecimal('dailyWage')
  const allowance = readDecimal('allowance')
  const bonus = readDecimal('bonus')
  const fine = readDecimal('fine')
  const loanDeduction = readDecimal('loanDeduction')
  const attendanceDays = nonnegativeInteger(input.attendanceDays ?? previous?.attendanceDays ?? 0, 'attendanceDays')
  const missingDays = nonnegativeInteger(input.missingDays ?? previous?.missingDays ?? 0, 'missingDays')
  const baseAmount = new Decimal(roundAmount(workdays.mul(dailyWage)))
  const payable = new Decimal(roundAmount(baseAmount.add(allowance).add(bonus).sub(fine).sub(loanDeduction)))
  const remarks = input.remarks === undefined ? (previous?.remarks ?? null) : (input.remarks === null ? null : String(input.remarks).trim() || null)
  return {
    employeeId,
    month: payrollMonth,
    workdays: workdays.toString(),
    attendanceDays,
    missingDays,
    overtimeHours: overtimeHours.toString(),
    dailyWage: dailyWage.toString(),
    baseAmount: baseAmount.toString(),
    allowance: allowance.toString(),
    bonus: bonus.toString(),
    fine: fine.toString(),
    loanDeduction: loanDeduction.toString(),
    payable: payable.toString(),
    remarks,
    paidTotal: previous?.paidTotal ?? null,
  }
}

async function payrollSnapshot(ctx: Ctx, payrollMonth: string, employeeId: string): Promise<Wire> {
  const employeeKey = ctx.db.normalizeId('employees', employeeId)
  const employee = employeeKey ? await ctx.db.get(employeeKey) : null
  if (!employeeKey || !employee) throw synieError('conflict', '工资单员工不存在')
  const { from, to } = monthBounds(payrollMonth)
  const projection = await ctx.db.query('attendanceProjectionState').withIndex('by_key', (q) => q.eq('key', 'singleton')).unique()
  const indexes = await ctx.db.query('attendanceDayProjections').withIndex('by_generation_employee_date', (q) =>
    q.eq('generation', projection?.activeGeneration ?? 0).eq('employeeId', employeeKey).gte('date', from).lt('date', to),
  ).collect()
  let normalHours = new Decimal(0)
  let overtimeHours = new Decimal(0)
  let bonusWorkdays = new Decimal(0)
  let missingDays = 0
  for (const day of indexes) {
    normalHours = normalHours.add(scaledInt64ToDecimal(day.normalHoursScaled, 6))
    overtimeHours = overtimeHours.add(scaledInt64ToDecimal(day.overtimeHoursScaled, 6))
    bonusWorkdays = bonusWorkdays.add(scaledInt64ToDecimal(day.bonusWorkdayScaled, 6))
    if (day.status === 'MISSING') missingDays += 1
  }
  return {
    workdays: normalHours.div(8).add(bonusWorkdays).toString(),
    attendanceDays: indexes.length,
    missingDays,
    overtimeHours: overtimeHours.toString(),
    dailyWage: employee.dailyWage === null ? '0' : scaledInt64ToDecimal(employee.dailyWage, 2),
    allowance: employee.monthlyAllowance === null ? '0' : scaledInt64ToDecimal(employee.monthlyAllowance, 2),
  }
}

export async function createPayrollRecord(ctx: MutationCtx, actor: Actor, raw: unknown): Promise<Wire> {
  requirePermission(actor, 'hr.payroll:create')
  const input = object(raw)
  const normalized = normalizePayroll(input)
  const result = await createDomainRecord(ctx, actor, 'hrPayrolls', {}, {
    permissionChecked: true,
    trustedDerived: normalized,
  })
  await replacePayrollIndex(ctx, 'hrPayrolls', String(result.id), result)
  return result
}

export async function updatePayrollRecord(ctx: MutationCtx, actor: Actor, id: string, raw: unknown): Promise<Wire> {
  requirePermission(actor, 'hr.payroll:update')
  const before = await loadHr(ctx, 'hrPayrolls', id)
  if (before.status !== PAYROLL_PENDING) throw synieError('conflict', '仅待发放工资单可修改或删除,差错请走补发')
  const normalized = normalizePayroll(object(raw), before)
  const result = await updateDomainRecord(ctx, actor, 'hrPayrolls', id, {}, {
    permissionChecked: true,
    trustedDerived: normalized,
  })
  await replacePayrollIndex(ctx, 'hrPayrolls', id, result)
  return result
}

export async function removePayrollRecord(ctx: MutationCtx, actor: Actor, id: string): Promise<void> {
  requirePermission(actor, 'hr.payroll:delete')
  const before = await loadHr(ctx, 'hrPayrolls', id)
  if (before.status !== PAYROLL_PENDING) throw synieError('conflict', '仅待发放工资单可修改或删除,差错请走补发')
  await removeDomainRecord(ctx, actor, 'hrPayrolls', id, { permissionChecked: true })
  await replacePayrollIndex(ctx, 'hrPayrolls', id, null)
}

async function loanBalance(ctx: Ctx, employeeId: string): Promise<Decimal> {
  const loans = await indexedRows(ctx, 'hrEmployeeLoans', 'employee', employeeId)
  return loans.reduce((sum, row) => {
    const amount = new Decimal(String(row.amount ?? '0'))
    return String(row.kind).toUpperCase() === LOAN_BORROW ? sum.add(amount) : sum.sub(amount)
  }, new Decimal(0))
}

async function paymentTotal(ctx: Ctx, payrollId: string): Promise<Decimal | null> {
  const payments = await indexedRows(ctx, 'hrPayrollPayments', 'payroll', payrollId)
  if (!payments.length) return null
  return payments.reduce((sum, row) => sum.add(String(row.amount ?? '0')), new Decimal(0))
}

async function createPaymentInternal(
  ctx: MutationCtx,
  actor: Actor,
  payroll: Wire,
  paidOn: string,
  amount: Decimal,
  remarks: string | null,
): Promise<Wire> {
  const pending = payroll.status === PAYROLL_PENDING
  if (pending) {
    const deduction = new Decimal(String(payroll.loanDeduction ?? '0'))
    if (deduction.gt(0) && (await loanBalance(ctx, String(payroll.employeeId))).lt(deduction)) {
      throw synieError('conflict', '借款抵扣超过员工借款余额')
    }
  }
  const result = await createDomainRecord(ctx, actor, 'hrPayrollPayments', {}, {
    permissionChecked: true,
    trustedDerived: {
      payrollId: payroll.id,
      employeeId: payroll.employeeId,
      month: payroll.month,
      paidOn,
      amount: amount.toString(),
      kind: pending ? PAYMENT_NORMAL : PAYMENT_SUPPLEMENT,
      remarks,
      createdById: actor.userId,
    },
  })
  await replacePayrollIndex(ctx, 'hrPayrollPayments', String(result.id), result)

  if (pending) {
    const deduction = new Decimal(String(payroll.loanDeduction ?? '0'))
    if (deduction.gt(0)) {
      const loan = await createDomainRecord(ctx, actor, 'hrEmployeeLoans', {}, {
        permissionChecked: true,
        trustedDerived: {
          kind: LOAN_REPAY,
          occurredOn: paidOn,
          amount: deduction.toString(),
          remarks: null,
          employeeId: payroll.employeeId,
          payrollId: payroll.id,
          createdById: actor.userId,
        },
      })
      await replacePayrollIndex(ctx, 'hrEmployeeLoans', String(loan.id), loan)
    }
  }

  const paid = await paymentTotal(ctx, String(payroll.id))
  if (pending) {
    await patchDomainStatus(ctx, actor, 'hrPayrolls', String(payroll.id), PAYROLL_PAID, 'mark_paid', {
      paidTotal: paid?.toString() ?? null,
    })
  } else {
    await patchDomainComputed(ctx, actor, 'hrPayrolls', String(payroll.id), {
      paidTotal: paid?.toString() ?? null,
    }, 'recompute_paid_total')
  }
  return result
}

export async function createPaymentRecord(ctx: MutationCtx, actor: Actor, raw: unknown): Promise<Wire> {
  requirePermission(actor, 'hr.payroll_payment:create')
  const input = object(raw)
  const payrollId = String(input.payrollId ?? '').trim()
  if (!payrollId) throw validationError('工资发放参数不合法', { payrollId: ['不能为空'] })
  const payroll = await loadHr(ctx, 'hrPayrolls', payrollId)
  const paidOn = dateOnly(input.paidOn, 'paidOn')
  const amount = decimal(input.amount, 'amount', { nonzero: true })
  const remarks = input.remarks == null ? null : String(input.remarks).trim() || null
  return createPaymentInternal(ctx, actor, payroll, paidOn, amount, remarks)
}

export async function payRemainingRecord(
  ctx: MutationCtx,
  actor: Actor,
  raw: unknown,
): Promise<Wire> {
  requirePermission(actor, 'hr.payroll_payment:create')
  const input = object(raw)
  const payrollId = String(input.payrollId ?? '').trim()
  const payroll = await loadHr(ctx, 'hrPayrolls', payrollId)
  const total = await paymentTotal(ctx, payrollId)
  const remaining = new Decimal(String(payroll.payable ?? '0')).sub(total ?? 0)
  if (!remaining.gt(0)) throw synieError('conflict', '该工资单已无未发差额')
  return createPaymentInternal(
    ctx,
    actor,
    payroll,
    dateOnly(input.paidOn, 'paidOn'),
    remaining,
    input.remarks == null ? null : String(input.remarks).trim() || null,
  )
}

export async function removePaymentRecord(ctx: MutationCtx, actor: Actor, id: string): Promise<void> {
  requirePermission(actor, 'hr.payroll_payment:delete')
  const payment = await loadHr(ctx, 'hrPayrollPayments', id)
  const payrollId = String(payment.payrollId)
  const payroll = await loadHr(ctx, 'hrPayrolls', payrollId)
  await removeDomainRecord(ctx, actor, 'hrPayrollPayments', id, { permissionChecked: true })
  await replacePayrollIndex(ctx, 'hrPayrollPayments', id, null)
  const remaining = await indexedRows(ctx, 'hrPayrollPayments', 'payroll', payrollId)
  const reverse = payment.kind === PAYMENT_NORMAL || remaining.length === 0
  if (reverse) {
    for (const loan of await indexedRows(ctx, 'hrEmployeeLoans', 'payroll', payrollId)) {
      await removeDomainRecord(ctx, actor, 'hrEmployeeLoans', String(loan.id), { permissionChecked: true })
      await replacePayrollIndex(ctx, 'hrEmployeeLoans', String(loan.id), null)
    }
  }
  const paid = remaining.length
    ? remaining.reduce((sum, row) => sum.add(String(row.amount ?? '0')), new Decimal(0))
    : null
  if (reverse && payroll.status === PAYROLL_PAID) {
    await patchDomainStatus(ctx, actor, 'hrPayrolls', payrollId, PAYROLL_PENDING, 'mark_pending', {
      paidTotal: paid?.toString() ?? null,
    })
  } else {
    await patchDomainComputed(ctx, actor, 'hrPayrolls', payrollId, {
      paidTotal: paid?.toString() ?? null,
    }, 'recompute_paid_total')
  }
}

function normalizeLoan(raw: unknown, previous?: Wire): Wire {
  const input = object(raw)
  const kind = String(input.kind ?? previous?.kind ?? '').toUpperCase()
  if (kind !== LOAN_BORROW && kind !== LOAN_REPAY) {
    throw validationError('员工借款参数不合法', { kind: ['必须是 BORROW 或 REPAY'] })
  }
  const employeeId = String(input.employeeId ?? previous?.employeeId ?? '').trim()
  if (!employeeId) throw validationError('员工借款参数不合法', { employeeId: ['不能为空'] })
  return {
    kind,
    employeeId,
    occurredOn: dateOnly(input.occurredOn ?? previous?.occurredOn, 'occurredOn'),
    amount: decimal(input.amount ?? previous?.amount, 'amount', { nonnegative: true, nonzero: true }).toString(),
    remarks: input.remarks === undefined ? (previous?.remarks ?? null) : (input.remarks == null ? null : String(input.remarks).trim() || null),
    payrollId: previous?.payrollId ?? null,
    createdById: previous?.createdById,
  }
}

export async function createLoanRecord(ctx: MutationCtx, actor: Actor, raw: unknown): Promise<Wire> {
  requirePermission(actor, 'hr.employee_loan:create')
  const normalized = normalizeLoan(raw)
  normalized.createdById = actor.userId
  const result = await createDomainRecord(ctx, actor, 'hrEmployeeLoans', {}, {
    permissionChecked: true,
    trustedDerived: normalized,
  })
  await replacePayrollIndex(ctx, 'hrEmployeeLoans', String(result.id), result)
  return result
}

export async function updateLoanRecord(ctx: MutationCtx, actor: Actor, id: string, raw: unknown): Promise<Wire> {
  requirePermission(actor, 'hr.employee_loan:update')
  const before = await loadHr(ctx, 'hrEmployeeLoans', id)
  if (before.payrollId) throw synieError('conflict', '工资发放联动生成的归还记录不可修改或删除,请从发放记录侧处理')
  const result = await updateDomainRecord(ctx, actor, 'hrEmployeeLoans', id, {}, {
    permissionChecked: true,
    trustedDerived: normalizeLoan(raw, before),
  })
  await replacePayrollIndex(ctx, 'hrEmployeeLoans', id, result)
  return result
}

export async function removeLoanRecord(ctx: MutationCtx, actor: Actor, id: string): Promise<void> {
  requirePermission(actor, 'hr.employee_loan:delete')
  const before = await loadHr(ctx, 'hrEmployeeLoans', id)
  if (before.payrollId) throw synieError('conflict', '工资发放联动生成的归还记录不可修改或删除,请从发放记录侧处理')
  await removeDomainRecord(ctx, actor, 'hrEmployeeLoans', id, { permissionChecked: true })
  await replacePayrollIndex(ctx, 'hrEmployeeLoans', id, null)
}

export const payRemaining = authedMutation({
  args: { payrollId: v.string(), paidOn: v.string(), remarks: v.optional(v.string()) },
  returns: v.any(),
  handler: (ctx, args) => payRemainingRecord(ctx, ctx.actor, args),
})

export const refresh = authedMutation({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'hr.payroll:update')
    const before = await loadHr(ctx, 'hrPayrolls', args.id)
    if (before.status !== PAYROLL_PENDING) throw synieError('conflict', '仅待发放工资单可重取快照')
    const snapshot = await payrollSnapshot(ctx, String(before.month), String(before.employeeId))
    const result = await updateDomainRecord(ctx, ctx.actor, 'hrPayrolls', args.id, {}, {
      permissionChecked: true,
      trustedDerived: normalizePayroll({ ...snapshot }, before),
    })
    await replacePayrollIndex(ctx, 'hrPayrolls', args.id, result)
    return result
  },
})

export const monthStats = authedQuery({
  args: { month: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'hr.payroll:read')
    const payrollMonth = month(args.month)
    const payrolls = await indexedRows(ctx, 'hrPayrolls', 'month', payrollMonth)
    const payable = payrolls.reduce((sum, row) => sum.add(String(row.payable ?? '0')), new Decimal(0))
    const paid = payrolls.reduce((sum, row) => sum.add(String(row.paidTotal ?? '0')), new Decimal(0))
    return {
      count: payrolls.length,
      pendingCount: payrolls.filter((row) => row.status === PAYROLL_PENDING).length,
      payableTotal: payable.toString(),
      paidTotal: paid.toString(),
    }
  },
})

export const loanBalances = authedQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    requirePermission(ctx.actor, 'hr.employee_loan:read')
    const indexes = await ctx.db.query('hrPayrollIndex').withIndex('by_resource_date', (q) =>
      q.eq('resource', 'hrEmployeeLoans'),
    ).collect()
    const balances = new Map<string, { borrowed: Decimal; repaid: Decimal }>()
    for (const index of indexes) {
      const loan = await loadHr(ctx, 'hrEmployeeLoans', index.recordId)
      const entry = balances.get(index.employeeId) ?? { borrowed: new Decimal(0), repaid: new Decimal(0) }
      const amount = new Decimal(String(loan.amount))
      if (loan.kind === LOAN_BORROW) entry.borrowed = entry.borrowed.add(amount)
      else entry.repaid = entry.repaid.add(amount)
      balances.set(index.employeeId, entry)
    }
    const result = []
    for (const [employeeId, totals] of balances) {
      const normalized = ctx.db.normalizeId('employees', employeeId)
      const employee = normalized ? await ctx.db.get(normalized) : null
      result.push({
        employeeId,
        employeeCode: employee?.code ?? null,
        employeeName: employee?.name ?? null,
        borrowed: totals.borrowed.toString(),
        repaid: totals.repaid.toString(),
        balance: totals.borrowed.sub(totals.repaid).toString(),
      })
    }
    return result.sort((left, right) => String(left.employeeCode ?? '').localeCompare(String(right.employeeCode ?? '')) || String(left.employeeName ?? '').localeCompare(String(right.employeeName ?? '')))
  },
})

export const generateBatch = internalMutation({
  args: { userId: v.id('appUsers'), month: v.string(), employeeIds: v.array(v.string()) },
  returns: v.object({ created: v.number(), skipped: v.number() }),
  handler: async (ctx, args) => {
    const actor = await actorForAppUser(ctx, args.userId)
    requirePermission(actor, 'hr.payroll:create')
    let created = 0
    let skipped = 0
    for (const employeeId of args.employeeIds) {
      const existing = await ctx.db.query('hrPayrollIndex').withIndex('by_resource_month_employee', (q) =>
        q.eq('resource', 'hrPayrolls').eq('month', args.month).eq('employeeId', employeeId),
      ).first()
      if (existing) { skipped += 1; continue }
      const snapshot = await payrollSnapshot(ctx, args.month, employeeId)
      await createPayrollRecord(ctx, actor, { employeeId, month: args.month, ...snapshot })
      created += 1
    }
    return { created, skipped }
  },
})

export const generate = action({
  args: { month: v.string() },
  returns: v.object({ created: v.number(), skipped: v.number() }),
  handler: async (ctx, args) => {
    const bounds = monthBounds(args.month)
    const authUser = await authComponent.safeGetAuthUser(ctx)
    if (!authUser) throw synieError('unauthorized', '登录状态已失效,请重新登录')
    const payload = await ctx.runQuery(internal.domains.hr.attendance.actorPayload, { authUserId: authUser._id })
    requirePermission({ superAdmin: payload.superAdmin, permissions: new Set<string>(payload.permissions) }, 'hr.payroll:create')
    const employeeIds = new Set<string>()
    let cursor: string | null = null
    do {
      const page: { page: Array<{ employeeId: string }>; isDone: boolean; continueCursor: string } =
        await ctx.runQuery(internal.domains.hr.attendance.pairPage, {
          resource: 'hrAttendanceDays',
          dateFrom: bounds.from,
          dateTo: new Date(Date.parse(`${bounds.to}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10),
          paginationOpts: { numItems: 500, cursor },
        })
      for (const row of page.page) employeeIds.add(row.employeeId)
      cursor = page.isDone ? null : page.continueCursor
    } while (cursor)
    let created = 0
    let skipped = 0
    const ordered = [...employeeIds].sort()
    for (let index = 0; index < ordered.length; index += 25) {
      const result = await ctx.runMutation(internal.domains.hr.payroll.generateBatch, {
        userId: payload.userId as Id<'appUsers'>,
        month: bounds.month,
        employeeIds: ordered.slice(index, index + 25),
      })
      created += result.created
      skipped += result.skipped
    }
    return { created, skipped }
  },
})
