import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AuthzEnforcer } from '~/platform/authz/enforce.ts'
import { permitOf } from '~/platform/authz/enforce.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { listQuerySchema, validationHook } from '~/platform/http/zod.ts'
import type { PartyAddressService } from './address-service.ts'
import {
  CUSTOMER_RESOURCE_NAME,
  EMPLOYEE_RESOURCE_NAME,
  PARTY_ADDRESS_RESOURCE_NAME,
  SUPPLIER_RESOURCE_NAME,
} from './meta.ts'
import type { CustomerService, EmployeeService, SupplierService } from './party-service.ts'

/**
 * party 四资源 REST。
 * 逐端点挂 `guard(资源, 动作)`（requireAuth 之后），handler 用 `permitOf(c)` 取凭证。
 */

const idParam = z.object({ id: z.string().uuid() })

const partyCreate = z
  .object({
    code: z.string().min(1),
    name: z.string().min(1),
    shortName: z.string().nullable().optional(),
  })
  .strict()

const partyUpdate = z
  .object({
    code: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    shortName: z.string().nullable().optional(),
  })
  .strict()

const employeeCreate = z
  .object({
    code: z.string().nullable().optional(),
    name: z.string().min(1),
    attendanceNo: z.string().nullable().optional(),
    idNumber: z.string().nullable().optional(),
    householdRegistration: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    currentAddress: z.string().nullable().optional(),
    dailyWage: z.string().nullable().optional(),
    monthlyAllowance: z.string().nullable().optional(),
    insuranceTypes: z.array(z.string()).optional(),
  })
  .strict()

const employeeUpdate = z
  .object({
    code: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    attendanceNo: z.string().nullable().optional(),
    idNumber: z.string().nullable().optional(),
    householdRegistration: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    currentAddress: z.string().nullable().optional(),
    dailyWage: z.string().nullable().optional(),
    monthlyAllowance: z.string().nullable().optional(),
    insuranceTypes: z.array(z.string()).optional(),
  })
  .strict()

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

function partyDto(p: Awaited<ReturnType<CustomerService['get']>>) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    shortName: p.shortName,
    insertedAt: p.insertedAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }
}

function employeeDto(e: Awaited<ReturnType<EmployeeService['get']>>) {
  return {
    id: e.id,
    code: e.code,
    name: e.name,
    attendanceNo: e.attendanceNo,
    idNumber: e.idNumber,
    householdRegistration: e.householdRegistration,
    phone: e.phone,
    currentAddress: e.currentAddress,
    dailyWage: e.dailyWage,
    monthlyAllowance: e.monthlyAllowance,
    insuranceTypes: e.insuranceTypes,
    insertedAt: e.insertedAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  }
}

export function customerRoutes(deps: { auth: AuthService; authz: AuthzEnforcer; customers: CustomerService }) {
  const { auth, authz, customers } = deps
  const guard = (action: string) => authz.guard(CUSTOMER_RESOURCE_NAME, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const result = await customers.list(permitOf(c), toList(c.req.valid('json')))
      return c.json({ count: result.count, results: result.results.map(partyDto) })
    })
    .post('/', guard('create'), zValidator('json', partyCreate, validationHook), async (c) => {
      const item = await customers.create(permitOf(c), c.req.valid('json'))
      return c.json(partyDto(item), 201)
    })
    .get('/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(partyDto(await customers.get(permitOf(c), c.req.valid('param').id)))
    })
    .patch(
      '/:id',
      guard('update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', partyUpdate, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await customers.update(permitOf(c), c.req.valid('param').id, {
          code: body.code,
          name: body.name,
          shortName: body.shortName,
          shortNamePresent: present(raw, 'shortName'),
        })
        return c.json(partyDto(item))
      },
    )
    .delete('/:id', guard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await customers.remove(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function supplierRoutes(deps: { auth: AuthService; authz: AuthzEnforcer; suppliers: SupplierService }) {
  const { auth, authz, suppliers } = deps
  const guard = (action: string) => authz.guard(SUPPLIER_RESOURCE_NAME, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const result = await suppliers.list(permitOf(c), toList(c.req.valid('json')))
      return c.json({ count: result.count, results: result.results.map(partyDto) })
    })
    .post('/', guard('create'), zValidator('json', partyCreate, validationHook), async (c) => {
      const item = await suppliers.create(permitOf(c), c.req.valid('json'))
      return c.json(partyDto(item), 201)
    })
    .get('/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(partyDto(await suppliers.get(permitOf(c), c.req.valid('param').id)))
    })
    .patch(
      '/:id',
      guard('update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', partyUpdate, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await suppliers.update(permitOf(c), c.req.valid('param').id, {
          code: body.code,
          name: body.name,
          shortName: body.shortName,
          shortNamePresent: present(raw, 'shortName'),
        })
        return c.json(partyDto(item))
      },
    )
    .delete('/:id', guard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await suppliers.remove(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

const partyAddressPartyType = z.enum(['CUSTOMER', 'SUPPLIER', 'COMPANY'])
const partyAddressPurpose = z.enum(['SHIPPING', 'OFFICE', 'OTHER'])

const partyAddressCreate = z
  .object({
    partyType: partyAddressPartyType,
    partyId: z.string().uuid(),
    name: z.string().min(1),
    purpose: partyAddressPurpose,
    contactName: z.string().nullable().optional(),
    contactPhone: z.string().nullable().optional(),
    province: z.string().min(1),
    city: z.string().min(1),
    district: z.string().min(1),
    address: z.string().min(1),
    isDefault: z.boolean().optional(),
    active: z.boolean().optional(),
    remarks: z.string().nullable().optional(),
  })
  .strict()

const partyAddressUpdate = z
  .object({
    name: z.string().min(1).optional(),
    purpose: partyAddressPurpose.optional(),
    contactName: z.string().nullable().optional(),
    contactPhone: z.string().nullable().optional(),
    province: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    district: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
    isDefault: z.boolean().optional(),
    active: z.boolean().optional(),
    remarks: z.string().nullable().optional(),
  })
  .strict()

function partyAddressDto(a: Awaited<ReturnType<PartyAddressService['get']>>) {
  return {
    id: a.id,
    partyType: a.partyType,
    partyId: a.partyId,
    name: a.name,
    purpose: a.purpose,
    contactName: a.contactName,
    contactPhone: a.contactPhone,
    province: a.province,
    city: a.city,
    district: a.district,
    address: a.address,
    isDefault: a.isDefault,
    active: a.active,
    remarks: a.remarks,
    insertedAt: a.insertedAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  }
}

export function partyAddressRoutes(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  addresses: PartyAddressService
}) {
  const { auth, authz, addresses } = deps
  const guard = (action: string) => authz.guard(PARTY_ADDRESS_RESOURCE_NAME, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const result = await addresses.list(permitOf(c), toList(c.req.valid('json')))
      return c.json({ count: result.count, results: result.results.map(partyAddressDto) })
    })
    .post('/', guard('create'), zValidator('json', partyAddressCreate, validationHook), async (c) => {
      const item = await addresses.create(permitOf(c), c.req.valid('json'))
      return c.json(partyAddressDto(item), 201)
    })
    .get('/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(partyAddressDto(await addresses.get(permitOf(c), c.req.valid('param').id)))
    })
    .patch(
      '/:id',
      guard('update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', partyAddressUpdate, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await addresses.update(permitOf(c), c.req.valid('param').id, {
          name: body.name,
          purpose: body.purpose,
          contactName: body.contactName,
          contactNamePresent: present(raw, 'contactName'),
          contactPhone: body.contactPhone,
          contactPhonePresent: present(raw, 'contactPhone'),
          province: body.province,
          city: body.city,
          district: body.district,
          address: body.address,
          isDefault: body.isDefault,
          active: body.active,
          remarks: body.remarks,
          remarksPresent: present(raw, 'remarks'),
        })
        return c.json(partyAddressDto(item))
      },
    )
    .delete('/:id', guard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await addresses.remove(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function employeeRoutes(deps: { auth: AuthService; authz: AuthzEnforcer; employees: EmployeeService }) {
  const { auth, authz, employees } = deps
  const guard = (action: string) => authz.guard(EMPLOYEE_RESOURCE_NAME, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const result = await employees.list(permitOf(c), toList(c.req.valid('json')))
      return c.json({ count: result.count, results: result.results.map(employeeDto) })
    })
    .post('/', guard('create'), zValidator('json', employeeCreate, validationHook), async (c) => {
      const body = c.req.valid('json')
      const item = await employees.create(permitOf(c), body)
      return c.json(employeeDto(item), 201)
    })
    .get('/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(employeeDto(await employees.get(permitOf(c), c.req.valid('param').id)))
    })
    .patch(
      '/:id',
      guard('update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', employeeUpdate, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await employees.update(permitOf(c), c.req.valid('param').id, {
          code: body.code,
          name: body.name,
          attendanceNo: body.attendanceNo,
          attendanceNoPresent: present(raw, 'attendanceNo'),
          idNumber: body.idNumber,
          idNumberPresent: present(raw, 'idNumber'),
          householdRegistration: body.householdRegistration,
          householdRegistrationPresent: present(raw, 'householdRegistration'),
          phone: body.phone,
          phonePresent: present(raw, 'phone'),
          currentAddress: body.currentAddress,
          currentAddressPresent: present(raw, 'currentAddress'),
          dailyWage: body.dailyWage,
          dailyWagePresent: present(raw, 'dailyWage'),
          monthlyAllowance: body.monthlyAllowance,
          monthlyAllowancePresent: present(raw, 'monthlyAllowance'),
          insuranceTypes: body.insuranceTypes,
          insuranceTypesPresent: present(raw, 'insuranceTypes'),
        })
        return c.json(employeeDto(item))
      },
    )
    .delete('/:id', guard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await employees.remove(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
}
