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
import { EMPLOYEE_RESOURCE_NAME } from './meta.ts'
import type { EmployeeService } from './party-service.ts'

/**
 * party 手写 REST：仅员工（`insurance_types` 是 enumArray，标准内核不支持）。
 * 客户/供应商/地址已迁 `platform/standard` 派生路由（挂载见 src/app.ts）。
 * 逐端点挂 `guard(资源, 动作)`（requireAuth 之后），handler 用 `permitOf(c)` 取凭证。
 */

const idParam = z.object({ id: z.string().uuid() })

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
