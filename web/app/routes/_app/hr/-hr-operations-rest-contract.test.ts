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

  test('只读/extension 绑定 REST transport，三个 basic 资源绑定 Catalog Form', () => {
    const bindings = [
      ['./attendance/punches.tsx', 'attendancePunchClient'],
      ['./attendance/imports.tsx', 'attendanceImportClient'],
      ['./attendance/days.tsx', 'attendanceDayClient'],
      ['./payroll/slips.tsx', 'payrollClient'],
    ] as const

    for (const [page, client] of bindings) {
      expect(source(page)).toContain(`client={${client}}`)
    }

    for (const [page, resource] of [
      ['./attendance/corrections.tsx', 'hrAttendanceCorrections'],
      ['./payroll/loans.tsx', 'hrEmployeeLoans'],
      ['./payroll/-payments-section.tsx', 'hrPayrollPayments'],
      ['./payroll/payments.tsx', 'hrPayrollPayments'],
    ] as const) {
      const text = source(page)
      expect(text).toContain('useCatalogBasicForm')
      expect(text).toContain(`'${resource}'`)
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

  test('工资发放与 basic 自定义部分经 binding.writer，复杂表单保留领域 helper', () => {
    const payments = source('./payroll/-payments-section.tsx')
    expect(payments).toContain('queryPayrollPayments')
    expect(payments).toContain('paymentForm.binding.writer.create')
    expect(payments).toContain('paymentForm.binding.writer.delete')

    expect(source('./attendance/-import-drawers.tsx')).toContain(
      'createAttendanceImport',
    )
    expect(source('./attendance/corrections.tsx')).toContain('binding.writer.update')
    expect(source('./payroll/slips.tsx')).toContain('savePayroll')
    expect(source('./payroll/loans.tsx')).toContain('binding.writer.update')
  })
})
