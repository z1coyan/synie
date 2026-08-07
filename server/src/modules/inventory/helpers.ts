/**
 * 库存域共享工具：日期/状态 wire、单位折算、叶子仓校验。
 *
 * 鉴权不在本文件：路由挂 `guard(资源, 动作)`，服务收 Permit，
 * 三个执行点（listAuthorized / loadAuthorized / assertCompanyWritable）由平台拥有。
 */
import { decimal, toDecimalString, type Decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'

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

/** Unicode 码点长度：实现见 platform/posting/text（W0 T0.4） */
export { runeLen } from '~/platform/posting/text.ts'

/** 库存单据物料投影 / base_qty：实现见 platform/posting/material-qty（W0 T0.1） */
export {
  projectStockItem,
  type StockItemProjection as ItemProjection,
} from '~/platform/posting/material-qty.ts'

/** 叶子仓校验：实现见 platform/posting/warehouse（W0 T0.2） */
export { validateLeafWarehouse } from '~/platform/posting/warehouse.ts'

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
