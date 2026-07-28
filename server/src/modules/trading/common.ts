/**
 * 销售/采购交易链共用工具（金额 wire、日期、对手校验、权限）。
 */
import { decimal, toDecimalString, type Decimal } from '@synie/shared'
import { sql, type RawBuilder } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'
import { canAccessCompany, hasPermission, type Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'

export type TradingSide = 'sales' | 'purchase'

export function parseSide(value: string): TradingSide {
  const v = value.trim().toLowerCase()
  if (v === 'sales' || v === 'purchase') return v
  throw ApiError.validation('方向不合法', { side: ['只能为 sales 或 purchase'] })
}

export function wireDecimal(value: Decimal | string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return toDecimalString(decimal(value))
}

export function wireRequiredDecimal(value: Decimal | string | number): string {
  return toDecimalString(decimal(value))
}

/** 业务日 → YYYY-MM-DD */
export function toDateOnly(value: Date | string): string {
  if (typeof value === 'string') return value.trim().slice(0, 10)
  const y = value.getUTCFullYear()
  const m = String(value.getUTCMonth() + 1).padStart(2, '0')
  const d = String(value.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function todayUTC(): string {
  return toDateOnly(new Date())
}

export function asDate(value: unknown): string {
  if (value instanceof Date) return toDateOnly(value)
  if (typeof value === 'string') return toDateOnly(value)
  return String(value).slice(0, 10)
}

export function asDateTime(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return new Date(String(value)).toISOString()
}

export function asOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return String(value)
}

export function upperStatus(value: string): string {
  return value.trim().toUpperCase()
}

export function lowerParty(value: string): string {
  return value.trim().toLowerCase()
}

export function requirePerm(actor: Actor, prefix: string, action: string, message: string): void {
  if (!hasPermission(actor, `${prefix}:${action}`)) {
    throw new ApiError('forbidden', message)
  }
}

export function requireCompanyAccess(actor: Actor, companyId: string, notFoundMessage: string): void {
  if (!canAccessCompany(actor, companyId)) {
    throw new ApiError('not_found', notFoundMessage)
  }
}

/** 白名单表名进 SQL 标识符（仅内部常量） */
export function ident(name: string): RawBuilder<unknown> {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`非法 SQL 标识符: ${name}`)
  }
  return sql.raw(name)
}

export async function partyExists(
  db: DbHandle,
  partyType: string,
  partyId: string,
): Promise<boolean> {
  const t = lowerParty(partyType)
  const row = await sql<{ exists: boolean }>`
    SELECT CASE ${t}::text
      WHEN 'customer' THEN EXISTS(SELECT 1 FROM sal_customers WHERE id=${partyId}::uuid)
      WHEN 'supplier' THEN EXISTS(SELECT 1 FROM pur_supplier WHERE id=${partyId}::uuid)
      WHEN 'company' THEN EXISTS(SELECT 1 FROM bas_company WHERE id=${partyId}::uuid)
      ELSE false END AS exists
  `.execute(db)
  return Boolean(row.rows[0]?.exists)
}

export interface MaterialSnap {
  code: string
  name: string
  unitName: string
  spec: string | null
  customerPartNo: string | null
  defaultUnitId: string
  factor: Decimal | null
  isCustomerMaterial: boolean
  customerId: string | null
}

export async function loadMaterialSnap(
  db: DbHandle,
  materialId: string,
  unitId: string,
): Promise<MaterialSnap> {
  const rows = await sql<{
    code: string
    name: string
    spec: string | null
    customer_part_no: string | null
    default_unit_id: string
    is_customer_material: boolean
    customer_id: string | null
    unit_name: string
    factor: string | null
  }>`
    SELECT m.code, m.name, m.spec, m.customer_part_no, m.default_unit_id,
      m.is_customer_material, m.customer_id, u.name AS unit_name, mu.factor::text AS factor
    FROM inv_material m
    JOIN bas_unit u ON u.id = ${unitId}::uuid
    LEFT JOIN inv_material_unit mu ON mu.material_id = m.id AND mu.unit_id = u.id
    WHERE m.id = ${materialId}::uuid
  `.execute(db)
  const row = rows.rows[0]
  if (!row) {
    throw ApiError.validation('物料参数不合法', { materialId: ['物料或单位不存在'] })
  }
  const factor = row.factor !== null && row.factor !== undefined ? decimal(row.factor) : null
  if (unitId !== row.default_unit_id && (factor === null || !factor.gt(0))) {
    throw ApiError.validation('物料参数不合法', {
      unitId: ['单位必须是物料默认单位或其单位转换单位'],
    })
  }
  return {
    code: row.code,
    name: row.name,
    unitName: row.unit_name,
    spec: row.spec,
    customerPartNo: row.customer_part_no,
    defaultUnitId: row.default_unit_id,
    factor,
    isCustomerMaterial: row.is_customer_material,
    customerId: row.customer_id,
  }
}

export function convertToBaseQty(qty: Decimal, unitId: string, snap: MaterialSnap): Decimal {
  if (unitId === snap.defaultUnitId) return qty
  if (snap.factor && snap.factor.gt(0)) {
    return qty.div(snap.factor).toDecimalPlaces(6)
  }
  throw ApiError.validation('物料参数不合法', {
    unitId: ['单位必须是物料默认单位或其单位转换单位'],
  })
}

export function guardCustomerMaterial(
  side: TradingSide,
  partyType: string,
  partyId: string,
  snap: MaterialSnap,
): void {
  if (side !== 'sales' || !snap.isCustomerMaterial) return
  if (lowerParty(partyType) !== 'customer') {
    throw ApiError.validation('条目参数不合法', {
      materialId: ['客户物料不能挂到内部公司单据'],
    })
  }
  if (!snap.customerId || snap.customerId !== partyId) {
    throw ApiError.validation('条目参数不合法', {
      materialId: ['非本客户物料,不能挂到此单据'],
    })
  }
}

export async function syncDrawingAttachments(
  db: DbHandle,
  ownerType: string,
  ownerId: string,
  materialId: string,
  companyId: string,
): Promise<void> {
  await sql`
    DELETE FROM sys_attachment WHERE owner_type = ${ownerType} AND owner_id = ${ownerId}::uuid
  `.execute(db)
  await sql`
    INSERT INTO sys_attachment(owner_type, owner_id, category, file_id, company_id)
    SELECT ${ownerType}, ${ownerId}::uuid, 'drawing', file_id, ${companyId}::uuid
    FROM sys_attachment
    WHERE owner_type = 'inv_material' AND owner_id = ${materialId}::uuid AND category = 'drawing'
  `.execute(db)
}

export function presentKey(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key)
}

export function namedRef(id: string, name: string): { id: string; name: string } {
  return { id, name }
}

export function codeNamedRef(
  id: string,
  code: string,
  name: string,
): { id: string; code: string; name: string } {
  return { id, code, name }
}

export function runeLen(s: string): number {
  return [...s].length
}
