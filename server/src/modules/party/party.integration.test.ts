import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { withTx } from '~/db/tx.ts'
import type { Actor } from '~/platform/authz/core/index.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { deriveWireSchemas } from '~/platform/standard/wire.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { createCustomerService, createEmployeeService } from './party-service.ts'
import { testActor } from '~/platform/authz/testing.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（party 客商员工）', () => {
  const db = createDb(url!)
  const registry = createSealedResourceRegistry()
  const authz = createAuthzEnforcer(registry)
  const numbering = createNumberingService(db, buildNumberingCatalog(registry), registry)
  const customers = createCustomerService(db, registry)
  const employees = createEmployeeService(db, numbering, registry)
  const actor: Actor = testActor({
    userId: crypto.randomUUID(),
    username: 'party-test',
    name: null,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })
  /** superAdmin 凭证：party 三资源均为 global，rowFilter 恒全集 */
  function permit(resource: string, action: string): Permit {
    const decision = authz.decideFor(actor, resource, action)
    if (decision.outcome !== 'permit') throw new Error(`夹具应当 permit：${resource}:${action}`)
    return decision.permit
  }
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const customerIds: string[] = []
  const employeeIds: string[] = []
  /** 用例内已删除的员工（审计行仍在，afterAll 一并清） */
  const employeeAuditIds: string[] = []
  /** 自动取号用例自建的编号规则（共享库已有启用规则则复用，不新插） */
  let employeeRuleId = ''

  /** 用例内自删员工：从存活清单摘出，审计行留给 afterAll 清 */
  function forgetEmployee(id: string): void {
    employeeIds.splice(employeeIds.indexOf(id), 1)
    employeeAuditIds.push(id)
  }

  beforeAll(async () => {
    // 员工编号改系统生成后须持有启用规则（setup 种子规则在共享库可能被清；幂等补建）
    const existing = await db
      .selectFrom('sys_numbering_rule')
      .select('id')
      .where('resource', '=', 'hr.employee')
      .where('enabled', '=', true)
      .executeTakeFirst()
    if (!existing) {
      await numbering.create(permit('sysNumberingRules', 'create'), {
        resource: 'hr.employee',
        name: `员工编号-T${suffix}`,
        segments: [{ type: 'text', value: `T(E)${suffix}-` }, { type: 'seq', padding: 4 }],
        perCompany: false,
      })
    }
  })

  afterAll(async () => {
    for (const id of employeeAuditIds) {
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'hr_employees').where('record_id', '=', id).execute()
    }
    for (const id of employeeIds) {
      // 标准派生后审计 resource 即表名（hr_employees），不再是历史单数 hr_employee
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'hr_employees').where('record_id', '=', id).execute()
      await db.deleteFrom('hr_employees').where('id', '=', id).execute()
    }
    for (const id of customerIds) {
      // 标准派生后审计 resource 即表名（sal_customers），不再是历史单数 sal_customer
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'sal_customers').where('record_id', '=', id).execute()
      await db.deleteFrom('sal_customers').where('id', '=', id).execute()
    }
    if (employeeRuleId) {
      await db.deleteFrom('sys_numbering_counter').where('rule_id', '=', employeeRuleId).execute()
      await db.deleteFrom('sys_numbering_rule').where('id', '=', employeeRuleId).execute()
    }
    await db.destroy()
  })

  // 机械 CRUD（建/删/审计/批量/越权）由 standard-contract 的客户与供应商描述符继承；
  // 本用例只留检索与 present-key 归一这两条不在合同里的语义。
  test('客户：检索命中 + present-key 简称归一', async () => {
    const c = await customers.create(permit('salCustomers', 'create'), {
      code: `C${suffix}`,
      name: `客户-${suffix}`,
      shortName: '客户',
    })
    customerIds.push(c.id)
    const listed = await customers.list(permit('salCustomers', 'read'), { limit: 10, offset: 0, search: suffix })
    expect(listed.results.some((r) => r.id === c.id)).toBe(true)

    // present-key 语义：缺省不动、空串与 null 均清空（简称归一）
    const renamed = await customers.update(permit('salCustomers', 'update'), c.id, {
      name: `客户改-${suffix}`,
    })
    expect(renamed.name).toBe(`客户改-${suffix}`)
    expect(renamed.shortName).toBe('客户')
    const cleared = await customers.update(permit('salCustomers', 'update'), c.id, { shortName: '' })
    expect(cleared.shortName).toBeNull()

    await customers.remove(permit('salCustomers', 'delete'), c.id)
    customerIds.splice(customerIds.indexOf(c.id), 1)
  })

  test('员工：参保多选 + 考勤机唯一', async () => {
    // 员工编号由系统按 hr.employee 规则生成，不接受手填
    const att = `A${suffix}`
    const emp = await employees.create(permit('hrEmployees', 'create'), {
      name: `员工-${suffix}`,
      attendanceNo: att,
      insuranceTypes: ['SOCIAL_INJURY', 'HOUSING_FUND'],
      dailyWage: '200.50',
    })
    employeeIds.push(emp.id)
    expect(emp.insuranceTypes).toContain('SOCIAL_INJURY')
    expect(emp.dailyWage).toBe('200.5')

    await expect(
      employees.create(permit('hrEmployees', 'create'), {
        name: '重复考勤',
        attendanceNo: att,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })

    const filtered = await employees.list(permit('hrEmployees', 'read'), {
      limit: 20,
      offset: 0,
      filter: {
        insuranceTypes: { kind: 'enumArray', op: 'hasAny', values: ['SOCIAL_INJURY'] },
      },
    })
    expect(filtered.results.some((r) => r.id === emp.id)).toBe(true)

    // 库内参保类型小写（create 审计由 standard-contract 的员工描述符继承）
    const raw = await db
      .selectFrom('hr_employees')
      .select('insurance_types')
      .where('id', '=', emp.id)
      .executeTakeFirstOrThrow()
    expect(raw.insurance_types).toEqual(['social_injury', 'housing_fund'])

    await employees.remove(permit('hrEmployees', 'delete'), emp.id)
    forgetEmployee(emp.id)
  })

  test('员工：空串文本归一 null、参保去重、非负工钱', async () => {
    const emp = await employees.create(permit('hrEmployees', 'create'), {
      name: `员工空-${suffix}`,
      attendanceNo: '',
      idNumber: '',
      phone: '',
      insuranceTypes: ['SOCIAL_MEDICAL', 'SOCIAL_MEDICAL'],
    })
    employeeIds.push(emp.id)
    // 唯一索引压在 attendance_no/id_number 上：空串必须归一为 null，否则第二个员工即撞车
    expect(emp.attendanceNo).toBeNull()
    expect(emp.idNumber).toBeNull()
    expect(emp.phone).toBeNull()
    expect(emp.insuranceTypes).toEqual(['SOCIAL_MEDICAL'])

    const second = await employees.create(permit('hrEmployees', 'create'), {
      name: `员工空二-${suffix}`,
      attendanceNo: '',
      idNumber: '',
    })
    employeeIds.push(second.id)

    await expect(
      employees.update(permit('hrEmployees', 'update'), emp.id, { dailyWage: '-1' }),
    ).rejects.toMatchObject({ code: 'validation' })
    // 编号系统生成后 code 是 readonly：patch 里的 code 键被内核静默忽略，编号不动
    const afterCodePatch = await employees.update(permit('hrEmployees', 'update'), emp.id, {
      code: '',
      phone: '13800000000',
    })
    expect(afterCodePatch.code).toBe(emp.code)

    for (const id of [emp.id, second.id]) {
      await employees.remove(permit('hrEmployees', 'delete'), id)
      forgetEmployee(id)
    }
  })

  test('员工：留空自动取号 + 考勤自动建档接缝(审计键=表名)', async () => {
    // 编号规则夹具（资源键即 permissionPrefix hr.employee）
    const existing = await db
      .selectFrom('sys_numbering_rule')
      .select('id')
      .where('resource', '=', 'hr.employee')
      .where('enabled', '=', true)
      .executeTakeFirst()
    const prefix = `PE${suffix.slice(0, 4).toUpperCase()}-`
    if (!existing) {
      // 段用 jsonb_build_object 拼：绑定参数走 ::jsonb 会被当成 JSON 字符串（双重编码）
      const rule = await sql<{ id: string }>`
        INSERT INTO sys_numbering_rule(resource, name, segments, per_company, enabled)
        VALUES ('hr.employee', ${`员工规则-${suffix}`},
                ARRAY[jsonb_build_object('type', 'text', 'value', ${prefix}::text),
                      '{"type":"seq","padding":4}'::jsonb],
                false, true) RETURNING id
      `.execute(db)
      employeeRuleId = rule.rows[0]!.id
    }

    const auto = await employees.create(permit('hrEmployees', 'create'), {
      name: `员工号-${suffix}`,
    })
    employeeIds.push(auto.id)
    expect(auto.code).toBeTruthy()
    if (employeeRuleId) expect(auto.code.startsWith(prefix)).toBe(true)

    // 考勤导入接缝：调用方持 trx，本函数只消费凭证
    const seeded = await withTx(db, (trx) =>
      employees.autoCreateForAttendance(trx, permit('hrEmployees', 'create'), `SEAM${suffix}`),
    )
    employeeIds.push(seeded.id)
    expect(seeded.name).toBe('[未知]')
    expect(seeded.attendanceNo).toBe(`SEAM${suffix}`)
    const seamAudit = await db
      .selectFrom('sys_audit_log')
      .select('id')
      .where('resource', '=', 'hr_employees')
      .where('record_id', '=', seeded.id)
      .execute()
    expect(seamAudit).toHaveLength(1)

    // 同考勤号再自动建档 → 唯一冲突文案
    await expect(
      withTx(db, (trx) =>
        employees.autoCreateForAttendance(trx, permit('hrEmployees', 'create'), `SEAM${suffix}`),
      ),
    ).rejects.toMatchObject({ code: 'conflict', message: '考勤机编号已存在' })

    for (const id of [auto.id, seeded.id]) {
      await employees.remove(permit('hrEmployees', 'delete'), id)
      forgetEmployee(id)
    }
  })

  test('员工 wire schema 派生：冻结既有请求形状', () => {
    // 标准路由要求完整词表（standardRoutes 装配期同款断言）
    const declared = new Set(employees.meta.actions.map((a) => a.key))
    for (const action of ['read', 'create', 'update', 'delete', 'batch_update', 'batch_delete']) {
      expect(declared.has(action), `缺动作 ${action}`).toBe(true)
    }
    const schemas = deriveWireSchemas(employees.meta, employees.stampedColumns)
    // 创建：编号系统生成（readonly 不进 wire，传键即未知键 422）；可空文本与金额收 null；参保类型大写 token 数组
    expect(schemas.create.safeParse({ name: '张三' }).success).toBe(true)
    expect(schemas.create.safeParse({ code: '', name: '张三' }).success).toBe(false)
    expect(
      schemas.create.safeParse({
        name: '张三',
        attendanceNo: null,
        idNumber: null,
        householdRegistration: null,
        phone: null,
        currentAddress: null,
        dailyWage: null,
        monthlyAllowance: null,
        insuranceTypes: [],
      }).success,
    ).toBe(true)
    expect(schemas.create.safeParse({ name: '张三', dailyWage: '100.5' }).success).toBe(true)
    // name 必填、未知参保类型拒绝、编号显式 null 拒绝（列 NOT NULL）
    // 未知键拒绝已由 standard-contract 的员工描述符继承
    expect(schemas.create.safeParse({}).success).toBe(false)
    expect(schemas.create.safeParse({ name: '张三', insuranceTypes: ['NOPE'] }).success).toBe(false)
    // code 是 readonly 未知键：null 与任意值同样拒绝
    expect(schemas.create.safeParse({ code: null, name: '张三' }).success).toBe(false)
    // 更新：present-key 语义（出现即写、null 清空、缺省不动）
    expect(schemas.update.safeParse({}).success).toBe(true)
    expect(schemas.update.safeParse({ attendanceNo: null }).success).toBe(true)
    expect(schemas.update.safeParse({ insuranceTypes: ['HOUSING_FUND'] }).success).toBe(true)
    expect(schemas.update.safeParse({ name: '' }).success).toBe(false)
  })
})
