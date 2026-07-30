import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveSource } from '~/components/synie-remote-select/remote-query'

const customers = readFileSync(join(import.meta.dirname, 'customers.tsx'), 'utf8')
const suppliers = readFileSync(join(import.meta.dirname, 'suppliers.tsx'), 'utf8')
const employees = readFileSync(join(import.meta.dirname, '../hr/employees.tsx'), 'utf8')
const attendanceImports = readFileSync(join(import.meta.dirname, '../hr/attendance/-import-drawers.tsx'), 'utf8')
const drawerRegistry = readFileSync(
  join(import.meta.dirname, '../../../components/synie-record-drawer/extension-drawer-props.tsx'),
  'utf8',
)
const employeePresentation = readFileSync(
  join(import.meta.dirname, '../../../lib/resources/presentation/employee.tsx'),
  'utf8',
)

const FORBIDDEN_GRAPHQL_MARKERS = {
  customers: ['gqlFetch', 'CREATE_CUSTOMER', 'UPDATE_CUSTOMER', 'createSalCustomer', 'updateSalCustomer'],
  suppliers: ['gqlFetch', 'CREATE_SUPPLIER', 'UPDATE_SUPPLIER', 'createPurSupplier', 'updatePurSupplier'],
  employees: ['gqlFetch', 'CREATE_EMPLOYEE', 'UPDATE_EMPLOYEE', 'createHrEmployee', 'updateHrEmployee'],
} as const

describe('客户/供应商/员工页 REST 迁移契约', () => {
  test('三个业务页均不含旧 GraphQL operation', () => {
    for (const marker of FORBIDDEN_GRAPHQL_MARKERS.customers) expect(customers).not.toContain(marker)
    for (const marker of FORBIDDEN_GRAPHQL_MARKERS.suppliers) expect(suppliers).not.toContain(marker)
    for (const marker of FORBIDDEN_GRAPHQL_MARKERS.employees) expect(employees).not.toContain(marker)
  })

  test('客户/员工走 PE，供应商走 Catalog Basic Form', () => {
    expect(customers).toContain('createCustomerPresentation(binding)')
    expect(customers.match(/client=\{client\}/g)).toHaveLength(2)
    expect(suppliers).toContain("const RESOURCE = 'purSuppliers'")
    expect(suppliers).toContain('useCatalogBasicForm(RESOURCE')
    expect(suppliers.match(/client=\{client\}/g)).toHaveLength(2)
    expect(employees).toContain('createEmployeePresentation(binding)')
    expect(employees.match(/client=\{client\}/g)).toHaveLength(2)
  })

  test('registry 让跨页面远程选择器与 FK 速览使用 REST client', () => {
    expect(resolveSource({ resource: 'salCustomers' })?.client?.id).toBe('rest:salCustomers')
    expect(resolveSource({ resource: 'purSuppliers' })?.client?.id).toBe('rest:purSuppliers')
    expect(resolveSource({ resource: 'hrEmployees' })?.client?.id).toBe('rest:hrEmployees')
  })

  test('考勤导入的员工权限 Meta 也显式走 REST client', () => {
    expect(attendanceImports).toContain("useGridMeta('hrEmployees', true)")
  })

  test('员工编号创建可空自动取号且编辑态仍可修改', () => {
    expect(employeePresentation).toContain(
      "code: { order: 0, cols: 6, required: false, placeholder: '留空自动编号' }",
    )
    expect(employeePresentation).not.toContain(
      "code: { order: 0, cols: 6, required: false, edit: 'createOnly'",
    )
    expect(drawerRegistry).not.toContain('hrEmployees:')
  })
})
