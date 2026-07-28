import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import type { TodoSourceRegistry } from '~/platform/todo/source-registry.ts'
import { allPartyResourceMetas } from './meta.ts'
import {
  createCustomerService,
  createEmployeeService,
  createSupplierService,
} from './party-service.ts'

export {
  createCustomerService,
  createSupplierService,
  createEmployeeService,
  type CustomerService,
  type SupplierService,
  type EmployeeService,
} from './party-service.ts'
export { customerRoutes, supplierRoutes, employeeRoutes } from './routes.ts'
export { allPartyResourceMetas } from './meta.ts'

export function registerPartyResources(registry: Registry): void {
  for (const meta of allPartyResourceMetas()) {
    registry.register(meta)
  }
}

/** 待办对手方名称解析（customer/supplier → 业务表） */
export function registerPartyTodoSources(todos: TodoSourceRegistry): void {
  todos.registerParty('customer', { table: 'sal_customers', nameColumn: 'name' })
  todos.registerParty('supplier', { table: 'pur_supplier', nameColumn: 'name' })
}

export function createPartyServices(db: Kysely<Database>, numbering: NumberingService) {
  return {
    customers: createCustomerService(db),
    suppliers: createSupplierService(db),
    employees: createEmployeeService(db, numbering),
  }
}
