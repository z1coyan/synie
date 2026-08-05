/**
 * 库存分录流水 + 余额表（只读）；余额委托 inventory engine.balance。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit——
 * 列表 `listAuthorized`、单条 `loadAuthorizedFrom`（不命中一律 not_found）。
 * 余额是单公司聚合真值，公司不在边界内即空结果（不泄露存在性）。
 */
import type { ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { BalanceRow, InventoryEngine } from '~/engines/inventory/index.ts'
import type { DB as Database } from '~/db/types.ts'
import { listAuthorized } from '~/db/list.ts'
import { companyInPermitScope, loadAuthorizedFrom } from '~/db/load.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { dateWire, toDate, wireDecimal } from './helpers.ts'
import { stockEntryResourceMeta } from './meta.ts'

export interface StockEntry {
  id: string
  seq: number
  quantity: string
  postingDate: Date
  voucherType: string
  voucherId: string
  voucherNo: string
  isCancelled: boolean
  cancelledAt: Date | null
  remarks: string | null
  insertedAt: Date
  companyId: string
  warehouseId: string
  materialId: string
  /** 物料主数据投影(list join;详情 get 同样 join) */
  materialCode: string | null
  materialName: string | null
  materialSpec: string | null
  customerPartNo: string | null
}

export const ENTRY_RESOURCE = 'invStockEntries'

const META = stockEntryResourceMeta()

/** 列表与单条共用同一份投影（别名与 listAuthorized 的 alias 必须逐字一致） */
const ENTRY_ALIAS = 'inv_stock_entry'
const ENTRY_SOURCE = sql` FROM (
  SELECT e.*, m.code AS material_code, m.name AS material_name,
    m.spec AS material_spec, m.customer_part_no AS customer_part_no
  FROM inv_stock_entry e JOIN inv_material m ON m.id = e.material_id
) AS inv_stock_entry`
const ENTRY_SELECT = sql`SELECT id,seq,quantity,posting_date,voucher_type,voucher_id,voucher_no,
  is_cancelled,remarks,inserted_at,company_id,warehouse_id,material_id,cancelled_at,
  material_code,material_name,material_spec,customer_part_no`

export function createStockEntryService(
  db: Kysely<Database>,
  inventory: InventoryEngine,
  registry: Registry,
) {
  const target = registry.authzTarget(ENTRY_RESOURCE)

  async function get(permit: Permit, id: string): Promise<StockEntry> {
    return loadAuthorizedFrom({
      db,
      permit,
      target,
      alias: ENTRY_ALIAS,
      source: ENTRY_SOURCE,
      select: ENTRY_SELECT,
      id,
      mapRow: (r) => mapEntry(r as never),
      notFoundMessage: '库存分录不存在',
    })
  }

  async function list(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
      db,
      permit,
      target,
      alias: ENTRY_ALIAS,
      resource: META,
      // join 物料主数据投影四字段(分录无快照,展示/搜索口径即物料当前值,见 ADR 物料列)
      source: ENTRY_SOURCE,
      select: ENTRY_SELECT,
      defaultOrder: sql`"seq" ASC`,
      query,
      mapRow: (r) => mapEntry(r as never),
    })
  }

  async function balance(
    permit: Permit,
    query: {
      companyId: string
      asOf?: string | null
      warehouseId?: string | null
      materialId?: string | null
      hideZero?: boolean | null
    },
  ): Promise<BalanceRow[]> {
    // 聚合口径按单公司取数：公司不在边界内即空结果（不套逐行过滤，分录无行级绑定列）
    if (!companyInPermitScope(permit, query.companyId)) return []
    const hideZero = query.hideZero == null ? true : query.hideZero
    return inventory.balance(db, {
      companyId: query.companyId,
      asOf: query.asOf ? dateWire(query.asOf) : undefined,
      warehouseId: query.warehouseId ?? null,
      materialId: query.materialId ?? null,
      hideZero,
    })
  }

  return { get, list, balance }
}

export type StockEntryService = ReturnType<typeof createStockEntryService>

function mapEntry(row: {
  id: string
  seq: string | number
  quantity: string
  posting_date: Date | string
  voucher_type: string
  voucher_id: string
  voucher_no: string
  is_cancelled: boolean
  cancelled_at: Date | string | null
  remarks: string | null
  inserted_at: Date | string
  company_id: string
  warehouse_id: string
  material_id: string
  material_code?: string | null
  material_name?: string | null
  material_spec?: string | null
  customer_part_no?: string | null
}): StockEntry {
  return {
    id: row.id,
    seq: Number(row.seq),
    quantity: wireDecimal(row.quantity) ?? String(row.quantity),
    postingDate: toDate(row.posting_date),
    voucherType: row.voucher_type,
    voucherId: row.voucher_id,
    voucherNo: row.voucher_no,
    isCancelled: row.is_cancelled,
    cancelledAt: row.cancelled_at ? toDate(row.cancelled_at) : null,
    remarks: row.remarks,
    insertedAt: toDate(row.inserted_at),
    companyId: row.company_id,
    warehouseId: row.warehouse_id,
    materialId: row.material_id,
    materialCode: row.material_code ?? null,
    materialName: row.material_name ?? null,
    materialSpec: row.material_spec ?? null,
    customerPartNo: row.customer_part_no ?? null,
  }
}
