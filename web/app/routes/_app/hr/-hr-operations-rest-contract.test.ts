import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

const pages = [
  './attendance/punches.tsx',
  './attendance/imports.tsx',
  './attendance/-import-drawers.tsx',
  './attendance/days.tsx',
  './attendance/corrections.tsx',
  './attendance/monthly.tsx',
  './payroll/slips.tsx',
  './payroll/-payments-section.tsx',
  './payroll/payments.tsx',
  './payroll/loans.tsx',
] as const

describe('PR-2.19 人力考勤与薪酬 REST 边界', () => {
  test('七资源消费面不再包含 GraphQL 请求或 operation', () => {
    for (const page of pages) {
      const text = source(page)
      expect(text).not.toContain('gqlFetch')
      expect(text).not.toMatch(/\b(query|mutation)\s+\(\$/)
    }
  })

  test('七个 Grid 与 Drawer 显式绑定 REST client', () => {
    const bindings = [
      ['./attendance/punches.tsx', 'attendancePunchClient'],
      ['./attendance/imports.tsx', 'attendanceImportClient'],
      ['./attendance/days.tsx', 'attendanceDayClient'],
      ['./attendance/corrections.tsx', 'attendanceCorrectionClient'],
      ['./payroll/slips.tsx', 'payrollClient'],
      ['./payroll/payments.tsx', 'payrollPaymentClient'],
      ['./payroll/loans.tsx', 'employeeLoanClient'],
    ] as const

    for (const [page, client] of bindings) {
      expect(source(page)).toContain(`client={${client}}`)
    }
  })

  test('导入、重算、月汇总、工资与借款动作全部经 REST', () => {
    const clients = source('../../../lib/resources/hr-operations.ts')
    for (const endpoint of [
      "api.hr['attendance-imports'][':id'].import",
      "api.hr['attendance-days'].recalc",
      "api.hr['attendance-days']['month-summary']",
      "api.hr.payrolls[':id'].refresh",
      "api.hr.payrolls.generate",
      "api.hr.payrolls['month-stats']",
      "api.hr['payroll-payments']['pay-remaining']",
      "api.hr['employee-loans'].balances",
    ]) {
      expect(clients).toContain(endpoint)
    }
  })

  test('工资发放子表与全部自定义表单复用 REST client', () => {
    const payments = source('./payroll/-payments-section.tsx')
    expect(payments).toContain('queryPayrollPayments')
    expect(payments).toContain('createPayrollPayment')
    expect(payments).toContain('deletePayrollPayment')

    expect(source('./attendance/-import-drawers.tsx')).toContain(
      'createAttendanceImport',
    )
    expect(source('./attendance/corrections.tsx')).toContain(
      'saveAttendanceCorrection',
    )
    expect(source('./payroll/slips.tsx')).toContain('savePayroll')
    expect(source('./payroll/loans.tsx')).toContain('saveEmployeeLoan')
  })
})
