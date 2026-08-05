/**
 * 手工出入库单：审核/作废走 withTx + 库存过账骨架（auditInventoryDocInTx）。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit——
 * 列表 `listAuthorized`、写前取行 `loadAuthorized`（不命中一律 not_found）、
 * create 走 `assertCompanyWritable`。模块内零鉴权代码。
 * 状态前置条件（草稿才能改等）是领域不变量，留在本文件抛 conflict。
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
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { listAuthorized } from '~/db/list.ts'
import { assertCompanyWritable, loadAuthorized } from '~/db/load.ts'
import {
  auditInventoryDocInTx,
  voidInventoryDocInTx,
} from '~/platform/posting/skeleton.ts'
import {
  dateWire,
  lowerStatus,
  projectStockItem,
  runeLen,
  toDate,
  trimOrNull,
  upperStatus,
  validateLeafWarehouse,
  validateOptionalText,
  wireDecimal,
} from './helpers.ts'
import { utcToday } from '~/db/dates.ts'
import { stockDocItemResourceMeta, stockDocResourceMeta } from './meta.ts'

export type StockDocDirection = 'IN' | 'OUT'
export type StockDocStatus = 'DRAFT' | 'AUDITED' | 'VOIDED'

export interface StockDoc {
  id: string
  docNo: string
  direction: StockDocDirection
  docDate: Date
  summary: string | null
  remarks: string | null
  status: StockDocStatus
  auditedAt: Date | null
  insertedAt: Date
  updatedAt: Date
  companyId: string
  warehouseId: string
  createdById: string | null
  auditedById: string | null
}

export interface StockDocItem {
  id: string
  idx: number
  qty: string
  baseQty: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitName: string
  remark: string | null
  insertedAt: Date
  updatedAt: Date
  stockDocId: string
  companyId: string
  materialId: string
  unitId: string
}

const DOC_AUDIT = auditFieldsOf(stockDocResourceMeta())

const ITEM_AUDIT = auditFieldsOf(stockDocItemResourceMeta())

const DOC_META = stockDocResourceMeta()
const ITEM_META = stockDocItemResourceMeta()
const LABEL = '手工出入库单'
const ITEM_LABEL = '手工出入库单行'
const VOUCHER_TYPE = 'inv.stock_doc'

export const DOC_RESOURCE = 'invStockDocs'
export const DOC_ITEM_RESOURCE = 'invStockDocItems'

const DOC_TABLE = 'inv_stock_doc'
const ITEM_TABLE = 'inv_stock_doc_item'

export function createStockDocService(
  db: Kysely<Database>,
  numbering: NumberingService,
  inventory: InventoryEngine,
  registry: Registry,
) {
  const docTarget = registry.authzTarget(DOC_RESOURCE)
  const itemTarget = registry.authzTarget(DOC_ITEM_RESOURCE)

  /** 按 Permit 取单头（可锁）；不命中一律 not_found */
  async function loadDoc(
    handle: DbHandle,
    permit: Permit,
    id: string,
    forUpdate: boolean,
  ): Promise<StockDoc> {
    const row = await loadAuthorized({
      db: handle,
      permit,
      target: docTarget,
      table: DOC_TABLE,
      id,
      forUpdate,
      notFoundMessage: `${LABEL}不存在`,
    })
    return mapDoc(row as never)
  }

  /** 锁草稿单头：行编辑与工作流的公共前置（授权 → 状态守卫） */
  async function lockDraftDoc(trx: DbHandle, permit: Permit, docId: string): Promise<StockDoc> {
    const doc = await loadDoc(trx, permit, docId, true)
    if (doc.status !== 'DRAFT') {
      throw new ApiError('conflict', `仅草稿${LABEL}可编辑单据行`)
    }
    return doc
  }

  /** 单据行的母单：行不存在与母单不可达同为 not_found */
  async function parentOf(trx: DbHandle, permit: Permit, itemId: string): Promise<StockDoc> {
    const row = await trx
      .selectFrom('inv_stock_doc_item')
      .select('stock_doc_id')
      .where('id', '=', itemId)
      .executeTakeFirst()
    if (!row) throw new ApiError('not_found', `${ITEM_LABEL}不存在`)
    return lockDraftDoc(trx, permit, row.stock_doc_id)
  }
  async function get(permit: Permit, id: string): Promise<StockDoc> {
    return loadDoc(db, permit, id, false)
  }

  async function list(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
      db,
      permit,
      target: docTarget,
      alias: DOC_TABLE,
      resource: DOC_META,
      source: sql` FROM inv_stock_doc`,
      select: sql`SELECT id,doc_no,direction,doc_date,summary,remarks,status,audited_at,
        inserted_at,updated_at,company_id,warehouse_id,created_by_id,audited_by_id`,
      defaultOrder: sql`"doc_no" ASC, "id" ASC`,
      query,
      mapRow: (r) => mapDoc(r as never),
    })
  }

  async function create(
    permit: Permit,
    input: {
      docNo?: string | null
      direction: StockDocDirection
      docDate?: string | null
      summary?: string | null
      remarks?: string | null
      companyId: string
      warehouseId: string
    },
  ): Promise<StockDoc> {
    const fields: Record<string, string[]> = {}
    if (input.direction !== 'IN' && input.direction !== 'OUT') {
      fields.direction = ['必须是 IN 或 OUT']
    }
    if (!input.companyId) fields.companyId = ['必填']
    if (!input.warehouseId) fields.warehouseId = ['必填']
    if (input.docNo != null && runeLen(input.docNo.trim()) > 32) fields.docNo = ['最多 32 个字符']
    validateOptionalText(fields, 'summary', input.summary, 512)
    validateOptionalText(fields, 'remarks', input.remarks, 512)
    if (Object.keys(fields).length > 0) {
      throw ApiError.validation(`${LABEL}参数不合法`, fields)
    }
    // 入参校验（400）先于公司边界（404）：错误语义唯一规则只管后者
    assertCompanyWritable(permit, input.companyId, '公司不存在')
    return withTx(db, async (trx) => {
      await validateLeafWarehouse(trx, input.companyId, input.warehouseId, LABEL)
      const docDate = input.docDate ? dateWire(input.docDate) : utcToday()
      let docNo = input.docNo?.trim() ?? ''
      if (!docNo) {
        docNo = await numbering.nextInTx(trx, {
          resource: 'inv.stock_doc',
          values: {
            company_id: input.companyId,
            doc_date: docDate,
            direction: input.direction,
          },
        })
      }
      if (runeLen(docNo) > 32) {
        throw ApiError.validation(`${LABEL}参数不合法`, { docNo: ['最多 32 个字符'] })
      }
      try {
        const row = await trx
          .insertInto('inv_stock_doc')
          .values({
            doc_no: docNo,
            direction: lowerStatus(input.direction),
            doc_date: docDate,
            summary: trimOrNull(input.summary),
            remarks: trimOrNull(input.remarks),
            company_id: input.companyId,
            warehouse_id: input.warehouseId,
            created_by_id: permit.actor.userId || null,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapDoc(row)
        await writeAudit(trx, permit.actor, {
          resource: 'inv_stock_doc',
          recordId: item.id,
          recordLabel: item.docNo,
          companyId: item.companyId,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(docSnap(item), DOC_AUDIT),
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '创建手工出入库单失败', [
          { code: '23505', message: '单据编号已存在' },
        ])
      }
    })
  }

  async function update(
    permit: Permit,
    id: string,
    input: {
      docNo?: string
      direction?: StockDocDirection
      docDate?: string
      summary?: string | null
      summaryPresent?: boolean
      remarks?: string | null
      remarksPresent?: boolean
      warehouseId?: string
    },
  ): Promise<StockDoc> {
    return withTx(db, async (trx) => {
      const before = await loadDoc(trx, permit, id, true)
      if (before.status !== 'DRAFT') {
        throw new ApiError('conflict', '仅草稿手工出入库单可修改或删除')
      }
      if (input.direction != null && input.direction !== before.direction) {
        throw ApiError.validation(`${LABEL}参数不合法`, { direction: ['出入库方向不可变更'] })
      }
      const after: StockDoc = {
        ...before,
        docNo: input.docNo != null ? input.docNo.trim() : before.docNo,
        docDate: input.docDate ? new Date(`${dateWire(input.docDate)}T00:00:00Z`) : before.docDate,
        summary: input.summaryPresent ? trimOrNull(input.summary) : before.summary,
        remarks: input.remarksPresent ? trimOrNull(input.remarks) : before.remarks,
        warehouseId: input.warehouseId ?? before.warehouseId,
      }
      const fields: Record<string, string[]> = {}
      if (!after.docNo || runeLen(after.docNo) > 32) fields.docNo = ['不能为空且最多 32 个字符']
      validateOptionalText(fields, 'summary', after.summary, 512)
      validateOptionalText(fields, 'remarks', after.remarks, 512)
      if (Object.keys(fields).length > 0) {
        throw ApiError.validation(`${LABEL}参数不合法`, fields)
      }
      await validateLeafWarehouse(trx, after.companyId, after.warehouseId, LABEL)
      const changes = auditDiff(docSnap(before), docSnap(after), DOC_AUDIT)
      if (Object.keys(changes).length === 0) return before
      try {
        const row = await trx
          .updateTable('inv_stock_doc')
          .set({
            doc_no: after.docNo,
            doc_date: dateWire(after.docDate),
            summary: after.summary,
            remarks: after.remarks,
            warehouse_id: after.warehouseId,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapDoc(row)
        await writeAudit(trx, permit.actor, {
          resource: 'inv_stock_doc',
          recordId: item.id,
          recordLabel: item.docNo,
          companyId: item.companyId,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '更新手工出入库单失败', [
          { code: '23505', message: '单据编号已存在' },
        ])
      }
    })
  }

  async function remove(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const item = await loadDoc(trx, permit, id, true)
      if (item.status !== 'DRAFT') {
        throw new ApiError('conflict', '仅草稿手工出入库单可修改或删除')
      }
      await trx.deleteFrom('inv_stock_doc').where('id', '=', id).execute()
      await writeAudit(trx, permit.actor, {
        resource: 'inv_stock_doc',
        recordId: item.id,
        recordLabel: item.docNo,
        companyId: item.companyId,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(docSnap(item), DOC_AUDIT),
      })
    })
  }

  async function audit(permit: Permit, id: string): Promise<StockDoc> {
    return withTx(db, async (trx) =>
      auditInventoryDocInTx(trx, permit.actor, inventory, {
        voucherType: VOUCHER_TYPE,
        headTable: 'inv_stock_doc',
        setPostingDate: false,
        lockDraft: async (t) => {
          const before = await loadDoc(t, permit, id, true)
          if (before.status !== 'DRAFT') {
            throw new ApiError('conflict', '仅草稿手工出入库单可审核')
          }
          return before
        },
        collect: async (t, before) => {
          const items = await t
            .selectFrom('inv_stock_doc_item')
            .selectAll()
            .where('stock_doc_id', '=', id)
            .execute()
          if (items.length === 0) {
            throw new ApiError('conflict', '审核前必须至少填写一行单据行')
          }
          // 方向进 direction；数量为绝对值（引擎 interface 瘦身后）
          const stockLines = items.map((item) => ({
            warehouseId: before.warehouseId,
            materialId: item.material_id,
            quantity: decimal(item.base_qty),
            direction: before.direction === 'OUT' ? ('out' as const) : ('in' as const),
            remarks: before.summary,
          }))
          return { stockLines, postingDate: dateWire(before.docDate) }
        },
        voucherOf: (h) => ({ id: h.id, no: h.docNo, companyId: h.companyId }),
        reload: async (t, headId) => {
          const row = await t
            .selectFrom('inv_stock_doc')
            .selectAll()
            .where('id', '=', headId)
            .executeTakeFirstOrThrow()
          return mapDoc(row)
        },
        snapshot: docSnap,
        auditFields: DOC_AUDIT,
      }),
    )
  }

  async function voidDoc(permit: Permit, id: string): Promise<StockDoc> {
    return withTx(db, async (trx) =>
      voidInventoryDocInTx(trx, permit.actor, inventory, {
        voucherType: VOUCHER_TYPE,
        headTable: 'inv_stock_doc',
        lockAudited: async (t) => {
          const before = await loadDoc(t, permit, id, true)
          if (before.status !== 'AUDITED') {
            throw new ApiError('conflict', '仅已审核手工出入库单可作废')
          }
          return before
        },
        voucherOf: (h) => ({ id: h.id, no: h.docNo, companyId: h.companyId }),
        reload: async (t, headId) => {
          const row = await t
            .selectFrom('inv_stock_doc')
            .selectAll()
            .where('id', '=', headId)
            .executeTakeFirstOrThrow()
          return mapDoc(row)
        },
        snapshot: docSnap,
        auditFields: DOC_AUDIT,
      }),
    )
  }

  // —— 行 ——
  /** 行的可达性经 via 链递归到母单自身的行谓词 */
  async function getItem(permit: Permit, id: string): Promise<StockDocItem> {
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
      source: sql` FROM inv_stock_doc_item`,
      select: sql`SELECT id,idx,qty,base_qty,material_code,material_name,material_spec,unit_name,
        remark,inserted_at,updated_at,stock_doc_id,company_id,material_id,unit_id`,
      defaultOrder: sql`"idx" ASC, "id" ASC`,
      query,
      mapRow: (r) => mapItem(r as never),
    })
  }

  async function createItem(
    permit: Permit,
    input: {
      stockDocId: string
      idx: number
      qty: string
      materialId: string
      unitId: string
      remark?: string | null
    },
  ): Promise<StockDocItem> {
    const qty = parseQty(input.qty)
    validateItemInput(qty, input.materialId, input.unitId, input.remark)
    return withTx(db, async (trx) => {
      const doc = await lockDraftDoc(trx, permit, input.stockDocId)
      const projection = await projectStockItem(
        trx,
        input.materialId,
        input.unitId,
        qty,
        '手工出入库单行',
      )
      const row = await trx
        .insertInto('inv_stock_doc_item')
        .values({
          idx: input.idx,
          qty: wireDecimal(qty) ?? qty.toFixed(),
          base_qty: wireDecimal(projection.baseQty) ?? projection.baseQty.toFixed(),
          material_code: projection.materialCode,
          material_name: projection.materialName,
          material_spec: projection.materialSpec,
          unit_name: projection.unitName,
          remark: trimOrNull(input.remark),
          stock_doc_id: input.stockDocId,
          company_id: doc.companyId,
          material_id: input.materialId,
          unit_id: input.unitId,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      const item = mapItem(row)
      await writeAudit(trx, permit.actor, {
        resource: 'inv_stock_doc_item',
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
  ): Promise<StockDocItem> {
    return withTx(db, async (trx) => {
      // 母单先锁（授权 + 草稿门），再锁行：与并发路径的加锁顺序一致
      await parentOf(trx, permit, id)
      const locked = await trx
        .selectFrom('inv_stock_doc_item')
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
      const projection = await projectStockItem(trx, materialId, unitId, qty, '手工出入库单行')
      const after: StockDocItem = {
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
        .updateTable('inv_stock_doc_item')
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
        resource: 'inv_stock_doc_item',
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
        .selectFrom('inv_stock_doc_item')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', `${ITEM_LABEL}不存在`)
      const item = mapItem(locked)
      await trx.deleteFrom('inv_stock_doc_item').where('id', '=', id).execute()
      await writeAudit(trx, permit.actor, {
        resource: 'inv_stock_doc_item',
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
    audit,
    void: voidDoc,
    getItem,
    queryItems,
    createItem,
    updateItem,
    removeItem,
  }
}

export type StockDocService = ReturnType<typeof createStockDocService>

function mapDoc(row: {
  id: string
  doc_no: string
  direction: string
  doc_date: Date | string
  summary: string | null
  remarks: string | null
  status: string
  audited_at: Date | string | null
  inserted_at: Date | string
  updated_at: Date | string
  company_id: string
  warehouse_id: string
  created_by_id: string | null
  audited_by_id: string | null
}): StockDoc {
  return {
    id: row.id,
    docNo: row.doc_no,
    direction: upperStatus(row.direction) as StockDocDirection,
    docDate: toDate(row.doc_date),
    summary: row.summary,
    remarks: row.remarks,
    status: upperStatus(row.status) as StockDocStatus,
    auditedAt: row.audited_at ? toDate(row.audited_at) : null,
    insertedAt: toDate(row.inserted_at),
    updatedAt: toDate(row.updated_at),
    companyId: row.company_id,
    warehouseId: row.warehouse_id,
    createdById: row.created_by_id,
    auditedById: row.audited_by_id,
  }
}

function mapItem(row: {
  id: string
  idx: string | number
  qty: string
  base_qty: string
  material_code: string
  material_name: string
  material_spec: string | null
  unit_name: string
  remark: string | null
  inserted_at: Date | string
  updated_at: Date | string
  stock_doc_id: string
  company_id: string
  material_id: string
  unit_id: string
}): StockDocItem {
  return {
    id: row.id,
    idx: Number(row.idx),
    qty: wireDecimal(row.qty) ?? String(row.qty),
    baseQty: wireDecimal(row.base_qty) ?? String(row.base_qty),
    materialCode: row.material_code,
    materialName: row.material_name,
    materialSpec: row.material_spec,
    unitName: row.unit_name,
    remark: row.remark,
    insertedAt: toDate(row.inserted_at),
    updatedAt: toDate(row.updated_at),
    stockDocId: row.stock_doc_id,
    companyId: row.company_id,
    materialId: row.material_id,
    unitId: row.unit_id,
  }
}

function docSnap(item: StockDoc): Record<string, unknown> {
  return {
    doc_no: item.docNo,
    direction: item.direction,
    doc_date: item.docDate,
    summary: item.summary,
    remarks: item.remarks,
    status: item.status,
    audited_at: item.auditedAt,
    company_id: item.companyId,
    warehouse_id: item.warehouseId,
    created_by_id: item.createdById,
    audited_by_id: item.auditedById,
  }
}

function itemSnap(item: StockDocItem): Record<string, unknown> {
  return {
    idx: item.idx,
    qty: item.qty,
    base_qty: item.baseQty,
    material_code: item.materialCode,
    material_name: item.materialName,
    material_spec: item.materialSpec,
    unit_name: item.unitName,
    remark: item.remark,
    stock_doc_id: item.stockDocId,
    company_id: item.companyId,
    material_id: item.materialId,
    unit_id: item.unitId,
  }
}

function parseQty(raw: string) {
  if (!isDecimalString(raw) || !decimal(raw).isPositive()) {
    throw ApiError.validation('手工出入库单行参数不合法', { qty: ['数量必须大于零'] })
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
    throw ApiError.validation('手工出入库单行参数不合法', fields)
  }
}
