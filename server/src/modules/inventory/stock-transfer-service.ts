/**
 * 手工调拨单：单头走标准动作内核（get/list/update/remove + workflow 转移），
 * 发货/收货是两段推进（DRAFT→SHIPPED→RECEIVED），各自的 effect 调库存引擎。
 *
 * 两处按动作弹射（内核缺「服务端派生列」原语，见迁移决策日志）：
 * - `create`：`created_by_id` 是 readonly 列且本资源不声明 owner 绑定；
 * - 单据行 CRUD：物料快照列 readonly，子行内核 update 不写这些列。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit。
 */
import { decimal, isDecimalString, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { InventoryEngine } from '~/engines/inventory/index.ts'
import { withTx, type DbHandle, type TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { auditCreated, auditDestroyed, auditDiff, writeAudit } from '~/platform/audit/write.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { mapRow, snapshot } from '~/platform/standard/fields.ts'
import { createStandardService, type StandardService } from '~/platform/standard/service.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { listAuthorized } from '~/db/list.ts'
import { assertCompanyWritable, loadAuthorized } from '~/db/load.ts'
import {
  dateWire,
  projectStockItem,
  runeLen,
  toDate,
  trimOrNull,
  validateLeafWarehouse,
  validateOptionalText,
  wireDecimal,
} from './helpers.ts'
import { utcToday } from '~/db/dates.ts'
import { stockTransferItemResourceMeta, stockTransferResourceMeta } from './meta.ts'

export type TransferStatus = 'DRAFT' | 'SHIPPED' | 'RECEIVED'

/** wire 形单头（内核口径：date 为 YYYY-MM-DD 字符串，datetime 为 Date） */
export interface StockTransfer {
  id: string
  docNo: string
  docDate: string
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
  [key: string]: unknown
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

const DOC_META = stockTransferResourceMeta()
const ITEM_META = stockTransferItemResourceMeta()

const DOC_AUDIT = auditFieldsOf(DOC_META)
const ITEM_AUDIT = auditFieldsOf(ITEM_META)

const LABEL = '手工调拨单'
const ITEM_LABEL = '手工调拨单行'
const VOUCHER_TYPE = 'inv.stock_transfer'

export const TRANSFER_RESOURCE = 'invStockTransfers'
export const TRANSFER_ITEM_RESOURCE = 'invStockTransferItems'

const DOC_TABLE = 'inv_stock_transfer'
const ITEM_TABLE = 'inv_stock_transfer_item'

const DOC_WRITE_ERRORS = [{ code: '23505', message: '单据编号已存在' }] as const

export function createStockTransferService(
  db: Kysely<Database>,
  numbering: NumberingService,
  inventory: InventoryEngine,
  registry: Registry,
) {
  const docTarget = registry.authzTarget(TRANSFER_RESOURCE)
  const itemTarget = registry.authzTarget(TRANSFER_ITEM_RESOURCE)

  async function itemRowsOf(trx: TrxHandle, docId: string, ordered = false) {
    const q = trx.selectFrom('inv_stock_transfer_item').selectAll().where('stock_transfer_id', '=', docId)
    return ordered ? q.orderBy('idx', 'asc').execute() : q.execute()
  }

  const base: StandardService<StockTransfer> = createStandardService<StockTransfer>({
    db,
    registry,
    resource: TRANSFER_RESOURCE,
    notFound: `${LABEL}不存在`,
    defaultOrder: sql`"doc_no" ASC, "id" ASC`,
    writeErrors: [...DOC_WRITE_ERRORS],
    hooks: {
      // create 走手写路径；本钩子只服务 update
      validate: ({ action, draft }) => {
        if (action !== 'update') return
        normalizeDocDraft(draft)
        const fields: Record<string, string[]> = {}
        const docNo = String(draft.docNo ?? '')
        if (!docNo || runeLen(docNo) > 32) fields.docNo = ['不能为空且最多 32 个字符']
        validateOptionalText(fields, 'summary', draft.summary as string | null, 512)
        validateOptionalText(fields, 'remarks', draft.remarks as string | null, 512)
        if (Object.keys(fields).length > 0) {
          throw ApiError.validation(`${LABEL}参数不合法`, fields)
        }
        validateDistinct(
          String(draft.fromWarehouseId),
          String(draft.toWarehouseId),
          String(draft.transitWarehouseId),
        )
      },
      beforeWrite: async (trx, { draft }) => {
        await validateWarehouses(
          trx,
          String(draft.companyId),
          String(draft.fromWarehouseId),
          String(draft.toWarehouseId),
          String(draft.transitWarehouseId),
          true,
        )
      },
    },
    workflow: {
      mutableMessage: '仅草稿调拨单可修改或删除',
      transitions: [
        {
          key: 'ship',
          label: '发货',
          from: ['DRAFT'],
          to: 'SHIPPED',
          guardMessage: '仅草稿调拨单可发货',
          stamps: ({ permit }) => ({
            shipped_at: sql`(now() AT TIME ZONE 'utc')`,
            shipped_by_id: permit.actor.userId || null,
          }),
          effect: async (trx, { before }) => {
            const items = await itemRowsOf(trx, String(before.id))
            if (items.length === 0) {
              throw new ApiError('conflict', '发货前必须至少填写一行单据行')
            }
            await validateWarehouses(
              trx,
              String(before.companyId),
              String(before.fromWarehouseId),
              String(before.toWarehouseId),
              String(before.transitWarehouseId),
              true,
            )
            const lines = items.flatMap((item) => {
              const qty = decimal(item.base_qty)
              return [
                {
                  warehouseId: String(before.fromWarehouseId),
                  materialId: item.material_id,
                  quantity: qty,
                  direction: 'out' as const,
                  remarks: before.summary as string | null,
                },
                {
                  warehouseId: String(before.transitWarehouseId),
                  materialId: item.material_id,
                  quantity: qty,
                  direction: 'in' as const,
                  remarks: before.summary as string | null,
                },
              ]
            })
            await inventory.post(trx, voucherOf(before), lines)
          },
        },
        {
          key: 'receive',
          label: '收货',
          from: ['SHIPPED'],
          to: 'RECEIVED',
          guardMessage: '仅已发货调拨单可收货',
          stamps: ({ permit }) => ({
            received_at: sql`(now() AT TIME ZONE 'utc')`,
            received_by_id: permit.actor.userId || null,
          }),
          effect: async (trx, { before, input }) => {
            const items = await itemRowsOf(trx, String(before.id), true)
            const receipts = (input.receipts ?? null) as Array<{ itemId: string; qty: string }> | null
            const resolved = resolveReceipts(items, receipts)
            const lines = resolved.flatMap((r) => {
              if (r.qty.isZero()) return []
              return [
                {
                  warehouseId: String(before.transitWarehouseId),
                  materialId: r.item.material_id,
                  quantity: r.qty,
                  direction: 'out' as const,
                  remarks: before.summary as string | null,
                },
                {
                  warehouseId: String(before.toWarehouseId),
                  materialId: r.item.material_id,
                  quantity: r.qty,
                  direction: 'in' as const,
                  remarks: before.summary as string | null,
                },
              ]
            })
            if (lines.length > 0) {
              await inventory.post(trx, voucherOf(before), lines)
            }
            // 实收回写逐行审计（系统回写，actor 为空）
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
                resource: ITEM_TABLE,
                recordId: afterItem.id,
                recordLabel: afterItem.materialCode,
                companyId: afterItem.companyId,
                actionType: 'update',
                actionName: 'write_received',
                changes: auditDiff(itemSnap(beforeItem), itemSnap(afterItem), ITEM_AUDIT),
              })
            }
          },
        },
      ],
    },
  })

  function voucherOf(head: Record<string, unknown>) {
    return {
      type: VOUCHER_TYPE,
      id: String(head.id),
      no: String(head.docNo),
      companyId: String(head.companyId),
      postingDate: String(head.docDate),
    }
  }

  /**
   * 创建（手写）：单号取号 + 录入人盖章 —— created_by_id 不在内核可写列内。
   */
  async function create(
    permit: Permit,
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
    assertCompanyWritable(permit, input.companyId, '公司不存在')
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
      const docDate = input.docDate ? dateWire(input.docDate) : utcToday()
      const docNo = await numbering.assignedInTx(trx, {
        resource: VOUCHER_TYPE,
        field: 'docNo',
        provided: input.docNo,
        values: { company_id: input.companyId, doc_date: docDate },
      })
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
            created_by_id: permit.actor.userId || null,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapRow(DOC_META, row) as StockTransfer
        await writeAudit(trx, permit.actor, {
          resource: DOC_TABLE,
          recordId: item.id,
          recordLabel: item.docNo,
          companyId: item.companyId,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(snapshot(DOC_META, item, DOC_AUDIT), DOC_AUDIT),
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '创建手工调拨单失败', [...DOC_WRITE_ERRORS])
      }
    })
  }

  /** 按 Permit 取单头（可锁）；不命中一律 not_found */
  async function loadDoc(handle: DbHandle, permit: Permit, id: string, forUpdate: boolean): Promise<StockTransfer> {
    const row = await loadAuthorized({
      db: handle,
      permit,
      target: docTarget,
      table: DOC_TABLE,
      id,
      forUpdate,
      notFoundMessage: `${LABEL}不存在`,
    })
    return mapRow(DOC_META, row) as StockTransfer
  }

  /** 锁草稿单头：行编辑的公共前置（授权 → 状态守卫） */
  async function lockDraft(trx: DbHandle, permit: Permit, id: string): Promise<StockTransfer> {
    const doc = await loadDoc(trx, permit, id, true)
    if (doc.status !== 'DRAFT') {
      throw new ApiError('conflict', '仅草稿调拨单可编辑单据行')
    }
    return doc
  }

  /** 单据行的母单：行不存在与母单不可达同为 not_found */
  async function parentOf(trx: DbHandle, permit: Permit, itemId: string): Promise<StockTransfer> {
    const row = await trx
      .selectFrom('inv_stock_transfer_item')
      .select('stock_transfer_id')
      .where('id', '=', itemId)
      .executeTakeFirst()
    if (!row) throw new ApiError('not_found', `${ITEM_LABEL}不存在`)
    return lockDraft(trx, permit, row.stock_transfer_id)
  }

  /** 行的可达性经 via 链递归到母单自身的行谓词 */
  async function getItem(permit: Permit, id: string): Promise<StockTransferItem> {
    const row = await loadAuthorized({
      db,
      permit,
      target: itemTarget,
      table: ITEM_TABLE,
      id,
      notFoundMessage: `${ITEM_LABEL}不存在`,
    })
    return mapItem(row as never)
  }

  async function queryItems(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
      db,
      permit,
      target: itemTarget,
      alias: ITEM_TABLE,
      resource: ITEM_META,
      source: sql` FROM inv_stock_transfer_item`,
      select: sql`SELECT id,idx,qty,base_qty,received_qty,material_code,material_name,material_spec,
        unit_name,remark,inserted_at,updated_at,stock_transfer_id,company_id,material_id,unit_id`,
      defaultOrder: sql`"idx" ASC, "id" ASC`,
      query,
      mapRow: (r) => mapItem(r as never),
    })
  }

  async function createItem(
    permit: Permit,
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
      const doc = await lockDraft(trx, permit, input.stockTransferId)
      const projection = await projectStockItem(trx, input.materialId, input.unitId, qty, ITEM_LABEL)
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
      await writeAudit(trx, permit.actor, {
        resource: ITEM_TABLE,
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
    permit: Permit,
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
      // 母单先锁（授权 + 草稿门），再锁行：与并发路径的加锁顺序一致
      await parentOf(trx, permit, id)
      const locked = await trx
        .selectFrom('inv_stock_transfer_item')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', `${ITEM_LABEL}不存在`)
      const before = mapItem(locked)
      const qty = input.qty != null ? parseQty(input.qty) : decimal(before.qty)
      const materialId = input.materialId ?? before.materialId
      const unitId = input.unitId ?? before.unitId
      const remark = input.remarkPresent ? trimOrNull(input.remark) : before.remark
      const idx = input.idx ?? before.idx
      validateItemInput(qty, materialId, unitId, remark)
      const projection = await projectStockItem(trx, materialId, unitId, qty, ITEM_LABEL)
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
      await writeAudit(trx, permit.actor, {
        resource: ITEM_TABLE,
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

  async function removeItem(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      await parentOf(trx, permit, id)
      const locked = await trx
        .selectFrom('inv_stock_transfer_item')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', `${ITEM_LABEL}不存在`)
      const item = mapItem(locked)
      await trx.deleteFrom('inv_stock_transfer_item').where('id', '=', id).execute()
      await writeAudit(trx, permit.actor, {
        resource: ITEM_TABLE,
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
    ...base,
    create,
    ship: (permit: Permit, id: string) => base.transition(permit, id, 'ship'),
    receive: (permit: Permit, id: string, input: { receipts?: Array<{ itemId: string; qty: string }> | null }) =>
      base.transition(permit, id, 'receive', input as Record<string, unknown>),
    getItem,
    queryItems,
    createItem,
    updateItem,
    removeItem,
  }
}

export type StockTransferService = ReturnType<typeof createStockTransferService>

/** 单头 wire 规范化（trim / 业务日切片）：服务直调路径与路由同口径 */
function normalizeDocDraft(draft: Record<string, unknown>): void {
  if (typeof draft.docNo === 'string') draft.docNo = draft.docNo.trim()
  if (typeof draft.docDate === 'string') draft.docDate = dateWire(draft.docDate)
  draft.summary = trimOrNull(draft.summary as string | null | undefined)
  draft.remarks = trimOrNull(draft.remarks as string | null | undefined)
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
      throw new ApiError('conflict', `收货数量必须覆盖全部行:第 ${item.idx} 行缺实收数量`)
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

function mapItem(row: TransferItemRow): StockTransferItem {
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
    throw ApiError.validation(`${ITEM_LABEL}参数不合法`, { qty: ['数量必须大于零'] })
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
    throw ApiError.validation(`${ITEM_LABEL}参数不合法`, fields)
  }
}
