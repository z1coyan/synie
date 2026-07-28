import { decimal, isDecimalString, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { mapWriteError } from '../base/dberr.ts'
import { listFromSource } from '../base/list.ts'
import {
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

const PARTY_AUDIT = ['code', 'name', 'short_name'] as const
const EMP_AUDIT = [
  'code',
  'name',
  'attendance_no',
  'id_number',
  'household_registration',
  'phone',
  'current_address',
  'daily_wage',
  'monthly_allowance',
  'insurance_types',
] as const

export function createCustomerService(db: Kysely<Database>) {
  return createPartyKind(db, {
    table: 'sal_customers',
    resource: 'sal_customer',
    label: '客户',
    meta: customerResourceMeta(),
    notFound: '客户不存在',
    materialCheck: true,
  })
}

export function createSupplierService(db: Kysely<Database>) {
  return createPartyKind(db, {
    table: 'pur_supplier',
    resource: 'pur_supplier',
    label: '供应商',
    meta: supplierResourceMeta(),
    notFound: '供应商不存在',
    materialCheck: false,
  })
}

function createPartyKind(
  db: Kysely<Database>,
  opts: {
    table: 'sal_customers' | 'pur_supplier'
    resource: string
    label: string
    meta: ReturnType<typeof customerResourceMeta>
    notFound: string
    materialCheck: boolean
  },
) {
  async function get(id: string): Promise<Party> {
    const row = await db.selectFrom(opts.table).selectAll().where('id', '=', id).executeTakeFirst()
    if (!row) throw new ApiError('not_found', opts.notFound)
    return mapParty(row)
  }

  async function list(query: Partial<ListQuery>) {
    return listFromSource({
      db,
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
    actor: Actor,
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
        await writeAudit(trx, actor, {
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
    actor: Actor,
    id: string,
    input: {
      code?: string
      name?: string
      shortName?: string | null
      shortNamePresent?: boolean
    },
  ): Promise<Party> {
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom(opts.table)
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', opts.notFound)
      const before = mapParty(locked)
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
        await writeAudit(trx, actor, {
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

  async function remove(actor: Actor, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom(opts.table)
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', opts.notFound)
      if (opts.materialCheck) {
        const linked = await trx
          .selectFrom('inv_material')
          .select('id')
          .where('customer_id', '=', id)
          .executeTakeFirst()
        if (linked) throw new ApiError('conflict', '存在关联物料,不能删除')
      }
      const item = mapParty(locked)
      try {
        await trx.deleteFrom(opts.table).where('id', '=', id).execute()
      } catch (err) {
        throw mapWriteError(err, `删除${opts.label}失败`, [
          { code: '23503', message: `${opts.label}已被业务数据引用,不可删除` },
        ])
      }
      await writeAudit(trx, actor, {
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

export function createEmployeeService(db: Kysely<Database>, numbering: NumberingService) {
  async function get(id: string): Promise<Employee> {
    const row = await db.selectFrom('hr_employees').selectAll().where('id', '=', id).executeTakeFirst()
    if (!row) throw new ApiError('not_found', '员工不存在')
    return mapEmployee(row)
  }

  async function list(query: Partial<ListQuery>) {
    return listFromSource({
      db,
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
    actor: Actor,
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
        await writeAudit(trx, actor, {
          resource: 'hr_employee',
          recordId: item.id,
          recordLabel: item.name,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(empSnap(item), EMP_AUDIT),
          sensitiveFields: ['id_number'],
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

  async function update(
    actor: Actor,
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
      const locked = await trx
        .selectFrom('hr_employees')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '员工不存在')
      const before = mapEmployee(locked)
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
        await writeAudit(trx, actor, {
          resource: 'hr_employee',
          recordId: item.id,
          recordLabel: item.name,
          actionType: 'update',
          actionName: 'update',
          changes,
          sensitiveFields: ['id_number'],
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

  async function remove(actor: Actor, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('hr_employees')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '员工不存在')
      const item = mapEmployee(locked)
      try {
        await trx.deleteFrom('hr_employees').where('id', '=', id).execute()
      } catch (err) {
        throw mapWriteError(err, '删除员工失败', [
          { code: '23503', message: '员工已被业务数据引用,不可删除' },
        ])
      }
      await writeAudit(trx, actor, {
        resource: 'hr_employee',
        recordId: item.id,
        recordLabel: item.name,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(empSnap(item), EMP_AUDIT),
        sensitiveFields: ['id_number'],
      })
    })
  }

  return { get, list, create, update, remove }
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
