/**
 * 库存域共享工具：日期/状态 wire、单位折算、叶子仓校验。
 *
 * 鉴权不在本文件：路由挂 `guard(资源, 动作)`，服务收 Permit，
 * 三个执行点（listAuthorized / loadAuthorized / assertCompanyWritable）由平台拥有。
 */
import { decimal, roundBaseQty, toDecimalString, type Decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'

export function toDate(value: unknown): Date {
  if (value instanceof Date) return value
  return new Date(String(value))
}

/** 业务日 wire：YYYY-MM-DD */
export function dateWire(value: Date | string): string {
  if (typeof value === 'string') return value.trim().slice(0, 10)
  const y = value.getUTCFullYear()
  const m = String(value.getUTCMonth() + 1).padStart(2, '0')
  const d = String(value.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 日期字段 ISO（Go time.Time JSON 形态：午夜 UTC） */
export function dateIso(value: Date | string): string {
  const day = dateWire(value)
  return `${day}T00:00:00Z`
}

export function datetimeIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null
  const d = value instanceof Date ? value : new Date(value)
  return d.toISOString()
}

export function upperStatus(value: string): string {
  return value.trim().toUpperCase()
}

export function lowerStatus(value: string): string {
  return value.trim().toLowerCase()
}

export function wireDecimal(value: Decimal | string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return toDecimalString(decimal(value))
}

export function trimOrNull(value: string | null | undefined): string | null {
  if (value == null) return null
  const t = value.trim()
  return t === '' ? null : t
}

export function validateOptionalText(
  fields: Record<string, string[]>,
  name: string,
  value: string | null | undefined,
  max: number,
): void {
  if (value != null && [...value].length > max) {
    fields[name] = [`最多 ${max} 个字符`]
  }
}

export function runeLen(value: string): number {
  return [...value].length
}

export interface ItemProjection {
  baseQty: Decimal
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitName: string
}

/**
 * 物料默认单位口径折算：qty / factor（转换单位）或 qty 本身（默认单位）。
 * factor 语义：1 默认单位 = factor 该单位。
 */
export async function projectStockItem(
  db: DbHandle,
  materialId: string,
  unitId: string,
  qty: Decimal,
  label: string,
): Promise<ItemProjection> {
  const row = await sql<{
    material_code: string
    material_name: string
    material_spec: string | null
    material_type: string
    default_unit_id: string
    unit_name: string
    conversion_factor: string | null
  }>`
    SELECT m.code AS material_code,
           m.name AS material_name,
           m.spec AS material_spec,
           m.material_type,
           m.default_unit_id,
           u.name AS unit_name,
           mu.factor::text AS conversion_factor
    FROM inv_material AS m
    JOIN bas_unit AS u ON u.id = ${unitId}::uuid
    LEFT JOIN inv_material_unit AS mu
      ON mu.material_id = m.id AND mu.unit_id = ${unitId}::uuid
    WHERE m.id = ${materialId}::uuid
  `.execute(db)

  if (row.rows.length === 0) {
    const mat = await db
      .selectFrom('inv_material')
      .select('id')
      .where('id', '=', materialId)
      .executeTakeFirst()
    if (!mat) {
      throw ApiError.validation(`${label}参数不合法`, { materialId: ['物料不存在'] })
    }
    throw ApiError.validation(`${label}参数不合法`, {
      unitId: ['单位必须是物料默认单位或其单位转换单位'],
    })
  }

  const r = row.rows[0]!
  // 手工出入库/调拨/盘点等库存单据只接受库存类物料（虚拟/资产不进库存数量账）
  if (r.material_type !== 'STOCK') {
    throw ApiError.validation(`${label}参数不合法`, {
      materialId: ['仅库存类物料可进库存单据'],
    })
  }
  let baseQty = qty
  if (r.default_unit_id !== unitId) {
    if (r.conversion_factor == null || !decimal(r.conversion_factor).isPositive()) {
      throw ApiError.validation(`${label}参数不合法`, {
        unitId: ['单位必须是物料默认单位或其单位转换单位'],
      })
    }
    baseQty = decimal(roundBaseQty(qty.div(decimal(r.conversion_factor))))
  }
  return {
    baseQty,
    materialCode: r.material_code,
    materialName: r.material_name,
    materialSpec: r.material_spec,
    unitName: r.unit_name,
  }
}

export async function validateLeafWarehouse(
  db: DbHandle,
  companyId: string,
  warehouseId: string,
  label: string,
  fieldName = 'warehouseId',
  checkActive = true,
): Promise<void> {
  const row = await db
    .selectFrom('inv_warehouse')
    .select(['id', 'company_id', 'is_leaf', 'active'])
    .where('id', '=', warehouseId)
    .executeTakeFirst()
  if (!row) {
    throw ApiError.validation(`${label}参数不合法`, { [fieldName]: ['仓库不存在'] })
  }
  if (row.company_id !== companyId) {
    throw ApiError.validation(`${label}参数不合法`, { [fieldName]: ['仓库不属于本公司'] })
  }
  if (!row.is_leaf) {
    throw ApiError.validation(`${label}参数不合法`, {
      [fieldName]: ['只有叶子仓库才能发生库存'],
    })
  }
  if (checkActive && !row.active) {
    throw ApiError.validation(`${label}参数不合法`, { [fieldName]: ['仓库已停用'] })
  }
}

export async function currentBookQty(
  db: DbHandle,
  warehouseId: string,
  materialId: string,
): Promise<Decimal> {
  const row = await sql<{ qty: string }>`
    SELECT COALESCE(sum(quantity), 0)::text AS qty
    FROM inv_stock_entry
    WHERE warehouse_id = ${warehouseId}::uuid
      AND material_id = ${materialId}::uuid
      AND is_cancelled = false
  `.execute(db)
  return decimal(row.rows[0]?.qty ?? '0')
}
