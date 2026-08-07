/**
 * 手工出入库单：单头走标准动作内核（get/list/update/remove + workflow 转移），
 * 审核/作废两个转移的 effect 调库存引擎（取代 posting/skeleton 的编排 spec）。
 *
 * 两处按动作弹射（迁移时的内核缺口，见迁移决策日志）：
 * - `create`：`created_by_id` 是 readonly 列且本资源不声明 owner 绑定
 *   （矩阵不得授出行级范围，见 resource-authz.test）；
 * - 单据行 CRUD：物料快照列（material_code/base_qty…）readonly。
 *
 * 注意：弹射理由已随内核演进失效——`insertColumns`（头，finance/invoice 等在用于
 * 盖 created_by_id）与子行 `derivedFields`（进 WRITE_COLS）已分别覆盖上述两类缺口。
 * 回收手写 create/审计/取号 = 删除 ~150 行并继承合同套件，留作后续独立评估；
 * 回收前需逐字段对拍审计快照与错误文案（字节冻结约束）。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit。
 */
import { decimal, isDecimalString, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { InventoryEngine } from '~/engines/inventory/index.ts'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { auditCreated, auditDestroyed, auditDiff, writeAudit } from '~/platform/audit/write.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { mapRow, snapshot } from '~/platform/standard/fields.ts'
import { auditStamp, createStandardService, type StandardService } from '~/platform/standard/service.ts'
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
import { stockDocItemResourceMeta, stockDocResourceMeta } from './meta.ts'

export type StockDocDirection = 'IN' | 'OUT'
export type StockDocStatus = 'DRAFT' | 'AUDITED' | 'VOIDED'

/** wire 形单头（内核口径：date 为 YYYY-MM-DD 字符串，datetime 为 Date） */
export interface StockDoc {
  id: string
  docNo: string
  direction: StockDocDirection
  docDate: string
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
  [key: string]: unknown
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

const DOC_META = stockDocResourceMeta()
const ITEM_META = stockDocItemResourceMeta()

const DOC_AUDIT = auditFieldsOf(DOC_META)
const ITEM_AUDIT = auditFieldsOf(ITEM_META)

const LABEL = '手工出入库单'
const ITEM_LABEL = '手工出入库单行'
const VOUCHER_TYPE = 'inv.stock_doc'

export const DOC_RESOURCE = 'invStockDocs'
export const DOC_ITEM_RESOURCE = 'invStockDocItems'

const DOC_TABLE = 'inv_stock_doc'
const ITEM_TABLE = 'inv_stock_doc_item'

const DOC_WRITE_ERRORS = [{ code: '23505', message: '单据编号已存在' }] as const

export function createStockDocService(
  db: Kysely<Database>,
  numbering: NumberingService,
  inventory: InventoryEngine,
  registry: Registry,
) {
  const docTarget = registry.authzTarget(DOC_RESOURCE)
  const itemTarget = registry.authzTarget(DOC_ITEM_RESOURCE)

  /** 单头行集（审核过账用；行由手写路径维护，故此处直查） */
  async function itemRowsOf(trx: DbHandle, docId: string) {
    return trx.selectFrom('inv_stock_doc_item').selectAll().where('stock_doc_id', '=', docId).execute()
  }

  const base: StandardService<StockDoc> = createStandardService<StockDoc>({
    db,
    registry,
    resource: DOC_RESOURCE,
    notFound: `${LABEL}不存在`,
    defaultOrder: sql`"doc_no" ASC, "id" ASC`,
    writeErrors: [...DOC_WRITE_ERRORS],
    hooks: {
      // create 走手写路径；本钩子只服务 update
      validate: ({ action, draft, before }) => {
        if (action !== 'update' || !before) return
        normalizeDocDraft(draft)
        if (draft.direction !== before.direction) {
          throw ApiError.validation(`${LABEL}参数不合法`, { direction: ['出入库方向不可变更'] })
        }
        const fields: Record<string, string[]> = {}
        const docNo = String(draft.docNo ?? '')
        if (!docNo || runeLen(docNo) > 32) fields.docNo = ['不能为空且最多 32 个字符']
        validateOptionalText(fields, 'summary', draft.summary as string | null, 512)
        validateOptionalText(fields, 'remarks', draft.remarks as string | null, 512)
        if (Object.keys(fields).length > 0) {
          throw ApiError.validation(`${LABEL}参数不合法`, fields)
        }
      },
      beforeWrite: async (trx, { draft }) => {
        await validateLeafWarehouse(trx, String(draft.companyId), String(draft.warehouseId), LABEL)
      },
    },
    workflow: {
      mutableMessage: `仅草稿${LABEL}可修改或删除`,
      transitions: [
        {
          key: 'audit',
          label: '审核',
          from: ['DRAFT'],
          to: 'AUDITED',
          guardMessage: `仅草稿${LABEL}可审核`,
          stamps: ({ permit }) => auditStamp(permit),
          effect: async (trx, { before }) => {
            const items = await itemRowsOf(trx, String(before.id))
            if (items.length === 0) {
              throw new ApiError('conflict', '审核前必须至少填写一行单据行')
            }
            // 方向进 direction；数量为绝对值（引擎 interface 瘦身后）
            const stockLines = items.map((item) => ({
              warehouseId: String(before.warehouseId),
              materialId: item.material_id,
              quantity: decimal(item.base_qty),
              direction: before.direction === 'OUT' ? ('out' as const) : ('in' as const),
              remarks: before.summary as string | null,
            }))
            await inventory.post(
              trx,
              {
                type: VOUCHER_TYPE,
                id: String(before.id),
                no: String(before.docNo),
                companyId: String(before.companyId),
                postingDate: String(before.docDate),
              },
              stockLines,
            )
          },
        },
        {
          key: 'void',
          label: '作废',
          from: ['AUDITED'],
          to: 'VOIDED',
          guardMessage: `仅已审核${LABEL}可作废`,
          effect: async (trx, { before }) => {
            await inventory.cancel(trx, { type: VOUCHER_TYPE, id: String(before.id) }, new Date())
          },
        },
      ],
    },
  })

  /**
   * 创建（手写）：单号取号 + 录入人盖章 —— created_by_id 不在内核可写列内。
   */
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
      const docNo = await numbering.assignedInTx(trx, {
        resource: VOUCHER_TYPE,
        field: 'docNo',
        provided: input.docNo,
        values: {
          company_id: input.companyId,
          doc_date: docDate,
          direction: input.direction,
        },
      })
      if (runeLen(docNo) > 32) {
        throw ApiError.validation(`${LABEL}参数不合法`, { docNo: ['最多 32 个字符'] })
      }
      try {
        const row = await trx
          .insertInto('inv_stock_doc')
          .values({
            doc_no: docNo,
            direction: input.direction.toLowerCase(),
            doc_date: docDate,
            summary: trimOrNull(input.summary),
            remarks: trimOrNull(input.remarks),
            company_id: input.companyId,
            warehouse_id: input.warehouseId,
            created_by_id: permit.actor.userId || null,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapRow(DOC_META, row) as StockDoc
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
        throw mapWriteError(err, '创建手工出入库单失败', [...DOC_WRITE_ERRORS])
      }
    })
  }

  /** 按 Permit 取单头（可锁）；不命中一律 not_found */
  async function loadDoc(handle: DbHandle, permit: Permit, id: string, forUpdate: boolean): Promise<StockDoc> {
    const row = await loadAuthorized({
      db: handle,
      permit,
      target: docTarget,
      table: DOC_TABLE,
      id,
      forUpdate,
      notFoundMessage: `${LABEL}不存在`,
    })
    return mapRow(DOC_META, row) as StockDoc
  }

  /** 锁草稿单头：行编辑的公共前置（授权 → 状态守卫） */
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
      const projection = await projectStockItem(trx, input.materialId, input.unitId, qty, ITEM_LABEL)
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
      const projection = await projectStockItem(trx, materialId, unitId, qty, ITEM_LABEL)
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
        .selectFrom('inv_stock_doc_item')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', `${ITEM_LABEL}不存在`)
      const item = mapItem(locked)
      await trx.deleteFrom('inv_stock_doc_item').where('id', '=', id).execute()
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
    audit: (permit: Permit, id: string) => base.transition(permit, id, 'audit'),
    void: (permit: Permit, id: string) => base.transition(permit, id, 'void'),
    getItem,
    queryItems,
    createItem,
    updateItem,
    removeItem,
  }
}

export type StockDocService = ReturnType<typeof createStockDocService>

/** 单头 wire 规范化（trim / 业务日切片）：服务直调路径与路由同口径 */
function normalizeDocDraft(draft: Record<string, unknown>): void {
  if (typeof draft.docNo === 'string') draft.docNo = draft.docNo.trim()
  if (typeof draft.docDate === 'string') draft.docDate = dateWire(draft.docDate)
  draft.summary = trimOrNull(draft.summary as string | null | undefined)
  draft.remarks = trimOrNull(draft.remarks as string | null | undefined)
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
