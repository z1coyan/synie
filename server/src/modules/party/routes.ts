import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { listQuerySchema, validationHook } from '~/platform/http/zod.ts'
import type { PartyAddressService } from './address-service.ts'
import type { CustomerService, EmployeeService, SupplierService } from './party-service.ts'

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

export function customerRoutes(deps: { auth: AuthService; customers: CustomerService }) {
  const { auth, customers } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const result = await customers.list(c.get('actor'), toList(c.req.valid('json')))
      return c.json({ count: result.count, results: result.results.map(partyDto) })
    })
    .post('/', zValidator('json', partyCreate, validationHook), async (c) => {
      const item = await customers.create(c.get('actor'), c.req.valid('json'))
      return c.json(partyDto(item), 201)
    })
    .get('/:id', zValidator('param', idParam, validationHook), async (c) => {
      return c.json(partyDto(await customers.get(c.get('actor'), c.req.valid('param').id)))
    })
    .patch(
      '/:id',
      zValidator('param', idParam, validationHook),
      zValidator('json', partyUpdate, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await customers.update(c.get('actor'), c.req.valid('param').id, {
          code: body.code,
          name: body.name,
          shortName: body.shortName,
          shortNamePresent: present(raw, 'shortName'),
        })
        return c.json(partyDto(item))
      },
    )
    .delete('/:id', zValidator('param', idParam, validationHook), async (c) => {
      await customers.remove(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function supplierRoutes(deps: { auth: AuthService; suppliers: SupplierService }) {
  const { auth, suppliers } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const result = await suppliers.list(c.get('actor'), toList(c.req.valid('json')))
      return c.json({ count: result.count, results: result.results.map(partyDto) })
    })
    .post('/', zValidator('json', partyCreate, validationHook), async (c) => {
      const item = await suppliers.create(c.get('actor'), c.req.valid('json'))
      return c.json(partyDto(item), 201)
    })
    .get('/:id', zValidator('param', idParam, validationHook), async (c) => {
      return c.json(partyDto(await suppliers.get(c.get('actor'), c.req.valid('param').id)))
    })
    .patch(
      '/:id',
      zValidator('param', idParam, validationHook),
      zValidator('json', partyUpdate, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await suppliers.update(c.get('actor'), c.req.valid('param').id, {
          code: body.code,
          name: body.name,
          shortName: body.shortName,
          shortNamePresent: present(raw, 'shortName'),
        })
        return c.json(partyDto(item))
      },
    )
    .delete('/:id', zValidator('param', idParam, validationHook), async (c) => {
      await suppliers.remove(c.get('actor'), c.req.valid('param').id)
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
  addresses: PartyAddressService
}) {
  const { auth, addresses } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const result = await addresses.list(c.get('actor'), toList(c.req.valid('json')))
      return c.json({ count: result.count, results: result.results.map(partyAddressDto) })
    })
    .post('/', zValidator('json', partyAddressCreate, validationHook), async (c) => {
      const item = await addresses.create(c.get('actor'), c.req.valid('json'))
      return c.json(partyAddressDto(item), 201)
    })
    .get('/:id', zValidator('param', idParam, validationHook), async (c) => {
      return c.json(partyAddressDto(await addresses.get(c.get('actor'), c.req.valid('param').id)))
    })
    .patch(
      '/:id',
      zValidator('param', idParam, validationHook),
      zValidator('json', partyAddressUpdate, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await addresses.update(c.get('actor'), c.req.valid('param').id, {
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
    .delete('/:id', zValidator('param', idParam, validationHook), async (c) => {
      await addresses.remove(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function employeeRoutes(deps: { auth: AuthService; employees: EmployeeService }) {
  const { auth, employees } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const result = await employees.list(c.get('actor'), toList(c.req.valid('json')))
      return c.json({ count: result.count, results: result.results.map(employeeDto) })
    })
    .post('/', zValidator('json', employeeCreate, validationHook), async (c) => {
      const body = c.req.valid('json')
      const item = await employees.create(c.get('actor'), body)
      return c.json(employeeDto(item), 201)
    })
    .get('/:id', zValidator('param', idParam, validationHook), async (c) => {
      return c.json(employeeDto(await employees.get(c.get('actor'), c.req.valid('param').id)))
    })
    .patch(
      '/:id',
      zValidator('param', idParam, validationHook),
      zValidator('json', employeeUpdate, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await employees.update(c.get('actor'), c.req.valid('param').id, {
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
    .delete('/:id', zValidator('param', idParam, validationHook), async (c) => {
      await employees.remove(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })
}
