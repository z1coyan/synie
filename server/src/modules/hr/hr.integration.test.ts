import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import type { DB as Database } from '~/db/types.ts'
import { sql, type Kysely } from 'kysely'
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

    const tryLogin = async (username: string, password: string) => {
      const res = await app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) return null
      return (await res.json()) as { token: string; user: { id: string } }
    }

    // 共享库可能被 setup 截断；多密码尝试后自建超管
    let login =
      (await tryLogin('admin', 'admin123')) ??
      (await tryLogin(
        process.env.E2E_ADMIN_USERNAME ?? 'admin',
        process.env.E2E_ADMIN_PASSWORD ?? 'admin123',
      ))
    if (!login) {
      const { hashPassword } = await import('~/platform/auth/password.ts')
      const password = 'admin123'
      const hashed = await hashPassword(password)
      await db
        .insertInto('sys_user')
        .values({
          username: 'admin',
          name: 'hr-integration-admin',
          hashed_password: hashed,
          super_admin: true,
          all_companies: true,
        })
        .onConflict((oc) =>
          oc.column('username').doUpdateSet({
            hashed_password: hashed,
            super_admin: true,
            all_companies: true,
          }),
        )
        .execute()
      login = await tryLogin('admin', password)
    }
    expect(login).toBeTruthy()
    token = login!.token
    userId = login!.user.id

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

    // 员工编号系统生成：无启用规则则幂等补建——不得依赖其他套件夹具的文件执行序
    // （CI 序 hr 在 party/standard-contract 之前，裸跑即 409「未配置启用的编号规则」）
    const employeeRule = await db
      .selectFrom('sys_numbering_rule')
      .select('id')
      .where('resource', '=', 'hr.employee')
      .where('enabled', '=', true)
      .executeTakeFirst()
    if (!employeeRule) {
      // 段用 jsonb_build_object 拼：绑定参数走 ::jsonb 会被当成 JSON 字符串（双重编码）
      await sql`
        INSERT INTO sys_numbering_rule(resource, name, segments, per_company, enabled)
        VALUES ('hr.employee', ${`员工规则-${prefix}`},
                ARRAY[jsonb_build_object('type', 'text', 'value', ${`${prefix}E-`}::text),
                      '{"type":"seq","padding":4}'::jsonb],
                false, true)
      `.execute(db)
    }
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
    const meta = await json<{ name: string; capabilities: { action: string }[] }>(
      '/meta/resources/hrPayrolls',
    )
    expect(meta.name).toBe('hrPayrolls')
    expect(meta.capabilities.some((entry) => entry.action === 'create')).toBe(true)

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
    const loan = await json<{ id: string; kind: string; createdById: string | null }>(
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
    // 经办人由服务端盖章（wire 不可写）
    expect(loan.createdById).toBe(userId)

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

    const payment = await json<{ id: string; kind: string; month: string }>(
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
      results: Array<{ id: string; kind: string; amount: string; payrollId: string | null }>
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

    // 联动生成的归还记录不可改删
    const autoRepayId = autoRepay.results[0]!.id
    await json(
      `/hr/employee-loans/${autoRepayId}`,
      { method: 'PATCH', body: JSON.stringify({ amount: '3' }) },
      409,
    )
    await json(`/hr/employee-loans/${autoRepayId}`, { method: 'DELETE' }, 409)

    // 手工借款可改（present-key：备注出现即写）
    const loanPatched = await json<{ amount: string; remarks: string | null }>(
      `/hr/employee-loans/${loan.id}`,
      { method: 'PATCH', body: JSON.stringify({ amount: '120', remarks: '追加' }) },
    )
    expect(loanPatched.amount).toBe('120')
    expect(loanPatched.remarks).toBe('追加')

    // 待发放工资单：PATCH 重算应发 → 重取快照 → 删除
    const draft = await json<{ id: string; baseAmount: string; payable: string }>(
      '/hr/payrolls',
      {
        method: 'POST',
        body: JSON.stringify({
          employeeId: emp.id,
          month: '2099-02',
          workdays: '1',
          attendanceDays: 1,
          missingDays: 0,
          overtimeHours: '0',
          dailyWage: '100',
          allowance: '0',
          bonus: '0',
          fine: '0',
          loanDeduction: '0',
        }),
      },
      201,
    )
    expect(draft.baseAmount).toBe('100')
    expect(draft.payable).toBe('100')

    const patched = await json<{
      baseAmount: string
      payable: string
      remarks: string | null
    }>(`/hr/payrolls/${draft.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ bonus: '20', fine: '5', remarks: '补差' }),
    })
    expect(patched.baseAmount).toBe('100')
    expect(patched.payable).toBe('115')
    expect(patched.remarks).toBe('补差')

    // 2099-02 无考勤：工日归零、日薪/补贴回落到员工档案，奖金罚款保留
    const refreshed = await json<{
      workdays: string
      dailyWage: string
      allowance: string
      payable: string
    }>(`/hr/payrolls/${draft.id}/refresh`, { method: 'POST' })
    expect(refreshed.workdays).toBe('0')
    expect(refreshed.dailyWage).toBe('100.1')
    expect(refreshed.allowance).toBe('10')
    expect(refreshed.payable).toBe('25')

    await json(`/hr/payrolls/${draft.id}`, { method: 'DELETE' }, 204)
    await json(`/hr/payrolls/${draft.id}`, {}, 404)

    // 删除发放：工资单回退待发放，联动归还一并撤销
    await json(`/hr/payroll-payments/${payment.id}`, { method: 'DELETE' }, 204)
    const reverted = await json<{ status: string; paidTotal: string | null }>(
      `/hr/payrolls/${payroll.id}`,
    )
    expect(reverted.status).toBe('PENDING')
    expect(reverted.paidTotal).toBeNull()
    const afterRevert = await json<{ count: number }>('/hr/employee-loans/query', {
      method: 'POST',
      body: JSON.stringify({
        limit: 20,
        filter: { payrollId: { kind: 'fk', values: [payroll.id] } },
      }),
    })
    expect(afterRevert.count).toBe(0)

    // 按月生成：删掉手工单后按考勤月汇总建单，已存在的不覆盖
    await json(`/hr/payrolls/${payroll.id}`, { method: 'DELETE' }, 204)
    const generated = await json<{ created: number; skipped: number }>('/hr/payrolls/generate', {
      method: 'POST',
      body: JSON.stringify({ month: '2099-01' }),
    })
    expect(generated.created).toBe(1)
    expect(generated.skipped).toBe(0)
    const listed = await json<{
      count: number
      results: Array<{ workdays: string; baseAmount: string; payable: string; status: string }>
    }>('/hr/payrolls/query', {
      method: 'POST',
      body: JSON.stringify({
        limit: 20,
        filter: {
          employeeId: { kind: 'fk', values: [emp.id] },
          month: { kind: 'text', op: 'eq', value: '2099-01' },
        },
      }),
    })
    expect(listed.count).toBe(1)
    // 7.5/8 + 0.5 奖励工日 = 1.4375 工日 × 100.1 日薪 = 143.89 + 10 补贴
    expect(listed.results[0]!.workdays).toBe('1.4375')
    expect(listed.results[0]!.baseAmount).toBe('143.89')
    expect(listed.results[0]!.payable).toBe('153.89')
    expect(listed.results[0]!.status).toBe('PENDING')

    const again = await json<{ created: number; skipped: number }>('/hr/payrolls/generate', {
      method: 'POST',
      body: JSON.stringify({ month: '2099-01' }),
    })
    expect(again.created).toBe(0)
    expect(again.skipped).toBe(1)
  })
})
