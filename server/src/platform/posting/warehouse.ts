/**
 * 仓库校验（platform/posting · W0 领域基元）
 *
 * 合并 inventory `validateLeafWarehouse`、manufacturing `validateWarehouse`、
 * fulfillment/outsourced 内 `validateWarehouse`、outsourced `validateOutsourcedWarehouse`：
 * - 叶子 / 同司 / 启用 / 外协绑定
 * - 报错文案按调用点 title/label 参数化，字节不变
 *
 * platform 自带 SQL，禁止 import `~/modules/*`。
 */
import type { DbHandle } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { lowerParty } from '~/platform/posting/text.ts'

// ---------------------------------------------------------------------------
// 共用：读仓 + 对手类型口径（lowerParty 见 text.ts）
// ---------------------------------------------------------------------------

interface WarehouseRow {
  id: string
  company_id: string
  is_leaf: boolean
  active: boolean
  is_outsourced: boolean
  party_type: string | null
  party_id: string | null
}

async function loadWarehouse(
  db: DbHandle,
  warehouseId: string,
): Promise<WarehouseRow | undefined> {
  return db
    .selectFrom('inv_warehouse')
    .select([
      'id',
      'company_id',
      'is_leaf',
      'active',
      'is_outsourced',
      'party_type',
      'party_id',
    ])
    .where('id', '=', warehouseId)
    .executeTakeFirst()
}

// ---------------------------------------------------------------------------
// inventory：validateLeafWarehouse（分字段报错 + label 拼标题）
// ---------------------------------------------------------------------------

/**
 * 叶子仓 / 同司 / 可选启用。
 * `label` 拼进校验标题（如「其他入库单」→「其他入库单参数不合法」）。
 * `checkActive=false`：调拨已发运后改头等路径允许已停用仓。
 */
export async function validateLeafWarehouse(
  db: DbHandle,
  companyId: string,
  warehouseId: string,
  label: string,
  fieldName = 'warehouseId',
  checkActive = true,
): Promise<void> {
  const row = await loadWarehouse(db, warehouseId)
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

// ---------------------------------------------------------------------------
// manufacturing：validateWarehouse（可空、固定标题、叶子文案不同）
// ---------------------------------------------------------------------------

/**
 * 生产入库仓：可空跳过；分字段报错；叶子文案为「仅叶子仓可入库」。
 * 签名对齐原 manufacturing/helpers（warehouseId 在前）。
 */
export async function validateMfgWarehouse(
  db: DbHandle,
  warehouseId: string | null | undefined,
  companyId: string,
  field = 'warehouseId',
): Promise<void> {
  if (warehouseId == null) return
  const wh = await loadWarehouse(db, warehouseId)
  if (!wh) {
    throw ApiError.validation('生产入库仓库不合法', { [field]: ['仓库不存在'] })
  }
  if (wh.company_id !== companyId) {
    throw ApiError.validation('生产入库仓库不合法', { [field]: ['仓库不属于本公司'] })
  }
  if (!wh.is_leaf) {
    throw ApiError.validation('生产入库仓库不合法', { [field]: ['仅叶子仓可入库'] })
  }
  if (!wh.active) {
    throw ApiError.validation('生产入库仓库不合法', { [field]: ['仓库已停用'] })
  }
}

// ---------------------------------------------------------------------------
// fulfillment / outsourced：合并式启用叶子仓（单条 detail 文案）
// ---------------------------------------------------------------------------

/**
 * 须为本公司启用叶子仓（条件任一不满足 → 同一 detail 文案）。
 * `title` 按调用点逐字：`履约仓库不合法` / `委外履约仓库不合法`。
 */
export async function validateEnabledLeafWarehouse(
  db: DbHandle,
  companyId: string,
  warehouseId: string,
  title: string,
  field = 'warehouseId',
  detail = '须为单据公司启用叶子仓',
): Promise<void> {
  const wh = await loadWarehouse(db, warehouseId)
  if (!wh || wh.company_id !== companyId || !wh.active || !wh.is_leaf) {
    throw ApiError.validation(title, { [field]: [detail] })
  }
}

// ---------------------------------------------------------------------------
// outsourced：外协仓绑定对手
// ---------------------------------------------------------------------------

/**
 * 外协仓：本公司 + 启用 + 叶子 + is_outsourced + 绑定当前对手（party 大小写不敏感）。
 * 文案对齐原 outsourced/service：`外协仓不合法` / `outsourcedWarehouseId`。
 */
export async function validateOutsourcedWarehouse(
  db: DbHandle,
  companyId: string,
  partyType: string,
  partyId: string,
  warehouseId: string,
): Promise<void> {
  const wh = await loadWarehouse(db, warehouseId)
  const valid =
    wh &&
    wh.company_id === companyId &&
    wh.is_outsourced &&
    wh.active &&
    wh.is_leaf &&
    wh.party_type &&
    lowerParty(wh.party_type) === lowerParty(partyType) &&
    wh.party_id === partyId
  if (!valid) {
    throw ApiError.validation('外协仓不合法', {
      outsourcedWarehouseId: ['须为绑定当前对手的本公司启用外协仓'],
    })
  }
}
