/**
 * 物料口径（platform/posting · W0 领域基元）
 *
 * 合并 trading `loadMaterialSnap`+`convertToBaseQty`、inventory `projectStockItem`、
 * manufacturing `deriveItemProjection`：
 * - 同一 SQL join（物料 + 单位 + 转换系数）
 * - base_qty 6 位 half-up 一处（`roundBaseQty` / `DECIMAL_SCALE.baseQty`）
 * - 报错文案按调用点 label/字段参数化，字节不变
 *
 * platform 自带 SQL，禁止 import `~/modules/*`。
 */
import {
  decimal,
  isDecimalString,
  roundBaseQty,
  toDecimalString,
  type Decimal,
} from '@synie/shared'
import { sql } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'

// ---------------------------------------------------------------------------
// 核心：同一 join + 6 位折算
// ---------------------------------------------------------------------------

interface MaterialUnitJoinRow {
  code: string
  name: string
  spec: string | null
  customer_part_no: string | null
  default_unit_id: string
  is_customer_material: boolean
  customer_id: string | null
  material_type: string
  unit_name: string
  factor: string | null
}

/** 物料 + 单位 + 转换系数（LEFT JOIN）；物料或单位缺失时返回 null */
export async function loadMaterialUnitJoin(
  db: DbHandle,
  materialId: string,
  unitId: string,
): Promise<MaterialUnitJoinRow | null> {
  const rows = await sql<MaterialUnitJoinRow>`
    SELECT m.code, m.name, m.spec, m.customer_part_no, m.default_unit_id,
      m.is_customer_material, m.customer_id, m.material_type,
      u.name AS unit_name, mu.factor::text AS factor
    FROM inv_material m
    JOIN bas_unit u ON u.id = ${unitId}::uuid
    LEFT JOIN inv_material_unit mu ON mu.material_id = m.id AND mu.unit_id = u.id
    WHERE m.id = ${materialId}::uuid
  `.execute(db)
  return rows.rows[0] ?? null
}

function factorOf(raw: string | null | undefined): Decimal | null {
  if (raw === null || raw === undefined) return null
  return decimal(raw)
}

/**
 * qty → 默认单位口径 base_qty。
 * - 已是默认单位：原样返回（调用方若需强制 6 位可再 `roundBaseQty`）
 * - 转换单位：`qty / factor`，half-up 6 位（`roundBaseQty` 唯一定义）
 * - factor 无效：返回 null，由调用方按自身文案抛错
 */
export function qtyToBase(
  qty: Decimal,
  unitId: string,
  defaultUnitId: string,
  factor: Decimal | null,
): Decimal | null {
  if (unitId === defaultUnitId) return qty
  if (factor != null && factor.gt(0)) {
    return decimal(roundBaseQty(qty.div(factor)))
  }
  return null
}

// ---------------------------------------------------------------------------
// trading：loadMaterialSnap + convertToBaseQty
// ---------------------------------------------------------------------------

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
  materialType: string
}

export async function loadMaterialSnap(
  db: DbHandle,
  materialId: string,
  unitId: string,
): Promise<MaterialSnap> {
  const row = await loadMaterialUnitJoin(db, materialId, unitId)
  if (!row) {
    throw ApiError.validation('物料参数不合法', { materialId: ['物料或单位不存在'] })
  }
  const factor = factorOf(row.factor)
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
    materialType: row.material_type,
  }
}

export function convertToBaseQty(qty: Decimal, unitId: string, snap: MaterialSnap): Decimal {
  const base = qtyToBase(qty, unitId, snap.defaultUnitId, snap.factor)
  if (base !== null) return base
  throw ApiError.validation('物料参数不合法', {
    unitId: ['单位必须是物料默认单位或其单位转换单位'],
  })
}

// ---------------------------------------------------------------------------
// inventory：projectStockItem
// ---------------------------------------------------------------------------

export interface StockItemProjection {
  baseQty: Decimal
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitName: string
}

/**
 * 物料默认单位口径折算：qty / factor（转换单位）或 qty 本身（默认单位）。
 * factor 语义：1 默认单位 = factor 该单位。
 * `label` 拼进校验标题（如「库存单据条目」→「库存单据条目参数不合法」）。
 */
export async function projectStockItem(
  db: DbHandle,
  materialId: string,
  unitId: string,
  qty: Decimal,
  label: string,
): Promise<StockItemProjection> {
  const row = await loadMaterialUnitJoin(db, materialId, unitId)
  if (!row) {
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
  // 手工出入库/调拨/盘点等库存单据只接受库存类物料（虚拟/资产不进库存数量账）
  if (row.material_type !== 'STOCK') {
    throw ApiError.validation(`${label}参数不合法`, {
      materialId: ['仅库存类物料可进库存单据'],
    })
  }
  const factor = factorOf(row.factor)
  const baseQty = qtyToBase(qty, unitId, row.default_unit_id, factor)
  if (baseQty === null) {
    throw ApiError.validation(`${label}参数不合法`, {
      unitId: ['单位必须是物料默认单位或其单位转换单位'],
    })
  }
  return {
    baseQty,
    materialCode: row.code,
    materialName: row.name,
    materialSpec: row.spec,
    unitName: row.unit_name,
  }
}

// ---------------------------------------------------------------------------
// manufacturing：deriveItemProjection
// ---------------------------------------------------------------------------

export interface MfgItemProjection {
  baseQty: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitName: string
}

/** 物料/单位折算默认单位口径（6 位）；qty 字符串入口对齐原 manufacturing 签名与文案 */
export async function deriveItemProjection(
  db: DbHandle,
  materialId: string,
  unitId: string,
  qtyRaw: string,
): Promise<MfgItemProjection> {
  // 原 parsePositiveQty 内联（field 固定 qty），文案字节不变
  if (!isDecimalString(qtyRaw)) {
    throw ApiError.validation('数量参数不合法', { qty: ['必须为有效十进制数字'] })
  }
  const qtyDec = decimal(qtyRaw)
  if (!qtyDec.gt(0)) {
    throw ApiError.validation('数量参数不合法', { qty: ['必须大于 0'] })
  }
  const qty = toDecimalString(qtyDec)

  const row = await loadMaterialUnitJoin(db, materialId, unitId)
  if (!row) {
    const material = await db
      .selectFrom('inv_material')
      .select('id')
      .where('id', '=', materialId)
      .executeTakeFirst()
    if (!material) {
      throw ApiError.validation('需求行参数不合法', { materialId: ['物料不存在'] })
    }
    const unit = await db
      .selectFrom('bas_unit')
      .select('id')
      .where('id', '=', unitId)
      .executeTakeFirst()
    if (!unit) {
      throw ApiError.validation('需求行参数不合法', { unitId: ['单位不存在'] })
    }
    // 物料与单位均存在时 join 必有行；防御
    throw ApiError.validation('需求行参数不合法', {
      unitId: ['单位必须是物料默认单位或其单位转换单位'],
    })
  }

  // 6 位精度舍入后以 toDecimalString 出 wire（去尾零策略对齐原 roundBaseQty→decimal→toDecimalString）
  let baseQty = toDecimalString(decimal(roundBaseQty(qty)))
  if (unitId !== row.default_unit_id) {
    const factor = factorOf(row.factor)
    if (factor === null) {
      throw ApiError.validation('需求行参数不合法', {
        unitId: ['单位必须是物料默认单位或其单位转换单位'],
      })
    }
    if (!factor.gt(0)) {
      throw new ApiError('conflict', '物料单位转换系数必须大于零')
    }
    baseQty = toDecimalString(decimal(roundBaseQty(decimal(qty).div(factor))))
  }
  return {
    baseQty,
    materialCode: row.code,
    materialName: row.name,
    materialSpec: row.spec,
    unitName: row.unit_name,
  }
}
