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
import {requirePermission,  dateWire, toDate, wireDecimal } from './helpers.ts'
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

const META = stockEntryResourceMeta()

export function createStockEntryService(db: Kysely<Database>, inventory: InventoryEngine) {
  async function get(actor: Actor, id: string): Promise<StockEntry> {
    requirePermission(actor, 'inv.stock_entry:read')
    const row = await db
      .selectFrom('inv_stock_entry as e')
      .innerJoin('inv_material as m', 'm.id', 'e.material_id')
      .selectAll('e')
      .select(['m.code as material_code', 'm.name as material_name', 'm.spec as material_spec', 'm.customer_part_no'])
      .where('e.id', '=', id)
      .executeTakeFirst()
    if (!row || !canAccessCompany(actor, row.company_id)) {
      throw new ApiError('not_found', '库存分录不存在')
    }
    return mapEntry(row)
  }

  async function list(actor: Actor, query: Partial<ListQuery>) {
    requirePermission(actor, 'inv.stock_entry:read')
    const scope = companyScopeWhere(actor, 'company_id')
    if (scope.empty) return { count: 0, results: [] as StockEntry[] }
    return listFromSource({
      db,
      resource: META,
      // join 物料主数据投影四字段(分录无快照,展示/搜索口径即物料当前值,见 ADR 物料列)
      source: sql` FROM (
        SELECT e.*, m.code AS material_code, m.name AS material_name,
          m.spec AS material_spec, m.customer_part_no AS customer_part_no
        FROM inv_stock_entry e JOIN inv_material m ON m.id = e.material_id
      ) AS x`,
      select: sql`SELECT id,seq,quantity,posting_date,voucher_type,voucher_id,voucher_no,
        is_cancelled,remarks,inserted_at,company_id,warehouse_id,material_id,cancelled_at,
        material_code,material_name,material_spec,customer_part_no`,
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
    requirePermission(actor, 'inv.stock_entry:read')
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
