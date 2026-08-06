/**
 * 库存盘点单：单头走标准动作内核（get/list/update/remove + workflow 转移），
 * 审核（approve）/作废（cancel）两个转移的 effect 调库存引擎。
 *
 * 三处按动作弹射（见迁移决策日志）：
 * - `create`：`created_by_id` / `snapshot_taken_at` 是 readonly 列，内核 insert 写不进；
 *   且建单时按 items/loadAll 联动建行，属跨资源编排，不进钩子；
 * - `refresh`：重算账面快照是领域动作（无状态迁移），内核工作流表达不了；
 * - 盘点明细 CRUD：账面/折算/物料快照列 readonly，子行内核 update 不写这些列。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit。
 * `refresh` 无独立动作码（meta 未声明），沿用 update 的门控。
 */
import { decimal, isDecimalString, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { InventoryEngine, StockLine } from '~/engines/inventory/index.ts'
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
  currentBookQty,
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
import { stockCountItemResourceMeta, stockCountResourceMeta } from './meta.ts'

export type CountStatus = 'DRAFT' | 'AUDITED' | 'CANCELLED'

/** wire 形单头（内核口径：date 为 YYYY-MM-DD 字符串，datetime 为 Date） */
export interface StockCount {
  id: string
  docNo: string
  postingDate: string
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
  [key: string]: unknown
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

const DOC_META = stockCountResourceMeta()
const ITEM_META = stockCountItemResourceMeta()

const DOC_AUDIT = auditFieldsOf(DOC_META)
const ITEM_AUDIT = auditFieldsOf(ITEM_META)

const LABEL = '库存盘点单'
const ITEM_LABEL = '库存盘点单行'
const VOUCHER_TYPE = 'inv.stock_count'

export const COUNT_RESOURCE = 'invStockCounts'
export const COUNT_ITEM_RESOURCE = 'invStockCountItems'

const DOC_TABLE = 'inv_stock_count'
const ITEM_TABLE = 'inv_stock_count_item'

const DOC_WRITE_ERRORS = [{ code: '23505', message: '单据编号已存在' }] as const

export function createStockCountService(
  db: Kysely<Database>,
  numbering: NumberingService,
  inventory: InventoryEngine,
  registry: Registry,
) {
  const docTarget = registry.authzTarget(COUNT_RESOURCE)
  const itemTarget = registry.authzTarget(COUNT_ITEM_RESOURCE)

  const base: StandardService<StockCount> = createStandardService<StockCount>({
    db,
    registry,
    resource: COUNT_RESOURCE,
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
      },
      beforeWrite: async (trx, { draft }) => {
        await validateLeafWarehouse(trx, String(draft.companyId), String(draft.warehouseId), LABEL)
      },
    },
    workflow: {
      mutableMessage: `仅草稿${LABEL}可修改或删除`,
      transitions: [
        {
          key: 'approve',
          label: '审核',
          from: ['DRAFT'],
          to: 'AUDITED',
          guardMessage: `仅草稿${LABEL}可审核`,
          stamps: ({ permit }) => auditStamp(permit),
          effect: async (trx, { before }) => {
            const id = String(before.id)
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
                lockKeys.push(`inv_stock:${String(before.warehouseId)}:${item.materialId}`)
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
            const stockLines: StockLine[] = []
            for (const raw of items) {
              const item = mapItem(raw)
              const delta = decimal(item.convertedCounted!).minus(decimal(item.bookQuantity))
              if (delta.isZero()) continue
              // 方向进 direction；数量为绝对值（引擎 interface 瘦身后）
              stockLines.push({
                warehouseId: String(before.warehouseId),
                materialId: item.materialId,
                quantity: delta.isNegative() ? delta.neg() : delta,
                direction: delta.isNegative() ? 'out' : 'in',
                remarks: before.summary as string | null,
              })
            }
            if (stockLines.length > 0) {
              await inventory.post(
                trx,
                {
                  type: VOUCHER_TYPE,
                  id,
                  no: String(before.docNo),
                  companyId: String(before.companyId),
                  postingDate: String(before.postingDate),
                },
                stockLines,
              )
            }
          },
        },
        {
          key: 'cancel',
          label: '作废',
          from: ['AUDITED'],
          to: 'CANCELLED',
          guardMessage: `仅已审核${LABEL}可作废`,
          effect: async (trx, { before }) => {
            await inventory.cancel(trx, { type: VOUCHER_TYPE, id: String(before.id) }, new Date())
          },
        },
      ],
    },
  })

  /** 按 Permit 取单头（可锁）；不命中一律 not_found */
  async function loadCount(handle: DbHandle, permit: Permit, id: string, forUpdate: boolean): Promise<StockCount> {
    const row = await loadAuthorized({
      db: handle,
      permit,
      target: docTarget,
      table: DOC_TABLE,
      id,
      forUpdate,
      notFoundMessage: `${LABEL}不存在`,
    })
    return mapRow(DOC_META, row) as StockCount
  }

  /** 锁草稿单头：行编辑的公共前置（授权 → 状态守卫） */
  async function lockDraftCount(trx: DbHandle, permit: Permit, id: string): Promise<StockCount> {
    const count = await loadCount(trx, permit, id, true)
    if (count.status !== 'DRAFT') {
      throw new ApiError('conflict', `仅草稿${LABEL}可编辑单据行`)
    }
    return count
  }

  /** 盘点行的母单：行不存在与母单不可达同为 not_found */
  async function parentOf(trx: DbHandle, permit: Permit, itemId: string): Promise<StockCount> {
    const row = await trx
      .selectFrom('inv_stock_count_item')
      .select('count_id')
      .where('id', '=', itemId)
      .executeTakeFirst()
    if (!row) throw new ApiError('not_found', `${ITEM_LABEL}不存在`)
    return lockDraftCount(trx, permit, row.count_id)
  }

  /**
   * 创建（手写）：取号 + 录入人/快照时间盖章 + items/loadAll 联动建行
   * —— 三者都不在内核可写列/钩子纪律内。
   */
  async function create(
    permit: Permit,
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
    // 入参校验（400）先于公司边界（404）：错误语义唯一规则只管后者
    assertCompanyWritable(permit, input.companyId, '公司不存在')
    return withTx(db, async (trx) => {
      await validateLeafWarehouse(trx, input.companyId, input.warehouseId, LABEL)
      const postingDate = input.postingDate ? dateWire(input.postingDate) : utcToday()
      let docNo = input.docNo?.trim() ?? ''
      if (!docNo) {
        docNo = await numbering.nextInTx(trx, {
          resource: VOUCHER_TYPE,
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
            created_by_id: permit.actor.userId || null,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const count = mapRow(DOC_META, row) as StockCount
        await writeAudit(trx, permit.actor, {
          resource: DOC_TABLE,
          recordId: count.id,
          recordLabel: count.docNo,
          companyId: count.companyId,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(snapshot(DOC_META, count, DOC_AUDIT), DOC_AUDIT),
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
            await insertCountItem(trx, permit, count, {
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
            await createItemInTx(trx, permit, count, {
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
        throw mapWriteError(err, '创建库存盘点单失败', [...DOC_WRITE_ERRORS])
      }
    })
  }

  /**
   * 刷新账面数量（手写）：重算每行 book_quantity 并重置快照时间。
   * 领域动作、无状态迁移，内核工作流表达不了。
   */
  async function refresh(permit: Permit, id: string): Promise<StockCount> {
    return withTx(db, async (trx) => {
      const before = await loadCount(trx, permit, id, true)
      if (before.status !== 'DRAFT') {
        throw new ApiError('conflict', `仅草稿${LABEL}可刷新账面数量`)
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
          await writeAudit(trx, permit.actor, {
            resource: ITEM_TABLE,
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
      const after = mapRow(DOC_META, row) as StockCount
      await writeAudit(trx, permit.actor, {
        resource: DOC_TABLE,
        recordId: after.id,
        recordLabel: after.docNo,
        companyId: after.companyId,
        actionType: 'update',
        actionName: 'refresh',
        changes: auditDiff(
          snapshot(DOC_META, before, DOC_AUDIT),
          snapshot(DOC_META, after, DOC_AUDIT),
          DOC_AUDIT,
        ),
      })
      return after
    })
  }

  /** 行的可达性经 via 链递归到母单自身的行谓词 */
  async function getItem(permit: Permit, id: string): Promise<StockCountItem> {
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
      source: sql` FROM inv_stock_count_item`,
      select: sql`SELECT id,counted_quantity,converted_counted,book_quantity,material_code,
        material_name,material_spec,unit_name,remark,inserted_at,updated_at,
        count_id,company_id,material_id,unit_id`,
      defaultOrder: sql`"material_code" ASC, "id" ASC`,
      query,
      mapRow: (r) => mapItem(r as never),
    })
  }

  async function createItem(
    permit: Permit,
    input: {
      countId: string
      materialId: string
      unitId: string
      countedQuantity?: string | null
      remark?: string | null
    },
  ): Promise<StockCountItem> {
    return withTx(db, async (trx) => {
      const count = await lockDraftCount(trx, permit, input.countId)
      return createItemInTx(trx, permit, count, {
        materialId: input.materialId,
        unitId: input.unitId,
        countedQuantity: input.countedQuantity ?? null,
        remark: input.remark ?? null,
      })
    })
  }

  async function updateItem(
    permit: Permit,
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
      // 母单先锁（授权 + 草稿门），再锁行：与并发路径的加锁顺序一致
      const count = await parentOf(trx, permit, id)
      const locked = await trx
        .selectFrom('inv_stock_count_item')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', `${ITEM_LABEL}不存在`)
      const before = mapItem(locked)
      const materialId = input.materialId ?? before.materialId
      const unitId = input.unitId ?? before.unitId
      const countedRaw = input.countedQuantityPresent
        ? (input.countedQuantity ?? null)
        : before.countedQuantity
      const remark = input.remarkPresent ? trimOrNull(input.remark) : before.remark
      const counted = parseCounted(countedRaw)
      validateItemInput(materialId, unitId, counted, remark)
      const projection = await projectCountItem(trx, count.warehouseId, materialId, unitId, counted)
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
        .selectFrom('inv_stock_count_item')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', `${ITEM_LABEL}不存在`)
      const item = mapItem(locked)
      await trx.deleteFrom('inv_stock_count_item').where('id', '=', id).execute()
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
    refresh,
    approve: (permit: Permit, id: string) => base.transition(permit, id, 'approve'),
    cancel: (permit: Permit, id: string) => base.transition(permit, id, 'cancel'),
    getItem,
    queryItems,
    createItem,
    updateItem,
    removeItem,
  }
}

export type StockCountService = ReturnType<typeof createStockCountService>

/** 单头 wire 规范化（trim / 业务日切片）：服务直调路径与路由同口径 */
function normalizeDocDraft(draft: Record<string, unknown>): void {
  if (typeof draft.docNo === 'string') draft.docNo = draft.docNo.trim()
  if (typeof draft.postingDate === 'string') draft.postingDate = dateWire(draft.postingDate)
  draft.summary = trimOrNull(draft.summary as string | null | undefined)
  draft.remarks = trimOrNull(draft.remarks as string | null | undefined)
}

async function createItemInTx(
  db: DbHandle,
  permit: Permit,
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
  return insertCountItem(db, permit, count, {
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
  permit: Permit,
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
  await writeAudit(db, permit.actor, {
    resource: ITEM_TABLE,
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
    const p = await projectStockItem(db, materialId, unitId, counted, ITEM_LABEL)
    convertedCounted = p.baseQty
    materialCode = p.materialCode
    materialName = p.materialName
    materialSpec = p.materialSpec
    unitName = p.unitName
  } else {
    // 仍需校验单位合法
    const p = await projectStockItem(db, materialId, unitId, decimal(1), ITEM_LABEL)
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
    throw ApiError.validation(`${ITEM_LABEL}参数不合法`, { countedQuantity: ['数量不合法'] })
  }
  const d = decimal(raw)
  if (d.isNegative()) {
    throw ApiError.validation(`${ITEM_LABEL}参数不合法`, { countedQuantity: ['不能小于零'] })
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
    throw ApiError.validation(`${ITEM_LABEL}参数不合法`, fields)
  }
}
