/**
 * 手工调拨单：发货/收货走 withTx + inventory engine。
 */
import { decimal, isDecimalString, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { InventoryEngine } from '~/engines/inventory/index.ts'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { canAccessCompany } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { companyScopeWhere, listFromSource } from '~/db/list.ts'
import {
  dateWire,
  projectStockItem,
  runeLen,
  todayUTC,
  toDate,
  trimOrNull,
  upperStatus,
  validateLeafWarehouse,
  validateOptionalText,
  wireDecimal,
} from './helpers.ts'
import { stockTransferItemResourceMeta, stockTransferResourceMeta } from './meta.ts'

export type TransferStatus = 'DRAFT' | 'SHIPPED' | 'RECEIVED'

export interface StockTransfer {
  id: string
  docNo: string
  docDate: Date
  summary: string | null
  remarks: string | null
  status: TransferStatus
  shippedAt: Date | null
  receivedAt: Date | null
  insertedAt: Date
  updatedAt: Date
  companyId: string
  fromWarehouseId: string
  toWarehouseId: string
  transitWarehouseId: string
  createdById: string | null
  shippedById: string | null
  receivedById: string | null
}

export interface StockTransferItem {
  id: string
  idx: number
  qty: string
  baseQty: string
  receivedQty: string | null
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitName: string
  remark: string | null
  insertedAt: Date
  updatedAt: Date
  stockTransferId: string
  companyId: string
  materialId: string
  unitId: string
}

const DOC_AUDIT = [
  'doc_no',
  'doc_date',
  'summary',
  'remarks',
  'status',
  'shipped_at',
  'received_at',
  'company_id',
  'from_warehouse_id',
  'to_warehouse_id',
  'transit_warehouse_id',
  'created_by_id',
  'shipped_by_id',
  'received_by_id',
] as const

const ITEM_AUDIT = [
  'idx',
  'qty',
  'base_qty',
  'received_qty',
  'material_code',
  'material_name',
  'material_spec',
  'unit_name',
  'remark',
  'stock_transfer_id',
  'company_id',
  'material_id',
  'unit_id',
] as const

const DOC_META = stockTransferResourceMeta()
const ITEM_META = stockTransferItemResourceMeta()
const LABEL = '手工调拨单'
const VOUCHER_TYPE = 'inv.stock_transfer'

export function createStockTransferService(
  db: Kysely<Database>,
  numbering: NumberingService,
  inventory: InventoryEngine,
) {
  async function get(actor: Actor, id: string): Promise<StockTransfer> {
    const row = await db
      .selectFrom('inv_stock_transfer')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row || !canAccessCompany(actor, row.company_id)) {
      throw new ApiError('not_found', '手工调拨单不存在')
    }
    return mapDoc(row)
  }

  async function list(actor: Actor, query: Partial<ListQuery>) {
    const scope = companyScopeWhere(actor, 'company_id')
    if (scope.empty) return { count: 0, results: [] as StockTransfer[] }
    return listFromSource({
      db,
      resource: DOC_META,
      source: sql` FROM inv_stock_transfer`,
      select: sql`SELECT id,doc_no,doc_date,summary,remarks,status,shipped_at,received_at,
        inserted_at,updated_at,company_id,from_warehouse_id,to_warehouse_id,transit_warehouse_id,
        created_by_id,shipped_by_id,received_by_id`,
      defaultOrder: sql`"doc_no" ASC, "id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: (r) => mapDoc(r as never),
    })
  }

  async function create(
    actor: Actor,
    input: {
      docNo?: string | null
      docDate?: string | null
      summary?: string | null
      remarks?: string | null
      companyId: string
      fromWarehouseId: string
      toWarehouseId: string
      transitWarehouseId: string
    },
  ): Promise<StockTransfer> {
    if (input.companyId && !canAccessCompany(actor, input.companyId)) {
      throw new ApiError('forbidden', '无权操作该公司数据')
    }
    const fields: Record<string, string[]> = {}
    if (!input.companyId) fields.companyId = ['必填']
    if (!input.fromWarehouseId) fields.fromWarehouseId = ['必填']
    if (!input.toWarehouseId) fields.toWarehouseId = ['必填']
    if (!input.transitWarehouseId) fields.transitWarehouseId = ['必填']
    if (input.docNo != null && runeLen(input.docNo.trim()) > 32) fields.docNo = ['最多 32 个字符']
    validateOptionalText(fields, 'summary', input.summary, 512)
    validateOptionalText(fields, 'remarks', input.remarks, 512)
    if (Object.keys(fields).length > 0) {
      throw ApiError.validation(`${LABEL}参数不合法`, fields)
    }
    validateDistinct(input.fromWarehouseId, input.toWarehouseId, input.transitWarehouseId)
    return withTx(db, async (trx) => {
      await validateWarehouses(
        trx,
        input.companyId,
        input.fromWarehouseId,
        input.toWarehouseId,
        input.transitWarehouseId,
        true,
      )
      const docDate = input.docDate ? dateWire(input.docDate) : todayUTC()
      let docNo = input.docNo?.trim() ?? ''
      if (!docNo) {
        docNo = await numbering.nextInTx(trx, {
          resource: 'inv.stock_transfer',
          values: { company_id: input.companyId, doc_date: docDate },
        })
      }
      if (runeLen(docNo) > 32) {
        throw ApiError.validation(`${LABEL}参数不合法`, { docNo: ['最多 32 个字符'] })
      }
      try {
        const row = await trx
          .insertInto('inv_stock_transfer')
          .values({
            doc_no: docNo,
            doc_date: docDate,
            summary: trimOrNull(input.summary),
            remarks: trimOrNull(input.remarks),
            company_id: input.companyId,
            from_warehouse_id: input.fromWarehouseId,
            to_warehouse_id: input.toWarehouseId,
            transit_warehouse_id: input.transitWarehouseId,
            created_by_id: actor.userId?.trim() ? actor.userId : null,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapDoc(row)
        await writeAudit(trx, actor, {
          resource: 'inv_stock_transfer',
          recordId: item.id,
          recordLabel: item.docNo,
          companyId: item.companyId,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(docSnap(item), DOC_AUDIT),
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '创建手工调拨单失败', [
          { code: '23505', message: '单据编号已存在' },
        ])
      }
    })
  }

  async function update(
    actor: Actor,
    id: string,
    input: {
      docNo?: string
      docDate?: string
      summary?: string | null
      summaryPresent?: boolean
      remarks?: string | null
      remarksPresent?: boolean
      fromWarehouseId?: string
      toWarehouseId?: string
      transitWarehouseId?: string
    },
  ): Promise<StockTransfer> {
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('inv_stock_transfer')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '手工调拨单不存在')
      const before = mapDoc(locked)
      if (!canAccessCompany(actor, before.companyId)) {
        throw new ApiError('forbidden', '无权操作该公司数据')
      }
      if (before.status !== 'DRAFT') {
        throw new ApiError('conflict', '仅草稿调拨单可修改或删除')
      }
      const after: StockTransfer = {
        ...before,
        docNo: input.docNo != null ? input.docNo.trim() : before.docNo,
        docDate: input.docDate ? new Date(`${dateWire(input.docDate)}T00:00:00Z`) : before.docDate,
        summary: input.summaryPresent ? trimOrNull(input.summary) : before.summary,
        remarks: input.remarksPresent ? trimOrNull(input.remarks) : before.remarks,
        fromWarehouseId: input.fromWarehouseId ?? before.fromWarehouseId,
        toWarehouseId: input.toWarehouseId ?? before.toWarehouseId,
        transitWarehouseId: input.transitWarehouseId ?? before.transitWarehouseId,
      }
      const fields: Record<string, string[]> = {}
      if (!after.docNo || runeLen(after.docNo) > 32) fields.docNo = ['不能为空且最多 32 个字符']
      validateOptionalText(fields, 'summary', after.summary, 512)
      validateOptionalText(fields, 'remarks', after.remarks, 512)
      if (Object.keys(fields).length > 0) {
        throw ApiError.validation(`${LABEL}参数不合法`, fields)
      }
      validateDistinct(after.fromWarehouseId, after.toWarehouseId, after.transitWarehouseId)
      await validateWarehouses(
        trx,
        after.companyId,
        after.fromWarehouseId,
        after.toWarehouseId,
        after.transitWarehouseId,
        true,
      )
      const changes = auditDiff(docSnap(before), docSnap(after), DOC_AUDIT)
      if (Object.keys(changes).length === 0) return before
      try {
        const row = await trx
          .updateTable('inv_stock_transfer')
          .set({
            doc_no: after.docNo,
            doc_date: dateWire(after.docDate),
            summary: after.summary,
            remarks: after.remarks,
            from_warehouse_id: after.fromWarehouseId,
            to_warehouse_id: after.toWarehouseId,
            transit_warehouse_id: after.transitWarehouseId,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapDoc(row)
        await writeAudit(trx, actor, {
          resource: 'inv_stock_transfer',
          recordId: item.id,
          recordLabel: item.docNo,
          companyId: item.companyId,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '更新手工调拨单失败', [
          { code: '23505', message: '单据编号已存在' },
        ])
      }
    })
  }

  async function remove(actor: Actor, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('inv_stock_transfer')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '手工调拨单不存在')
      const item = mapDoc(locked)
      if (!canAccessCompany(actor, item.companyId)) {
        throw new ApiError('forbidden', '无权操作该公司数据')
      }
      if (item.status !== 'DRAFT') {
        throw new ApiError('conflict', '仅草稿调拨单可修改或删除')
      }
      await trx.deleteFrom('inv_stock_transfer').where('id', '=', id).execute()
      await writeAudit(trx, actor, {
        resource: 'inv_stock_transfer',
        recordId: item.id,
        recordLabel: item.docNo,
        companyId: item.companyId,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(docSnap(item), DOC_AUDIT),
      })
    })
  }

  async function ship(actor: Actor, id: string): Promise<StockTransfer> {
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('inv_stock_transfer')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '手工调拨单不存在')
      const before = mapDoc(locked)
      if (!canAccessCompany(actor, before.companyId)) {
        throw new ApiError('forbidden', '无权操作该公司数据')
      }
      if (before.status !== 'DRAFT') {
        throw new ApiError('conflict', '仅草稿调拨单可发货')
      }
      const items = await trx
        .selectFrom('inv_stock_transfer_item')
        .selectAll()
        .where('stock_transfer_id', '=', id)
        .execute()
      if (items.length === 0) {
        throw new ApiError('conflict', '发货前必须至少填写一行单据行')
      }
      await validateWarehouses(
        trx,
        before.companyId,
        before.fromWarehouseId,
        before.toWarehouseId,
        before.transitWarehouseId,
        true,
      )
      const lines = items.flatMap((item) => {
        const qty = decimal(item.base_qty)
        return [
          {
            warehouseId: before.fromWarehouseId,
            materialId: item.material_id,
            quantity: qty,
            direction: 'out' as const,
            remarks: before.summary,
          },
          {
            warehouseId: before.transitWarehouseId,
            materialId: item.material_id,
            quantity: qty,
            direction: 'in' as const,
            remarks: before.summary,
          },
        ]
      })
      await inventory.post(
        trx,
        {
          type: VOUCHER_TYPE,
          id: before.id,
          no: before.docNo,
          companyId: before.companyId,
          postingDate: dateWire(before.docDate),
        },
        lines,
      )
      const now = new Date()
      const row = await trx
        .updateTable('inv_stock_transfer')
        .set({
          status: 'shipped',
          shipped_at: now,
          shipped_by_id: actor.userId?.trim() ? actor.userId : null,
          updated_at: sql`(now() AT TIME ZONE 'utc')`,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
      const after = mapDoc(row)
      await writeAudit(trx, actor, {
        resource: 'inv_stock_transfer',
        recordId: after.id,
        recordLabel: after.docNo,
        companyId: after.companyId,
        actionType: 'update',
        actionName: 'ship',
        changes: auditDiff(docSnap(before), docSnap(after), DOC_AUDIT),
      })
      return after
    })
  }

  async function receive(
    actor: Actor,
    id: string,
    input: { receipts?: Array<{ itemId: string; qty: string }> | null },
  ): Promise<StockTransfer> {
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('inv_stock_transfer')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '手工调拨单不存在')
      const before = mapDoc(locked)
      if (!canAccessCompany(actor, before.companyId)) {
        throw new ApiError('forbidden', '无权操作该公司数据')
      }
      if (before.status !== 'SHIPPED') {
        throw new ApiError('conflict', '仅已发货调拨单可收货')
      }
      const items = await trx
        .selectFrom('inv_stock_transfer_item')
        .selectAll()
        .where('stock_transfer_id', '=', id)
        .orderBy('idx', 'asc')
        .execute()
      const resolved = resolveReceipts(items, input.receipts ?? null)
      const lines = resolved.flatMap((r) => {
        if (r.qty.isZero()) return []
        return [
          {
            warehouseId: before.transitWarehouseId,
            materialId: r.item.material_id,
            quantity: r.qty,
            direction: 'out' as const,
            remarks: before.summary,
          },
          {
            warehouseId: before.toWarehouseId,
            materialId: r.item.material_id,
            quantity: r.qty,
            direction: 'in' as const,
            remarks: before.summary,
          },
        ]
      })
      if (lines.length > 0) {
        await inventory.post(
          trx,
          {
            type: VOUCHER_TYPE,
            id: before.id,
            no: before.docNo,
            companyId: before.companyId,
            postingDate: dateWire(before.docDate),
          },
          lines,
        )
      }
      for (const r of resolved) {
        const beforeItem = mapItem(r.item)
        const row = await trx
          .updateTable('inv_stock_transfer_item')
          .set({
            received_qty: wireDecimal(r.qty) ?? r.qty.toFixed(),
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', r.item.id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const afterItem = mapItem(row)
        await writeAudit(trx, null, {
          resource: 'inv_stock_transfer_item',
          recordId: afterItem.id,
          recordLabel: afterItem.materialCode,
          companyId: afterItem.companyId,
          actionType: 'update',
          actionName: 'write_received',
          changes: auditDiff(itemSnap(beforeItem), itemSnap(afterItem), ITEM_AUDIT),
        })
      }
      const now = new Date()
      const row = await trx
        .updateTable('inv_stock_transfer')
        .set({
          status: 'received',
          received_at: now,
          received_by_id: actor.userId?.trim() ? actor.userId : null,
          updated_at: sql`(now() AT TIME ZONE 'utc')`,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
      const after = mapDoc(row)
      await writeAudit(trx, actor, {
        resource: 'inv_stock_transfer',
        recordId: after.id,
        recordLabel: after.docNo,
        companyId: after.companyId,
        actionType: 'update',
        actionName: 'receive',
        changes: auditDiff(docSnap(before), docSnap(after), DOC_AUDIT),
      })
      return after
    })
  }

  async function getItem(actor: Actor, id: string): Promise<StockTransferItem> {
    const row = await db
      .selectFrom('inv_stock_transfer_item')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row || !canAccessCompany(actor, row.company_id)) {
      throw new ApiError('not_found', '手工调拨单行不存在')
    }
    return mapItem(row)
  }

  async function queryItems(actor: Actor, query: Partial<ListQuery>) {
    const scope = companyScopeWhere(actor, 'company_id')
    if (scope.empty) return { count: 0, results: [] as StockTransferItem[] }
    return listFromSource({
      db,
      resource: ITEM_META,
      source: sql` FROM inv_stock_transfer_item`,
      select: sql`SELECT id,idx,qty,base_qty,received_qty,material_code,material_name,material_spec,
        unit_name,remark,inserted_at,updated_at,stock_transfer_id,company_id,material_id,unit_id`,
      defaultOrder: sql`"idx" ASC, "id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: (r) => mapItem(r as never),
    })
  }

  async function createItem(
    actor: Actor,
    input: {
      stockTransferId: string
      idx: number
      qty: string
      materialId: string
      unitId: string
      remark?: string | null
    },
  ): Promise<StockTransferItem> {
    const qty = parseQty(input.qty)
    validateItemInput(qty, input.materialId, input.unitId, input.remark)
    return withTx(db, async (trx) => {
      const doc = await lockDraft(trx, actor, input.stockTransferId)
      const projection = await projectStockItem(
        trx,
        input.materialId,
        input.unitId,
        qty,
        '手工调拨单行',
      )
      const row = await trx
        .insertInto('inv_stock_transfer_item')
        .values({
          idx: input.idx,
          qty: wireDecimal(qty) ?? qty.toFixed(),
          base_qty: wireDecimal(projection.baseQty) ?? projection.baseQty.toFixed(),
          material_code: projection.materialCode,
          material_name: projection.materialName,
          material_spec: projection.materialSpec,
          unit_name: projection.unitName,
          remark: trimOrNull(input.remark),
          stock_transfer_id: input.stockTransferId,
          company_id: doc.companyId,
          material_id: input.materialId,
          unit_id: input.unitId,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      const item = mapItem(row)
      await writeAudit(trx, actor, {
        resource: 'inv_stock_transfer_item',
        recordId: item.id,
        recordLabel: item.materialCode,
        companyId: item.companyId,
        actionType: 'create',
        actionName: 'create',
        changes: auditCreated(itemSnap(item), ITEM_AUDIT),
      })
      return item
    })
  }

  async function updateItem(
    actor: Actor,
    id: string,
    input: {
      idx?: number
      qty?: string
      materialId?: string
      unitId?: string
      remark?: string | null
      remarkPresent?: boolean
    },
  ): Promise<StockTransferItem> {
    return withTx(db, async (trx) => {
      const current = await trx
        .selectFrom('inv_stock_transfer_item')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
      if (!current) throw new ApiError('not_found', '手工调拨单行不存在')
      await lockDraft(trx, actor, current.stock_transfer_id)
      const locked = await trx
        .selectFrom('inv_stock_transfer_item')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '手工调拨单行不存在')
      const before = mapItem(locked)
      const qty = input.qty != null ? parseQty(input.qty) : decimal(before.qty)
      const materialId = input.materialId ?? before.materialId
      const unitId = input.unitId ?? before.unitId
      const remark = input.remarkPresent ? trimOrNull(input.remark) : before.remark
      const idx = input.idx ?? before.idx
      validateItemInput(qty, materialId, unitId, remark)
      const projection = await projectStockItem(trx, materialId, unitId, qty, '手工调拨单行')
      const after: StockTransferItem = {
        ...before,
        idx,
        qty: wireDecimal(qty) ?? qty.toFixed(),
        baseQty: wireDecimal(projection.baseQty) ?? projection.baseQty.toFixed(),
        materialCode: projection.materialCode,
        materialName: projection.materialName,
        materialSpec: projection.materialSpec,
        unitName: projection.unitName,
        remark,
        materialId,
        unitId,
      }
      const changes = auditDiff(itemSnap(before), itemSnap(after), ITEM_AUDIT)
      if (Object.keys(changes).length === 0) return before
      const row = await trx
        .updateTable('inv_stock_transfer_item')
        .set({
          idx: after.idx,
          qty: after.qty,
          base_qty: after.baseQty,
          material_code: after.materialCode,
          material_name: after.materialName,
          material_spec: after.materialSpec,
          unit_name: after.unitName,
          remark: after.remark,
          material_id: after.materialId,
          unit_id: after.unitId,
          updated_at: sql`(now() AT TIME ZONE 'utc')`,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
      const item = mapItem(row)
      await writeAudit(trx, actor, {
        resource: 'inv_stock_transfer_item',
        recordId: item.id,
        recordLabel: item.materialCode,
        companyId: item.companyId,
        actionType: 'update',
        actionName: 'update',
        changes,
      })
      return item
    })
  }

  async function removeItem(actor: Actor, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const current = await trx
        .selectFrom('inv_stock_transfer_item')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
      if (!current) throw new ApiError('not_found', '手工调拨单行不存在')
      await lockDraft(trx, actor, current.stock_transfer_id)
      const locked = await trx
        .selectFrom('inv_stock_transfer_item')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '手工调拨单行不存在')
      const item = mapItem(locked)
      await trx.deleteFrom('inv_stock_transfer_item').where('id', '=', id).execute()
      await writeAudit(trx, actor, {
        resource: 'inv_stock_transfer_item',
        recordId: item.id,
        recordLabel: item.materialCode,
        companyId: item.companyId,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(itemSnap(item), ITEM_AUDIT),
      })
    })
  }

  return {
    get,
    list,
    create,
    update,
    remove,
    ship,
    receive,
    getItem,
    queryItems,
    createItem,
    updateItem,
    removeItem,
  }
}

export type StockTransferService = ReturnType<typeof createStockTransferService>

async function lockDraft(db: DbHandle, actor: Actor, id: string): Promise<StockTransfer> {
  const row = await db
    .selectFrom('inv_stock_transfer')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw new ApiError('not_found', '手工调拨单不存在')
  const doc = mapDoc(row)
  if (!canAccessCompany(actor, doc.companyId)) {
    throw new ApiError('forbidden', '无权操作该公司数据')
  }
  if (doc.status !== 'DRAFT') {
    throw new ApiError('conflict', '仅草稿调拨单可编辑单据行')
  }
  return doc
}

function validateDistinct(fromId: string, toId: string, transitId: string): void {
  if (fromId === toId || fromId === transitId || toId === transitId) {
    throw ApiError.validation(`${LABEL}参数不合法`, {
      transitWarehouseId: ['调出、调入与在途仓库必须两两不同'],
    })
  }
}

async function validateWarehouses(
  db: DbHandle,
  companyId: string,
  fromId: string,
  toId: string,
  transitId: string,
  checkActive: boolean,
): Promise<void> {
  validateDistinct(fromId, toId, transitId)
  for (const wid of [fromId, toId, transitId]) {
    await validateLeafWarehouse(db, companyId, wid, LABEL, 'warehouseId', checkActive)
  }
}

type TransferItemRow = {
  id: string
  idx: string | number
  qty: string
  base_qty: string
  received_qty: string | null
  material_code: string
  material_name: string
  material_spec: string | null
  unit_name: string
  remark: string | null
  inserted_at: Date | string
  updated_at: Date | string
  stock_transfer_id: string
  company_id: string
  material_id: string
  unit_id: string
}

function resolveReceipts(
  items: TransferItemRow[],
  receipts: Array<{ itemId: string; qty: string }> | null,
): Array<{ item: TransferItemRow; qty: ReturnType<typeof decimal> }> {
  if (receipts == null) {
    return items.map((item) => ({ item, qty: decimal(item.base_qty) }))
  }
  const given = new Map<string, ReturnType<typeof decimal>>()
  for (const r of receipts) {
    if (given.has(r.itemId)) throw new ApiError('conflict', '实收行不得重复')
    if (!isDecimalString(r.qty)) {
      throw ApiError.validation('手工调拨单收货参数不合法', { 'receipts.qty': ['数量不合法'] })
    }
    given.set(r.itemId, decimal(r.qty))
  }
  const known = new Set(items.map((i) => i.id))
  for (const id of given.keys()) {
    if (!known.has(id)) throw new ApiError('conflict', '实收行不属于本调拨单')
  }
  return items.map((item) => {
    const qty = given.get(item.id)
    if (qty == null) {
      throw new ApiError(
        'conflict',
        `收货数量必须覆盖全部行:第 ${item.idx} 行缺实收数量`,
      )
    }
    const base = decimal(item.base_qty)
    if (qty.isNegative() || qty.greaterThan(base)) {
      throw new ApiError(
        'conflict',
        `第 ${item.idx} 行实收数量必须在 0 与发货数量 ${base.toFixed()} 之间`,
      )
    }
    return { item, qty }
  })
}

function mapDoc(row: {
  id: string
  doc_no: string
  doc_date: Date | string
  summary: string | null
  remarks: string | null
  status: string
  shipped_at: Date | string | null
  received_at: Date | string | null
  inserted_at: Date | string
  updated_at: Date | string
  company_id: string
  from_warehouse_id: string
  to_warehouse_id: string
  transit_warehouse_id: string
  created_by_id: string | null
  shipped_by_id: string | null
  received_by_id: string | null
}): StockTransfer {
  return {
    id: row.id,
    docNo: row.doc_no,
    docDate: toDate(row.doc_date),
    summary: row.summary,
    remarks: row.remarks,
    status: upperStatus(row.status) as TransferStatus,
    shippedAt: row.shipped_at ? toDate(row.shipped_at) : null,
    receivedAt: row.received_at ? toDate(row.received_at) : null,
    insertedAt: toDate(row.inserted_at),
    updatedAt: toDate(row.updated_at),
    companyId: row.company_id,
    fromWarehouseId: row.from_warehouse_id,
    toWarehouseId: row.to_warehouse_id,
    transitWarehouseId: row.transit_warehouse_id,
    createdById: row.created_by_id,
    shippedById: row.shipped_by_id,
    receivedById: row.received_by_id,
  }
}

function mapItem(row: {
  id: string
  idx: string | number
  qty: string
  base_qty: string
  received_qty: string | null
  material_code: string
  material_name: string
  material_spec: string | null
  unit_name: string
  remark: string | null
  inserted_at: Date | string
  updated_at: Date | string
  stock_transfer_id: string
  company_id: string
  material_id: string
  unit_id: string
}): StockTransferItem {
  return {
    id: row.id,
    idx: Number(row.idx),
    qty: wireDecimal(row.qty) ?? String(row.qty),
    baseQty: wireDecimal(row.base_qty) ?? String(row.base_qty),
    receivedQty: row.received_qty == null ? null : (wireDecimal(row.received_qty) ?? String(row.received_qty)),
    materialCode: row.material_code,
    materialName: row.material_name,
    materialSpec: row.material_spec,
    unitName: row.unit_name,
    remark: row.remark,
    insertedAt: toDate(row.inserted_at),
    updatedAt: toDate(row.updated_at),
    stockTransferId: row.stock_transfer_id,
    companyId: row.company_id,
    materialId: row.material_id,
    unitId: row.unit_id,
  }
}

function docSnap(item: StockTransfer): Record<string, unknown> {
  return {
    doc_no: item.docNo,
    doc_date: item.docDate,
    summary: item.summary,
    remarks: item.remarks,
    status: item.status,
    shipped_at: item.shippedAt,
    received_at: item.receivedAt,
    company_id: item.companyId,
    from_warehouse_id: item.fromWarehouseId,
    to_warehouse_id: item.toWarehouseId,
    transit_warehouse_id: item.transitWarehouseId,
    created_by_id: item.createdById,
    shipped_by_id: item.shippedById,
    received_by_id: item.receivedById,
  }
}

function itemSnap(item: StockTransferItem): Record<string, unknown> {
  return {
    idx: item.idx,
    qty: item.qty,
    base_qty: item.baseQty,
    received_qty: item.receivedQty,
    material_code: item.materialCode,
    material_name: item.materialName,
    material_spec: item.materialSpec,
    unit_name: item.unitName,
    remark: item.remark,
    stock_transfer_id: item.stockTransferId,
    company_id: item.companyId,
    material_id: item.materialId,
    unit_id: item.unitId,
  }
}

function parseQty(raw: string) {
  if (!isDecimalString(raw) || !decimal(raw).isPositive()) {
    throw ApiError.validation('手工调拨单行参数不合法', { qty: ['数量必须大于零'] })
  }
  return decimal(raw)
}

function validateItemInput(
  qty: ReturnType<typeof decimal>,
  materialId: string,
  unitId: string,
  remark: string | null | undefined,
): void {
  const fields: Record<string, string[]> = {}
  if (!qty.isPositive()) fields.qty = ['数量必须大于零']
  if (!materialId) fields.materialId = ['必填']
  if (!unitId) fields.unitId = ['必填']
  if (remark != null && runeLen(remark) > 512) fields.remark = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('手工调拨单行参数不合法', fields)
  }
}
