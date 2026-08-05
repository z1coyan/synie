/**
 * 客户 / 供应商 / 员工（全局主数据，无公司列 → global 形态）。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit——
 * 列表 `listAuthorized`、单条/写前取行 `loadAuthorized`。
 * 关联物料/唯一约束是领域不变量，留在本文件。
 */
import { decimal, isDecimalString, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import { auditFieldsOf, auditSpecOf } from '~/platform/audit/spec.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { AuthzTarget } from '~/platform/meta/resource-authz.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { listAuthorized } from '~/db/list.ts'
import { loadAuthorized } from '~/db/load.ts'
import { deleteAddressesForParty } from './address-service.ts'
import {
  CUSTOMER_RESOURCE_NAME,
  EMPLOYEE_RESOURCE_NAME,
  SUPPLIER_RESOURCE_NAME,
  customerResourceMeta,
  employeeResourceMeta,
  INSURANCE_WIRE,
  supplierResourceMeta,
} from './meta.ts'

export interface Party {
  id: string
  code: string
  name: string
  shortName: string | null
  insertedAt: Date
  updatedAt: Date
}

export interface Employee {
  id: string
  code: string
  name: string
  attendanceNo: string | null
  idNumber: string | null
  householdRegistration: string | null
  phone: string | null
  currentAddress: string | null
  dailyWage: string | null
  monthlyAllowance: string | null
  insuranceTypes: string[]
  insertedAt: Date
  updatedAt: Date
}

// 客户/供应商审计白名单同构：任一侧 meta 派生即可（spec.test 断言两侧一致）
const PARTY_AUDIT = auditFieldsOf(customerResourceMeta())
const EMP_AUDIT_SPEC = auditSpecOf(employeeResourceMeta())
const EMP_AUDIT = EMP_AUDIT_SPEC.fields

export function createCustomerService(db: Kysely<Database>, registry: Registry) {
  return createPartyKind(db, {
    table: 'sal_customers',
    resource: 'sal_customer',
    label: '客户',
    target: registry.authzTarget(CUSTOMER_RESOURCE_NAME),
    meta: customerResourceMeta(),
    notFound: '客户不存在',
    materialCheck: true,
    addressPartyType: 'CUSTOMER',
  })
}

export function createSupplierService(db: Kysely<Database>, registry: Registry) {
  return createPartyKind(db, {
    table: 'pur_supplier',
    resource: 'pur_supplier',
    label: '供应商',
    target: registry.authzTarget(SUPPLIER_RESOURCE_NAME),
    meta: supplierResourceMeta(),
    notFound: '供应商不存在',
    materialCheck: false,
    addressPartyType: 'SUPPLIER',
  })
}

function createPartyKind(
  db: Kysely<Database>,
  opts: {
    table: 'sal_customers' | 'pur_supplier'
    resource: string
    label: string
    target: AuthzTarget
    meta: ReturnType<typeof customerResourceMeta>
    notFound: string
    materialCheck: boolean
    addressPartyType: 'CUSTOMER' | 'SUPPLIER'
  },
) {
  async function get(permit: Permit, id: string): Promise<Party> {
    const row = await loadAuthorized({
      db,
      permit,
      target: opts.target,
      table: opts.table,
      id,
      notFoundMessage: opts.notFound,
    })
    return mapParty(row as never)
  }

  async function list(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
      db,
      permit,
      target: opts.target,
      alias: opts.table,
      resource: opts.meta,
      source: sql` FROM ${sql.table(opts.table)}`,
      select: sql`SELECT id, code, name, short_name, inserted_at, updated_at`,
      defaultOrder: sql`"code" ASC, "id" ASC`,
      query,
      mapRow: (r) =>
        mapParty({
          id: String(r.id),
          code: String(r.code),
          name: String(r.name),
          short_name: r.short_name == null ? null : String(r.short_name),
          inserted_at: r.inserted_at as Date,
          updated_at: r.updated_at as Date,
        }),
    })
  }

  async function create(
    permit: Permit,
    input: { code: string; name: string; shortName?: string | null },
  ): Promise<Party> {
    const { code, name, shortName } = normalizeParty(input.code, input.name, input.shortName)
    return withTx(db, async (trx) => {
      try {
        const row = await trx
          .insertInto(opts.table)
          .values({ code, name, short_name: shortName })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapParty(row)
        await writeAudit(trx, permit.actor, {
          resource: opts.resource,
          recordId: item.id,
          recordLabel: item.name,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(partySnap(item), PARTY_AUDIT),
        })
        return item
      } catch (err) {
        throw mapWriteError(err, `创建${opts.label}失败`, [
          { code: '23505', message: `${opts.label}编号已存在` },
        ])
      }
    })
  }

  async function update(
    permit: Permit,
    id: string,
    input: {
      code?: string
      name?: string
      shortName?: string | null
      shortNamePresent?: boolean
    },
  ): Promise<Party> {
    return withTx(db, async (trx) => {
      const locked = await loadAuthorized({
        db: trx,
        permit,
        target: opts.target,
        table: opts.table,
        id,
        forUpdate: true,
        notFoundMessage: opts.notFound,
      })
      const before = mapParty(locked as never)
      const { code, name, shortName } = normalizeParty(
        input.code ?? before.code,
        input.name ?? before.name,
        input.shortNamePresent ? input.shortName : before.shortName,
      )
      const after = { ...before, code, name, shortName }
      const changes = auditDiff(partySnap(before), partySnap(after), PARTY_AUDIT)
      if (Object.keys(changes).length === 0) return before
      try {
        const row = await trx
          .updateTable(opts.table)
          .set({
            code,
            name,
            short_name: shortName,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapParty(row)
        await writeAudit(trx, permit.actor, {
          resource: opts.resource,
          recordId: item.id,
          recordLabel: item.name,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
        return item
      } catch (err) {
        throw mapWriteError(err, `更新${opts.label}失败`, [
          { code: '23505', message: `${opts.label}编号已存在` },
        ])
      }
    })
  }

  async function remove(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const locked = await loadAuthorized({
        db: trx,
        permit,
        target: opts.target,
        table: opts.table,
        id,
        forUpdate: true,
        notFoundMessage: opts.notFound,
      })
      if (opts.materialCheck) {
        const linked = await trx
          .selectFrom('inv_material')
          .select('id')
          .where('customer_id', '=', id)
          .executeTakeFirst()
        if (linked) throw new ApiError('conflict', '存在关联物料,不能删除')
      }
      const item = mapParty(locked as never)
      await deleteAddressesForParty(trx, opts.addressPartyType, id)
      try {
        await trx.deleteFrom(opts.table).where('id', '=', id).execute()
      } catch (err) {
        throw mapWriteError(err, `删除${opts.label}失败`, [
          { code: '23503', message: `${opts.label}已被业务数据引用,不可删除` },
        ])
      }
      await writeAudit(trx, permit.actor, {
        resource: opts.resource,
        recordId: item.id,
        recordLabel: item.name,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(partySnap(item), PARTY_AUDIT),
      })
    })
  }

  return { get, list, create, update, remove }
}

export type CustomerService = ReturnType<typeof createCustomerService>
export type SupplierService = ReturnType<typeof createSupplierService>

export function createEmployeeService(
  db: Kysely<Database>,
  numbering: NumberingService,
  registry: Registry,
) {
  const target = registry.authzTarget(EMPLOYEE_RESOURCE_NAME)

  async function get(permit: Permit, id: string): Promise<Employee> {
    const row = await loadAuthorized({
      db,
      permit,
      target,
      table: 'hr_employees',
      id,
      notFoundMessage: '员工不存在',
    })
    return mapEmployee(row as never)
  }

  async function list(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
      db,
      permit,
      target,
      alias: 'hr_employees',
      resource: employeeResourceMeta(),
      source: sql` FROM hr_employees`,
      select: sql`SELECT id,code,name,attendance_no,id_number,household_registration,phone,current_address,
daily_wage,monthly_allowance,inserted_at,updated_at,insurance_types`,
      defaultOrder: sql`"code" ASC, "id" ASC`,
      query,
      mapRow: (r) => mapEmployee(r as never),
    })
  }

  async function create(
    permit: Permit,
    input: {
      code?: string | null
      name: string
      attendanceNo?: string | null
      idNumber?: string | null
      householdRegistration?: string | null
      phone?: string | null
      currentAddress?: string | null
      dailyWage?: string | null
      monthlyAllowance?: string | null
      insuranceTypes?: string[]
    },
  ): Promise<Employee> {
    let code = input.code?.trim() || ''
    if (!code) {
      code = await numbering.next({ resource: 'hr.employee' })
    }
    const normalized = normalizeEmployee({
      code,
      name: input.name,
      attendanceNo: input.attendanceNo ?? null,
      idNumber: input.idNumber ?? null,
      householdRegistration: input.householdRegistration ?? null,
      phone: input.phone ?? null,
      currentAddress: input.currentAddress ?? null,
      dailyWage: input.dailyWage ?? null,
      monthlyAllowance: input.monthlyAllowance ?? null,
      insuranceTypes: input.insuranceTypes ?? [],
    })
    return withTx(db, async (trx) => {
      try {
        const row = await trx
          .insertInto('hr_employees')
          .values({
            code: normalized.code,
            name: normalized.name,
            attendance_no: normalized.attendanceNo,
            id_number: normalized.idNumber,
            household_registration: normalized.householdRegistration,
            phone: normalized.phone,
            current_address: normalized.currentAddress,
            daily_wage: normalized.dailyWage,
            monthly_allowance: normalized.monthlyAllowance,
            insurance_types: lowerInsurance(normalized.insuranceTypes),
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapEmployee(row)
        await writeAudit(trx, permit.actor, {
          resource: 'hr_employee',
          recordId: item.id,
          recordLabel: item.name,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(empSnap(item), EMP_AUDIT),
          sensitiveFields: EMP_AUDIT_SPEC.sensitiveFields,
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '创建员工失败', [
          { code: '23505', constraint: 'attendance', message: '考勤机编号已存在' },
          { code: '23505', constraint: 'id_number', message: '身份证号已存在' },
          { code: '23505', message: '员工编号已存在' },
        ])
      }
    })
  }

  /**
   * 考勤导入自动建档接缝（调用方持 trx）。
   * 分支内二次授权：调用方在分支里再取一张 `hr.employee:create` 的 Permit（spec §7），
   * 本函数只消费凭证不做判定。
   */
  async function autoCreateForAttendance(
    trx: TrxHandle,
    permit: Permit,
    attendanceNo: string,
  ): Promise<{ id: string; code: string; name: string; attendanceNo: string }> {
    const code = await numbering.nextInTx(trx, { resource: 'hr.employee' })
    const name = '[未知]'
    try {
      const emp = await trx
        .insertInto('hr_employees')
        .values({ code, name, attendance_no: attendanceNo })
        .returning('id')
        .executeTakeFirstOrThrow()
      await writeAudit(trx, permit.actor, {
        resource: 'hr_employee',
        recordId: emp.id,
        recordLabel: name,
        actionType: 'create',
        actionName: 'create',
        changes: {
          code: { to: code },
          name: { to: name },
          attendance_no: { to: attendanceNo },
        },
        sensitiveFields: EMP_AUDIT_SPEC.sensitiveFields,
      })
      return { id: emp.id, code, name, attendanceNo }
    } catch (err) {
      throw mapWriteError(err, '自动创建员工失败', [
        { code: '23505', constraint: 'attendance', message: '考勤机编号已存在' },
        { code: '23505', constraint: 'id_number', message: '身份证号已存在' },
        { code: '23505', message: '员工编号已存在' },
      ])
    }
  }

  async function update(
    permit: Permit,
    id: string,
    input: {
      code?: string
      name?: string
      attendanceNo?: string | null
      attendanceNoPresent?: boolean
      idNumber?: string | null
      idNumberPresent?: boolean
      householdRegistration?: string | null
      householdRegistrationPresent?: boolean
      phone?: string | null
      phonePresent?: boolean
      currentAddress?: string | null
      currentAddressPresent?: boolean
      dailyWage?: string | null
      dailyWagePresent?: boolean
      monthlyAllowance?: string | null
      monthlyAllowancePresent?: boolean
      insuranceTypes?: string[]
      insuranceTypesPresent?: boolean
    },
  ): Promise<Employee> {
    return withTx(db, async (trx) => {
      const locked = await loadAuthorized({
        db: trx,
        permit,
        target,
        table: 'hr_employees',
        id,
        forUpdate: true,
        notFoundMessage: '员工不存在',
      })
      const before = mapEmployee(locked as never)
      const draft = {
        code: input.code ?? before.code,
        name: input.name ?? before.name,
        attendanceNo: input.attendanceNoPresent ? (input.attendanceNo ?? null) : before.attendanceNo,
        idNumber: input.idNumberPresent ? (input.idNumber ?? null) : before.idNumber,
        householdRegistration: input.householdRegistrationPresent
          ? (input.householdRegistration ?? null)
          : before.householdRegistration,
        phone: input.phonePresent ? (input.phone ?? null) : before.phone,
        currentAddress: input.currentAddressPresent
          ? (input.currentAddress ?? null)
          : before.currentAddress,
        dailyWage: input.dailyWagePresent ? (input.dailyWage ?? null) : before.dailyWage,
        monthlyAllowance: input.monthlyAllowancePresent
          ? (input.monthlyAllowance ?? null)
          : before.monthlyAllowance,
        insuranceTypes: input.insuranceTypesPresent
          ? (input.insuranceTypes ?? [])
          : before.insuranceTypes,
      }
      const normalized = normalizeEmployee(draft)
      const afterBase = { ...before, ...normalized }
      const changes = auditDiff(empSnap(before), empSnap(afterBase), EMP_AUDIT)
      if (Object.keys(changes).length === 0) return before
      try {
        const row = await trx
          .updateTable('hr_employees')
          .set({
            code: normalized.code,
            name: normalized.name,
            attendance_no: normalized.attendanceNo,
            id_number: normalized.idNumber,
            household_registration: normalized.householdRegistration,
            phone: normalized.phone,
            current_address: normalized.currentAddress,
            daily_wage: normalized.dailyWage,
            monthly_allowance: normalized.monthlyAllowance,
            insurance_types: lowerInsurance(normalized.insuranceTypes),
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapEmployee(row)
        await writeAudit(trx, permit.actor, {
          resource: 'hr_employee',
          recordId: item.id,
          recordLabel: item.name,
          actionType: 'update',
          actionName: 'update',
          changes,
          sensitiveFields: EMP_AUDIT_SPEC.sensitiveFields,
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '更新员工失败', [
          { code: '23505', constraint: 'attendance', message: '考勤机编号已存在' },
          { code: '23505', constraint: 'id_number', message: '身份证号已存在' },
          { code: '23505', message: '员工编号已存在' },
        ])
      }
    })
  }

  async function remove(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const locked = await loadAuthorized({
        db: trx,
        permit,
        target,
        table: 'hr_employees',
        id,
        forUpdate: true,
        notFoundMessage: '员工不存在',
      })
      const item = mapEmployee(locked as never)
      try {
        await trx.deleteFrom('hr_employees').where('id', '=', id).execute()
      } catch (err) {
        throw mapWriteError(err, '删除员工失败', [
          { code: '23503', message: '员工已被业务数据引用,不可删除' },
        ])
      }
      await writeAudit(trx, permit.actor, {
        resource: 'hr_employee',
        recordId: item.id,
        recordLabel: item.name,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(empSnap(item), EMP_AUDIT),
        sensitiveFields: EMP_AUDIT_SPEC.sensitiveFields,
      })
    })
  }

  return { get, list, create, autoCreateForAttendance, update, remove }
}

export type EmployeeService = ReturnType<typeof createEmployeeService>

function normalizeParty(code: string, name: string, shortName?: string | null) {
  code = code.trim()
  name = name.trim()
  const fields: Record<string, string[]> = {}
  if (!code || [...code].length > 32) fields.code = ['不能为空且最多 32 个字符']
  if (!name || [...name].length > 128) fields.name = ['不能为空且最多 128 个字符']
  let sn: string | null = null
  if (shortName !== undefined && shortName !== null) {
    const t = shortName.trim()
    sn = t === '' ? null : t
    if (sn && [...sn].length > 64) fields.shortName = ['最多 64 个字符']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('参数不合法', fields)
  }
  return { code, name, shortName: sn }
}

function normalizeEmployee(input: {
  code: string
  name: string
  attendanceNo: string | null
  idNumber: string | null
  householdRegistration: string | null
  phone: string | null
  currentAddress: string | null
  dailyWage: string | null
  monthlyAllowance: string | null
  insuranceTypes: string[]
}) {
  const code = input.code.trim()
  const name = input.name.trim()
  const fields: Record<string, string[]> = {}
  if (!code || [...code].length > 32) fields.code = ['不能为空且最多 32 个字符']
  if (!name || [...name].length > 64) fields.name = ['不能为空且最多 64 个字符']
  const trimNull = (v: string | null, max: number, field: string) => {
    if (v === null || v === undefined) return null
    const t = v.trim()
    if (!t) return null
    if ([...t].length > max) fields[field] = [`最多 ${max} 个字符`]
    return t
  }
  const attendanceNo = trimNull(input.attendanceNo, 64, 'attendanceNo')
  const idNumber = trimNull(input.idNumber, 32, 'idNumber')
  const householdRegistration = trimNull(input.householdRegistration, 128, 'householdRegistration')
  const phone = trimNull(input.phone, 32, 'phone')
  const currentAddress = trimNull(input.currentAddress, 256, 'currentAddress')
  const parseMoney = (v: string | null, field: string) => {
    if (v === null || v === undefined || v.trim() === '') return null
    if (!isDecimalString(v.trim()) || !decimal(v.trim()).gte(0)) {
      fields[field] = ['必须是非负十进制字符串']
      return null
    }
    return decimal(v.trim()).toFixed()
  }
  const dailyWage = parseMoney(input.dailyWage, 'dailyWage')
  const monthlyAllowance = parseMoney(input.monthlyAllowance, 'monthlyAllowance')
  const insuranceTypes: string[] = []
  for (const raw of input.insuranceTypes) {
    const wire = raw.trim().toUpperCase()
    if (!INSURANCE_WIRE.has(wire)) {
      fields.insuranceTypes = ['包含未知参保类型']
      break
    }
    if (!insuranceTypes.includes(wire)) insuranceTypes.push(wire)
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('员工参数不合法', fields)
  }
  return {
    code,
    name,
    attendanceNo,
    idNumber,
    householdRegistration,
    phone,
    currentAddress,
    dailyWage,
    monthlyAllowance,
    insuranceTypes,
  }
}

function lowerInsurance(types: string[]): string[] {
  return types.map((t) => t.toLowerCase())
}

function mapParty(row: {
  id: string
  code: string
  name: string
  short_name: string | null
  inserted_at: Date | string
  updated_at: Date | string
}): Party {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    shortName: row.short_name,
    insertedAt: toDate(row.inserted_at),
    updatedAt: toDate(row.updated_at),
  }
}

function mapEmployee(row: {
  id: string
  code: string
  name: string
  attendance_no: string | null
  id_number: string | null
  household_registration: string | null
  phone: string | null
  current_address: string | null
  daily_wage: string | number | null
  monthly_allowance: string | number | null
  insurance_types: string[] | null
  inserted_at: Date | string
  updated_at: Date | string
}): Employee {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    attendanceNo: row.attendance_no,
    idNumber: row.id_number,
    householdRegistration: row.household_registration,
    phone: row.phone,
    currentAddress: row.current_address,
    dailyWage: row.daily_wage == null ? null : decimal(String(row.daily_wage)).toFixed(),
    monthlyAllowance:
      row.monthly_allowance == null ? null : decimal(String(row.monthly_allowance)).toFixed(),
    insuranceTypes: (row.insurance_types ?? []).map((t) => t.toUpperCase()),
    insertedAt: toDate(row.inserted_at),
    updatedAt: toDate(row.updated_at),
  }
}

function partySnap(p: Party): Record<string, unknown> {
  return { code: p.code, name: p.name, short_name: p.shortName }
}

function empSnap(e: Employee): Record<string, unknown> {
  return {
    code: e.code,
    name: e.name,
    attendance_no: e.attendanceNo,
    id_number: e.idNumber,
    household_registration: e.householdRegistration,
    phone: e.phone,
    current_address: e.currentAddress,
    daily_wage: e.dailyWage,
    monthly_allowance: e.monthlyAllowance,
    insurance_types: e.insuranceTypes.map((t) => t.toLowerCase()),
  }
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v)
}
