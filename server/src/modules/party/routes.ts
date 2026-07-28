import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import { requirePermission } from '~/platform/authz/actor.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { validationHook } from '~/platform/http/zod.ts'
import type { CustomerService, EmployeeService, SupplierService } from './party-service.ts'

const listQuerySchema = z
  .object({
    limit: z.number().int().min(0).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    search: z.string().optional(),
    sort: z
      .object({ column: z.string(), direction: z.enum(['ascending', 'descending']) })
      .optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

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

/** 权限中间件：必须挂在 zValidator 之前，保证畸形 body 仍 403 */
function requirePerm(code: string) {
  return async (
    c: { get: (k: 'actor') => AppEnv['Variables']['actor'] },
    next: () => Promise<void>,
  ) => {
    requirePermission(c.get('actor'), code)
    await next()
  }
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
    .post(
      '/query',
      requirePerm('sales.customer:read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await customers.list(toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(partyDto) })
      },
    )
    .post(
      '/',
      requirePerm('sales.customer:create'),
      zValidator('json', partyCreate, validationHook),
      async (c) => {
        const item = await customers.create(c.get('actor'), c.req.valid('json'))
        return c.json(partyDto(item), 201)
      },
    )
    .get(
      '/:id',
      requirePerm('sales.customer:read'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        return c.json(partyDto(await customers.get(c.req.valid('param').id)))
      },
    )
    .patch(
      '/:id',
      requirePerm('sales.customer:update'),
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
    .delete(
      '/:id',
      requirePerm('sales.customer:delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await customers.remove(c.get('actor'), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function supplierRoutes(deps: { auth: AuthService; suppliers: SupplierService }) {
  const { auth, suppliers } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      requirePerm('purchase.supplier:read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await suppliers.list(toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(partyDto) })
      },
    )
    .post(
      '/',
      requirePerm('purchase.supplier:create'),
      zValidator('json', partyCreate, validationHook),
      async (c) => {
        const item = await suppliers.create(c.get('actor'), c.req.valid('json'))
        return c.json(partyDto(item), 201)
      },
    )
    .get(
      '/:id',
      requirePerm('purchase.supplier:read'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        return c.json(partyDto(await suppliers.get(c.req.valid('param').id)))
      },
    )
    .patch(
      '/:id',
      requirePerm('purchase.supplier:update'),
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
    .delete(
      '/:id',
      requirePerm('purchase.supplier:delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await suppliers.remove(c.get('actor'), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function employeeRoutes(deps: { auth: AuthService; employees: EmployeeService }) {
  const { auth, employees } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      requirePerm('hr.employee:read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await employees.list(toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(employeeDto) })
      },
    )
    .post(
      '/',
      requirePerm('hr.employee:create'),
      zValidator('json', employeeCreate, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const item = await employees.create(c.get('actor'), body)
        return c.json(employeeDto(item), 201)
      },
    )
    .get(
      '/:id',
      requirePerm('hr.employee:read'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        return c.json(employeeDto(await employees.get(c.req.valid('param').id)))
      },
    )
    .patch(
      '/:id',
      requirePerm('hr.employee:update'),
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
    .delete(
      '/:id',
      requirePerm('hr.employee:delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await employees.remove(c.get('actor'), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}
