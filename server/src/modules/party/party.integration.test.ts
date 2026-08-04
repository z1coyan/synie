import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { createCustomerService, createEmployeeService, createSupplierService } from './party-service.ts'
import { testActor } from '~/platform/authz/testing.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（party 客商员工）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db, buildNumberingCatalog(createSealedResourceRegistry()))
  const customers = createCustomerService(db)
  const suppliers = createSupplierService(db)
  const employees = createEmployeeService(db, numbering)
  const actor: Actor = testActor({
    userId: crypto.randomUUID(),
    username: 'party-test',
    name: null,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const customerIds: string[] = []
  const supplierIds: string[] = []
  const employeeIds: string[] = []

  afterAll(async () => {
    for (const id of employeeIds) {
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'hr_employee').where('record_id', '=', id).execute()
      await db.deleteFrom('hr_employees').where('id', '=', id).execute()
    }
    for (const id of customerIds) {
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'sal_customer').where('record_id', '=', id).execute()
      await db.deleteFrom('sal_customers').where('id', '=', id).execute()
    }
    for (const id of supplierIds) {
      await db.deleteFrom('sys_audit_log').where('resource', '=', 'pur_supplier').where('record_id', '=', id).execute()
      await db.deleteFrom('pur_supplier').where('id', '=', id).execute()
    }
    await db.destroy()
  })

  test('客户/供应商 CRUD', async () => {
    const c = await customers.create(actor, {
      code: `C${suffix}`,
      name: `客户-${suffix}`,
      shortName: '客户',
    })
    customerIds.push(c.id)
    const s = await suppliers.create(actor, {
      code: `S${suffix}`,
      name: `供应商-${suffix}`,
    })
    supplierIds.push(s.id)
    const listed = await customers.list(actor, { limit: 10, offset: 0, search: suffix })
    expect(listed.results.some((r) => r.id === c.id)).toBe(true)
    await customers.remove(actor, c.id)
    customerIds.splice(customerIds.indexOf(c.id), 1)
    await suppliers.remove(actor, s.id)
    supplierIds.splice(supplierIds.indexOf(s.id), 1)
  })

  test('员工：参保多选 + 考勤机唯一', async () => {
    // 需要启用的编号规则；若无则显式 code
    const att = `A${suffix}`
    const emp = await employees.create(actor, {
      code: `E${suffix}`,
      name: `员工-${suffix}`,
      attendanceNo: att,
      insuranceTypes: ['SOCIAL_INJURY', 'HOUSING_FUND'],
      dailyWage: '200.50',
    })
    employeeIds.push(emp.id)
    expect(emp.insuranceTypes).toContain('SOCIAL_INJURY')
    expect(emp.dailyWage).toBe('200.5')

    await expect(
      employees.create(actor, {
        code: `E2${suffix}`,
        name: '重复考勤',
        attendanceNo: att,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })

    const filtered = await employees.list(actor, {
      limit: 20,
      offset: 0,
      filter: {
        insuranceTypes: { kind: 'enumArray', op: 'hasAny', values: ['SOCIAL_INJURY'] },
      },
    })
    expect(filtered.results.some((r) => r.id === emp.id)).toBe(true)

    await employees.remove(actor, emp.id)
    employeeIds.splice(employeeIds.indexOf(emp.id), 1)
  })
})
