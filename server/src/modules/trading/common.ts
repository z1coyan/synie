/**
 * 销售/采购交易链共用工具（金额 wire、日期、对手校验）。
 *
 * 鉴权不在本文件：路由挂 `guard(资源, 动作)`，服务收 Permit，
 * 三个执行点由平台拥有（工单 10 删除了本模块自造的 requirePerm 包装）。
 */
import { decimal, toDecimalString, type Decimal } from '@synie/shared'
import { sql } from 'kysely'
import { toDateOnly } from '~/db/dates.ts'
import type { DbHandle } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { lowerParty, runeLen } from '~/platform/posting/text.ts'

export { ident } from '~/db/ident.ts'
export { toDateOnly }
/** 对手类型 / 码点长度：实现见 platform/posting/text（W0 T0.4） */
export { lowerParty, runeLen }

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

/** 物料快照 / base_qty 折算：实现见 platform/posting/material-qty（W0 T0.1） */
export {
  convertToBaseQty,
  loadMaterialSnap,
  type MaterialSnap,
} from '~/platform/posting/material-qty.ts'

import type { MaterialSnap } from '~/platform/posting/material-qty.ts'

/** 单据行的物料类型准入：不在白名单即拦（行保存时校验，与引用合法性同层）。 */
export function guardMaterialType(
  snap: MaterialSnap,
  allowed: readonly string[],
  label: string,
): void {
  if (allowed.includes(snap.materialType)) return
  const message =
    allowed.length === 1 && allowed[0] === 'STOCK'
      ? '仅库存类物料可进该单据'
      : '资产类物料不能进该单据'
  throw ApiError.validation(`${label}参数不合法`, { materialId: [message] })
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


