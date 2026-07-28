/**
 * 库存分录流水 + 余额表（只读）；余额委托 inventory engine.balance。
 */
import type { ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { BalanceRow, InventoryEngine } from '~/engines/inventory/index.ts'
import type { DB as Database } from '~/db/types.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { canAccessCompany } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { companyScopeWhere, listFromSource } from '~/db/list.ts'
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
}

const META = stockEntryResourceMeta()

export function createStockEntryService(db: Kysely<Database>, inventory: InventoryEngine) {
  async function get(actor: Actor, id: string): Promise<StockEntry> {
    const row = await db
      .selectFrom('inv_stock_entry')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row || !canAccessCompany(actor, row.company_id)) {
      throw new ApiError('not_found', '库存分录不存在')
    }
    return mapEntry(row)
  }

  async function list(actor: Actor, query: Partial<ListQuery>) {
    const scope = companyScopeWhere(actor, 'company_id')
    if (scope.empty) return { count: 0, results: [] as StockEntry[] }
    return listFromSource({
      db,
      resource: META,
      source: sql` FROM inv_stock_entry`,
      select: sql`SELECT id,seq,quantity,posting_date,voucher_type,voucher_id,voucher_no,
        is_cancelled,remarks,inserted_at,company_id,warehouse_id,material_id,cancelled_at`,
      defaultOrder: sql`"seq" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: (r) => mapEntry(r as never),
    })
  }

  async function balance(
    actor: Actor,
    query: {
      companyId: string
      asOf?: string | null
      warehouseId?: string | null
      materialId?: string | null
      hideZero?: boolean | null
    },
  ): Promise<BalanceRow[]> {
    if (!canAccessCompany(actor, query.companyId)) {
      throw new ApiError('forbidden', '无权查看该公司数据')
    }
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
  }
}
