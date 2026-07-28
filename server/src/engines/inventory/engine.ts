/**
 * 库存事实引擎：唯一写入/作废 inv_stock_entry 的应用路径。
 * 行为对齐 server-go/internal/domain/inventory/stock；事务边界归调用方。
 */
import { decimal, toDecimalString, type Decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type {
  BalanceQuery,
  BalanceRow,
  InventoryEngine,
  StockLine,
  StockVoucher,
  StockVoucherRef,
} from './types.ts'

interface BalanceKey {
  warehouseId: string
  materialId: string
}

interface WarehouseRef {
  name: string
  companyId: string
  isLeaf: boolean
  allowNegative: boolean
}

interface MaterialRef {
  name: string
}

export function createInventoryEngine(): InventoryEngine {
  return { post, cancel, balance }
}

/**
 * 校验并追加库存分录。按（仓×物料）advisory lock 串行化后做负库存校验。
 * 不 begin/commit；调用方持有 trx。
 */
export async function post(db: DbHandle, voucher: StockVoucher, lines: StockLine[]): Promise<void> {
  validateVoucher(voucher)
  if (lines.length === 0) {
    throw ApiError.validation('库存过账校验失败', { lines: ['分录不少于一行'] })
  }

  const normalized = lines.map((line, i) => normalizeLine(line, i))
  const { warehouses, materials } = await loadReferences(db, voucher.companyId, normalized, true)
  const deltas = group(normalized)
  await lockAndCheck(db, deltas, warehouses, materials)

  for (const line of normalized) {
    try {
      await db
        .insertInto('inv_stock_entry')
        .values({
          company_id: voucher.companyId,
          warehouse_id: line.warehouseId,
          material_id: line.materialId,
          quantity: toDecimalString(line.quantity),
          posting_date: toDateOnly(voucher.postingDate),
          voucher_type: voucher.type,
          voucher_id: voucher.id,
          voucher_no: voucher.no,
          remarks: line.remarks,
        })
        .execute()
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw new ApiError('internal', '写入库存分录失败', { cause: err })
    }
  }
}

/**
 * 标记来源单据下未作废分录为作废。先按（仓×物料）加锁并做负库存校验（作废=反向变动）。
 * 无 live 分录或重复调用均成功（幂等）。
 */
export async function cancel(
  db: DbHandle,
  ref: StockVoucherRef,
  cancelledAt: Date = new Date(),
): Promise<void> {
  if (!ref.type?.trim() || !ref.id) {
    throw ApiError.validation('库存作废参数不合法', {
      voucher: ['来源单据类型和 ID 必填'],
    })
  }

  let initial: Array<{
    warehouse_id: string
    material_id: string
    quantity: string
    company_id: string
  }>
  try {
    initial = await db
      .selectFrom('inv_stock_entry')
      .select(['warehouse_id', 'material_id', 'quantity', 'company_id'])
      .where('voucher_type', '=', ref.type)
      .where('voucher_id', '=', ref.id)
      .where('is_cancelled', '=', false)
      .orderBy('seq', 'asc')
      .execute()
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError('internal', '读取待作废库存分录失败', { cause: err })
  }
  if (initial.length === 0) return

  const keys: BalanceKey[] = []
  const seen = new Set<string>()
  for (const entry of initial) {
    const k = balanceKeyString({ warehouseId: entry.warehouse_id, materialId: entry.material_id })
    if (seen.has(k)) continue
    seen.add(k)
    keys.push({ warehouseId: entry.warehouse_id, materialId: entry.material_id })
  }
  sortKeys(keys)
  for (const key of keys) {
    await lockBalanceKey(db, key)
  }

  // 等锁期间可能已被并发作废：重读保持幂等
  let live: typeof initial
  try {
    live = await db
      .selectFrom('inv_stock_entry')
      .select(['warehouse_id', 'material_id', 'quantity', 'company_id'])
      .where('voucher_type', '=', ref.type)
      .where('voucher_id', '=', ref.id)
      .where('is_cancelled', '=', false)
      .orderBy('seq', 'asc')
      .execute()
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError('internal', '重读待作废库存分录失败', { cause: err })
  }
  if (live.length === 0) return

  const reverseLines: NormalizedLine[] = live.map((entry) => ({
    warehouseId: entry.warehouse_id,
    materialId: entry.material_id,
    quantity: decimal(entry.quantity).neg(),
    remarks: null,
  }))
  const companyId = live[0]!.company_id
  const { warehouses, materials } = await loadReferences(db, companyId, reverseLines, false)
  await checkLockedBalances(db, group(reverseLines), warehouses, materials)

  const at = Number.isNaN(cancelledAt.getTime()) ? new Date() : cancelledAt
  try {
    await db
      .updateTable('inv_stock_entry')
      .set({
        is_cancelled: true,
        cancelled_at: at,
      })
      .where('voucher_type', '=', ref.type)
      .where('voucher_id', '=', ref.id)
      .where('is_cancelled', '=', false)
      .execute()
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError('internal', '作废库存分录失败', { cause: err })
  }
}

/** 截至业务日的（仓×物料）余额聚合（只读；报表/余额表复用） */
export async function balance(db: DbHandle, query: BalanceQuery): Promise<BalanceRow[]> {
  if (!query.companyId) {
    throw ApiError.validation('库存余额参数不合法', { companyId: ['公司必填'] })
  }
  const asOf = query.asOf ? toDateOnly(query.asOf) : utcToday()
  const hideZero = query.hideZero === true
  const warehouseId = query.warehouseId ?? null
  const materialId = query.materialId ?? null

  try {
    const rows = await sql<{
      warehouse_id: string
      warehouse_name: string
      material_id: string
      material_code: string
      material_name: string
      material_spec: string | null
      unit_name: string
      quantity: string
    }>`
      SELECT e.warehouse_id,
             w.name AS warehouse_name,
             e.material_id,
             m.code AS material_code,
             m.name AS material_name,
             m.spec AS material_spec,
             u.name AS unit_name,
             sum(e.quantity)::text AS quantity
      FROM inv_stock_entry AS e
      JOIN inv_warehouse AS w ON w.id = e.warehouse_id
      JOIN inv_material AS m ON m.id = e.material_id
      JOIN bas_unit AS u ON u.id = m.default_unit_id
      WHERE e.company_id = ${query.companyId}
        AND e.is_cancelled = false
        AND e.posting_date <= ${asOf}::date
        AND (${warehouseId}::uuid IS NULL OR e.warehouse_id = ${warehouseId})
        AND (${materialId}::uuid IS NULL OR e.material_id = ${materialId})
      GROUP BY e.warehouse_id, w.name, e.material_id, m.code, m.name, m.spec, u.name
      HAVING (NOT ${hideZero} OR sum(e.quantity) <> 0)
      ORDER BY w.name ASC, m.code ASC, e.warehouse_id ASC, e.material_id ASC
    `.execute(db)

    return rows.rows.map((row) => ({
      warehouseId: row.warehouse_id,
      warehouseName: row.warehouse_name,
      materialId: row.material_id,
      materialCode: row.material_code,
      materialName: row.material_name,
      materialSpec: row.material_spec,
      unitName: row.unit_name,
      quantity: row.quantity,
    }))
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError('internal', '查询库存余额失败', { cause: err })
  }
}

// ─── 内部 ───────────────────────────────────────────────────

interface NormalizedLine {
  warehouseId: string
  materialId: string
  quantity: Decimal
  remarks: string | null
}

function validateVoucher(voucher: StockVoucher): void {
  const fields: Record<string, string[]> = {}
  const type = voucher.type?.trim() ?? ''
  if (type === '' || type.length > 64) {
    fields.voucherType = ['必填且最多 64 个字符']
  }
  if (!voucher.id) {
    fields.voucherId = ['必填']
  }
  const no = voucher.no?.trim() ?? ''
  if (no === '' || no.length > 64) {
    fields.voucherNo = ['必填且最多 64 个字符']
  }
  if (!voucher.companyId) {
    fields.companyId = ['必填']
  }
  if (
    !voucher.postingDate ||
    (voucher.postingDate instanceof Date && Number.isNaN(voucher.postingDate.getTime())) ||
    (typeof voucher.postingDate === 'string' && voucher.postingDate.trim() === '')
  ) {
    fields.postingDate = ['必填']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('库存过账参数不合法', fields)
  }
}

function normalizeLine(line: StockLine, index: number): NormalizedLine {
  if (!line.warehouseId) {
    throw ApiError.validation('库存过账校验失败', { warehouseId: ['仓库不存在'] })
  }
  if (!line.materialId) {
    throw ApiError.validation('库存过账校验失败', { materialId: ['物料不存在'] })
  }
  const quantity = decimal(line.quantity ?? 0)
  if (quantity.isZero()) {
    throw ApiError.validation('库存过账校验失败', {
      [`lines.${index}.quantity`]: ['数量不能为零'],
    })
  }
  return {
    warehouseId: line.warehouseId,
    materialId: line.materialId,
    quantity,
    remarks: line.remarks ?? null,
  }
}

async function loadReferences(
  db: DbHandle,
  companyId: string,
  lines: NormalizedLine[],
  checkCompany: boolean,
): Promise<{ warehouses: Map<string, WarehouseRef>; materials: Map<string, MaterialRef> }> {
  const warehouseIds = uniqueIds(lines.map((l) => l.warehouseId))
  const materialIds = uniqueIds(lines.map((l) => l.materialId))

  let warehouseRows: Array<{
    id: string
    name: string
    company_id: string
    is_leaf: boolean
    allow_negative: boolean
  }>
  let materialRows: Array<{ id: string; name: string }>
  try {
    warehouseRows = await db
      .selectFrom('inv_warehouse')
      .select(['id', 'name', 'company_id', 'is_leaf', 'allow_negative'])
      .where('id', 'in', warehouseIds)
      .execute()
    materialRows = await db
      .selectFrom('inv_material')
      .select(['id', 'name'])
      .where('id', 'in', materialIds)
      .execute()
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError('internal', '读取库存主数据失败', { cause: err })
  }

  const warehouses = new Map<string, WarehouseRef>()
  for (const row of warehouseRows) {
    warehouses.set(row.id, {
      name: row.name,
      companyId: row.company_id,
      isLeaf: row.is_leaf,
      allowNegative: row.allow_negative,
    })
  }
  const materials = new Map<string, MaterialRef>()
  for (const row of materialRows) {
    materials.set(row.id, { name: row.name })
  }

  for (const id of warehouseIds) {
    const item = warehouses.get(id)
    if (!item) {
      throw ApiError.validation('库存过账校验失败', { warehouseId: ['仓库不存在'] })
    }
    if (checkCompany && item.companyId !== companyId) {
      throw ApiError.validation('库存过账校验失败', { warehouseId: ['仓库必须属于单据公司'] })
    }
    if (!item.isLeaf) {
      throw ApiError.validation('库存过账校验失败', { warehouseId: ['只有叶子仓库才能发生库存'] })
    }
  }
  for (const id of materialIds) {
    if (!materials.has(id)) {
      throw ApiError.validation('库存过账校验失败', { materialId: ['物料不存在'] })
    }
  }
  return { warehouses, materials }
}

async function lockAndCheck(
  db: DbHandle,
  deltas: Map<string, { key: BalanceKey; delta: Decimal }>,
  warehouses: Map<string, WarehouseRef>,
  materials: Map<string, MaterialRef>,
): Promise<void> {
  const keys = [...deltas.values()].map((v) => v.key)
  sortKeys(keys)
  for (const key of keys) {
    await lockBalanceKey(db, key)
  }
  await checkLockedBalances(db, deltas, warehouses, materials)
}

async function lockBalanceKey(db: DbHandle, key: BalanceKey): Promise<void> {
  const lockKey = stockLockKey(key)
  try {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}::text, 0))`.execute(db)
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError('internal', '锁定库存余额失败', { cause: err })
  }
}

async function checkLockedBalances(
  db: DbHandle,
  deltas: Map<string, { key: BalanceKey; delta: Decimal }>,
  warehouses: Map<string, WarehouseRef>,
  materials: Map<string, MaterialRef>,
): Promise<void> {
  const keys = [...deltas.values()].map((v) => v.key)
  sortKeys(keys)
  for (const key of keys) {
    const wh = warehouses.get(key.warehouseId)!
    if (wh.allowNegative) continue

    let current: Decimal
    try {
      const row = await sql<{ qty: string }>`
        SELECT COALESCE(sum(quantity), 0)::text AS qty
        FROM inv_stock_entry
        WHERE warehouse_id = ${key.warehouseId}
          AND material_id = ${key.materialId}
          AND is_cancelled = false
      `.execute(db)
      current = decimal(row.rows[0]?.qty ?? '0')
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw new ApiError('internal', '读取当前库存余额失败', { cause: err })
    }

    const delta = deltas.get(balanceKeyString(key))!.delta
    if (current.plus(delta).isNegative()) {
      const mat = materials.get(key.materialId)!
      throw new ApiError(
        'conflict',
        `仓「${wh.name}」物料「${mat.name}」库存不足:当前余额 ${current.toFixed()},本次变动 ${delta.toFixed()}`,
      )
    }
  }
}

function group(lines: NormalizedLine[]): Map<string, { key: BalanceKey; delta: Decimal }> {
  const result = new Map<string, { key: BalanceKey; delta: Decimal }>()
  for (const line of lines) {
    const key: BalanceKey = { warehouseId: line.warehouseId, materialId: line.materialId }
    const sk = balanceKeyString(key)
    const existing = result.get(sk)
    if (existing) {
      existing.delta = existing.delta.plus(line.quantity)
    } else {
      result.set(sk, { key, delta: line.quantity })
    }
  }
  return result
}

function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function balanceKeyString(key: BalanceKey): string {
  return `${key.warehouseId}:${key.materialId}`
}

function stockLockKey(key: BalanceKey): string {
  return `inv_stock:${key.warehouseId}:${key.materialId}`
}

function sortKeys(keys: BalanceKey[]): void {
  keys.sort((a, b) => {
    const left = stockLockKey(a)
    const right = stockLockKey(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
}

function toDateOnly(value: Date | string): string {
  if (typeof value === 'string') {
    return value.trim().slice(0, 10)
  }
  const y = value.getUTCFullYear()
  const m = String(value.getUTCMonth() + 1).padStart(2, '0')
  const d = String(value.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function utcToday(): string {
  return toDateOnly(new Date())
}
