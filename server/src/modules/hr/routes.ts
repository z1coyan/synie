import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { validationHook } from '~/platform/http/zod.ts'
import type { AttendanceService } from './attendance-service.ts'
import type { PayrollService } from './payroll-service.ts'

const listQuerySchema = z
  .object({
    limit: z.number().int().min(0).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    search: z.string().optional(),
    sort: z
      .object({ column: z.string(), direction: z.enum(['ascending', 'descending']) })
      .optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const idParam = z.object({ id: z.string().uuid() })
const monthQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) })

function toList(body: z.infer<typeof listQuerySchema>): Partial<ListQuery> {
  return {
    limit: body.limit,
    offset: body.offset,
    search: body.search,
    sort: body.sort,
    filter: body.filter as ListQuery['filter'],
  }
}

function present(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key)
}


function iso(d: Date | null | undefined): string | null {
  if (d == null) return null
  return d.toISOString()
}

function punchDto(p: Awaited<ReturnType<AttendanceService['getPunch']>>) {
  return {
    id: p.id,
    attendanceNo: p.attendanceNo,
    punchedAt: p.punchedAt.toISOString(),
    insertedAt: p.insertedAt.toISOString(),
    employeeId: p.employeeId,
    importId: p.importId,
  }
}

function importDto(i: Awaited<ReturnType<AttendanceService['getImport']>>) {
  return {
    id: i.id,
    status: i.status,
    error: i.error,
    totalRows: i.totalRows,
    badRows: i.badRows,
    dupRows: i.dupRows,
    matchedRows: i.matchedRows,
    unmatchedRows: i.unmatchedRows,
    unmatchedDetail: i.unmatchedDetail,
    importedCount: i.importedCount,
    skippedExistingRows: i.skippedExistingRows,
    skippedUnmatchedRows: i.skippedUnmatchedRows,
    autoCreatedCount: i.autoCreatedCount,
    importedAt: iso(i.importedAt),
    insertedAt: i.insertedAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
    fileId: i.fileId,
    createdById: i.createdById,
    importedById: i.importedById,
    punchCount: i.punchCount,
  }
}

function dayDto(d: Awaited<ReturnType<AttendanceService['getDay']>>) {
  return {
    id: d.id,
    date: d.date,
    morningIn: d.morningIn,
    morningOut: d.morningOut,
    afternoonIn: d.afternoonIn,
    afternoonOut: d.afternoonOut,
    normalHours: d.normalHours,
    overtimeHours: d.overtimeHours,
    bonusWorkday: d.bonusWorkday,
    status: d.status,
    insertedAt: d.insertedAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    employeeId: d.employeeId,
  }
}

function correctionDto(c: Awaited<ReturnType<AttendanceService['getCorrection']>>) {
  return {
    id: c.id,
    date: c.date,
    times: c.times,
    note: c.note,
    insertedAt: c.insertedAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    employeeId: c.employeeId,
    createdById: c.createdById,
  }
}

function payrollDto(p: Awaited<ReturnType<PayrollService['getPayroll']>>) {
  return {
    id: p.id,
    month: p.month,
    workdays: p.workdays,
    attendanceDays: p.attendanceDays,
    missingDays: p.missingDays,
    overtimeHours: p.overtimeHours,
    dailyWage: p.dailyWage,
    baseAmount: p.baseAmount,
    allowance: p.allowance,
    bonus: p.bonus,
    fine: p.fine,
    loanDeduction: p.loanDeduction,
    payable: p.payable,
    status: p.status,
    remarks: p.remarks,
    insertedAt: p.insertedAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    employeeId: p.employeeId,
    paidTotal: p.paidTotal,
  }
}

function paymentDto(p: Awaited<ReturnType<PayrollService['getPayment']>>) {
  return {
    id: p.id,
    month: p.month,
    paidOn: p.paidOn,
    amount: p.amount,
    kind: p.kind,
    remarks: p.remarks,
    insertedAt: p.insertedAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    payrollId: p.payrollId,
    employeeId: p.employeeId,
    createdById: p.createdById,
  }
}

function loanDto(l: Awaited<ReturnType<PayrollService['getLoan']>>) {
  return {
    id: l.id,
    kind: l.kind,
    occurredOn: l.occurredOn,
    amount: l.amount,
    remarks: l.remarks,
    insertedAt: l.insertedAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
    employeeId: l.employeeId,
    payrollId: l.payrollId,
    createdById: l.createdById,
  }
}

export function attendancePunchRoutes(deps: { auth: AuthService; attendance: AttendanceService }) {
  const { auth, attendance: hr } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await hr.listPunches(c.get('actor'), toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(punchDto) })
      },
    )
    .get(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => c.json(punchDto(await hr.getPunch(c.get('actor'), c.req.valid('param').id))),
    )
}

export function attendanceImportRoutes(deps: { auth: AuthService; attendance: AttendanceService }) {
  const { auth, attendance: hr } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await hr.listImports(c.get('actor'), toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(importDto) })
      },
    )
    .post(
      '/',
      zValidator(
        'json',
        z.object({ fileId: z.string().uuid() }).strict(),
        validationHook,
      ),
      async (c) => {
        const item = await hr.createImport(c.get('actor'), c.req.valid('json').fileId)
        return c.json(importDto(item), 201)
      },
    )
    .get(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => c.json(importDto(await hr.getImport(c.get('actor'), c.req.valid('param').id))),
    )
    .post(
      '/:id/import',
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z.object({ autoCreateEmployees: z.boolean().optional() }).strict(),
        validationHook,
      ),
      async (c) => {
        const item = await hr.executeImport(
          c.get('actor'),
          c.req.valid('param').id,
          c.req.valid('json'),
        )
        return c.json(importDto(item))
      },
    )
    .delete(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => {
        await hr.deleteImport(c.get('actor'), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function attendanceDayRoutes(deps: { auth: AuthService; attendance: AttendanceService }) {
  const { auth, attendance: hr } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await hr.listDays(c.get('actor'), toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(dayDto) })
      },
    )
    .post(
      '/recalc',
      zValidator(
        'json',
        z
          .object({
            dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const body = c.req.valid('json')
        const count = await hr.recalcDays(c.get('actor'), body.dateFrom, body.dateTo)
        return c.json({ count })
      },
    )
    .get(
      '/month-summary',
      zValidator('query', monthQuery, validationHook),
      async (c) => {
        const items = await hr.monthSummary(c.get('actor'), c.req.valid('query').month)
        return c.json(
          items.map((item) => ({
            employeeId: item.employeeId,
            employeeCode: item.employeeCode,
            employeeName: item.employeeName,
            days: item.days,
            missingDays: item.missingDays,
            normalHours: item.normalHours,
            overtimeHours: item.overtimeHours,
            bonusWorkdays: item.bonusWorkdays,
            workdays: item.workdays,
          })),
        )
      },
    )
    .get(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => c.json(dayDto(await hr.getDay(c.get('actor'), c.req.valid('param').id))),
    )
}

export function attendanceCorrectionRoutes(deps: { auth: AuthService; attendance: AttendanceService }) {
  const { auth, attendance: hr } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await hr.listCorrections(c.get('actor'), toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(correctionDto) })
      },
    )
    .post(
      '/',
      zValidator(
        'json',
        z
          .object({
            employeeId: z.string().uuid(),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            times: z.array(z.string()).min(1).max(20),
            note: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const item = await hr.createCorrection(c.get('actor'), c.req.valid('json'))
        return c.json(correctionDto(item), 201)
      },
    )
    .get(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => c.json(correctionDto(await hr.getCorrection(c.get('actor'), c.req.valid('param').id))),
    )
    .patch(
      '/:id',
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            employeeId: z.string().uuid().optional(),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            times: z.array(z.string()).min(1).max(20).optional(),
            note: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await hr.updateCorrection(c.get('actor'), c.req.valid('param').id, {
          ...body,
          notePresent: present(raw, 'note'),
        })
        return c.json(correctionDto(item))
      },
    )
    .delete(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => {
        await hr.deleteCorrection(c.get('actor'), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function payrollRoutes(deps: { auth: AuthService; payroll: PayrollService }) {
  const { auth, payroll: hr } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await hr.listPayrolls(c.get('actor'), toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(payrollDto) })
      },
    )
    .post(
      '/',
      zValidator(
        'json',
        z
          .object({
            employeeId: z.string().uuid(),
            month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
            workdays: z.string().optional(),
            attendanceDays: z.number().int().min(0).optional(),
            missingDays: z.number().int().min(0).optional(),
            overtimeHours: z.string().optional(),
            dailyWage: z.string().optional(),
            allowance: z.string().optional(),
            bonus: z.string().optional(),
            fine: z.string().optional(),
            loanDeduction: z.string().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const item = await hr.createPayroll(c.get('actor'), c.req.valid('json'))
        return c.json(payrollDto(item), 201)
      },
    )
    .post(
      '/generate',
      zValidator(
        'json',
        z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict(),
        validationHook,
      ),
      async (c) => {
        const result = await hr.generatePayrolls(c.get('actor'), c.req.valid('json').month)
        return c.json(result)
      },
    )
    .get(
      '/month-stats',
      zValidator('query', monthQuery, validationHook),
      async (c) => {
        return c.json(await hr.payrollMonthStats(c.get('actor'), c.req.valid('query').month))
      },
    )
    .get(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => c.json(payrollDto(await hr.getPayroll(c.get('actor'), c.req.valid('param').id))),
    )
    .patch(
      '/:id',
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            workdays: z.string().optional(),
            attendanceDays: z.number().int().min(0).optional(),
            missingDays: z.number().int().min(0).optional(),
            overtimeHours: z.string().optional(),
            dailyWage: z.string().optional(),
            allowance: z.string().optional(),
            bonus: z.string().optional(),
            fine: z.string().optional(),
            loanDeduction: z.string().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await hr.updatePayroll(c.get('actor'), c.req.valid('param').id, {
          ...body,
          remarksPresent: present(raw, 'remarks'),
        })
        return c.json(payrollDto(item))
      },
    )
    .post(
      '/:id/refresh',
      zValidator('param', idParam, validationHook),
      async (c) => {
        const item = await hr.refreshPayroll(c.get('actor'), c.req.valid('param').id)
        return c.json(payrollDto(item))
      },
    )
    .delete(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => {
        await hr.deletePayroll(c.get('actor'), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function payrollPaymentRoutes(deps: { auth: AuthService; payroll: PayrollService }) {
  const { auth, payroll: hr } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await hr.listPayments(c.get('actor'), toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(paymentDto) })
      },
    )
    .post(
      '/',
      zValidator(
        'json',
        z
          .object({
            payrollId: z.string().uuid(),
            paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            amount: z.string(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const item = await hr.createPayment(c.get('actor'), c.req.valid('json'))
        return c.json(paymentDto(item), 201)
      },
    )
    .post(
      '/pay-remaining',
      zValidator(
        'json',
        z
          .object({
            payrollId: z.string().uuid(),
            paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const item = await hr.payRemaining(c.get('actor'), c.req.valid('json'))
        return c.json(paymentDto(item), 201)
      },
    )
    .get(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => c.json(paymentDto(await hr.getPayment(c.get('actor'), c.req.valid('param').id))),
    )
    .delete(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => {
        await hr.deletePayment(c.get('actor'), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function employeeLoanRoutes(deps: { auth: AuthService; payroll: PayrollService }) {
  const { auth, payroll: hr } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await hr.listLoans(c.get('actor'), toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(loanDto) })
      },
    )
    .post(
      '/',
      zValidator(
        'json',
        z
          .object({
            employeeId: z.string().uuid(),
            kind: z.enum(['BORROW', 'REPAY', 'borrow', 'repay']),
            occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            amount: z.string(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const item = await hr.createLoan(c.get('actor'), c.req.valid('json'))
        return c.json(loanDto(item), 201)
      },
    )
    .get(
      '/balances',
      async (c) => {
        const items = await hr.loanBalances(c.get('actor'))
        return c.json(
          items.map((item) => ({
            employeeId: item.employeeId,
            employeeCode: item.employeeCode,
            employeeName: item.employeeName,
            borrowed: item.borrowed,
            repaid: item.repaid,
            balance: item.balance,
          })),
        )
      },
    )
    .get(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => c.json(loanDto(await hr.getLoan(c.get('actor'), c.req.valid('param').id))),
    )
    .patch(
      '/:id',
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            employeeId: z.string().uuid().optional(),
            kind: z.enum(['BORROW', 'REPAY', 'borrow', 'repay']).optional(),
            occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            amount: z.string().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await hr.updateLoan(c.get('actor'), c.req.valid('param').id, {
          ...body,
          remarksPresent: present(raw, 'remarks'),
        })
        return c.json(loanDto(item))
      },
    )
    .delete(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => {
        await hr.deleteLoan(c.get('actor'), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}
