/**
 * 库存盘点单：刷新/审核/作废；审核走 withTx + inventory engine + 快照兜底。
 */
import { decimal, isDecimalString, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { InventoryEngine, StockLine } from '~/engines/inventory/index.ts'
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
import { mapWriteError } from '../base/dberr.ts'
import { companyScopeWhere, listFromSource } from '../base/list.ts'
import {
  currentBookQty,
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
import { stockCountItemResourceMeta, stockCountResourceMeta } from './meta.ts'

export type CountStatus = 'DRAFT' | 'AUDITED' | 'CANCELLED'

export interface StockCount {
  id: string
  docNo: string
  postingDate: Date
  summary: string | null
  remarks: string | null
  status: CountStatus
  auditedAt: Date | null
  snapshotTakenAt: Date
  insertedAt: Date
  updatedAt: Date
  companyId: string
  warehouseId: string
  createdById: string | null
  auditedById: string | null
}

export interface StockCountItem {
  id: string
  countedQuantity: string | null
  convertedCounted: string | null
  bookQuantity: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitName: string
  remark: string | null
  insertedAt: Date
  updatedAt: Date
  countId: string
  companyId: string
  materialId: string
  unitId: string
}

const DOC_AUDIT = [
  'doc_no',
  'posting_date',
  'summary',
  'remarks',
  'status',
  'audited_at',
  'snapshot_taken_at',
  'company_id',
  'warehouse_id',
  'created_by_id',
  'audited_by_id',
] as const

const ITEM_AUDIT = [
  'counted_quantity',
  'converted_counted',
  'book_quantity',
  'material_code',
  'material_name',
  'material_spec',
  'unit_name',
  'remark',
  'count_id',
  'company_id',
  'material_id',
  'unit_id',
] as const

const DOC_META = stockCountResourceMeta()
const ITEM_META = stockCountItemResourceMeta()
const LABEL = '库存盘点单'
const VOUCHER_TYPE = 'inv.stock_count'

export function createStockCountService(
  db: Kysely<Database>,
  numbering: NumberingService,
  inventory: InventoryEngine,
) {
  async function get(actor: Actor, id: string): Promise<StockCount> {
    const row = await db.selectFrom('inv_stock_count').selectAll().where('id', '=', id).executeTakeFirst()
    if (!row || !canAccessCompany(actor, row.company_id)) {
      throw new ApiError('not_found', '库存盘点单不存在')
    }
    return mapDoc(row)
  }

  async function list(actor: Actor, query: Partial<ListQuery>) {
    const scope = companyScopeWhere(actor, 'company_id')
    if (scope.empty) return { count: 0, results: [] as StockCount[] }
    return listFromSource({
      db,
      resource: DOC_META,
      source: sql` FROM inv_stock_count`,
      select: sql`SELECT id,doc_no,posting_date,summary,remarks,status,audited_at,snapshot_taken_at,
        inserted_at,updated_at,company_id,warehouse_id,created_by_id,audited_by_id`,
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
      postingDate?: string | null
      summary?: string | null
      remarks?: string | null
      companyId: string
      warehouseId: string
      items?: Array<{
        materialId: string
        unitId: string
        countedQuantity?: string | null
        remark?: string | null
      }>
      loadAll?: boolean
    },
  ): Promise<StockCount> {
    if (!canAccessCompany(actor, input.companyId)) {
      throw new ApiError('forbidden', '无权操作该公司数据')
    }
    const fields: Record<string, string[]> = {}
    if (!input.companyId) fields.companyId = ['必填']
    if (!input.warehouseId) fields.warehouseId = ['必填']
    if (input.loadAll && input.items && input.items.length > 0) {
      fields.items = ['不能与 loadAll 同时提供']
    }
    if (input.docNo != null && runeLen(input.docNo.trim()) > 32) fields.docNo = ['最多 32 个字符']
    validateOptionalText(fields, 'summary', input.summary, 512)
    validateOptionalText(fields, 'remarks', input.remarks, 512)
    if (Object.keys(fields).length > 0) {
      throw ApiError.validation(`${LABEL}参数不合法`, fields)
    }
    return withTx(db, async (trx) => {
      await validateLeafWarehouse(trx, input.companyId, input.warehouseId, LABEL)
      const postingDate = input.postingDate ? dateWire(input.postingDate) : todayUTC()
      let docNo = input.docNo?.trim() ?? ''
      if (!docNo) {
        docNo = await numbering.nextInTx(trx, {
          resource: 'inv.stock_count',
          values: { company_id: input.companyId, posting_date: postingDate },
        })
      }
      if (runeLen(docNo) > 32) {
        throw ApiError.validation(`${LABEL}参数不合法`, { docNo: ['最多 32 个字符'] })
      }
      try {
        // 快照时间用库钟，避免 JS/PG 时钟偏差触发「快照后有变动」误判
        const row = await trx
          .insertInto('inv_stock_count')
          .values({
            doc_no: docNo,
            posting_date: postingDate,
            summary: trimOrNull(input.summary),
            remarks: trimOrNull(input.remarks),
            snapshot_taken_at: sql`(now() AT TIME ZONE 'utc')`,
            company_id: input.companyId,
            warehouse_id: input.warehouseId,
            created_by_id: actor.userId?.trim() ? actor.userId : null,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const count = mapDoc(row)
        await writeAudit(trx, actor, {
          resource: 'inv_stock_count',
          recordId: count.id,
          recordLabel: count.docNo,
          companyId: count.companyId,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(docSnap(count), DOC_AUDIT),
        })
        if (input.loadAll) {
          const projections = await sql<{
            material_id: string
            material_code: string
            material_name: string
            material_spec: string | null
            unit_id: string
            unit_name: string
            book_quantity: string
          }>`
            SELECT m.id AS material_id,
                   m.code AS material_code,
                   m.name AS material_name,
                   m.spec AS material_spec,
                   m.default_unit_id AS unit_id,
                   u.name AS unit_name,
                   sum(e.quantity)::text AS book_quantity
            FROM inv_stock_entry AS e
            JOIN inv_material AS m ON m.id = e.material_id
            JOIN bas_unit AS u ON u.id = m.default_unit_id
            WHERE e.company_id = ${input.companyId}::uuid
              AND e.warehouse_id = ${input.warehouseId}::uuid
              AND e.is_cancelled = false
            GROUP BY m.id, m.code, m.name, m.spec, m.default_unit_id, u.name
            HAVING sum(e.quantity) <> 0
            ORDER BY m.code ASC, m.id ASC
          `.execute(trx)
          for (const p of projections.rows) {
            await insertCountItem(trx, actor, count, {
              materialId: p.material_id,
              unitId: p.unit_id,
              countedQuantity: null,
              remark: null,
              bookQuantity: p.book_quantity,
              materialCode: p.material_code,
              materialName: p.material_name,
              materialSpec: p.material_spec,
              unitName: p.unit_name,
              convertedCounted: null,
            })
          }
        } else {
          for (const line of input.items ?? []) {
            await createItemInTx(trx, actor, count, {
              materialId: line.materialId,
              unitId: line.unitId,
              countedQuantity: line.countedQuantity ?? null,
              remark: line.remark ?? null,
            })
          }
        }
        return count
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '创建库存盘点单失败', [
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
      postingDate?: string
      summary?: string | null
      summaryPresent?: boolean
      remarks?: string | null
      remarksPresent?: boolean
      warehouseId?: string
    },
  ): Promise<StockCount> {
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('inv_stock_count')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '库存盘点单不存在')
      const before = mapDoc(locked)
      if (!canAccessCompany(actor, before.companyId)) {
        throw new ApiError('forbidden', '无权操作该公司数据')
      }
      if (before.status !== 'DRAFT') {
        throw new ApiError('conflict', '仅草稿库存盘点单可修改或删除')
      }
      const after: StockCount = {
        ...before,
        docNo: input.docNo != null ? input.docNo.trim() : before.docNo,
        postingDate: input.postingDate
          ? new Date(`${dateWire(input.postingDate)}T00:00:00Z`)
          : before.postingDate,
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
          .updateTable('inv_stock_count')
          .set({
            doc_no: after.docNo,
            posting_date: dateWire(after.postingDate),
            summary: after.summary,
            remarks: after.remarks,
            warehouse_id: after.warehouseId,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapDoc(row)
        await writeAudit(trx, actor, {
          resource: 'inv_stock_count',
          recordId: item.id,
          recordLabel: item.docNo,
          companyId: item.companyId,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '更新库存盘点单失败', [
          { code: '23505', message: '单据编号已存在' },
        ])
      }
    })
  }

  async function remove(actor: Actor, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('inv_stock_count')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '库存盘点单不存在')
      const item = mapDoc(locked)
      if (!canAccessCompany(actor, item.companyId)) {
        throw new ApiError('forbidden', '无权操作该公司数据')
      }
      if (item.status !== 'DRAFT') {
        throw new ApiError('conflict', '仅草稿库存盘点单可修改或删除')
      }
      await trx.deleteFrom('inv_stock_count').where('id', '=', id).execute()
      await writeAudit(trx, actor, {
        resource: 'inv_stock_count',
        recordId: item.id,
        recordLabel: item.docNo,
        companyId: item.companyId,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(docSnap(item), DOC_AUDIT),
      })
    })
  }

  async function refresh(actor: Actor, id: string): Promise<StockCount> {
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('inv_stock_count')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '库存盘点单不存在')
      const before = mapDoc(locked)
      if (!canAccessCompany(actor, before.companyId)) {
        throw new ApiError('forbidden', '无权操作该公司数据')
      }
      if (before.status !== 'DRAFT') {
        throw new ApiError('conflict', '仅草稿库存盘点单可刷新账面数量')
      }
      const items = await trx
        .selectFrom('inv_stock_count_item')
        .selectAll()
        .where('count_id', '=', id)
        .execute()
      for (const raw of items) {
        const book = await currentBookQty(trx, before.warehouseId, raw.material_id)
        const beforeItem = mapItem(raw)
        const row = await trx
          .updateTable('inv_stock_count_item')
          .set({
            book_quantity: wireDecimal(book) ?? book.toFixed(),
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', raw.id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const afterItem = mapItem(row)
        const changes = auditDiff(itemSnap(beforeItem), itemSnap(afterItem), ITEM_AUDIT)
        if (Object.keys(changes).length > 0) {
          await writeAudit(trx, actor, {
            resource: 'inv_stock_count_item',
            recordId: afterItem.id,
            recordLabel: afterItem.materialCode,
            companyId: afterItem.companyId,
            actionType: 'update',
            actionName: 'sync_book_quantity',
            changes,
          })
        }
      }
      const row = await trx
        .updateTable('inv_stock_count')
        .set({
          snapshot_taken_at: sql`(now() AT TIME ZONE 'utc')`,
          updated_at: sql`(now() AT TIME ZONE 'utc')`,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
      const after = mapDoc(row)
      await writeAudit(trx, actor, {
        resource: 'inv_stock_count',
        recordId: after.id,
        recordLabel: after.docNo,
        companyId: after.companyId,
        actionType: 'update',
        actionName: 'refresh',
        changes: auditDiff(docSnap(before), docSnap(after), DOC_AUDIT),
      })
      return after
    })
  }

  async function approve(actor: Actor, id: string): Promise<StockCount> {
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('inv_stock_count')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '库存盘点单不存在')
      const before = mapDoc(locked)
      if (!canAccessCompany(actor, before.companyId)) {
        throw new ApiError('forbidden', '无权操作该公司数据')
      }
      if (before.status !== 'DRAFT') {
        throw new ApiError('conflict', '仅草稿库存盘点单可审核')
      }
      const items = await trx
        .selectFrom('inv_stock_count_item')
        .selectAll()
        .where('count_id', '=', id)
        .execute()
      if (items.length === 0) {
        throw new ApiError('conflict', '审核前必须至少填写一行盘点明细')
      }
      const lockKeys: string[] = []
      const seen = new Set<string>()
      for (const raw of items) {
        const item = mapItem(raw)
        if (item.countedQuantity == null || item.convertedCounted == null) {
          throw new ApiError('conflict', '审核前每行都必须填写实盘数量')
        }
        if (!seen.has(item.materialId)) {
          seen.add(item.materialId)
          lockKeys.push(`inv_stock:${before.warehouseId}:${item.materialId}`)
        }
      }
      lockKeys.sort()
      for (const key of lockKeys) {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`.execute(trx)
      }
      // 库内列对列比较，避免 JS Date 绑参时区偏移（timestamp without time zone）
      const stale = await sql<{ exists: boolean }>`
        SELECT EXISTS(
          SELECT 1
          FROM inv_stock_entry e
          JOIN inv_stock_count c ON c.id = ${id}::uuid
          WHERE e.company_id = c.company_id
            AND e.warehouse_id = c.warehouse_id
            AND (
              e.inserted_at > c.snapshot_taken_at
              OR e.cancelled_at > c.snapshot_taken_at
            )
        ) AS exists
      `.execute(trx)
      if (stale.rows[0]?.exists) {
        throw new ApiError('conflict', '库存已在快照后变化，请先刷新账面数量')
      }
      const lines: StockLine[] = []
      for (const raw of items) {
        const item = mapItem(raw)
        const delta = decimal(item.convertedCounted!).minus(decimal(item.bookQuantity))
        if (delta.isZero()) continue
        lines.push({
          warehouseId: before.warehouseId,
          materialId: item.materialId,
          quantity: delta,
          remarks: before.summary,
        })
      }
      if (lines.length > 0) {
        await inventory.post(
          trx,
          {
            type: VOUCHER_TYPE,
            id: before.id,
            no: before.docNo,
            companyId: before.companyId,
            postingDate: dateWire(before.postingDate),
          },
          lines,
        )
      }
      const now = new Date()
      const row = await trx
        .updateTable('inv_stock_count')
        .set({
          status: 'audited',
          audited_at: now,
          audited_by_id: actor.userId?.trim() ? actor.userId : null,
          updated_at: sql`(now() AT TIME ZONE 'utc')`,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
      const after = mapDoc(row)
      await writeAudit(trx, actor, {
        resource: 'inv_stock_count',
        recordId: after.id,
        recordLabel: after.docNo,
        companyId: after.companyId,
        actionType: 'update',
        actionName: 'approve',
        changes: auditDiff(docSnap(before), docSnap(after), DOC_AUDIT),
      })
      return after
    })
  }

  async function cancel(actor: Actor, id: string): Promise<StockCount> {
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('inv_stock_count')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '库存盘点单不存在')
      const before = mapDoc(locked)
      if (!canAccessCompany(actor, before.companyId)) {
        throw new ApiError('forbidden', '无权操作该公司数据')
      }
      if (before.status !== 'AUDITED') {
        throw new ApiError('conflict', '仅已审核库存盘点单可作废')
      }
      await inventory.cancel(trx, { type: VOUCHER_TYPE, id }, new Date())
      const row = await trx
        .updateTable('inv_stock_count')
        .set({
          status: 'cancelled',
          updated_at: sql`(now() AT TIME ZONE 'utc')`,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
      const after = mapDoc(row)
      await writeAudit(trx, actor, {
        resource: 'inv_stock_count',
        recordId: after.id,
        recordLabel: after.docNo,
        companyId: after.companyId,
        actionType: 'update',
        actionName: 'cancel',
        changes: auditDiff(docSnap(before), docSnap(after), DOC_AUDIT),
      })
      return after
    })
  }

  async function getItem(actor: Actor, id: string): Promise<StockCountItem> {
    const row = await db
      .selectFrom('inv_stock_count_item')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row || !canAccessCompany(actor, row.company_id)) {
      throw new ApiError('not_found', '库存盘点单行不存在')
    }
    return mapItem(row)
  }

  async function queryItems(actor: Actor, query: Partial<ListQuery>) {
    const scope = companyScopeWhere(actor, 'company_id')
    if (scope.empty) return { count: 0, results: [] as StockCountItem[] }
    return listFromSource({
      db,
      resource: ITEM_META,
      source: sql` FROM inv_stock_count_item`,
      select: sql`SELECT id,counted_quantity,converted_counted,book_quantity,material_code,
        material_name,material_spec,unit_name,remark,inserted_at,updated_at,
        count_id,company_id,material_id,unit_id`,
      defaultOrder: sql`"material_code" ASC, "id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: (r) => mapItem(r as never),
    })
  }

  async function createItem(
    actor: Actor,
    input: {
      countId: string
      materialId: string
      unitId: string
      countedQuantity?: string | null
      remark?: string | null
    },
  ): Promise<StockCountItem> {
    return withTx(db, async (trx) => {
      const count = await lockDraftCount(trx, actor, input.countId)
      return createItemInTx(trx, actor, count, {
        materialId: input.materialId,
        unitId: input.unitId,
        countedQuantity: input.countedQuantity ?? null,
        remark: input.remark ?? null,
      })
    })
  }

  async function updateItem(
    actor: Actor,
    id: string,
    input: {
      materialId?: string
      unitId?: string
      countedQuantity?: string | null
      countedQuantityPresent?: boolean
      remark?: string | null
      remarkPresent?: boolean
    },
  ): Promise<StockCountItem> {
    return withTx(db, async (trx) => {
      const current = await trx
        .selectFrom('inv_stock_count_item')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
      if (!current) throw new ApiError('not_found', '库存盘点单行不存在')
      const count = await lockDraftCount(trx, actor, current.count_id)
      const locked = await trx
        .selectFrom('inv_stock_count_item')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '库存盘点单行不存在')
      const before = mapItem(locked)
      const materialId = input.materialId ?? before.materialId
      const unitId = input.unitId ?? before.unitId
      const countedRaw = input.countedQuantityPresent
        ? (input.countedQuantity ?? null)
        : before.countedQuantity
      const remark = input.remarkPresent ? trimOrNull(input.remark) : before.remark
      const counted = parseCounted(countedRaw)
      validateItemInput(materialId, unitId, counted, remark)
      const projection = await projectCountItem(
        trx,
        count.warehouseId,
        materialId,
        unitId,
        counted,
      )
      const after: StockCountItem = {
        ...before,
        materialId,
        unitId,
        countedQuantity: counted == null ? null : (wireDecimal(counted) ?? counted.toFixed()),
        convertedCounted:
          projection.convertedCounted == null
            ? null
            : (wireDecimal(projection.convertedCounted) ?? projection.convertedCounted.toFixed()),
        bookQuantity: wireDecimal(projection.bookQuantity) ?? projection.bookQuantity.toFixed(),
        materialCode: projection.materialCode,
        materialName: projection.materialName,
        materialSpec: projection.materialSpec,
        unitName: projection.unitName,
        remark,
      }
      const changes = auditDiff(itemSnap(before), itemSnap(after), ITEM_AUDIT)
      if (Object.keys(changes).length === 0) return before
      const row = await trx
        .updateTable('inv_stock_count_item')
        .set({
          counted_quantity: after.countedQuantity,
          converted_counted: after.convertedCounted,
          book_quantity: after.bookQuantity,
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
        resource: 'inv_stock_count_item',
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
        .selectFrom('inv_stock_count_item')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
      if (!current) throw new ApiError('not_found', '库存盘点单行不存在')
      await lockDraftCount(trx, actor, current.count_id)
      const locked = await trx
        .selectFrom('inv_stock_count_item')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '库存盘点单行不存在')
      const item = mapItem(locked)
      await trx.deleteFrom('inv_stock_count_item').where('id', '=', id).execute()
      await writeAudit(trx, actor, {
        resource: 'inv_stock_count_item',
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
    refresh,
    approve,
    cancel,
    getItem,
    queryItems,
    createItem,
    updateItem,
    removeItem,
  }
}

export type StockCountService = ReturnType<typeof createStockCountService>

async function lockDraftCount(db: DbHandle, actor: Actor, id: string): Promise<StockCount> {
  const row = await db
    .selectFrom('inv_stock_count')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw new ApiError('not_found', '库存盘点单不存在')
  const count = mapDoc(row)
  if (!canAccessCompany(actor, count.companyId)) {
    throw new ApiError('forbidden', '无权操作该公司数据')
  }
  if (count.status !== 'DRAFT') {
    throw new ApiError('conflict', '仅草稿库存盘点单可编辑单据行')
  }
  return count
}

async function createItemInTx(
  db: DbHandle,
  actor: Actor,
  count: StockCount,
  input: {
    materialId: string
    unitId: string
    countedQuantity: string | null
    remark: string | null
  },
): Promise<StockCountItem> {
  const counted = parseCounted(input.countedQuantity)
  validateItemInput(input.materialId, input.unitId, counted, input.remark)
  const projection = await projectCountItem(
    db,
    count.warehouseId,
    input.materialId,
    input.unitId,
    counted,
  )
  return insertCountItem(db, actor, count, {
    materialId: input.materialId,
    unitId: input.unitId,
    countedQuantity: counted == null ? null : (wireDecimal(counted) ?? counted.toFixed()),
    convertedCounted:
      projection.convertedCounted == null
        ? null
        : (wireDecimal(projection.convertedCounted) ?? projection.convertedCounted.toFixed()),
    bookQuantity: wireDecimal(projection.bookQuantity) ?? projection.bookQuantity.toFixed(),
    materialCode: projection.materialCode,
    materialName: projection.materialName,
    materialSpec: projection.materialSpec,
    unitName: projection.unitName,
    remark: trimOrNull(input.remark),
  })
}

async function insertCountItem(
  db: DbHandle,
  actor: Actor | null,
  count: StockCount,
  values: {
    materialId: string
    unitId: string
    countedQuantity: string | null
    convertedCounted: string | null
    bookQuantity: string
    materialCode: string
    materialName: string
    materialSpec: string | null
    unitName: string
    remark: string | null
  },
): Promise<StockCountItem> {
  const row = await db
    .insertInto('inv_stock_count_item')
    .values({
      counted_quantity: values.countedQuantity,
      converted_counted: values.convertedCounted,
      book_quantity: values.bookQuantity,
      material_code: values.materialCode,
      material_name: values.materialName,
      material_spec: values.materialSpec,
      unit_name: values.unitName,
      remark: values.remark,
      count_id: count.id,
      company_id: count.companyId,
      material_id: values.materialId,
      unit_id: values.unitId,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  const item = mapItem(row)
  await writeAudit(db, actor, {
    resource: 'inv_stock_count_item',
    recordId: item.id,
    recordLabel: item.materialCode,
    companyId: item.companyId,
    actionType: 'create',
    actionName: 'create',
    changes: auditCreated(itemSnap(item), ITEM_AUDIT),
  })
  return item
}

async function projectCountItem(
  db: DbHandle,
  warehouseId: string,
  materialId: string,
  unitId: string,
  counted: ReturnType<typeof decimal> | null,
) {
  // 复用折算逻辑；账面单独取
  let convertedCounted: ReturnType<typeof decimal> | null = null
  let materialCode: string
  let materialName: string
  let materialSpec: string | null
  let unitName: string
  if (counted != null) {
    const p = await projectStockItem(db, materialId, unitId, counted, '库存盘点单行')
    convertedCounted = p.baseQty
    materialCode = p.materialCode
    materialName = p.materialName
    materialSpec = p.materialSpec
    unitName = p.unitName
  } else {
    // 仍需校验单位合法
    const p = await projectStockItem(db, materialId, unitId, decimal(1), '库存盘点单行')
    materialCode = p.materialCode
    materialName = p.materialName
    materialSpec = p.materialSpec
    unitName = p.unitName
  }
  const bookQuantity = await currentBookQty(db, warehouseId, materialId)
  return {
    convertedCounted,
    bookQuantity,
    materialCode,
    materialName,
    materialSpec,
    unitName,
  }
}

function mapDoc(row: {
  id: string
  doc_no: string
  posting_date: Date | string
  summary: string | null
  remarks: string | null
  status: string
  audited_at: Date | string | null
  snapshot_taken_at: Date | string
  inserted_at: Date | string
  updated_at: Date | string
  company_id: string
  warehouse_id: string
  created_by_id: string | null
  audited_by_id: string | null
}): StockCount {
  return {
    id: row.id,
    docNo: row.doc_no,
    postingDate: toDate(row.posting_date),
    summary: row.summary,
    remarks: row.remarks,
    status: upperStatus(row.status) as CountStatus,
    auditedAt: row.audited_at ? toDate(row.audited_at) : null,
    snapshotTakenAt: toDate(row.snapshot_taken_at),
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
  counted_quantity: string | null
  converted_counted: string | null
  book_quantity: string
  material_code: string
  material_name: string
  material_spec: string | null
  unit_name: string
  remark: string | null
  inserted_at: Date | string
  updated_at: Date | string
  count_id: string
  company_id: string
  material_id: string
  unit_id: string
}): StockCountItem {
  return {
    id: row.id,
    countedQuantity:
      row.counted_quantity == null
        ? null
        : (wireDecimal(row.counted_quantity) ?? String(row.counted_quantity)),
    convertedCounted:
      row.converted_counted == null
        ? null
        : (wireDecimal(row.converted_counted) ?? String(row.converted_counted)),
    bookQuantity: wireDecimal(row.book_quantity) ?? String(row.book_quantity),
    materialCode: row.material_code,
    materialName: row.material_name,
    materialSpec: row.material_spec,
    unitName: row.unit_name,
    remark: row.remark,
    insertedAt: toDate(row.inserted_at),
    updatedAt: toDate(row.updated_at),
    countId: row.count_id,
    companyId: row.company_id,
    materialId: row.material_id,
    unitId: row.unit_id,
  }
}

function docSnap(item: StockCount): Record<string, unknown> {
  return {
    doc_no: item.docNo,
    posting_date: item.postingDate,
    summary: item.summary,
    remarks: item.remarks,
    status: item.status,
    audited_at: item.auditedAt,
    snapshot_taken_at: item.snapshotTakenAt,
    company_id: item.companyId,
    warehouse_id: item.warehouseId,
    created_by_id: item.createdById,
    audited_by_id: item.auditedById,
  }
}

function itemSnap(item: StockCountItem): Record<string, unknown> {
  return {
    counted_quantity: item.countedQuantity,
    converted_counted: item.convertedCounted,
    book_quantity: item.bookQuantity,
    material_code: item.materialCode,
    material_name: item.materialName,
    material_spec: item.materialSpec,
    unit_name: item.unitName,
    remark: item.remark,
    count_id: item.countId,
    company_id: item.companyId,
    material_id: item.materialId,
    unit_id: item.unitId,
  }
}

function parseCounted(raw: string | null | undefined): ReturnType<typeof decimal> | null {
  if (raw == null || raw === '') return null
  if (!isDecimalString(raw)) {
    throw ApiError.validation('库存盘点单行参数不合法', { countedQuantity: ['数量不合法'] })
  }
  const d = decimal(raw)
  if (d.isNegative()) {
    throw ApiError.validation('库存盘点单行参数不合法', { countedQuantity: ['不能小于零'] })
  }
  return d
}

function validateItemInput(
  materialId: string,
  unitId: string,
  counted: ReturnType<typeof decimal> | null,
  remark: string | null | undefined,
): void {
  const fields: Record<string, string[]> = {}
  if (!materialId) fields.materialId = ['必填']
  if (!unitId) fields.unitId = ['必填']
  if (counted != null && counted.isNegative()) fields.countedQuantity = ['不能小于零']
  if (remark != null && runeLen(remark) > 512) fields.remark = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('库存盘点单行参数不合法', fields)
  }
}
