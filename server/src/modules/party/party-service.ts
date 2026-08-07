/**
 * 客户 / 供应商 / 员工（全局主数据，无公司列 → global 形态）。
 *
 * 三者均为 `platform/standard` 派生服务（CRUD/批量/审计/授权/自动取号按 meta 派生），
 * 本文件只留领域不变量——简称空串归一、删除前的关联物料保护与地址级联清理；
 * 员工侧的空串归一（唯一索引不容空串撞车）、非负工钱与参保类型集合语义。
 *
 * 员工的考勤自动建档接缝 `autoCreateForAttendance`（调用方持 trx、跨域二次授权）
 * 不在标准词表内，作为附加函数挂在派生服务对象上。
 */
import { decimal, isDecimalString } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { writeAudit } from '~/platform/audit/write.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { createStandardService, type StandardService } from '~/platform/standard/service.ts'
import { mapWriteError, type PgWriteMapping } from '~/db/dberr.ts'
import { deleteAddressesForParty } from './address-service.ts'
import {
  CUSTOMER_RESOURCE_NAME,
  EMPLOYEE_RESOURCE_NAME,
  SUPPLIER_RESOURCE_NAME,
  INSURANCE_WIRE,
} from './meta.ts'

export interface Party {
  id: string
  code: string
  name: string
  shortName: string | null
  insertedAt: Date
  updatedAt: Date
  [key: string]: unknown
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
  [key: string]: unknown
}

export function createCustomerService(db: Kysely<Database>, registry: Registry): StandardService<Party> {
  return createPartyKind(db, registry, {
    resource: CUSTOMER_RESOURCE_NAME,
    label: '客户',
    notFound: '客户不存在',
    materialCheck: true,
    addressPartyType: 'CUSTOMER',
  })
}

export function createSupplierService(db: Kysely<Database>, registry: Registry): StandardService<Party> {
  return createPartyKind(db, registry, {
    resource: SUPPLIER_RESOURCE_NAME,
    label: '供应商',
    notFound: '供应商不存在',
    materialCheck: false,
    addressPartyType: 'SUPPLIER',
  })
}

/**
 * 客户/供应商共用的标准派生工厂（两侧字段与不变量同构，仅文案与删除保护不同）。
 *
 * 领域不变量：
 * - 简称空串归一为 null（手写 normalizeParty 的既有语义；zod 已 trim）
 * - 客户删除前查关联物料（inv_material.customer_id）
 * - 删除主体级联清多态地址（无 DB 外键）
 */
function createPartyKind(
  db: Kysely<Database>,
  registry: Registry,
  opts: {
    resource: string
    label: string
    notFound: string
    materialCheck: boolean
    addressPartyType: 'CUSTOMER' | 'SUPPLIER'
  },
): StandardService<Party> {
  return createStandardService<Party>({
    db,
    registry,
    resource: opts.resource,
    notFound: opts.notFound,
    defaultOrder: sql`"code" ASC, "id" ASC`,
    writeErrors: [
      { code: '23505', message: `${opts.label}编号已存在` },
      { code: '23503', message: `${opts.label}已被业务数据引用,不可删除` },
    ],
    hooks: {
      validate: ({ draft }) => {
        if (draft.shortName === '') draft.shortName = null
        // 客户/供应商编码保留手填（ADR 2026-08-06-system-generated-numbering），但会作为段
        // 嵌入其他单据编号并渗入按公司计数器的分桶键——禁分隔符/空白
        if (typeof draft.code === 'string' && !/^[A-Za-z0-9]+$/.test(draft.code)) {
          throw ApiError.validation(`${opts.label}参数不合法`, { code: ['只能包含字母和数字'] })
        }
      },
      beforeDelete: async (trx, { item }) => {
        const id = String(item.id)
        if (opts.materialCheck) {
          const linked = await trx
            .selectFrom('inv_material')
            .select('id')
            .where('customer_id', '=', id)
            .executeTakeFirst()
          if (linked) throw new ApiError('conflict', '存在关联物料,不能删除')
        }
        await deleteAddressesForParty(trx, opts.addressPartyType, id)
      },
    },
  })
}

export type CustomerService = ReturnType<typeof createCustomerService>
export type SupplierService = ReturnType<typeof createSupplierService>

/** 员工唯一/外键冲突文案（三条唯一索引 + 业务引用保护，逐字沿用手写口径） */
const EMPLOYEE_WRITE_ERRORS: readonly PgWriteMapping[] = [
  { code: '23505', constraint: 'attendance', message: '考勤机编号已存在' },
  { code: '23505', constraint: 'id_number', message: '身份证号已存在' },
  { code: '23505', message: '员工编号已存在' },
  { code: '23503', message: '员工已被业务数据引用,不可删除' },
]

/** 员工服务：标准派生 + 考勤自动建档接缝（不在标准词表内，附加在服务对象上） */
export type EmployeeService = StandardService<Employee> & {
  autoCreateForAttendance: (
    trx: TrxHandle,
    permit: Permit,
    attendanceNo: string,
  ) => Promise<{ id: string; code: string; name: string; attendanceNo: string }>
}

export function createEmployeeService(
  db: Kysely<Database>,
  numbering: NumberingService,
  registry: Registry,
): EmployeeService {
  const service = createStandardService<Employee>({
    db,
    registry,
    resource: EMPLOYEE_RESOURCE_NAME,
    notFound: '员工不存在',
    defaultOrder: sql`"code" ASC, "id" ASC`,
    // 编号留空自动取号（meta.numbering，规则资源键 hr.employee）
    numbering: { service: numbering, field: 'code' },
    writeErrors: EMPLOYEE_WRITE_ERRORS,
    hooks: { validate: normalizeEmployeeDraft },
  })
  const auditResource = service.meta.table
  const sensitiveFields = service.meta.audit?.sensitiveFields

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
    const code = await numbering.nextInTx(trx, { resource: service.meta.permissionPrefix })
    const name = '[未知]'
    try {
      const emp = await trx
        .insertInto('hr_employees')
        .values({ code, name, attendance_no: attendanceNo })
        .returning('id')
        .executeTakeFirstOrThrow()
      await writeAudit(trx, permit.actor, {
        resource: auditResource,
        recordId: emp.id,
        recordLabel: name,
        actionType: 'create',
        actionName: 'create',
        changes: {
          code: { to: code },
          name: { to: name },
          attendance_no: { to: attendanceNo },
        },
        sensitiveFields,
      })
      return { id: emp.id, code, name, attendanceNo }
    } catch (err) {
      throw mapWriteError(err, '自动创建员工失败', EMPLOYEE_WRITE_ERRORS)
    }
  }

  return Object.assign(service, { autoCreateForAttendance })
}

/**
 * 员工领域不变量（长度/必填/枚举白名单已由 meta 派生 schema 承担）：
 * - 可空文本空串归一为 null（attendance_no / id_number 有唯一索引，空串会互撞）
 * - 日薪与月补贴非负
 * - 参保类型是集合（去重；wire 大写由内核规范化）
 * - 编号只在创建时可留空（自动取号），编辑不可清空
 */
function normalizeEmployeeDraft(ctx: {
  action: 'create' | 'update'
  draft: Record<string, unknown>
}): void {
  const { action, draft } = ctx
  const fields: Record<string, string[]> = {}
  for (const key of [
    'attendanceNo',
    'idNumber',
    'householdRegistration',
    'phone',
    'currentAddress',
  ]) {
    const value = draft[key]
    if (typeof value === 'string' && value.trim() === '') draft[key] = null
  }
  if (action === 'update' && String(draft.code ?? '').trim() === '') {
    fields.code = ['不能为空']
  }
  // 金额到此已被内核规范化为十进制字符串（非法十进制在 schema/规范化处即抛）
  for (const key of ['dailyWage', 'monthlyAllowance']) {
    const value = draft[key]
    if (value === null || value === undefined) continue
    const text = String(value).trim()
    if (!isDecimalString(text) || !decimal(text).gte(0)) {
      fields[key] = ['必须是非负十进制字符串']
    }
  }
  const types = draft.insuranceTypes
  if (Array.isArray(types)) {
    const unique: string[] = []
    for (const raw of types) {
      const wire = String(raw).trim().toUpperCase()
      if (!INSURANCE_WIRE.has(wire)) {
        fields.insuranceTypes = ['包含未知参保类型']
        break
      }
      if (!unique.includes(wire)) unique.push(wire)
    }
    if (!fields.insuranceTypes) draft.insuranceTypes = unique
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('员工参数不合法', fields)
  }
}
