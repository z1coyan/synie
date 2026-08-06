/**
 * HR REST：打卡 / 导入 / 日考勤 / 补卡 / 工资单 / 发放 / 员工借款。
 *
 * 逐端点挂 `guard(资源, 动作)`（requireAuth 之后），handler 用 `permitOf(c)` 取凭证。
 * 动作码唯一事实源是 meta：导入批次声明 `readAnyOf: [read, import]`（无独立权限点），
 * 日考勤 recalc 是 collection command 码；考勤导入建批次跨资源读文件走 guard allOf。
 * 自动建员工的分支条件权限（D8）在服务层分支内二次取凭证，路由算不出。
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AuthzEnforcer } from '~/platform/authz/enforce.ts'
import { permitOf } from '~/platform/authz/enforce.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import {
  dateOnlySchema,
  decimalStringSchema,
  listQuerySchema,
  validationHook,
} from '~/platform/http/zod.ts'
import { FILE_RESOURCE_NAME } from '~/platform/files/meta.ts'
import {
  ATTENDANCE_CORRECTION_RESOURCE,
  ATTENDANCE_DAY_RESOURCE,
  ATTENDANCE_IMPORT_RESOURCE,
  ATTENDANCE_PUNCH_RESOURCE,
  type AttendanceService,
} from './attendance-service.ts'
import {
  EMPLOYEE_LOAN_RESOURCE,
  PAYROLL_PAYMENT_RESOURCE,
  PAYROLL_RESOURCE,
  type PayrollService,
} from './payroll-service.ts'

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

export function attendancePunchRoutes(deps: {
  auth: AuthService; authz: AuthzEnforcer; attendance: AttendanceService
}) {
  const { auth, authz, attendance: hr } = deps
  const guard = (action: string) => authz.guard(ATTENDANCE_PUNCH_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      guard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await hr.listPunches(permitOf(c), toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(punchDto) })
      },
    )
    .get(
      '/:id',
      guard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(punchDto(await hr.getPunch(permitOf(c), c.req.valid('param').id))),
    )
}

export function attendanceImportRoutes(deps: {
  auth: AuthService; authz: AuthzEnforcer; attendance: AttendanceService
}) {
  const { auth, authz, attendance: hr } = deps
  // 读走 readAnyOf（[hr.attendance_punch:read, :import] 析取）；写走 import 命令码
  const readGuard = () => authz.guard(ATTENDANCE_IMPORT_RESOURCE, 'read')
  const importGuard = (allOf?: readonly string[]) =>
    authz.guard(ATTENDANCE_IMPORT_RESOURCE, 'import', allOf ? { allOf } : undefined)
  const codeOf = (resource: string, action: string) =>
    `${authz.targetOf(resource).prefix}:${action}`
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      readGuard(),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await hr.listImports(permitOf(c), toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(importDto) })
      },
    )
    // 建批次必然读考勤文件 → ∧ sys.file:read（迁移前是服务里两道码级闸）
    .post(
      '/',
      importGuard([codeOf(FILE_RESOURCE_NAME, 'read')]),
      zValidator(
        'json',
        z.object({ fileId: z.string().uuid() }).strict(),
        validationHook,
      ),
      async (c) => {
        const item = await hr.createImport(permitOf(c), c.req.valid('json').fileId)
        return c.json(importDto(item), 201)
      },
    )
    .get(
      '/:id',
      readGuard(),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(importDto(await hr.getImport(permitOf(c), c.req.valid('param').id))),
    )
    // 自动建员工是**分支**（取决于请求体），故 hr.employee:create 在服务层二次取证，不进 allOf
    .post(
      '/:id/import',
      importGuard(),
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z.object({ autoCreateEmployees: z.boolean().optional() }).strict(),
        validationHook,
      ),
      async (c) => {
        const item = await hr.executeImport(
          permitOf(c),
          c.req.valid('param').id,
          c.req.valid('json'),
        )
        return c.json(importDto(item))
      },
    )
    .delete(
      '/:id',
      importGuard(),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await hr.deleteImport(permitOf(c), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function attendanceDayRoutes(deps: {
  auth: AuthService; authz: AuthzEnforcer; attendance: AttendanceService
}) {
  const { auth, authz, attendance: hr } = deps
  const guard = (action: string) => authz.guard(ATTENDANCE_DAY_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      guard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await hr.listDays(permitOf(c), toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(dayDto) })
      },
    )
    .post(
      '/recalc',
      guard('recalc'),
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
        const count = await hr.recalcDays(permitOf(c), body.dateFrom, body.dateTo)
        return c.json({ count })
      },
    )
    .get(
      '/month-summary',
      guard('read'),
      zValidator('query', monthQuery, validationHook),
      async (c) => {
        const items = await hr.monthSummary(permitOf(c), c.req.valid('query').month)
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
      guard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(dayDto(await hr.getDay(permitOf(c), c.req.valid('param').id))),
    )
}

export function attendanceCorrectionRoutes(deps: {
  auth: AuthService; authz: AuthzEnforcer; attendance: AttendanceService
}) {
  const { auth, authz, attendance: hr } = deps
  const guard = (action: string) => authz.guard(ATTENDANCE_CORRECTION_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      guard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await hr.listCorrections(permitOf(c), toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(correctionDto) })
      },
    )
    .post(
      '/',
      guard('create'),
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
        const item = await hr.createCorrection(permitOf(c), c.req.valid('json'))
        return c.json(correctionDto(item), 201)
      },
    )
    .get(
      '/:id',
      guard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(correctionDto(await hr.getCorrection(permitOf(c), c.req.valid('param').id))),
    )
    .patch(
      '/:id',
      guard('update'),
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
        const item = await hr.updateCorrection(permitOf(c), c.req.valid('param').id, {
          ...body,
          notePresent: present(raw, 'note'),
        })
        return c.json(correctionDto(item))
      },
    )
    .delete(
      '/:id',
      guard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await hr.deleteCorrection(permitOf(c), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function payrollRoutes(deps: {
  auth: AuthService; authz: AuthzEnforcer; payroll: PayrollService
}) {
  const { auth, authz, payroll: hr } = deps
  const guard = (action: string) => authz.guard(PAYROLL_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      guard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await hr.listPayrolls(permitOf(c), toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(payrollDto) })
      },
    )
    .post(
      '/',
      guard('create'),
      zValidator(
        'json',
        z
          .object({
            employeeId: z.string().uuid(),
            month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
            workdays: decimalStringSchema.optional(),
            attendanceDays: z.number().int().min(0).optional(),
            missingDays: z.number().int().min(0).optional(),
            overtimeHours: decimalStringSchema.optional(),
            dailyWage: decimalStringSchema.optional(),
            allowance: decimalStringSchema.optional(),
            bonus: decimalStringSchema.optional(),
            fine: decimalStringSchema.optional(),
            loanDeduction: decimalStringSchema.optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const item = await hr.createPayroll(permitOf(c), c.req.valid('json'))
        return c.json(payrollDto(item), 201)
      },
    )
    .post(
      '/generate',
      guard('create'),
      zValidator(
        'json',
        z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict(),
        validationHook,
      ),
      async (c) => {
        const result = await hr.generatePayrolls(permitOf(c), c.req.valid('json').month)
        return c.json(result)
      },
    )
    .get(
      '/month-stats',
      guard('read'),
      zValidator('query', monthQuery, validationHook),
      async (c) => {
        return c.json(await hr.payrollMonthStats(permitOf(c), c.req.valid('query').month))
      },
    )
    .get(
      '/:id',
      guard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(payrollDto(await hr.getPayroll(permitOf(c), c.req.valid('param').id))),
    )
    .patch(
      '/:id',
      guard('update'),
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            workdays: decimalStringSchema.optional(),
            attendanceDays: z.number().int().min(0).optional(),
            missingDays: z.number().int().min(0).optional(),
            overtimeHours: decimalStringSchema.optional(),
            dailyWage: decimalStringSchema.optional(),
            allowance: decimalStringSchema.optional(),
            bonus: decimalStringSchema.optional(),
            fine: decimalStringSchema.optional(),
            loanDeduction: decimalStringSchema.optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      // present-key 语义由标准内核承担：出现即写、null 清空、缺省不动
      async (c) => {
        const item = await hr.updatePayroll(
          permitOf(c),
          c.req.valid('param').id,
          c.req.valid('json'),
        )
        return c.json(payrollDto(item))
      },
    )
    // refresh 未声明独立动作码，沿用最接近的 update（不为好看新增权限码）
    .post(
      '/:id/refresh',
      guard('update'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        const item = await hr.refreshPayroll(permitOf(c), c.req.valid('param').id)
        return c.json(payrollDto(item))
      },
    )
    .delete(
      '/:id',
      guard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await hr.deletePayroll(permitOf(c), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function payrollPaymentRoutes(deps: {
  auth: AuthService; authz: AuthzEnforcer; payroll: PayrollService
}) {
  const { auth, authz, payroll: hr } = deps
  const guard = (action: string) => authz.guard(PAYROLL_PAYMENT_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      guard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await hr.listPayments(permitOf(c), toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(paymentDto) })
      },
    )
    .post(
      '/',
      guard('create'),
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
        const item = await hr.createPayment(permitOf(c), c.req.valid('json'))
        return c.json(paymentDto(item), 201)
      },
    )
    // 批量发差额未声明独立动作码，沿用 create（一次发放即一条 payment）
    .post(
      '/pay-remaining',
      guard('create'),
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
        const item = await hr.payRemaining(permitOf(c), c.req.valid('json'))
        return c.json(paymentDto(item), 201)
      },
    )
    .get(
      '/:id',
      guard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(paymentDto(await hr.getPayment(permitOf(c), c.req.valid('param').id))),
    )
    .delete(
      '/:id',
      guard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await hr.deletePayment(permitOf(c), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function employeeLoanRoutes(deps: {
  auth: AuthService; authz: AuthzEnforcer; payroll: PayrollService
}) {
  const { auth, authz, payroll: hr } = deps
  const guard = (action: string) => authz.guard(EMPLOYEE_LOAN_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      guard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await hr.listLoans(permitOf(c), toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(loanDto) })
      },
    )
    .post(
      '/',
      guard('create'),
      zValidator(
        'json',
        z
          .object({
            employeeId: z.string().uuid(),
            kind: z.enum(['BORROW', 'REPAY', 'borrow', 'repay']),
            occurredOn: dateOnlySchema,
            amount: decimalStringSchema,
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const item = await hr.createLoan(permitOf(c), c.req.valid('json'))
        return c.json(loanDto(item), 201)
      },
    )
    .get(
      '/balances',
      guard('read'),
      async (c) => {
        const items = await hr.loanBalances(permitOf(c))
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
      guard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(loanDto(await hr.getLoan(permitOf(c), c.req.valid('param').id))),
    )
    .patch(
      '/:id',
      guard('update'),
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            employeeId: z.string().uuid().optional(),
            kind: z.enum(['BORROW', 'REPAY', 'borrow', 'repay']).optional(),
            occurredOn: dateOnlySchema.optional(),
            amount: decimalStringSchema.optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      // present-key 语义由标准内核承担：出现即写、null 清空、缺省不动
      async (c) => {
        const item = await hr.updateLoan(
          permitOf(c),
          c.req.valid('param').id,
          c.req.valid('json'),
        )
        return c.json(loanDto(item))
      },
    )
    .delete(
      '/:id',
      guard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await hr.deleteLoan(permitOf(c), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}
