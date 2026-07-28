import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import type { DB as Database } from '~/db/types.ts'
import type { Kysely } from 'kysely'
import {
  buildTestApp,
  createTestAuth,
  testDatabaseUrl,
} from '../../../test/helpers.ts'

const databaseUrl = testDatabaseUrl()
const describePg = databaseUrl ? describe : describe.skip

describePg('hr operations integration', () => {
  let db: Kysely<Database>
  let app: Awaited<ReturnType<typeof buildTestApp>>
  let token: string
  let userId: string
  const prefix = `HRIT${crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`
  const fileIds: string[] = []
  const employeeIds: string[] = []

  async function json<T>(
    path: string,
    init: RequestInit = {},
    expected = 200,
  ): Promise<T> {
    const headers = new Headers(init.headers)
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`)
    }
    if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json')
    }
    const res = await app.request(`/api/v1${path}`, { ...init, headers })
    const text = await res.text()
    expect(res.status).toBe(expected)
    return (text ? JSON.parse(text) : undefined) as T
  }

  beforeAll(async () => {
    db = createDb(databaseUrl!)
    const auth = await createTestAuth(db)
    app = await buildTestApp(db, { auth })
    // 确保测试库管理员密码
    const login = await json<{ token: string; user: { id: string } }>(
      '/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({
          username: 'admin',
          password: 'synie-integration-admin-password',
        }),
      },
    ).catch(async () =>
      json<{ token: string; user: { id: string } }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: 'admin', password: 'admin123' }),
      }),
    )
    token = login.token
    userId = login.user.id

    // 本地存储
    await db
      .insertInto('sys_storage')
      .values({
        name: `${prefix.toLowerCase()}-storage`,
        label: `${prefix}本地`,
        kind: 'local',
        root: `/tmp/${prefix.toLowerCase()}-files`,
        is_default: false,
      })
      .onConflict((oc) => oc.column('name').doNothing())
      .execute()
    await db.updateTable('sys_storage').set({ is_default: false }).execute()
    await db
      .updateTable('sys_storage')
      .set({ is_default: true })
      .where('name', '=', `${prefix.toLowerCase()}-storage`)
      .execute()
  })

  afterAll(async () => {
    await db
      .deleteFrom('hr_payroll_payment')
      .where('employee_id', 'in', employeeIds.length ? employeeIds : ['00000000-0000-0000-0000-000000000000'])
      .execute()
      .catch(() => undefined)
    await db
      .deleteFrom('hr_employee_loan')
      .where('employee_id', 'in', employeeIds.length ? employeeIds : ['00000000-0000-0000-0000-000000000000'])
      .execute()
      .catch(() => undefined)
    await db
      .deleteFrom('hr_payroll')
      .where('employee_id', 'in', employeeIds.length ? employeeIds : ['00000000-0000-0000-0000-000000000000'])
      .execute()
      .catch(() => undefined)
    await db
      .deleteFrom('hr_attendance_correction')
      .where('employee_id', 'in', employeeIds.length ? employeeIds : ['00000000-0000-0000-0000-000000000000'])
      .execute()
      .catch(() => undefined)
    await db
      .deleteFrom('hr_attendance_day')
      .where('employee_id', 'in', employeeIds.length ? employeeIds : ['00000000-0000-0000-0000-000000000000'])
      .execute()
      .catch(() => undefined)
    await db
      .deleteFrom('hr_attendance_punch')
      .where('employee_id', 'in', employeeIds.length ? employeeIds : ['00000000-0000-0000-0000-000000000000'])
      .execute()
      .catch(() => undefined)
    await db
      .deleteFrom('hr_attendance_import')
      .where(
        'file_id',
        'in',
        fileIds.length ? fileIds : ['00000000-0000-0000-0000-000000000000'],
      )
      .execute()
      .catch(() => undefined)
    if (employeeIds.length) {
      await db.deleteFrom('hr_employees').where('id', 'in', employeeIds).execute()
    }
    for (const id of fileIds) {
      await db.deleteFrom('sys_file').where('id', '=', id).execute().catch(() => undefined)
    }
    await db
      .deleteFrom('sys_storage')
      .where('name', '=', `${prefix.toLowerCase()}-storage`)
      .execute()
      .catch(() => undefined)
    await db.destroy()
  })

  test('meta 注册 + 权限优先 + 考勤导入日算 + 工资借款联动', async () => {
    // meta
    const meta = await json<{ name: string; grid: { capabilities: string[] } }>(
      '/meta/resources/hrPayrolls',
    )
    expect(meta.name).toBe('hrPayrolls')
    expect(meta.grid.capabilities).toContain('create')

    // 权限优先：无 token → 401 或 403；reader 无 create
    const denied = await app.request('/api/v1/hr/payrolls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    })
    expect([401, 403]).toContain(denied.status)

    // 员工
    const emp = await json<{ id: string; attendanceNo: string }>(
      '/hr/employees',
      {
        method: 'POST',
        body: JSON.stringify({
          code: `${prefix}E1`,
          name: `${prefix}甲`,
          attendanceNo: `${prefix.slice(-6)}01`,
          dailyWage: '100.1',
          monthlyAllowance: '10',
        }),
      },
      201,
    )
    employeeIds.push(emp.id)

    // 上传 .dat
    const content = [
      `${emp.attendanceNo} 2099-01-02 08:01:00`,
      `${emp.attendanceNo}\t2099-01-02 11:59:00 1 0`,
      `${emp.attendanceNo} 2099-01-02 13:00:00`,
      `${emp.attendanceNo} 2099-01-02 20:31:00`,
      `${emp.attendanceNo} 2099-01-02 20:31:00`,
      `BAD-LINE`,
      `${prefix.slice(-6)}99 2099-01-02 09:00:00`,
    ].join('\n')
    const form = new FormData()
    form.append('file', new Blob([content], { type: 'text/plain' }), `${prefix}-primary.dat`)
    const uploadRes = await app.request('/api/v1/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    expect(uploadRes.status).toBe(201)
    const uploaded = (await uploadRes.json()) as { file: { id: string } }
    fileIds.push(uploaded.file.id)

    const parsed = await json<{
      id: string
      status: string
      totalRows: number
      badRows: number
      dupRows: number
      matchedRows: number
      unmatchedRows: number
      punchCount: number
    }>(
      '/hr/attendance-imports',
      { method: 'POST', body: JSON.stringify({ fileId: uploaded.file.id }) },
      201,
    )
    expect(parsed.status).toBe('PARSED')
    expect(parsed.totalRows).toBe(7)
    expect(parsed.badRows).toBe(1)
    expect(parsed.dupRows).toBe(1)
    expect(parsed.matchedRows).toBe(4)
    expect(parsed.unmatchedRows).toBe(1)

    // sha256 防重
    await json(
      '/hr/attendance-imports',
      { method: 'POST', body: JSON.stringify({ fileId: uploaded.file.id }) },
      409,
    )

    const imported = await json<{
      status: string
      importedCount: number
      skippedUnmatchedRows: number
      punchCount: number
    }>(`/hr/attendance-imports/${parsed.id}/import`, {
      method: 'POST',
      body: JSON.stringify({ autoCreateEmployees: false }),
    })
    expect(imported.status).toBe('IMPORTED')
    expect(imported.importedCount).toBe(4)
    expect(imported.skippedUnmatchedRows).toBe(1)
    expect(imported.punchCount).toBe(4)

    const days = await json<{
      count: number
      results: Array<{
        morningIn: string
        normalHours: string
        overtimeHours: string
        bonusWorkday: string
        status: string
      }>
    }>('/hr/attendance-days/query', {
      method: 'POST',
      body: JSON.stringify({
        limit: 20,
        filter: {
          employeeId: { kind: 'fk', values: [emp.id] },
          date: { kind: 'date', op: 'eq', value: '2099-01-02' },
        },
      }),
    })
    expect(days.count).toBe(1)
    const day = days.results[0]!
    expect(day.morningIn).toBe('08:01:00')
    expect(day.normalHours).toBe('7.5')
    expect(day.overtimeHours).toBe('3.5')
    expect(day.bonusWorkday).toBe('0.5')
    expect(day.status).toBe('OK')

    // 借款 + 工资 + 首发联动归还
    const loan = await json<{ id: string; kind: string }>(
      '/hr/employee-loans',
      {
        method: 'POST',
        body: JSON.stringify({
          employeeId: emp.id,
          kind: 'BORROW',
          occurredOn: '2099-01-10',
          amount: '100',
        }),
      },
      201,
    )
    expect(loan.kind).toBe('BORROW')

    const payroll = await json<{
      id: string
      baseAmount: string
      payable: string
      status: string
      paidTotal: string | null
    }>(
      '/hr/payrolls',
      {
        method: 'POST',
        body: JSON.stringify({
          employeeId: emp.id,
          month: '2099-01',
          workdays: '2.345',
          attendanceDays: 2,
          missingDays: 0,
          overtimeHours: '3.5',
          dailyWage: '100.1',
          allowance: '10',
          bonus: '5',
          fine: '3',
          loanDeduction: '2',
        }),
      },
      201,
    )
    expect(payroll.baseAmount).toBe('234.73')
    expect(payroll.payable).toBe('244.73')
    expect(payroll.status).toBe('PENDING')
    expect(payroll.paidTotal).toBeNull()

    const payment = await json<{ kind: string; month: string }>(
      '/hr/payroll-payments',
      {
        method: 'POST',
        body: JSON.stringify({
          payrollId: payroll.id,
          paidOn: '2099-01-31',
          amount: '50',
        }),
      },
      201,
    )
    expect(payment.kind).toBe('NORMAL')
    expect(payment.month).toBe('2099-01')

    const autoRepay = await json<{
      count: number
      results: Array<{ kind: string; amount: string; payrollId: string | null }>
    }>('/hr/employee-loans/query', {
      method: 'POST',
      body: JSON.stringify({
        limit: 20,
        filter: { payrollId: { kind: 'fk', values: [payroll.id] } },
      }),
    })
    expect(autoRepay.count).toBe(1)
    expect(autoRepay.results[0]!.kind).toBe('REPAY')
    expect(autoRepay.results[0]!.amount).toBe('2')

    const paid = await json<{ status: string }>(`/hr/payrolls/${payroll.id}`)
    expect(paid.status).toBe('PAID')

    // 已发放不可改
    await json(
      `/hr/payrolls/${payroll.id}`,
      { method: 'PATCH', body: JSON.stringify({ remarks: 'x' }) },
      409,
    )

    // 不可用路由
    const internal = await app.request(`/api/v1/hr/payrolls/${payroll.id}/mark-paid`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect([404, 405]).toContain(internal.status)

    void userId
  })
})
