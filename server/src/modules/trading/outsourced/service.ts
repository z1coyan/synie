/**
 * 委外发料 / 委外入库：完整 CRUD、审核（库存+投影+总账）、作废回滚、比例带出材料/副产物。
 * 行为对齐 server-go/internal/domain/fulfillment/outsourced。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit——
 * 列表 `listAuthorized`、单条投影 `loadAuthorizedFrom`、写前取行 `loadAuthorized`（不命中一律
 * not_found）、create 走 `assertCompanyWritable`。子行/材料/副产物经 via 链递归到母单谓词
 * （材料/副产物是两级 via）。状态前置条件（草稿才能改等）是领域不变量，留在本文件抛 conflict。
 */
import type { ListQuery } from '@synie/shared'
import { decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { GlEngine } from '~/engines/gl/index.ts'
import type { InventoryEngine, StockLine } from '~/engines/inventory/index.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import { auditFieldsOf, mergeAuditFields } from '~/platform/audit/spec.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { listAuthorized } from '~/db/list.ts'
import { assertCompanyWritable, loadAuthorized, loadAuthorizedFrom } from '~/db/load.ts'
import { mapWriteError as mapWriteErrorBase } from '~/db/dberr.ts'

function mapWriteError(err: unknown, label: string): never {
  throw mapWriteErrorBase(err, `${label}失败`, [
    { code: '23505', message: `${label}单号或记录已存在` },
    { code: '23503', message: `${label}已被业务引用,不可删除` },
  ])
}
import {
  asDate,
  asDateTime,
  asOptionalString,
  convertToBaseQty,
  guardMaterialType,
  loadMaterialSnap,
  lowerParty,
  partyExists,
  runeLen,
  toDateOnly,
  upperStatus,
  wireRequiredDecimal,
} from '../common.ts'
import { utcToday } from '~/db/dates.ts'
import {
  postFulfillment,
  postOutsourcedIssue,
  reverseFulfillment,
  reverseOutsourcedIssue,
} from '../order/projection.ts'
import {
  auditFulfillmentInTx,
  auditInventoryDocInTx,
  voidFulfillmentInTx,
  voidInventoryDocInTx,
  type PostingProjectionLine,
} from '~/platform/posting/skeleton.ts'
import {
  outsourcedIssueItemMeta,
  outsourcedIssueMeta,
  outsourcedReceiptItemByproductMeta,
  outsourcedReceiptItemMaterialMeta,
  outsourcedReceiptItemMeta,
  outsourcedReceiptMeta,
} from './meta.ts'

export {
  outsourcedIssueMeta,
  outsourcedIssueItemMeta,
  outsourcedReceiptMeta,
  outsourcedReceiptItemMeta,
  outsourcedReceiptItemMaterialMeta,
  outsourcedReceiptItemByproductMeta,
} from './meta.ts'

/** 单据编号资源键（numbering 与库存/总账凭证类型沿用同一串，非权限码） */
const ISSUE_PREFIX = 'purchase.outsourced_issue'
const RECEIPT_PREFIX = 'purchase.outsourced_receipt'
const ISSUE_TABLE = 'pur_outsourced_issue'
const ISSUE_ITEM_TABLE = 'pur_outsourced_issue_item'
const RECEIPT_TABLE = 'pur_outsourced_receipt'
const RECEIPT_ITEM_TABLE = 'pur_outsourced_receipt_item'
const MATERIAL_TABLE = 'pur_outsourced_receipt_item_material'
const BYPRODUCT_TABLE = 'pur_outsourced_receipt_item_byproduct'

/** 判定资源名（路由 guard 与服务共用一处常量，不写裸字面量） */
export const ISSUE_RESOURCE = 'purOutsourcedIssues'
export const ISSUE_ITEM_RESOURCE = 'purOutsourcedIssueItems'
export const RECEIPT_RESOURCE = 'purOutsourcedReceipts'
export const RECEIPT_ITEM_RESOURCE = 'purOutsourcedReceiptItems'
export const RECEIPT_MATERIAL_RESOURCE = 'purOutsourcedReceiptItemMaterials'
export const RECEIPT_BYPRODUCT_RESOURCE = 'purOutsourcedReceiptItemByproducts'

const ISSUE_LABEL = '委外发料单'
const ISSUE_ITEM_LABEL = '委外发料行'
const RECEIPT_LABEL = '委外入库单'
const RECEIPT_ITEM_LABEL = '委外入库成品行'
const MATERIAL_LABEL = '委外入库材料行'
const BYPRODUCT_LABEL = '委外入库副产物行'

// —— 列表与单条共用同一份投影：alias 必须与子查询别名逐字一致（写错会静默算成空集） ——

const ISSUE_ITEM_ALIAS = 'issue_items'
const ISSUE_ITEM_SOURCE = sql` FROM (
  SELECT i.id,i.idx,i.qty,i.base_qty,i.material_code,i.material_name,i.material_spec,
    i.unit_name,i.order_no,i.remarks,i.inserted_at,i.updated_at,i.issue_id,i.company_id,
    i.order_item_material_id,i.material_id,i.unit_id,i.from_warehouse_id,i.outsourced_warehouse_id,
    h.issue_no,h.issue_date,h.status AS issue_status,h.party_type,h.party_id
  FROM pur_outsourced_issue_item i
  JOIN pur_outsourced_issue h ON h.id=i.issue_id
) issue_items`

const RECEIPT_ITEM_ALIAS = 'receipt_items'
const RECEIPT_ITEM_SOURCE = sql` FROM (
  SELECT i.id,i.idx,i.qty,i.base_qty,i.material_code,i.material_name,i.material_spec,
    i.customer_part_no,i.unit_name,i.order_no,i.order_qty,i.order_base_qty,i.order_unit_name,
    i.order_price,i.order_amount,i.order_base_price,i.order_base_amount,i.order_tax_rate,
    i.order_currency_code,i.reconciled_qty,i.remarks,i.inserted_at,i.updated_at,
    i.receipt_id,i.company_id,i.order_item_id,i.material_id,i.unit_id,i.warehouse_id,
    h.receipt_no,h.receipt_date,h.status AS receipt_status,h.party_type,h.party_id,
    (i.base_qty - i.reconciled_qty) AS remaining_reconcilable_qty
  FROM pur_outsourced_receipt_item i
  JOIN pur_outsourced_receipt h ON h.id=i.receipt_id
) receipt_items`

const MATERIAL_ALIAS = 'receipt_materials'
const MATERIAL_SOURCE = sql` FROM (
  SELECT c.id,c.idx,c.qty,c.base_qty,c.material_code,c.material_name,c.material_spec,
    c.unit_name,c.order_no,c.remarks,c.inserted_at,c.updated_at,c.receipt_item_id,
    c.company_id,c.order_item_material_id,c.material_id,c.unit_id,c.outsourced_warehouse_id,
    h.receipt_no
  FROM pur_outsourced_receipt_item_material c
  JOIN pur_outsourced_receipt_item i ON i.id=c.receipt_item_id
  JOIN pur_outsourced_receipt h ON h.id=i.receipt_id
) receipt_materials`

const BYPRODUCT_ALIAS = 'receipt_byproducts'
const BYPRODUCT_SOURCE = sql` FROM (
  SELECT c.id,c.idx,c.qty,c.base_qty,c.material_code,c.material_name,c.material_spec,
    c.unit_name,c.order_no,c.remarks,c.inserted_at,c.updated_at,c.receipt_item_id,
    c.company_id,c.order_item_byproduct_id,c.material_id,c.unit_id,c.warehouse_id,
    h.receipt_no
  FROM pur_outsourced_receipt_item_byproduct c
  JOIN pur_outsourced_receipt_item i ON i.id=c.receipt_item_id
  JOIN pur_outsourced_receipt h ON h.id=i.receipt_id
) receipt_byproducts`

const SELECT_ALL = sql`SELECT *`
const CHILD_ORDER = sql`"idx" ASC, "id" ASC`
const HEAD_ORDER = sql`"inserted_at" DESC, "id" DESC`

const ISSUE_AUDIT = auditFieldsOf(outsourcedIssueMeta())

const RECEIPT_AUDIT = auditFieldsOf(outsourcedReceiptMeta())

const ISSUE_ITEM_AUDIT = auditFieldsOf(outsourcedIssueItemMeta())

const RECEIPT_ITEM_AUDIT = auditFieldsOf(outsourcedReceiptItemMeta())

// 材料/副产物子行共用引擎：来源行外键/仓库列经 rename 映射为通用审计键 source_id/warehouse_id
const CHILD_AUDIT = mergeAuditFields(
  auditFieldsOf(outsourcedReceiptItemMaterialMeta(), {
    rename: { order_item_material_id: 'source_id', outsourced_warehouse_id: 'warehouse_id' },
  }),
  auditFieldsOf(outsourcedReceiptItemByproductMeta(), {
    rename: { order_item_byproduct_id: 'source_id' },
  }),
)

type Numberer = Pick<NumberingService, 'assignedInTx'>

export function createOutsourcedService(
  db: Kysely<Database>,
  numberer: Numberer,
  engines: {
    inventory: Pick<InventoryEngine, 'post' | 'cancel'>
    gl: Pick<GlEngine, 'post' | 'cancel'>
  },
  registry: Registry,
) {
  const { inventory, gl } = engines
  const issueTarget = registry.authzTarget(ISSUE_RESOURCE)
  const issueItemTarget = registry.authzTarget(ISSUE_ITEM_RESOURCE)
  const receiptTarget = registry.authzTarget(RECEIPT_RESOURCE)
  const receiptItemTarget = registry.authzTarget(RECEIPT_ITEM_RESOURCE)
  const materialTarget = registry.authzTarget(RECEIPT_MATERIAL_RESOURCE)
  const byproductTarget = registry.authzTarget(RECEIPT_BYPRODUCT_RESOURCE)

  // ---------- 授权取行 / 锁 ----------

  /** 按 Permit 取发料单头（可锁）；不命中一律 not_found */
  async function loadIssueRow(handle: DbHandle, permit: Permit, id: string, forUpdate: boolean) {
    return loadAuthorized({
      db: handle,
      permit,
      target: issueTarget,
      table: ISSUE_TABLE,
      id,
      forUpdate,
      notFoundMessage: `${ISSUE_LABEL}不存在`,
    })
  }

  /** 锁草稿发料单头：行编辑与工作流的公共前置（授权 → 状态守卫） */
  async function lockDraftIssue(handle: DbHandle, permit: Permit, id: string) {
    const row = await loadIssueRow(handle, permit, id, true)
    if (String(row.status).toLowerCase() !== 'draft') {
      throw new ApiError('conflict', `仅草稿${ISSUE_LABEL}可编辑`)
    }
    return row
  }

  /** 按 Permit 取入库单头（可锁）；不命中一律 not_found */
  async function loadReceiptRow(handle: DbHandle, permit: Permit, id: string, forUpdate: boolean) {
    return loadAuthorized({
      db: handle,
      permit,
      target: receiptTarget,
      table: RECEIPT_TABLE,
      id,
      forUpdate,
      notFoundMessage: `${RECEIPT_LABEL}不存在`,
    })
  }

  /** 锁草稿入库单头：行编辑与工作流的公共前置（授权 → 状态守卫） */
  async function lockDraftReceipt(handle: DbHandle, permit: Permit, id: string) {
    const row = await loadReceiptRow(handle, permit, id, true)
    if (String(row.status).toLowerCase() !== 'draft') {
      throw new ApiError('conflict', `仅草稿${RECEIPT_LABEL}可编辑`)
    }
    return row
  }

  /** 子行的母单外键（未加锁探针，仅用于定位母单）；行不存在即 not_found */
  async function parentIdOf(
    handle: DbHandle,
    table: string,
    fk: string,
    id: string,
    label: string,
  ): Promise<string> {
    const cur = await sql<{ parent_id: string }>`
      SELECT ${sql.raw(fk)} AS parent_id FROM ${sql.raw(table)} WHERE id=${id}::uuid
    `.execute(handle)
    const row = cur.rows[0]
    if (!row) throw new ApiError('not_found', `${label}不存在`)
    return row.parent_id
  }

  /** 母单锁定之后再锁子行：加锁顺序母单先行 */
  async function lockChildRow(handle: DbHandle, table: string, id: string, label: string) {
    const row = await sql<{ id: string }>`
      SELECT id FROM ${sql.raw(table)} WHERE id=${id}::uuid FOR UPDATE
    `.execute(handle)
    if (!row.rows[0]) throw new ApiError('not_found', `${label}不存在`)
  }

  /** 成品行的母单：先锁入库单（授权 + 草稿门），再锁成品行本身 */
  async function lockReceiptForItem(handle: DbHandle, permit: Permit, itemId: string) {
    const receiptId = await parentIdOf(
      handle,
      RECEIPT_ITEM_TABLE,
      'receipt_id',
      itemId,
      RECEIPT_ITEM_LABEL,
    )
    const receipt = mapReceipt(await lockDraftReceipt(handle, permit, receiptId))
    await lockChildRow(handle, RECEIPT_ITEM_TABLE, itemId, RECEIPT_ITEM_LABEL)
    const item = mapReceiptItem((await loadReceiptItem(handle, itemId))!)
    return { item, receipt }
  }

  // ---------- Issue head ----------

  async function listIssues(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
      db,
      permit,
      target: issueTarget,
      alias: ISSUE_TABLE,
      resource: outsourcedIssueMeta(),
      source: sql` FROM pur_outsourced_issue`,
      select: SELECT_ALL,
      defaultOrder: HEAD_ORDER,
      query,
      mapRow: mapIssue,
    })
  }

  async function getIssue(permit: Permit, id: string) {
    return mapIssue(await loadIssueRow(db, permit, id, false))
  }

  async function createIssue(
    permit: Permit,
    input: {
      companyId: string
      issueNo?: string | null
      issueDate?: string | null
      partyType: string
      partyId: string
      remarks?: string | null
      fromWarehouseId?: string | null
      outsourcedWarehouseId?: string | null
    },
  ) {
    // 入参校验（400）先于公司边界（404）：companyId 为空须报「必填」而不是「公司不存在」
    validateHeadParty(input.companyId, input.partyType, input.partyId, input.remarks ?? null)
    assertCompanyWritable(permit, input.companyId, '公司不存在')
    return withTx(db, async (trx) => {
      const issueDate = input.issueDate ? toDateOnly(input.issueDate) : utcToday()
      const issueNo = await numberer.assignedInTx(trx, {
        resource: ISSUE_PREFIX,
        field: 'issueNo',
        provided: input.issueNo,
        values: { company_id: input.companyId, issue_date: issueDate },
      })
      const partyType = lowerParty(input.partyType)
      const draft = {
        issueNo,
        issueDate,
        partyType,
        partyId: input.partyId,
        remarks: input.remarks ?? null,
        companyId: input.companyId,
        fromWarehouseId: input.fromWarehouseId ?? null,
        outsourcedWarehouseId: input.outsourcedWarehouseId ?? null,
      }
      await validateIssueHead(trx, draft)
      try {
        const ins = await sql<{ id: string }>`
          INSERT INTO pur_outsourced_issue (
            issue_no, issue_date, party_type, party_id, remarks, status, company_id,
            from_warehouse_id, outsourced_warehouse_id, created_by_id
          ) VALUES (
            ${issueNo}, ${issueDate}::date, ${partyType}, ${input.partyId}::uuid,
            ${draft.remarks}, 'draft', ${input.companyId}::uuid,
            ${draft.fromWarehouseId}::uuid, ${draft.outsourcedWarehouseId}::uuid,
            ${permit.actor.userId || null}::uuid
          ) RETURNING id
        `.execute(trx)
        const id = ins.rows[0]!.id
        const row = await loadIssue(trx, id)
        const dto = mapIssue(row!)
        await writeAudit(trx, permit.actor, {
          resource: ISSUE_TABLE,
          recordId: id,
          recordLabel: issueNo,
          companyId: input.companyId,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(issueSnap(dto), ISSUE_AUDIT),
        })
        return dto
      } catch (err) {
        throw mapWriteError(err, '创建委外发料单')
      }
    })
  }

  async function updateIssue(
    permit: Permit,
    id: string,
    input: {
      issueNo?: string
      issueDate?: string
      partyType?: string
      partyId?: string
      remarks?: string | null
      remarksPresent?: boolean
      fromWarehouseId?: string | null
      fromWarehouseIdPresent?: boolean
      outsourcedWarehouseId?: string | null
      outsourcedWarehouseIdPresent?: boolean
    },
  ) {
    return withTx(db, async (trx) => {
      const beforeRow = await lockDraftIssue(trx, permit, id)
      const before = mapIssue(beforeRow)
      if (input.issueNo !== undefined && input.issueNo.trim() !== before.issueNo) {
        throw ApiError.validation('委外发料单参数不合法', { issueNo: ['编号创建后不可修改'] })
      }
      const after = {
        issueNo: before.issueNo,
        issueDate: input.issueDate ? toDateOnly(input.issueDate) : before.issueDate,
        partyType: input.partyType !== undefined ? lowerParty(input.partyType) : lowerParty(before.partyType),
        partyId: input.partyId ?? before.partyId,
        remarks: input.remarksPresent ? (input.remarks ?? null) : before.remarks,
        companyId: before.companyId,
        fromWarehouseId: input.fromWarehouseIdPresent
          ? (input.fromWarehouseId ?? null)
          : before.fromWarehouseId,
        outsourcedWarehouseId: input.outsourcedWarehouseIdPresent
          ? (input.outsourcedWarehouseId ?? null)
          : before.outsourcedWarehouseId,
      }
      if (
        after.partyType !== lowerParty(before.partyType) ||
        after.partyId !== before.partyId
      ) {
        const exists = await sql<{ e: boolean }>`
          SELECT EXISTS(SELECT 1 FROM pur_outsourced_issue_item WHERE issue_id=${id}::uuid) AS e
        `.execute(trx)
        if (exists.rows[0]?.e) {
          throw new ApiError('conflict', '已有发料行时不可修改公司或对手')
        }
      }
      await validateIssueHead(trx, after)
      try {
        await sql`
          UPDATE pur_outsourced_issue SET
            issue_no=${after.issueNo}, issue_date=${after.issueDate}::date,
            party_type=${after.partyType}, party_id=${after.partyId}::uuid,
            remarks=${after.remarks},
            from_warehouse_id=${after.fromWarehouseId}::uuid,
            outsourced_warehouse_id=${after.outsourcedWarehouseId}::uuid,
            updated_at=(now() AT TIME ZONE 'utc')
          WHERE id=${id}::uuid
        `.execute(trx)
      } catch (err) {
        throw mapWriteError(err, '更新委外发料单')
      }
      const row = await loadIssue(trx, id)
      const dto = mapIssue(row!)
      const changes = auditDiff(issueSnap(before), issueSnap(dto), ISSUE_AUDIT)
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, permit.actor, {
          resource: ISSUE_TABLE,
          recordId: id,
          recordLabel: dto.issueNo,
          companyId: dto.companyId,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
      }
      return dto
    })
  }

  async function deleteIssue(permit: Permit, id: string) {
    await withTx(db, async (trx) => {
      const row = await lockDraftIssue(trx, permit, id)
      const dto = mapIssue(row)
      await writeAudit(trx, permit.actor, {
        resource: ISSUE_TABLE,
        recordId: id,
        recordLabel: dto.issueNo,
        companyId: dto.companyId,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(issueSnap(dto), ISSUE_AUDIT),
      })
      try {
        await sql`DELETE FROM pur_outsourced_issue WHERE id=${id}::uuid`.execute(trx)
      } catch (err) {
        throw mapWriteError(err, '删除委外发料单')
      }
    })
  }

  async function auditIssue(permit: Permit, id: string) {
    return withTx(db, async (trx) => {
      // collect 的闭包产物：发料投影行（键为 orderItemMaterialId，非履约 PostingProjectionLine）
      let projection: Array<{ orderItemMaterialId: string; baseQty: string }> = []
      return auditInventoryDocInTx(trx, permit.actor, inventory, {
        voucherType: ISSUE_PREFIX,
        headTable: ISSUE_TABLE,
        lockDraft: async (t) => mapIssue(await lockDraftIssue(t, permit, id)),
        collect: async (t, before) => {
          const items = await loadIssueActionItems(t, id)
          if (items.length === 0) {
            throw new ApiError('conflict', '委外发料单至少需要一条发料行')
          }
          const stockLines: StockLine[] = []
          projection = []
          for (const item of items) {
            await deriveIssueItem(t, before, {
              orderItemMaterialId: item.orderItemMaterialId,
              qty: decimal(item.qty),
              fromWarehouseId: item.fromWarehouseId,
              outsourcedWarehouseId: item.outsourcedWarehouseId,
              remarks: item.remarks,
            })
            projection.push({
              orderItemMaterialId: item.orderItemMaterialId,
              baseQty: item.baseQty,
            })
            stockLines.push(
              {
                warehouseId: item.fromWarehouseId,
                materialId: item.materialId,
                quantity: wireRequiredDecimal(item.baseQty),
                direction: 'out' as const,
                remarks: item.remarks,
              },
              {
                warehouseId: item.outsourcedWarehouseId,
                materialId: item.materialId,
                quantity: wireRequiredDecimal(item.baseQty),
                direction: 'in' as const,
                remarks: item.remarks,
              },
            )
          }
          return { stockLines, postingDate: before.issueDate }
        },
        postProjection: async (t, before) => {
          await postOutsourcedIssue(t, {
            companyId: before.companyId,
            partyType: before.partyType,
            partyId: before.partyId,
            lines: projection,
          })
        },
        voucherOf: (h) => ({ id: h.id, no: h.issueNo, companyId: h.companyId }),
        reload: async (t, headId) => mapIssue((await loadIssue(t, headId))!),
        snapshot: issueSnap,
        auditFields: ISSUE_AUDIT,
      })
    })
  }

  async function voidIssue(permit: Permit, id: string) {
    return withTx(db, async (trx) => {
      return voidInventoryDocInTx(trx, permit.actor, inventory, {
        voucherType: ISSUE_PREFIX,
        headTable: ISSUE_TABLE,
        lockAudited: async (t) => {
          const before = mapIssue(await loadIssueRow(t, permit, id, true))
          if (before.status !== 'AUDITED') {
            throw new ApiError('conflict', '仅已审核委外发料单可作废')
          }
          return before
        },
        reverseProjection: async (t, before) => {
          const items = await loadIssueActionItems(t, id)
          await reverseOutsourcedIssue(t, {
            companyId: before.companyId,
            partyType: before.partyType,
            partyId: before.partyId,
            lines: items.map((i) => ({
              orderItemMaterialId: i.orderItemMaterialId,
              baseQty: i.baseQty,
            })),
          })
        },
        voucherOf: (h) => ({ id: h.id, no: h.issueNo, companyId: h.companyId }),
        reload: async (t, headId) => mapIssue((await loadIssue(t, headId))!),
        snapshot: issueSnap,
        auditFields: ISSUE_AUDIT,
      })
    })
  }

  // ---------- Issue items ----------

  async function listIssueItems(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
      db,
      permit,
      target: issueItemTarget,
      alias: ISSUE_ITEM_ALIAS,
      resource: outsourcedIssueItemMeta(),
      source: ISSUE_ITEM_SOURCE,
      select: SELECT_ALL,
      defaultOrder: CHILD_ORDER,
      query,
      mapRow: mapIssueItem,
    })
  }

  /** 行的可达性经 via 链递归到母单自身的行谓词 */
  async function getIssueItem(permit: Permit, id: string) {
    return loadAuthorizedFrom({
      db,
      permit,
      target: issueItemTarget,
      alias: ISSUE_ITEM_ALIAS,
      source: ISSUE_ITEM_SOURCE,
      select: SELECT_ALL,
      id,
      mapRow: mapIssueItem,
      notFoundMessage: `${ISSUE_ITEM_LABEL}不存在`,
    })
  }

  async function createIssueItem(
    permit: Permit,
    input: {
      issueId: string
      idx: number
      qty: string
      orderItemMaterialId: string
      fromWarehouseId?: string | null
      outsourcedWarehouseId?: string | null
      remarks?: string | null
    },
  ) {
    return withTx(db, async (trx) => {
      const parent = mapIssue(await lockDraftIssue(trx, permit, input.issueId))
      const fromWarehouseId = input.fromWarehouseId ?? parent.fromWarehouseId
      const outsourcedWarehouseId = input.outsourcedWarehouseId ?? parent.outsourcedWarehouseId
      const derived = await deriveIssueItem(trx, parent, {
        orderItemMaterialId: input.orderItemMaterialId,
        qty: decimal(input.qty),
        fromWarehouseId,
        outsourcedWarehouseId,
        remarks: input.remarks ?? null,
      })
      try {
        const ins = await sql<{ id: string }>`
          INSERT INTO pur_outsourced_issue_item (
            idx,qty,base_qty,material_code,material_name,material_spec,unit_name,order_no,
            remarks,issue_id,company_id,order_item_material_id,material_id,unit_id,
            from_warehouse_id,outsourced_warehouse_id
          ) VALUES (
            ${input.idx},${wireRequiredDecimal(derived.qty)},${wireRequiredDecimal(derived.baseQty)},
            ${derived.materialCode},${derived.materialName},${derived.materialSpec},${derived.unitName},
            ${derived.orderNo},${derived.remarks},${input.issueId}::uuid,${parent.companyId}::uuid,
            ${input.orderItemMaterialId}::uuid,${derived.materialId}::uuid,${derived.unitId}::uuid,
            ${derived.fromWarehouseId}::uuid,${derived.outsourcedWarehouseId}::uuid
          ) RETURNING id
        `.execute(trx)
        const id = ins.rows[0]!.id
        const row = await loadIssueItem(trx, id)
        const dto = mapIssueItem(row!)
        await writeAudit(trx, permit.actor, {
          resource: ISSUE_ITEM_TABLE,
          recordId: id,
          recordLabel: String(dto.idx),
          companyId: dto.companyId,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(issueItemSnap(dto), ISSUE_ITEM_AUDIT),
        })
        return dto
      } catch (err) {
        throw mapWriteError(err, '创建委外发料行')
      }
    })
  }

  async function updateIssueItem(
    permit: Permit,
    id: string,
    input: {
      idx?: number
      qty?: string
      orderItemMaterialId?: string
      fromWarehouseId?: string
      outsourcedWarehouseId?: string
      remarks?: string | null
      remarksPresent?: boolean
    },
  ) {
    return withTx(db, async (trx) => {
      // 母单先锁（授权 + 草稿门），再锁行：与并发路径的加锁顺序一致
      const issueId = await parentIdOf(trx, ISSUE_ITEM_TABLE, 'issue_id', id, ISSUE_ITEM_LABEL)
      const parent = mapIssue(await lockDraftIssue(trx, permit, issueId))
      await lockChildRow(trx, ISSUE_ITEM_TABLE, id, ISSUE_ITEM_LABEL)
      const before = mapIssueItem((await loadIssueItem(trx, id))!)
      const derived = await deriveIssueItem(trx, parent, {
        orderItemMaterialId: input.orderItemMaterialId ?? before.orderItemMaterialId,
        qty: decimal(input.qty ?? before.qty),
        fromWarehouseId: input.fromWarehouseId ?? before.fromWarehouseId,
        outsourcedWarehouseId: input.outsourcedWarehouseId ?? before.outsourcedWarehouseId,
        remarks: input.remarksPresent ? (input.remarks ?? null) : before.remarks,
      })
      const idx = input.idx ?? before.idx
      try {
        await sql`
          UPDATE pur_outsourced_issue_item SET
            idx=${idx}, qty=${wireRequiredDecimal(derived.qty)},
            base_qty=${wireRequiredDecimal(derived.baseQty)},
            material_code=${derived.materialCode}, material_name=${derived.materialName},
            material_spec=${derived.materialSpec}, unit_name=${derived.unitName},
            order_no=${derived.orderNo}, remarks=${derived.remarks},
            order_item_material_id=${derived.orderItemMaterialId}::uuid,
            material_id=${derived.materialId}::uuid, unit_id=${derived.unitId}::uuid,
            from_warehouse_id=${derived.fromWarehouseId}::uuid,
            outsourced_warehouse_id=${derived.outsourcedWarehouseId}::uuid,
            updated_at=(now() AT TIME ZONE 'utc')
          WHERE id=${id}::uuid
        `.execute(trx)
      } catch (err) {
        throw mapWriteError(err, '更新委外发料行')
      }
      const row = await loadIssueItem(trx, id)
      const dto = mapIssueItem(row!)
      const changes = auditDiff(issueItemSnap(before), issueItemSnap(dto), ISSUE_ITEM_AUDIT)
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, permit.actor, {
          resource: ISSUE_ITEM_TABLE,
          recordId: id,
          recordLabel: String(dto.idx),
          companyId: dto.companyId,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
      }
      return dto
    })
  }

  async function deleteIssueItem(permit: Permit, id: string) {
    await withTx(db, async (trx) => {
      const issueId = await parentIdOf(trx, ISSUE_ITEM_TABLE, 'issue_id', id, ISSUE_ITEM_LABEL)
      await lockDraftIssue(trx, permit, issueId)
      await lockChildRow(trx, ISSUE_ITEM_TABLE, id, ISSUE_ITEM_LABEL)
      const before = mapIssueItem((await loadIssueItem(trx, id))!)
      await writeAudit(trx, permit.actor, {
        resource: ISSUE_ITEM_TABLE,
        recordId: id,
        recordLabel: String(before.idx),
        companyId: before.companyId,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(issueItemSnap(before), ISSUE_ITEM_AUDIT),
      })
      try {
        await sql`DELETE FROM pur_outsourced_issue_item WHERE id=${id}::uuid`.execute(trx)
      } catch (err) {
        throw mapWriteError(err, '删除委外发料行')
      }
    })
  }

  // ---------- Receipt head ----------

  async function listReceipts(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
      db,
      permit,
      target: receiptTarget,
      alias: RECEIPT_TABLE,
      resource: outsourcedReceiptMeta(),
      source: sql` FROM pur_outsourced_receipt`,
      select: SELECT_ALL,
      defaultOrder: HEAD_ORDER,
      query,
      mapRow: mapReceipt,
    })
  }

  async function getReceipt(permit: Permit, id: string) {
    return mapReceipt(await loadReceiptRow(db, permit, id, false))
  }

  async function createReceipt(
    permit: Permit,
    input: {
      companyId: string
      receiptNo?: string | null
      receiptDate?: string | null
      postingDate?: string | null
      partyType: string
      partyId: string
      remarks?: string | null
      warehouseId?: string | null
      outsourcedWarehouseId?: string | null
      debitAccountId?: string | null
      creditAccountId?: string | null
    },
  ) {
    // 入参校验（400）先于公司边界（404）：companyId 为空须报「必填」而不是「公司不存在」
    validateHeadParty(input.companyId, input.partyType, input.partyId, input.remarks ?? null)
    assertCompanyWritable(permit, input.companyId, '公司不存在')
    return withTx(db, async (trx) => {
      const receiptDate = input.receiptDate ? toDateOnly(input.receiptDate) : utcToday()
      const receiptNo = await numberer.assignedInTx(trx, {
        resource: RECEIPT_PREFIX,
        field: 'receiptNo',
        provided: input.receiptNo,
        values: { company_id: input.companyId, receipt_date: receiptDate },
      })
      const { debit, credit } = await resolveReceiptAccounts(
        trx,
        input.companyId,
        input.debitAccountId ?? null,
        input.creditAccountId ?? null,
      )
      const partyType = lowerParty(input.partyType)
      const draft = {
        receiptNo,
        receiptDate,
        postingDate: input.postingDate ? toDateOnly(input.postingDate) : null,
        partyType,
        partyId: input.partyId,
        remarks: input.remarks ?? null,
        companyId: input.companyId,
        warehouseId: input.warehouseId ?? null,
        outsourcedWarehouseId: input.outsourcedWarehouseId ?? null,
        debitAccountId: debit,
        creditAccountId: credit,
      }
      await validateReceiptHead(trx, draft)
      try {
        const ins = await sql<{ id: string }>`
          INSERT INTO pur_outsourced_receipt (
            receipt_no, receipt_date, posting_date, party_type, party_id, remarks, status,
            company_id, warehouse_id, outsourced_warehouse_id, debit_account_id,
            credit_account_id, created_by_id
          ) VALUES (
            ${receiptNo}, ${receiptDate}::date, ${draft.postingDate}::date, ${partyType},
            ${input.partyId}::uuid, ${draft.remarks}, 'draft', ${input.companyId}::uuid,
            ${draft.warehouseId}::uuid, ${draft.outsourcedWarehouseId}::uuid,
            ${debit}::uuid, ${credit}::uuid, ${permit.actor.userId || null}::uuid
          ) RETURNING id
        `.execute(trx)
        const id = ins.rows[0]!.id
        const row = await loadReceipt(trx, id)
        const dto = mapReceipt(row!)
        await writeAudit(trx, permit.actor, {
          resource: RECEIPT_TABLE,
          recordId: id,
          recordLabel: receiptNo,
          companyId: input.companyId,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(receiptSnap(dto), RECEIPT_AUDIT),
        })
        return dto
      } catch (err) {
        throw mapWriteError(err, '创建委外入库单')
      }
    })
  }

  async function updateReceipt(
    permit: Permit,
    id: string,
    input: {
      receiptNo?: string
      receiptDate?: string
      postingDate?: string | null
      postingDatePresent?: boolean
      partyType?: string
      partyId?: string
      remarks?: string | null
      remarksPresent?: boolean
      warehouseId?: string | null
      warehouseIdPresent?: boolean
      outsourcedWarehouseId?: string | null
      outsourcedWarehouseIdPresent?: boolean
      debitAccountId?: string
      creditAccountId?: string
    },
  ) {
    return withTx(db, async (trx) => {
      const beforeRow = await lockDraftReceipt(trx, permit, id)
      const before = mapReceipt(beforeRow)
      if (input.receiptNo !== undefined && input.receiptNo.trim() !== before.receiptNo) {
        throw ApiError.validation('委外入库单参数不合法', { receiptNo: ['编号创建后不可修改'] })
      }
      const after = {
        receiptNo: before.receiptNo,
        receiptDate: input.receiptDate ? toDateOnly(input.receiptDate) : before.receiptDate,
        postingDate: input.postingDatePresent
          ? input.postingDate
            ? toDateOnly(input.postingDate)
            : null
          : before.postingDate,
        partyType:
          input.partyType !== undefined ? lowerParty(input.partyType) : lowerParty(before.partyType),
        partyId: input.partyId ?? before.partyId,
        remarks: input.remarksPresent ? (input.remarks ?? null) : before.remarks,
        companyId: before.companyId,
        warehouseId: input.warehouseIdPresent
          ? (input.warehouseId ?? null)
          : before.warehouseId,
        outsourcedWarehouseId: input.outsourcedWarehouseIdPresent
          ? (input.outsourcedWarehouseId ?? null)
          : before.outsourcedWarehouseId,
        debitAccountId: input.debitAccountId ?? before.debitAccountId,
        creditAccountId: input.creditAccountId ?? before.creditAccountId,
      }
      if (
        after.partyType !== lowerParty(before.partyType) ||
        after.partyId !== before.partyId
      ) {
        const exists = await sql<{ e: boolean }>`
          SELECT EXISTS(SELECT 1 FROM pur_outsourced_receipt_item WHERE receipt_id=${id}::uuid) AS e
        `.execute(trx)
        if (exists.rows[0]?.e) {
          throw new ApiError('conflict', '已有成品行时不可修改公司或对手')
        }
      }
      await validateReceiptHead(trx, after)
      try {
        await sql`
          UPDATE pur_outsourced_receipt SET
            receipt_no=${after.receiptNo}, receipt_date=${after.receiptDate}::date,
            posting_date=${after.postingDate}::date, party_type=${after.partyType},
            party_id=${after.partyId}::uuid, remarks=${after.remarks},
            warehouse_id=${after.warehouseId}::uuid,
            outsourced_warehouse_id=${after.outsourcedWarehouseId}::uuid,
            debit_account_id=${after.debitAccountId}::uuid,
            credit_account_id=${after.creditAccountId}::uuid,
            updated_at=(now() AT TIME ZONE 'utc')
          WHERE id=${id}::uuid
        `.execute(trx)
      } catch (err) {
        throw mapWriteError(err, '更新委外入库单')
      }
      const row = await loadReceipt(trx, id)
      const dto = mapReceipt(row!)
      const changes = auditDiff(receiptSnap(before), receiptSnap(dto), RECEIPT_AUDIT)
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, permit.actor, {
          resource: RECEIPT_TABLE,
          recordId: id,
          recordLabel: dto.receiptNo,
          companyId: dto.companyId,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
      }
      return dto
    })
  }

  async function deleteReceipt(permit: Permit, id: string) {
    await withTx(db, async (trx) => {
      const row = await lockDraftReceipt(trx, permit, id)
      const dto = mapReceipt(row)
      await writeAudit(trx, permit.actor, {
        resource: RECEIPT_TABLE,
        recordId: id,
        recordLabel: dto.receiptNo,
        companyId: dto.companyId,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(receiptSnap(dto), RECEIPT_AUDIT),
      })
      try {
        await sql`DELETE FROM pur_outsourced_receipt WHERE id=${id}::uuid`.execute(trx)
      } catch (err) {
        throw mapWriteError(err, '删除委外入库单')
      }
    })
  }

  async function auditReceipt(
    permit: Permit,
    id: string,
    input: { postingDate?: string | null } = {},
  ) {
    return withTx(db, async (trx) => {
      return auditFulfillmentInTx(trx, permit.actor, { inventory, gl }, {
        voucherType: RECEIPT_PREFIX,
        headTable: RECEIPT_TABLE,
        partySide: 'credit',
        postingDateOverride: input.postingDate,
        lockDraft: async (t) => mapReceipt(await lockDraftReceipt(t, permit, id)),
        collect: async (t, before) => {
          const { items, materials, byproducts } = await loadReceiptActionLines(t, id)
          if (items.length === 0) {
            throw new ApiError('conflict', '委外入库单至少需要一条成品行')
          }
          const stockLines: StockLine[] = []
          const projectionLines: PostingProjectionLine[] = []
          let amount = decimal(0)
          for (const item of items) {
            await deriveReceiptItem(
              t,
              before,
              {
                qty: decimal(item.qty),
                orderItemId: item.orderItemId,
                unitId: item.unitId,
                warehouseId: item.warehouseId,
                remarks: item.remarks,
              },
              item.id,
            )
            projectionLines.push({ orderItemId: item.orderItemId, baseQty: item.baseQty })
            stockLines.push({
              warehouseId: item.warehouseId,
              materialId: item.materialId,
              quantity: wireRequiredDecimal(item.baseQty),
              direction: 'in',
              remarks: item.remarks,
            })
            if (decimal(item.orderBaseQty).gt(0)) {
              amount = amount.add(
                decimal(item.orderBaseAmount).mul(decimal(item.baseQty)).div(decimal(item.orderBaseQty)),
              )
            }
          }
          for (const m of materials) {
            if (!m.outsourcedWarehouseId) {
              throw new ApiError('conflict', '材料扣减行必须填写外协仓')
            }
            await validateOutsourcedWarehouse(
              t,
              before.companyId,
              before.partyType,
              before.partyId,
              m.outsourcedWarehouseId,
            )
            stockLines.push({
              warehouseId: m.outsourcedWarehouseId,
              materialId: m.materialId,
              quantity: wireRequiredDecimal(m.baseQty),
              direction: 'out',
              remarks: m.remarks,
            })
          }
          for (const b of byproducts) {
            if (!b.warehouseId) {
              throw new ApiError('conflict', '副产物行必须填写入仓')
            }
            await validateWarehouse(t, before.companyId, b.warehouseId)
            stockLines.push({
              warehouseId: b.warehouseId,
              materialId: b.materialId,
              quantity: wireRequiredDecimal(b.baseQty),
              direction: 'in',
              remarks: b.remarks,
            })
          }
          return { projectionLines, stockLines, amount }
        },
        postProjection: (t, before, lines) =>
          postFulfillment(t, 'purchase', {
            companyId: before.companyId,
            partyType: before.partyType,
            partyId: before.partyId,
            requireOutsourced: true,
            lines,
          }),
        voucherOf: (h) => ({
          id: h.id,
          no: h.receiptNo,
          companyId: h.companyId,
          documentDate: h.receiptDate,
          postingDate: h.postingDate,
          partyType: h.partyType,
          partyId: h.partyId,
          debitAccountId: h.debitAccountId,
          creditAccountId: h.creditAccountId,
        }),
        reload: async (t, receiptId) => mapReceipt((await loadReceipt(t, receiptId))!),
        snapshot: receiptSnap,
        auditFields: RECEIPT_AUDIT,
      })
    })
  }

  async function voidReceipt(permit: Permit, id: string) {
    return withTx(db, async (trx) => {
      return voidFulfillmentInTx(trx, permit.actor, { inventory, gl }, {
        voucherType: RECEIPT_PREFIX,
        headTable: RECEIPT_TABLE,
        lockAudited: async (t) => {
          const before = mapReceipt(await loadReceiptRow(t, permit, id, true))
          if (before.status !== 'AUDITED') {
            throw new ApiError('conflict', '仅已审核委外入库单可作废')
          }
          return before
        },
        voidableLines: async (t) => {
          const { items } = await loadReceiptActionLines(t, id)
          for (const item of items) {
            if (decimal(item.reconciledQty).gt(0)) {
              throw new ApiError('conflict', '存在已对账成品行,不可作废')
            }
          }
          return items.map((i) => ({ orderItemId: i.orderItemId, baseQty: i.baseQty }))
        },
        reverseProjection: (t, before, lines) =>
          reverseFulfillment(t, 'purchase', {
            companyId: before.companyId,
            partyType: before.partyType,
            partyId: before.partyId,
            requireOutsourced: true,
            lines,
          }),
        voucherOf: (h) => ({
          id: h.id,
          no: h.receiptNo,
          companyId: h.companyId,
          documentDate: h.receiptDate,
          postingDate: h.postingDate,
          partyType: h.partyType,
          partyId: h.partyId,
          debitAccountId: h.debitAccountId,
          creditAccountId: h.creditAccountId,
        }),
        reload: async (t, receiptId) => mapReceipt((await loadReceipt(t, receiptId))!),
        snapshot: receiptSnap,
        auditFields: RECEIPT_AUDIT,
      })
    })
  }

  // ---------- Receipt items ----------

  async function listReceiptItems(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
      db,
      permit,
      target: receiptItemTarget,
      alias: RECEIPT_ITEM_ALIAS,
      resource: outsourcedReceiptItemMeta(),
      source: RECEIPT_ITEM_SOURCE,
      select: SELECT_ALL,
      defaultOrder: CHILD_ORDER,
      query,
      mapRow: mapReceiptItem,
    })
  }

  /** 行的可达性经 via 链递归到母单自身的行谓词 */
  async function getReceiptItem(permit: Permit, id: string) {
    return loadAuthorizedFrom({
      db,
      permit,
      target: receiptItemTarget,
      alias: RECEIPT_ITEM_ALIAS,
      source: RECEIPT_ITEM_SOURCE,
      select: SELECT_ALL,
      id,
      mapRow: mapReceiptItem,
      notFoundMessage: `${RECEIPT_ITEM_LABEL}不存在`,
    })
  }

  async function createReceiptItem(
    permit: Permit,
    input: {
      receiptId: string
      idx: number
      qty: string
      orderItemId: string
      unitId?: string | null
      warehouseId?: string | null
      remarks?: string | null
    },
  ) {
    return withTx(db, async (trx) => {
      const parent = mapReceipt(await lockDraftReceipt(trx, permit, input.receiptId))
      return createReceiptItemInTx(trx, permit, parent, input, true)
    })
  }

  async function createReceiptItemInTx(
    trx: DbHandle,
    permit: Permit,
    parent: ReturnType<typeof mapReceipt>,
    input: {
      receiptId: string
      idx: number
      qty: string
      orderItemId: string
      unitId?: string | null
      warehouseId?: string | null
      remarks?: string | null
    },
    carry: boolean,
  ) {
    const warehouseId = input.warehouseId ?? parent.warehouseId
    const derived = await deriveReceiptItem(
      trx,
      parent,
      {
        qty: decimal(input.qty),
        orderItemId: input.orderItemId,
        unitId: input.unitId ?? null,
        warehouseId,
        remarks: input.remarks ?? null,
      },
      null,
    )
    try {
      const ins = await sql<{ id: string }>`
        INSERT INTO pur_outsourced_receipt_item (
          idx,qty,base_qty,material_code,material_name,material_spec,customer_part_no,unit_name,
          order_no,order_qty,order_base_qty,order_unit_name,order_price,order_amount,
          order_base_price,order_base_amount,order_tax_rate,order_currency_code,reconciled_qty,
          remarks,receipt_id,company_id,order_item_id,material_id,unit_id,warehouse_id
        ) VALUES (
          ${input.idx},${wireRequiredDecimal(derived.qty)},${wireRequiredDecimal(derived.baseQty)},
          ${derived.materialCode},${derived.materialName},${derived.materialSpec},${derived.customerPartNo},
          ${derived.unitName},${derived.orderNo},${wireRequiredDecimal(derived.orderQty)},
          ${wireRequiredDecimal(derived.orderBaseQty)},${derived.orderUnitName},
          ${wireRequiredDecimal(derived.orderPrice)},${wireRequiredDecimal(derived.orderAmount)},
          ${wireRequiredDecimal(derived.orderBasePrice)},${wireRequiredDecimal(derived.orderBaseAmount)},
          ${wireRequiredDecimal(derived.orderTaxRate)},${derived.orderCurrencyCode},0,
          ${derived.remarks},${input.receiptId}::uuid,${parent.companyId}::uuid,
          ${input.orderItemId}::uuid,${derived.materialId}::uuid,${derived.unitId}::uuid,
          ${derived.warehouseId}::uuid
        ) RETURNING id
      `.execute(trx)
      const id = ins.rows[0]!.id
      const row = await loadReceiptItem(trx, id)
      const dto = mapReceiptItem(row!)
      await writeAudit(trx, permit.actor, {
        resource: RECEIPT_ITEM_TABLE,
        recordId: id,
        recordLabel: String(dto.idx),
        companyId: dto.companyId,
        actionType: 'create',
        actionName: 'create',
        changes: auditCreated(receiptItemSnap(dto), RECEIPT_ITEM_AUDIT),
      })
      if (carry && decimal(dto.orderBaseQty).gt(0)) {
        await carryReceiptChildren(trx, permit, parent, dto)
      }
      return dto
    } catch (err) {
      throw mapWriteError(err, '创建委外入库成品行')
    }
  }

  async function updateReceiptItem(
    permit: Permit,
    id: string,
    input: {
      idx?: number
      qty?: string
      orderItemId?: string
      unitId?: string | null
      unitIdPresent?: boolean
      warehouseId?: string
      remarks?: string | null
      remarksPresent?: boolean
    },
  ) {
    return withTx(db, async (trx) => {
      // 母单先锁（授权 + 草稿门），再锁行：与并发路径的加锁顺序一致
      const receiptId = await parentIdOf(
        trx,
        RECEIPT_ITEM_TABLE,
        'receipt_id',
        id,
        RECEIPT_ITEM_LABEL,
      )
      const parent = mapReceipt(await lockDraftReceipt(trx, permit, receiptId))
      await lockChildRow(trx, RECEIPT_ITEM_TABLE, id, RECEIPT_ITEM_LABEL)
      const before = mapReceiptItem((await loadReceiptItem(trx, id))!)
      const orderItemId = input.orderItemId ?? before.orderItemId
      if (orderItemId !== before.orderItemId) {
        const children = await sql<{ e: boolean }>`
          SELECT EXISTS(
            SELECT 1 FROM pur_outsourced_receipt_item_material WHERE receipt_item_id=${id}::uuid
            UNION ALL
            SELECT 1 FROM pur_outsourced_receipt_item_byproduct WHERE receipt_item_id=${id}::uuid
          ) AS e
        `.execute(trx)
        if (children.rows[0]?.e) {
          throw new ApiError('conflict', '已有材料或副产物行时不可更换来源订单行')
        }
      }
      const unitId = input.unitIdPresent ? (input.unitId ?? null) : before.unitId
      const derived = await deriveReceiptItem(
        trx,
        parent,
        {
          qty: decimal(input.qty ?? before.qty),
          orderItemId,
          unitId,
          warehouseId: input.warehouseId ?? before.warehouseId,
          remarks: input.remarksPresent ? (input.remarks ?? null) : before.remarks,
        },
        id,
      )
      const idx = input.idx ?? before.idx
      try {
        await sql`
          UPDATE pur_outsourced_receipt_item SET
            idx=${idx}, qty=${wireRequiredDecimal(derived.qty)},
            base_qty=${wireRequiredDecimal(derived.baseQty)},
            material_code=${derived.materialCode}, material_name=${derived.materialName},
            material_spec=${derived.materialSpec}, customer_part_no=${derived.customerPartNo},
            unit_name=${derived.unitName}, order_no=${derived.orderNo},
            order_qty=${wireRequiredDecimal(derived.orderQty)},
            order_base_qty=${wireRequiredDecimal(derived.orderBaseQty)},
            order_unit_name=${derived.orderUnitName},
            order_price=${wireRequiredDecimal(derived.orderPrice)},
            order_amount=${wireRequiredDecimal(derived.orderAmount)},
            order_base_price=${wireRequiredDecimal(derived.orderBasePrice)},
            order_base_amount=${wireRequiredDecimal(derived.orderBaseAmount)},
            order_tax_rate=${wireRequiredDecimal(derived.orderTaxRate)},
            order_currency_code=${derived.orderCurrencyCode},
            remarks=${derived.remarks}, order_item_id=${orderItemId}::uuid,
            material_id=${derived.materialId}::uuid, unit_id=${derived.unitId}::uuid,
            warehouse_id=${derived.warehouseId}::uuid,
            updated_at=(now() AT TIME ZONE 'utc')
          WHERE id=${id}::uuid
        `.execute(trx)
      } catch (err) {
        throw mapWriteError(err, '更新委外入库成品行')
      }
      const row = await loadReceiptItem(trx, id)
      const dto = mapReceiptItem(row!)
      const changes = auditDiff(receiptItemSnap(before), receiptItemSnap(dto), RECEIPT_ITEM_AUDIT)
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, permit.actor, {
          resource: RECEIPT_ITEM_TABLE,
          recordId: id,
          recordLabel: String(dto.idx),
          companyId: dto.companyId,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
      }
      return dto
    })
  }

  async function deleteReceiptItem(permit: Permit, id: string) {
    await withTx(db, async (trx) => {
      const receiptId = await parentIdOf(
        trx,
        RECEIPT_ITEM_TABLE,
        'receipt_id',
        id,
        RECEIPT_ITEM_LABEL,
      )
      await lockDraftReceipt(trx, permit, receiptId)
      await lockChildRow(trx, RECEIPT_ITEM_TABLE, id, RECEIPT_ITEM_LABEL)
      const before = mapReceiptItem((await loadReceiptItem(trx, id))!)
      await writeAudit(trx, permit.actor, {
        resource: RECEIPT_ITEM_TABLE,
        recordId: id,
        recordLabel: String(before.idx),
        companyId: before.companyId,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(receiptItemSnap(before), RECEIPT_ITEM_AUDIT),
      })
      try {
        await sql`DELETE FROM pur_outsourced_receipt_item WHERE id=${id}::uuid`.execute(trx)
      } catch (err) {
        throw mapWriteError(err, '删除委外入库成品行')
      }
    })
  }

  // ---------- Receipt materials / byproducts ----------

  async function listReceiptMaterials(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
      db,
      permit,
      target: materialTarget,
      alias: MATERIAL_ALIAS,
      resource: outsourcedReceiptItemMaterialMeta(),
      source: MATERIAL_SOURCE,
      select: SELECT_ALL,
      defaultOrder: CHILD_ORDER,
      query,
      mapRow: mapReceiptMaterial,
    })
  }

  /** 材料行的可达性经两级 via（成品行 → 入库单）递归到母单自身的行谓词 */
  async function getReceiptMaterial(permit: Permit, id: string) {
    return loadAuthorizedFrom({
      db,
      permit,
      target: materialTarget,
      alias: MATERIAL_ALIAS,
      source: MATERIAL_SOURCE,
      select: SELECT_ALL,
      id,
      mapRow: mapReceiptMaterial,
      notFoundMessage: `${MATERIAL_LABEL}不存在`,
    })
  }

  async function createReceiptMaterial(
    permit: Permit,
    input: {
      receiptItemId: string
      idx: number
      qty: string
      orderItemMaterialId: string
      outsourcedWarehouseId?: string | null
      remarks?: string | null
    },
  ) {
    return withTx(db, async (trx) => {
      const { item: parentItem, receipt } = await lockReceiptForItem(
        trx,
        permit,
        input.receiptItemId,
      )
      return createReceiptMaterialInTx(trx, permit, receipt, parentItem, input)
    })
  }

  async function createReceiptMaterialInTx(
    trx: DbHandle,
    permit: Permit,
    receipt: ReturnType<typeof mapReceipt>,
    parentItem: ReturnType<typeof mapReceiptItem>,
    input: {
      receiptItemId: string
      idx: number
      qty: string
      orderItemMaterialId: string
      outsourcedWarehouseId?: string | null
      remarks?: string | null
    },
  ) {
    const outsourcedWarehouseId = input.outsourcedWarehouseId ?? receipt.outsourcedWarehouseId
    const derived = await deriveReceiptMaterial(trx, receipt, parentItem, {
      qty: decimal(input.qty),
      orderItemMaterialId: input.orderItemMaterialId,
      outsourcedWarehouseId,
      remarks: input.remarks ?? null,
    })
    try {
      const ins = await sql<{ id: string }>`
        INSERT INTO pur_outsourced_receipt_item_material (
          idx,qty,base_qty,material_code,material_name,material_spec,unit_name,order_no,
          remarks,receipt_item_id,company_id,order_item_material_id,material_id,unit_id,
          outsourced_warehouse_id
        ) VALUES (
          ${input.idx},${wireRequiredDecimal(derived.qty)},${wireRequiredDecimal(derived.baseQty)},
          ${derived.materialCode},${derived.materialName},${derived.materialSpec},${derived.unitName},
          ${derived.orderNo},${derived.remarks},${input.receiptItemId}::uuid,${receipt.companyId}::uuid,
          ${input.orderItemMaterialId}::uuid,${derived.materialId}::uuid,${derived.unitId}::uuid,
          ${derived.outsourcedWarehouseId}::uuid
        ) RETURNING id
      `.execute(trx)
      const id = ins.rows[0]!.id
      const row = await loadReceiptMaterial(trx, id)
      const dto = mapReceiptMaterial(row!)
      await writeAudit(trx, permit.actor, {
        resource: MATERIAL_TABLE,
        recordId: id,
        recordLabel: String(dto.idx),
        companyId: dto.companyId,
        actionType: 'create',
        actionName: 'create',
        changes: auditCreated(receiptMaterialSnap(dto), CHILD_AUDIT),
      })
      return dto
    } catch (err) {
      throw mapWriteError(err, '创建委外入库材料行')
    }
  }

  async function updateReceiptMaterial(
    permit: Permit,
    id: string,
    input: {
      idx?: number
      qty?: string
      orderItemMaterialId?: string
      outsourcedWarehouseId?: string | null
      outsourcedWarehouseIdPresent?: boolean
      remarks?: string | null
      remarksPresent?: boolean
    },
  ) {
    return withTx(db, async (trx) => {
      // 母单（入库单 → 成品行）先锁，再锁材料行：加锁顺序母单先行
      const receiptItemId = await parentIdOf(
        trx,
        MATERIAL_TABLE,
        'receipt_item_id',
        id,
        MATERIAL_LABEL,
      )
      const { item: parentItem, receipt } = await lockReceiptForItem(trx, permit, receiptItemId)
      await lockChildRow(trx, MATERIAL_TABLE, id, MATERIAL_LABEL)
      const before = mapReceiptMaterial((await loadReceiptMaterial(trx, id))!)
      const derived = await deriveReceiptMaterial(trx, receipt, parentItem, {
        qty: decimal(input.qty ?? before.qty),
        orderItemMaterialId: input.orderItemMaterialId ?? before.orderItemMaterialId,
        outsourcedWarehouseId: input.outsourcedWarehouseIdPresent
          ? (input.outsourcedWarehouseId ?? null)
          : before.outsourcedWarehouseId,
        remarks: input.remarksPresent ? (input.remarks ?? null) : before.remarks,
      })
      const idx = input.idx ?? before.idx
      try {
        await sql`
          UPDATE pur_outsourced_receipt_item_material SET
            idx=${idx}, qty=${wireRequiredDecimal(derived.qty)},
            base_qty=${wireRequiredDecimal(derived.baseQty)},
            material_code=${derived.materialCode}, material_name=${derived.materialName},
            material_spec=${derived.materialSpec}, unit_name=${derived.unitName},
            order_no=${derived.orderNo}, remarks=${derived.remarks},
            order_item_material_id=${derived.orderItemMaterialId}::uuid,
            material_id=${derived.materialId}::uuid, unit_id=${derived.unitId}::uuid,
            outsourced_warehouse_id=${derived.outsourcedWarehouseId}::uuid,
            updated_at=(now() AT TIME ZONE 'utc')
          WHERE id=${id}::uuid
        `.execute(trx)
      } catch (err) {
        throw mapWriteError(err, '更新委外入库材料行')
      }
      const row = await loadReceiptMaterial(trx, id)
      const dto = mapReceiptMaterial(row!)
      const changes = auditDiff(
        receiptMaterialSnap(before),
        receiptMaterialSnap(dto),
        CHILD_AUDIT,
      )
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, permit.actor, {
          resource: MATERIAL_TABLE,
          recordId: id,
          recordLabel: String(dto.idx),
          companyId: dto.companyId,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
      }
      return dto
    })
  }

  async function deleteReceiptMaterial(permit: Permit, id: string) {
    return deleteReceiptChild(permit, id, true)
  }

  async function listReceiptByproducts(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
      db,
      permit,
      target: byproductTarget,
      alias: BYPRODUCT_ALIAS,
      resource: outsourcedReceiptItemByproductMeta(),
      source: BYPRODUCT_SOURCE,
      select: SELECT_ALL,
      defaultOrder: CHILD_ORDER,
      query,
      mapRow: mapReceiptByproduct,
    })
  }

  /** 副产物行的可达性经两级 via（成品行 → 入库单）递归到母单自身的行谓词 */
  async function getReceiptByproduct(permit: Permit, id: string) {
    return loadAuthorizedFrom({
      db,
      permit,
      target: byproductTarget,
      alias: BYPRODUCT_ALIAS,
      source: BYPRODUCT_SOURCE,
      select: SELECT_ALL,
      id,
      mapRow: mapReceiptByproduct,
      notFoundMessage: `${BYPRODUCT_LABEL}不存在`,
    })
  }

  async function createReceiptByproduct(
    permit: Permit,
    input: {
      receiptItemId: string
      idx: number
      qty: string
      orderItemByproductId: string
      warehouseId?: string | null
      remarks?: string | null
    },
  ) {
    return withTx(db, async (trx) => {
      const { item: parentItem, receipt } = await lockReceiptForItem(
        trx,
        permit,
        input.receiptItemId,
      )
      return createReceiptByproductInTx(trx, permit, receipt, parentItem, input)
    })
  }

  async function createReceiptByproductInTx(
    trx: DbHandle,
    permit: Permit,
    receipt: ReturnType<typeof mapReceipt>,
    parentItem: ReturnType<typeof mapReceiptItem>,
    input: {
      receiptItemId: string
      idx: number
      qty: string
      orderItemByproductId: string
      warehouseId?: string | null
      remarks?: string | null
    },
  ) {
    const warehouseId = input.warehouseId ?? receipt.warehouseId
    const derived = await deriveReceiptByproduct(trx, receipt, parentItem, {
      qty: decimal(input.qty),
      orderItemByproductId: input.orderItemByproductId,
      warehouseId,
      remarks: input.remarks ?? null,
    })
    try {
      const ins = await sql<{ id: string }>`
        INSERT INTO pur_outsourced_receipt_item_byproduct (
          idx,qty,base_qty,material_code,material_name,material_spec,unit_name,order_no,
          remarks,receipt_item_id,company_id,order_item_byproduct_id,material_id,unit_id,
          warehouse_id
        ) VALUES (
          ${input.idx},${wireRequiredDecimal(derived.qty)},${wireRequiredDecimal(derived.baseQty)},
          ${derived.materialCode},${derived.materialName},${derived.materialSpec},${derived.unitName},
          ${derived.orderNo},${derived.remarks},${input.receiptItemId}::uuid,${receipt.companyId}::uuid,
          ${input.orderItemByproductId}::uuid,${derived.materialId}::uuid,${derived.unitId}::uuid,
          ${derived.warehouseId}::uuid
        ) RETURNING id
      `.execute(trx)
      const id = ins.rows[0]!.id
      const row = await loadReceiptByproduct(trx, id)
      const dto = mapReceiptByproduct(row!)
      await writeAudit(trx, permit.actor, {
        resource: BYPRODUCT_TABLE,
        recordId: id,
        recordLabel: String(dto.idx),
        companyId: dto.companyId,
        actionType: 'create',
        actionName: 'create',
        changes: auditCreated(receiptByproductSnap(dto), CHILD_AUDIT),
      })
      return dto
    } catch (err) {
      throw mapWriteError(err, '创建委外入库副产物行')
    }
  }

  async function updateReceiptByproduct(
    permit: Permit,
    id: string,
    input: {
      idx?: number
      qty?: string
      orderItemByproductId?: string
      warehouseId?: string | null
      warehouseIdPresent?: boolean
      remarks?: string | null
      remarksPresent?: boolean
    },
  ) {
    return withTx(db, async (trx) => {
      // 母单（入库单 → 成品行）先锁，再锁副产物行：加锁顺序母单先行
      const receiptItemId = await parentIdOf(
        trx,
        BYPRODUCT_TABLE,
        'receipt_item_id',
        id,
        BYPRODUCT_LABEL,
      )
      const { item: parentItem, receipt } = await lockReceiptForItem(trx, permit, receiptItemId)
      await lockChildRow(trx, BYPRODUCT_TABLE, id, BYPRODUCT_LABEL)
      const before = mapReceiptByproduct((await loadReceiptByproduct(trx, id))!)
      const derived = await deriveReceiptByproduct(trx, receipt, parentItem, {
        qty: decimal(input.qty ?? before.qty),
        orderItemByproductId: input.orderItemByproductId ?? before.orderItemByproductId,
        warehouseId: input.warehouseIdPresent
          ? (input.warehouseId ?? null)
          : before.warehouseId,
        remarks: input.remarksPresent ? (input.remarks ?? null) : before.remarks,
      })
      const idx = input.idx ?? before.idx
      try {
        await sql`
          UPDATE pur_outsourced_receipt_item_byproduct SET
            idx=${idx}, qty=${wireRequiredDecimal(derived.qty)},
            base_qty=${wireRequiredDecimal(derived.baseQty)},
            material_code=${derived.materialCode}, material_name=${derived.materialName},
            material_spec=${derived.materialSpec}, unit_name=${derived.unitName},
            order_no=${derived.orderNo}, remarks=${derived.remarks},
            order_item_byproduct_id=${derived.orderItemByproductId}::uuid,
            material_id=${derived.materialId}::uuid, unit_id=${derived.unitId}::uuid,
            warehouse_id=${derived.warehouseId}::uuid,
            updated_at=(now() AT TIME ZONE 'utc')
          WHERE id=${id}::uuid
        `.execute(trx)
      } catch (err) {
        throw mapWriteError(err, '更新委外入库副产物行')
      }
      const row = await loadReceiptByproduct(trx, id)
      const dto = mapReceiptByproduct(row!)
      const changes = auditDiff(
        receiptByproductSnap(before),
        receiptByproductSnap(dto),
        CHILD_AUDIT,
      )
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, permit.actor, {
          resource: BYPRODUCT_TABLE,
          recordId: id,
          recordLabel: String(dto.idx),
          companyId: dto.companyId,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
      }
      return dto
    })
  }

  async function deleteReceiptByproduct(permit: Permit, id: string) {
    return deleteReceiptChild(permit, id, false)
  }

  async function deleteReceiptChild(permit: Permit, id: string, material: boolean) {
    await withTx(db, async (trx) => {
      const table = material ? MATERIAL_TABLE : BYPRODUCT_TABLE
      const label = material ? MATERIAL_LABEL : BYPRODUCT_LABEL
      const receiptItemId = await parentIdOf(trx, table, 'receipt_item_id', id, '委外入库子行')
      await lockReceiptForItem(trx, permit, receiptItemId)
      await lockChildRow(trx, table, id, label)
      if (material) {
        const before = mapReceiptMaterial((await loadReceiptMaterial(trx, id))!)
        await writeAudit(trx, permit.actor, {
          resource: MATERIAL_TABLE,
          recordId: id,
          recordLabel: String(before.idx),
          companyId: before.companyId,
          actionType: 'destroy',
          actionName: 'destroy',
          changes: auditDestroyed(receiptMaterialSnap(before), CHILD_AUDIT),
        })
      } else {
        const before = mapReceiptByproduct((await loadReceiptByproduct(trx, id))!)
        await writeAudit(trx, permit.actor, {
          resource: BYPRODUCT_TABLE,
          recordId: id,
          recordLabel: String(before.idx),
          companyId: before.companyId,
          actionType: 'destroy',
          actionName: 'destroy',
          changes: auditDestroyed(receiptByproductSnap(before), CHILD_AUDIT),
        })
      }
      try {
        await sql`DELETE FROM ${sql.raw(table)} WHERE id=${id}::uuid`.execute(trx)
      } catch (err) {
        throw mapWriteError(err, '删除委外入库子行')
      }
    })
  }

  async function carryReceiptChildren(
    trx: DbHandle,
    permit: Permit,
    receipt: ReturnType<typeof mapReceipt>,
    parent: ReturnType<typeof mapReceiptItem>,
  ) {
    const ratio = decimal(parent.baseQty).div(decimal(parent.orderBaseQty))
    for (const isMaterial of [true, false]) {
      const table = isMaterial ? 'pur_order_item_material' : 'pur_order_item_byproduct'
      const sources = await sql<{ id: string; quantity: string }>`
        SELECT id, quantity::text AS quantity FROM ${sql.raw(table)}
        WHERE order_item_id=${parent.orderItemId}::uuid
        ORDER BY inserted_at, id
      `.execute(trx)
      let idx = 0
      for (const source of sources.rows) {
        const qty = decimal(source.quantity).mul(ratio).toDecimalPlaces(6)
        if (!qty.gt(0)) continue
        if (isMaterial) {
          await createReceiptMaterialInTx(trx, permit, receipt, parent, {
            receiptItemId: parent.id,
            idx,
            qty: wireRequiredDecimal(qty),
            orderItemMaterialId: source.id,
            outsourcedWarehouseId: receipt.outsourcedWarehouseId,
          })
        } else {
          await createReceiptByproductInTx(trx, permit, receipt, parent, {
            receiptItemId: parent.id,
            idx,
            qty: wireRequiredDecimal(qty),
            orderItemByproductId: source.id,
            warehouseId: receipt.warehouseId,
          })
        }
        idx++
      }
    }
  }

  return {
    listIssues,
    getIssue,
    createIssue,
    updateIssue,
    deleteIssue,
    auditIssue,
    voidIssue,
    listIssueItems,
    getIssueItem,
    createIssueItem,
    updateIssueItem,
    deleteIssueItem,
    listReceipts,
    getReceipt,
    createReceipt,
    updateReceipt,
    deleteReceipt,
    auditReceipt,
    voidReceipt,
    listReceiptItems,
    getReceiptItem,
    createReceiptItem,
    updateReceiptItem,
    deleteReceiptItem,
    listReceiptMaterials,
    getReceiptMaterial,
    createReceiptMaterial,
    updateReceiptMaterial,
    deleteReceiptMaterial,
    listReceiptByproducts,
    getReceiptByproduct,
    createReceiptByproduct,
    updateReceiptByproduct,
    deleteReceiptByproduct,
  }
}

export type OutsourcedService = ReturnType<typeof createOutsourcedService>

// ---- validation / derive ----

async function validateIssueHead(
  db: DbHandle,
  item: {
    issueNo: string
    issueDate: string
    partyType: string
    partyId: string
    remarks: string | null
    companyId: string
    fromWarehouseId: string | null
    outsourcedWarehouseId: string | null
  },
) {
  validateCommonHead(item.companyId, item.issueNo, item.issueDate, item.partyType, item.partyId, item.remarks)
  if (!(await partyExists(db, item.partyType, item.partyId))) {
    throw ApiError.validation('委外履约单参数不合法', { partyId: ['对手不存在'] })
  }
  if (item.fromWarehouseId) {
    await validateWarehouse(db, item.companyId, item.fromWarehouseId)
  }
  if (item.outsourcedWarehouseId) {
    await validateOutsourcedWarehouse(
      db,
      item.companyId,
      item.partyType,
      item.partyId,
      item.outsourcedWarehouseId,
    )
  }
}

async function validateReceiptHead(
  db: DbHandle,
  item: {
    receiptNo: string
    receiptDate: string
    partyType: string
    partyId: string
    remarks: string | null
    companyId: string
    warehouseId: string | null
    outsourcedWarehouseId: string | null
    debitAccountId: string
    creditAccountId: string
  },
) {
  validateCommonHead(
    item.companyId,
    item.receiptNo,
    item.receiptDate,
    item.partyType,
    item.partyId,
    item.remarks,
  )
  if (!item.debitAccountId || !item.creditAccountId) {
    throw ApiError.validation('委外入库单参数不合法', {
      debitAccountId: ['必填'],
      creditAccountId: ['必填'],
    })
  }
  if (!(await partyExists(db, item.partyType, item.partyId))) {
    throw ApiError.validation('委外履约单参数不合法', { partyId: ['对手不存在'] })
  }
  if (item.warehouseId) await validateWarehouse(db, item.companyId, item.warehouseId)
  if (item.outsourcedWarehouseId) {
    await validateOutsourcedWarehouse(
      db,
      item.companyId,
      item.partyType,
      item.partyId,
      item.outsourcedWarehouseId,
    )
  }
  await validateReceiptAccounts(db, item)
}

/**
 * 公司 / 对手 / 备注的形态校验（create 的公司闸之前先跑）：
 * 入参校验（400）必须先于公司边界（404），否则 `companyId: ''` 会先撞公司闸报「公司不存在」。
 */
function validateHeadParty(
  companyId: string,
  partyType: string,
  partyId: string,
  remarks: string | null,
) {
  const fields = partyFields(companyId, partyType, partyId, remarks)
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('委外履约单参数不合法', fields)
  }
}

function partyFields(
  companyId: string,
  partyType: string,
  partyId: string,
  remarks: string | null,
): Record<string, string[]> {
  const fields: Record<string, string[]> = {}
  const pt = lowerParty(partyType)
  if (pt !== 'supplier' && pt !== 'company') fields.partyType = ['只允许供应商或内部公司']
  if (!partyId) fields.partyId = ['必填']
  if (!companyId) fields.companyId = ['必填']
  if (pt === 'company' && partyId === companyId) fields.partyId = ['对手不能是本公司']
  if (remarks && runeLen(remarks) > 512) fields.remarks = ['最多 512 个字符']
  return fields
}

function validateCommonHead(
  companyId: string,
  no: string,
  documentDate: string,
  partyType: string,
  partyId: string,
  remarks: string | null,
) {
  const fields: Record<string, string[]> = {}
  if (!no.trim() || runeLen(no) > 32) fields.number = ['不能为空且最多 32 个字符']
  if (!documentDate) fields.documentDate = ['必填']
  Object.assign(fields, partyFields(companyId, partyType, partyId, remarks))
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('委外履约单参数不合法', fields)
  }
}

async function validateWarehouse(db: DbHandle, companyId: string, warehouseId: string) {
  const wh = await db
    .selectFrom('inv_warehouse')
    .select(['company_id', 'active', 'is_leaf'])
    .where('id', '=', warehouseId)
    .executeTakeFirst()
  if (!wh || wh.company_id !== companyId || !wh.active || !wh.is_leaf) {
    throw ApiError.validation('委外履约仓库不合法', {
      warehouseId: ['须为单据公司启用叶子仓'],
    })
  }
}

async function validateOutsourcedWarehouse(
  db: DbHandle,
  companyId: string,
  partyType: string,
  partyId: string,
  warehouseId: string,
) {
  const wh = await db
    .selectFrom('inv_warehouse')
    .select(['company_id', 'is_outsourced', 'active', 'is_leaf', 'party_type', 'party_id'])
    .where('id', '=', warehouseId)
    .executeTakeFirst()
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

async function validateReceiptAccounts(
  db: DbHandle,
  item: { companyId: string; debitAccountId: string; creditAccountId: string },
) {
  const rows = await sql<{
    id: string
    company_id: string
    is_group: boolean
    active: boolean
    role: string | null
  }>`
    SELECT id, company_id, is_group, active, role
    FROM bas_account WHERE id = ANY(${[item.debitAccountId, item.creditAccountId]}::uuid[])
  `.execute(db)
  const map = new Map(rows.rows.map((r) => [r.id, r]))
  for (const [field, accountId] of [
    ['debitAccountId', item.debitAccountId],
    ['creditAccountId', item.creditAccountId],
  ] as const) {
    const value = map.get(accountId)
    if (!value || value.company_id !== item.companyId || value.is_group || !value.active) {
      throw ApiError.validation('委外入库科目不合法', {
        [field]: ['须属于单据公司、启用且非汇总'],
      })
    }
    if (
      field === 'creditAccountId' &&
      (!value.role || value.role.toLowerCase() !== 'unbilled_payable')
    ) {
      throw ApiError.validation('委外入库科目不合法', {
        [field]: ['须为未开票应付角色科目'],
      })
    }
  }
}

async function resolveReceiptAccounts(
  db: DbHandle,
  companyId: string,
  debit: string | null,
  credit: string | null,
): Promise<{ debit: string; credit: string }> {
  let d = debit
  let c = credit
  if (!d || !c) {
    const defaults = await sql<{
      receipt_debit_account_id: string | null
      receipt_credit_account_id: string | null
    }>`
      SELECT receipt_debit_account_id, receipt_credit_account_id
      FROM sal_company_account_default WHERE company_id=${companyId}::uuid
    `.execute(db)
    const row = defaults.rows[0]
    if (!d) d = row?.receipt_debit_account_id ?? null
    if (!c) c = row?.receipt_credit_account_id ?? null
  }
  if (!d || !c) {
    throw ApiError.validation('委外入库单参数不合法', {
      accounts: ['未填写科目且公司未配置默认入库科目'],
    })
  }
  return { debit: d, credit: c }
}

async function deriveIssueItem(
  db: DbHandle,
  parent: ReturnType<typeof mapIssue>,
  draft: {
    orderItemMaterialId: string
    qty: ReturnType<typeof decimal>
    fromWarehouseId: string | null
    outsourcedWarehouseId: string | null
    remarks: string | null
  },
) {
  const fields: Record<string, string[]> = {}
  if (!draft.orderItemMaterialId) fields.orderItemMaterialId = ['必填']
  if (!draft.fromWarehouseId) fields.fromWarehouseId = ['必填']
  if (!draft.outsourcedWarehouseId) fields.outsourcedWarehouseId = ['必填']
  if (
    draft.fromWarehouseId &&
    draft.outsourcedWarehouseId &&
    draft.fromWarehouseId === draft.outsourcedWarehouseId
  ) {
    fields.warehouses = ['调出仓与外协仓不能相同']
  }
  if (draft.remarks && runeLen(draft.remarks) > 512) fields.remarks = ['最多 512 个字符']
  if (!draft.qty.gt(0)) fields.qty = ['必须大于 0']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('委外发料行参数不合法', fields)
  }
  const source = await loadMaterialSnapshot(db, draft.orderItemMaterialId)
  if (source.orderStatus !== 'audited' || !source.isOutsourced) {
    throw ApiError.validation('委外发料行参数不合法', {
      orderItemMaterialId: ['来源须为已审核委外订单发料清单行'],
    })
  }
  if (
    source.companyId !== parent.companyId ||
    lowerParty(source.partyType) !== lowerParty(parent.partyType) ||
    source.partyId !== parent.partyId
  ) {
    throw ApiError.validation('委外发料行参数不合法', {
      orderItemMaterialId: ['来源订单公司或对手不一致'],
    })
  }
  await validateWarehouse(db, parent.companyId, draft.fromWarehouseId!)
  await validateOutsourcedWarehouse(
    db,
    parent.companyId,
    parent.partyType,
    parent.partyId,
    draft.outsourcedWarehouseId!,
  )
  const snap = await loadMaterialSnap(db, source.materialId, source.unitId)
  guardMaterialType(snap, ['STOCK'], '委外发料行')
  const baseQty = convertToBaseQty(draft.qty, source.unitId, snap)
  return {
    qty: draft.qty,
    baseQty,
    materialId: source.materialId,
    unitId: source.unitId,
    materialCode: source.materialCode,
    materialName: source.materialName,
    materialSpec: source.materialSpec,
    unitName: source.unitName,
    orderNo: source.orderNo,
    orderItemMaterialId: draft.orderItemMaterialId,
    fromWarehouseId: draft.fromWarehouseId!,
    outsourcedWarehouseId: draft.outsourcedWarehouseId!,
    remarks: draft.remarks,
  }
}

async function loadMaterialSnapshot(db: DbHandle, id: string) {
  const rows = await sql<{
    company_id: string
    party_type: string
    party_id: string
    status: string
    is_outsourced: boolean
    order_no: string
    material_id: string
    unit_id: string
    material_code: string
    material_name: string
    material_spec: string | null
    unit_name: string
  }>`
    SELECT o.company_id, o.party_type, o.party_id, o.status, o.is_outsourced, o.order_no,
      ml.material_id, ml.unit_id, m.code AS material_code, m.name AS material_name, m.spec AS material_spec,
      u.name AS unit_name
    FROM pur_order_item_material ml
    JOIN pur_order_item oi ON oi.id=ml.order_item_id
    JOIN pur_order o ON o.id=oi.order_id
    JOIN inv_material m ON m.id=ml.material_id
    JOIN bas_unit u ON u.id=ml.unit_id
    WHERE ml.id=${id}::uuid
  `.execute(db)
  const r = rows.rows[0]
  if (!r) {
    throw ApiError.validation('委外发料行参数不合法', {
      orderItemMaterialId: ['来源发料清单行不存在'],
    })
  }
  return {
    companyId: r.company_id,
    partyType: r.party_type,
    partyId: r.party_id,
    orderStatus: r.status.toLowerCase(),
    isOutsourced: r.is_outsourced,
    orderNo: r.order_no,
    materialId: r.material_id,
    unitId: r.unit_id,
    materialCode: r.material_code,
    materialName: r.material_name,
    materialSpec: r.material_spec,
    unitName: r.unit_name,
  }
}

async function deriveReceiptItem(
  db: DbHandle,
  parent: ReturnType<typeof mapReceipt>,
  draft: {
    qty: ReturnType<typeof decimal>
    orderItemId: string
    unitId: string | null
    warehouseId: string | null
    remarks: string | null
  },
  excludeId: string | null,
) {
  const fields: Record<string, string[]> = {}
  if (!draft.qty.gt(0)) fields.qty = ['必须大于 0']
  if (!draft.orderItemId) fields.orderItemId = ['必填']
  if (!draft.warehouseId) fields.warehouseId = ['必填']
  if (draft.remarks && runeLen(draft.remarks) > 512) fields.remarks = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('委外入库成品行参数不合法', fields)
  }
  await validateWarehouse(db, parent.companyId, draft.warehouseId!)
  const source = await loadReceiptOrderSnapshot(db, draft.orderItemId)
  if (source.orderStatus !== 'audited' || !source.isOutsourced) {
    throw ApiError.validation('委外入库成品行参数不合法', {
      orderItemId: ['来源须为已审核委外订单行'],
    })
  }
  if (
    source.companyId !== parent.companyId ||
    lowerParty(source.partyType) !== lowerParty(parent.partyType) ||
    source.partyId !== parent.partyId
  ) {
    throw ApiError.validation('委外入库成品行参数不合法', {
      orderItemId: ['来源订单公司或对手不一致'],
    })
  }
  const chosenUnit = draft.unitId && draft.unitId.length > 0 ? draft.unitId : source.orderUnitId
  const snap = await loadMaterialSnap(db, source.materialId, chosenUnit)
  guardMaterialType(snap, ['STOCK'], '委外入库成品行')
  const baseQty = convertToBaseQty(draft.qty, chosenUnit, snap)
  const cur = excludeId
    ? await sql<{ order_currency_code: string }>`
        SELECT order_currency_code FROM pur_outsourced_receipt_item
        WHERE receipt_id=${parent.id}::uuid AND id<>${excludeId}::uuid
        ORDER BY idx,id LIMIT 1
      `.execute(db)
    : await sql<{ order_currency_code: string }>`
        SELECT order_currency_code FROM pur_outsourced_receipt_item
        WHERE receipt_id=${parent.id}::uuid
        ORDER BY idx,id LIMIT 1
      `.execute(db)
  if (cur.rows[0] && cur.rows[0].order_currency_code !== source.currencyCode) {
    throw ApiError.validation('委外入库成品行参数不合法', {
      orderItemId: ['同一入库单来源订单原币必须一致'],
    })
  }
  return {
    qty: draft.qty,
    baseQty,
    materialId: source.materialId,
    unitId: chosenUnit,
    unitName: snap.unitName,
    materialCode: source.materialCode,
    materialName: source.materialName,
    materialSpec: source.materialSpec,
    customerPartNo: source.customerPartNo,
    orderNo: source.orderNo,
    orderQty: source.orderQty,
    orderBaseQty: source.orderBaseQty,
    orderUnitName: source.orderUnitName,
    orderPrice: source.orderPrice,
    orderAmount: source.orderAmount,
    orderBasePrice: source.orderBasePrice,
    orderBaseAmount: source.orderBaseAmount,
    orderTaxRate: source.orderTaxRate,
    orderCurrencyCode: source.currencyCode,
    warehouseId: draft.warehouseId!,
    remarks: draft.remarks,
  }
}

async function loadReceiptOrderSnapshot(db: DbHandle, id: string) {
  const rows = await sql<Record<string, unknown>>`
    SELECT o.company_id, o.party_type, o.party_id, o.status, o.is_outsourced, o.order_no,
      cur.iso_code AS currency_code, i.material_id, m.default_unit_id, i.unit_id AS order_unit_id,
      i.qty, i.base_qty, i.unit_name, i.price, i.amount, i.base_price, i.base_amount, i.tax_rate,
      m.code AS material_code, m.name AS material_name, m.spec AS material_spec, m.customer_part_no
    FROM pur_order_item i
    JOIN pur_order o ON o.id=i.order_id
    JOIN bas_currency cur ON cur.id=o.currency_id
    JOIN inv_material m ON m.id=i.material_id
    WHERE i.id=${id}::uuid
  `.execute(db)
  const r = rows.rows[0]
  if (!r) {
    throw ApiError.validation('委外入库成品行参数不合法', { orderItemId: ['来源订单行不存在'] })
  }
  return {
    companyId: String(r.company_id),
    partyType: String(r.party_type),
    partyId: String(r.party_id),
    orderStatus: String(r.status).toLowerCase(),
    isOutsourced: Boolean(r.is_outsourced),
    orderNo: String(r.order_no),
    currencyCode: String(r.currency_code),
    materialId: String(r.material_id),
    orderUnitId: String(r.order_unit_id),
    orderQty: String(r.qty),
    orderBaseQty: String(r.base_qty),
    orderUnitName: String(r.unit_name),
    orderPrice: String(r.price),
    orderAmount: String(r.amount),
    orderBasePrice: String(r.base_price),
    orderBaseAmount: String(r.base_amount),
    orderTaxRate: String(r.tax_rate),
    materialCode: String(r.material_code),
    materialName: String(r.material_name),
    materialSpec: asOptionalString(r.material_spec),
    customerPartNo: asOptionalString(r.customer_part_no),
  }
}

async function deriveReceiptMaterial(
  db: DbHandle,
  receipt: ReturnType<typeof mapReceipt>,
  parent: ReturnType<typeof mapReceiptItem>,
  draft: {
    qty: ReturnType<typeof decimal>
    orderItemMaterialId: string
    outsourcedWarehouseId: string | null
    remarks: string | null
  },
) {
  validateChildShape(draft.qty, draft.orderItemMaterialId, draft.remarks)
  const source = await loadChildSource(db, true, draft.orderItemMaterialId)
  if (source.orderItemId !== parent.orderItemId) {
    throw ApiError.validation('委外入库材料行参数不合法', {
      orderItemMaterialId: ['来源必须属于父成品行的订单行'],
    })
  }
  if (draft.outsourcedWarehouseId) {
    await validateOutsourcedWarehouse(
      db,
      receipt.companyId,
      receipt.partyType,
      receipt.partyId,
      draft.outsourcedWarehouseId,
    )
  }
  const snap = await loadMaterialSnap(db, source.materialId, source.unitId)
  guardMaterialType(snap, ['STOCK'], '委外入库材料行')
  const baseQty = convertToBaseQty(draft.qty, source.unitId, snap)
  return {
    qty: draft.qty,
    baseQty,
    materialId: source.materialId,
    unitId: source.unitId,
    materialCode: source.materialCode,
    materialName: source.materialName,
    materialSpec: source.materialSpec,
    unitName: source.unitName,
    orderNo: source.orderNo,
    orderItemMaterialId: draft.orderItemMaterialId,
    outsourcedWarehouseId: draft.outsourcedWarehouseId,
    remarks: draft.remarks,
  }
}

async function deriveReceiptByproduct(
  db: DbHandle,
  receipt: ReturnType<typeof mapReceipt>,
  parent: ReturnType<typeof mapReceiptItem>,
  draft: {
    qty: ReturnType<typeof decimal>
    orderItemByproductId: string
    warehouseId: string | null
    remarks: string | null
  },
) {
  validateChildShape(draft.qty, draft.orderItemByproductId, draft.remarks)
  const source = await loadChildSource(db, false, draft.orderItemByproductId)
  if (source.orderItemId !== parent.orderItemId) {
    throw ApiError.validation('委外入库副产物行参数不合法', {
      orderItemByproductId: ['来源必须属于父成品行的订单行'],
    })
  }
  if (draft.warehouseId) {
    await validateWarehouse(db, receipt.companyId, draft.warehouseId)
  }
  const snap = await loadMaterialSnap(db, source.materialId, source.unitId)
  guardMaterialType(snap, ['STOCK'], '委外入库副产物行')
  const baseQty = convertToBaseQty(draft.qty, source.unitId, snap)
  return {
    qty: draft.qty,
    baseQty,
    materialId: source.materialId,
    unitId: source.unitId,
    materialCode: source.materialCode,
    materialName: source.materialName,
    materialSpec: source.materialSpec,
    unitName: source.unitName,
    orderNo: source.orderNo,
    orderItemByproductId: draft.orderItemByproductId,
    warehouseId: draft.warehouseId,
    remarks: draft.remarks,
  }
}

function validateChildShape(
  qty: ReturnType<typeof decimal>,
  sourceId: string,
  remarks: string | null,
) {
  const fields: Record<string, string[]> = {}
  if (!qty.gt(0)) fields.qty = ['必须大于 0']
  if (!sourceId) fields.sourceId = ['来源清单行必填']
  if (remarks && runeLen(remarks) > 512) fields.remarks = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('委外入库子行参数不合法', fields)
  }
}

async function loadChildSource(db: DbHandle, material: boolean, id: string) {
  const table = material ? 'pur_order_item_material' : 'pur_order_item_byproduct'
  const rows = await sql<{
    order_item_id: string
    material_id: string
    unit_id: string
    material_code: string
    material_name: string
    material_spec: string | null
    unit_name: string
    order_no: string
  }>`
    SELECT l.order_item_id, l.material_id, l.unit_id,
      m.code AS material_code, m.name AS material_name, m.spec AS material_spec,
      u.name AS unit_name, o.order_no
    FROM ${sql.raw(table)} l
    JOIN pur_order_item i ON i.id=l.order_item_id
    JOIN pur_order o ON o.id=i.order_id
    JOIN inv_material m ON m.id=l.material_id
    JOIN bas_unit u ON u.id=l.unit_id
    WHERE l.id=${id}::uuid
  `.execute(db)
  const r = rows.rows[0]
  if (!r) {
    throw ApiError.validation('委外入库子行参数不合法', { sourceId: ['来源清单行不存在'] })
  }
  return {
    orderItemId: r.order_item_id,
    materialId: r.material_id,
    unitId: r.unit_id,
    materialCode: r.material_code,
    materialName: r.material_name,
    materialSpec: r.material_spec,
    unitName: r.unit_name,
    orderNo: r.order_no,
  }
}

// ---- locks / loads ----

async function loadIssue(db: DbHandle, id: string) {
  const rows = await sql<Record<string, unknown>>`
    SELECT * FROM pur_outsourced_issue WHERE id=${id}::uuid
  `.execute(db)
  return rows.rows[0]
}

async function loadReceipt(db: DbHandle, id: string) {
  const rows = await sql<Record<string, unknown>>`
    SELECT * FROM pur_outsourced_receipt WHERE id=${id}::uuid
  `.execute(db)
  return rows.rows[0]
}

async function loadIssueItem(db: DbHandle, id: string) {
  const rows = await sql<Record<string, unknown>>`
    SELECT i.*, h.issue_no, h.issue_date, h.status AS issue_status, h.party_type, h.party_id
    FROM pur_outsourced_issue_item i
    JOIN pur_outsourced_issue h ON h.id=i.issue_id
    WHERE i.id=${id}::uuid
  `.execute(db)
  return rows.rows[0]
}

async function loadReceiptItem(db: DbHandle, id: string) {
  const rows = await sql<Record<string, unknown>>`
    SELECT i.*, h.receipt_no, h.receipt_date, h.status AS receipt_status, h.party_type, h.party_id,
      (i.base_qty - i.reconciled_qty) AS remaining_reconcilable_qty
    FROM pur_outsourced_receipt_item i
    JOIN pur_outsourced_receipt h ON h.id=i.receipt_id
    WHERE i.id=${id}::uuid
  `.execute(db)
  return rows.rows[0]
}

async function loadReceiptMaterial(db: DbHandle, id: string) {
  const rows = await sql<Record<string, unknown>>`
    SELECT c.*, h.receipt_no
    FROM pur_outsourced_receipt_item_material c
    JOIN pur_outsourced_receipt_item i ON i.id=c.receipt_item_id
    JOIN pur_outsourced_receipt h ON h.id=i.receipt_id
    WHERE c.id=${id}::uuid
  `.execute(db)
  return rows.rows[0]
}

async function loadReceiptByproduct(db: DbHandle, id: string) {
  const rows = await sql<Record<string, unknown>>`
    SELECT c.*, h.receipt_no
    FROM pur_outsourced_receipt_item_byproduct c
    JOIN pur_outsourced_receipt_item i ON i.id=c.receipt_item_id
    JOIN pur_outsourced_receipt h ON h.id=i.receipt_id
    WHERE c.id=${id}::uuid
  `.execute(db)
  return rows.rows[0]
}

async function loadIssueActionItems(db: DbHandle, issueId: string) {
  const rows = await sql<Record<string, unknown>>`
    SELECT id, order_item_material_id, base_qty, material_id, from_warehouse_id,
      outsourced_warehouse_id, qty, remarks
    FROM pur_outsourced_issue_item
    WHERE issue_id=${issueId}::uuid
    ORDER BY idx, id
    FOR UPDATE
  `.execute(db)
  return rows.rows.map((r) => ({
    id: String(r.id),
    orderItemMaterialId: String(r.order_item_material_id),
    baseQty: String(r.base_qty),
    materialId: String(r.material_id),
    fromWarehouseId: String(r.from_warehouse_id),
    outsourcedWarehouseId: String(r.outsourced_warehouse_id),
    qty: String(r.qty),
    remarks: asOptionalString(r.remarks),
  }))
}

async function loadReceiptActionLines(db: DbHandle, receiptId: string) {
  const itemRows = await sql<Record<string, unknown>>`
    SELECT id, order_item_id, base_qty, material_id, warehouse_id, unit_id, qty, remarks,
      order_base_qty, order_base_amount, reconciled_qty
    FROM pur_outsourced_receipt_item
    WHERE receipt_id=${receiptId}::uuid
    ORDER BY idx, id
    FOR UPDATE
  `.execute(db)
  const items = itemRows.rows.map((r) => ({
    id: String(r.id),
    orderItemId: String(r.order_item_id),
    baseQty: String(r.base_qty),
    materialId: String(r.material_id),
    warehouseId: String(r.warehouse_id),
    unitId: String(r.unit_id),
    qty: String(r.qty),
    remarks: asOptionalString(r.remarks),
    orderBaseQty: String(r.order_base_qty),
    orderBaseAmount: String(r.order_base_amount),
    reconciledQty: String(r.reconciled_qty ?? 0),
  }))
  const materials: Array<{
    outsourcedWarehouseId: string | null
    materialId: string
    baseQty: string
    remarks: string | null
  }> = []
  const byproducts: Array<{
    warehouseId: string | null
    materialId: string
    baseQty: string
    remarks: string | null
  }> = []
  for (const item of items) {
    const mats = await sql<Record<string, unknown>>`
      SELECT outsourced_warehouse_id, material_id, base_qty, remarks
      FROM pur_outsourced_receipt_item_material
      WHERE receipt_item_id=${item.id}::uuid
      ORDER BY idx, id
      FOR UPDATE
    `.execute(db)
    for (const m of mats.rows) {
      materials.push({
        outsourcedWarehouseId: m.outsourced_warehouse_id
          ? String(m.outsourced_warehouse_id)
          : null,
        materialId: String(m.material_id),
        baseQty: String(m.base_qty),
        remarks: asOptionalString(m.remarks),
      })
    }
    const byps = await sql<Record<string, unknown>>`
      SELECT warehouse_id, material_id, base_qty, remarks
      FROM pur_outsourced_receipt_item_byproduct
      WHERE receipt_item_id=${item.id}::uuid
      ORDER BY idx, id
      FOR UPDATE
    `.execute(db)
    for (const b of byps.rows) {
      byproducts.push({
        warehouseId: b.warehouse_id ? String(b.warehouse_id) : null,
        materialId: String(b.material_id),
        baseQty: String(b.base_qty),
        remarks: asOptionalString(b.remarks),
      })
    }
  }
  return { items, materials, byproducts }
}

// ---- DTO mappers ----

function mapIssue(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    issueNo: String(row.issue_no),
    issueDate: asDate(row.issue_date),
    partyType: upperStatus(String(row.party_type)),
    partyId: String(row.party_id),
    remarks: asOptionalString(row.remarks),
    status: upperStatus(String(row.status)),
    auditedAt: asDateTime(row.audited_at),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    companyId: String(row.company_id),
    fromWarehouseId: row.from_warehouse_id ? String(row.from_warehouse_id) : null,
    outsourcedWarehouseId: row.outsourced_warehouse_id
      ? String(row.outsourced_warehouse_id)
      : null,
    createdById: row.created_by_id ? String(row.created_by_id) : null,
    auditedById: row.audited_by_id ? String(row.audited_by_id) : null,
  }
}

function mapReceipt(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    receiptNo: String(row.receipt_no),
    receiptDate: asDate(row.receipt_date),
    postingDate: row.posting_date ? asDate(row.posting_date) : null,
    partyType: upperStatus(String(row.party_type)),
    partyId: String(row.party_id),
    remarks: asOptionalString(row.remarks),
    status: upperStatus(String(row.status)),
    auditedAt: asDateTime(row.audited_at),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    companyId: String(row.company_id),
    warehouseId: row.warehouse_id ? String(row.warehouse_id) : null,
    outsourcedWarehouseId: row.outsourced_warehouse_id
      ? String(row.outsourced_warehouse_id)
      : null,
    debitAccountId: String(row.debit_account_id),
    creditAccountId: String(row.credit_account_id),
    createdById: row.created_by_id ? String(row.created_by_id) : null,
    auditedById: row.audited_by_id ? String(row.audited_by_id) : null,
  }
}

function mapIssueItem(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    idx: Number(row.idx),
    qty: wireRequiredDecimal(String(row.qty)),
    baseQty: wireRequiredDecimal(String(row.base_qty)),
    materialCode: String(row.material_code),
    materialName: String(row.material_name),
    materialSpec: asOptionalString(row.material_spec),
    unitName: String(row.unit_name),
    orderNo: String(row.order_no),
    remarks: asOptionalString(row.remarks),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    issueId: String(row.issue_id),
    companyId: String(row.company_id),
    orderItemMaterialId: String(row.order_item_material_id),
    materialId: String(row.material_id),
    unitId: String(row.unit_id),
    fromWarehouseId: String(row.from_warehouse_id),
    outsourcedWarehouseId: String(row.outsourced_warehouse_id),
    issueNo: String(row.issue_no),
    issueDate: asDate(row.issue_date),
    issueStatus: upperStatus(String(row.issue_status)),
    partyType: upperStatus(String(row.party_type)),
    partyId: String(row.party_id),
  }
}

function mapReceiptItem(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    idx: Number(row.idx),
    qty: wireRequiredDecimal(String(row.qty)),
    baseQty: wireRequiredDecimal(String(row.base_qty)),
    materialCode: String(row.material_code),
    materialName: String(row.material_name),
    materialSpec: asOptionalString(row.material_spec),
    customerPartNo: asOptionalString(row.customer_part_no),
    unitName: String(row.unit_name),
    orderNo: String(row.order_no),
    orderQty: wireRequiredDecimal(String(row.order_qty)),
    orderBaseQty: wireRequiredDecimal(String(row.order_base_qty)),
    orderUnitName: String(row.order_unit_name),
    orderPrice: wireRequiredDecimal(String(row.order_price)),
    orderAmount: wireRequiredDecimal(String(row.order_amount)),
    orderBasePrice: wireRequiredDecimal(String(row.order_base_price)),
    orderBaseAmount: wireRequiredDecimal(String(row.order_base_amount)),
    orderTaxRate: wireRequiredDecimal(String(row.order_tax_rate)),
    orderCurrencyCode: String(row.order_currency_code),
    reconciledQty: wireRequiredDecimal(String(row.reconciled_qty ?? 0)),
    remainingReconcilableQty: wireRequiredDecimal(
      String(row.remaining_reconcilable_qty ?? decimal(String(row.base_qty)).sub(decimal(String(row.reconciled_qty ?? 0)))),
    ),
    remarks: asOptionalString(row.remarks),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    receiptId: String(row.receipt_id),
    companyId: String(row.company_id),
    orderItemId: String(row.order_item_id),
    materialId: String(row.material_id),
    unitId: String(row.unit_id),
    warehouseId: String(row.warehouse_id),
    receiptNo: String(row.receipt_no),
    receiptDate: asDate(row.receipt_date),
    receiptStatus: upperStatus(String(row.receipt_status)),
    partyType: upperStatus(String(row.party_type)),
    partyId: String(row.party_id),
  }
}

function mapReceiptMaterial(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    idx: Number(row.idx),
    qty: wireRequiredDecimal(String(row.qty)),
    baseQty: wireRequiredDecimal(String(row.base_qty)),
    materialCode: String(row.material_code),
    materialName: String(row.material_name),
    materialSpec: asOptionalString(row.material_spec),
    unitName: String(row.unit_name),
    orderNo: String(row.order_no),
    remarks: asOptionalString(row.remarks),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    receiptItemId: String(row.receipt_item_id),
    companyId: String(row.company_id),
    orderItemMaterialId: String(row.order_item_material_id),
    materialId: String(row.material_id),
    unitId: String(row.unit_id),
    outsourcedWarehouseId: row.outsourced_warehouse_id
      ? String(row.outsourced_warehouse_id)
      : null,
    receiptNo: String(row.receipt_no),
  }
}

function mapReceiptByproduct(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    idx: Number(row.idx),
    qty: wireRequiredDecimal(String(row.qty)),
    baseQty: wireRequiredDecimal(String(row.base_qty)),
    materialCode: String(row.material_code),
    materialName: String(row.material_name),
    materialSpec: asOptionalString(row.material_spec),
    unitName: String(row.unit_name),
    orderNo: String(row.order_no),
    remarks: asOptionalString(row.remarks),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    receiptItemId: String(row.receipt_item_id),
    companyId: String(row.company_id),
    orderItemByproductId: String(row.order_item_byproduct_id),
    materialId: String(row.material_id),
    unitId: String(row.unit_id),
    warehouseId: row.warehouse_id ? String(row.warehouse_id) : null,
    receiptNo: String(row.receipt_no),
  }
}

function issueSnap(item: ReturnType<typeof mapIssue>) {
  return {
    issue_no: item.issueNo,
    issue_date: item.issueDate,
    party_type: lowerParty(item.partyType),
    party_id: item.partyId,
    remarks: item.remarks,
    status: item.status,
    audited_at: item.auditedAt,
    company_id: item.companyId,
    from_warehouse_id: item.fromWarehouseId,
    outsourced_warehouse_id: item.outsourcedWarehouseId,
    created_by_id: item.createdById,
    audited_by_id: item.auditedById,
  }
}

function receiptSnap(item: ReturnType<typeof mapReceipt>) {
  return {
    receipt_no: item.receiptNo,
    receipt_date: item.receiptDate,
    posting_date: item.postingDate,
    party_type: lowerParty(item.partyType),
    party_id: item.partyId,
    remarks: item.remarks,
    status: item.status,
    audited_at: item.auditedAt,
    company_id: item.companyId,
    warehouse_id: item.warehouseId,
    outsourced_warehouse_id: item.outsourcedWarehouseId,
    debit_account_id: item.debitAccountId,
    credit_account_id: item.creditAccountId,
    created_by_id: item.createdById,
    audited_by_id: item.auditedById,
  }
}

function issueItemSnap(item: ReturnType<typeof mapIssueItem>) {
  return {
    idx: item.idx,
    qty: item.qty,
    base_qty: item.baseQty,
    material_code: item.materialCode,
    material_name: item.materialName,
    material_spec: item.materialSpec,
    unit_name: item.unitName,
    order_no: item.orderNo,
    remarks: item.remarks,
    issue_id: item.issueId,
    company_id: item.companyId,
    order_item_material_id: item.orderItemMaterialId,
    material_id: item.materialId,
    unit_id: item.unitId,
    from_warehouse_id: item.fromWarehouseId,
    outsourced_warehouse_id: item.outsourcedWarehouseId,
  }
}

function receiptItemSnap(item: ReturnType<typeof mapReceiptItem>) {
  return {
    idx: item.idx,
    qty: item.qty,
    base_qty: item.baseQty,
    material_code: item.materialCode,
    material_name: item.materialName,
    material_spec: item.materialSpec,
    customer_part_no: item.customerPartNo,
    unit_name: item.unitName,
    order_no: item.orderNo,
    order_qty: item.orderQty,
    order_base_qty: item.orderBaseQty,
    order_unit_name: item.orderUnitName,
    order_price: item.orderPrice,
    order_amount: item.orderAmount,
    order_base_price: item.orderBasePrice,
    order_base_amount: item.orderBaseAmount,
    order_tax_rate: item.orderTaxRate,
    order_currency_code: item.orderCurrencyCode,
    reconciled_qty: item.reconciledQty,
    remarks: item.remarks,
    receipt_id: item.receiptId,
    company_id: item.companyId,
    order_item_id: item.orderItemId,
    material_id: item.materialId,
    unit_id: item.unitId,
    warehouse_id: item.warehouseId,
  }
}

function receiptMaterialSnap(item: ReturnType<typeof mapReceiptMaterial>) {
  return {
    idx: item.idx,
    qty: item.qty,
    base_qty: item.baseQty,
    material_code: item.materialCode,
    material_name: item.materialName,
    material_spec: item.materialSpec,
    unit_name: item.unitName,
    order_no: item.orderNo,
    remarks: item.remarks,
    receipt_item_id: item.receiptItemId,
    company_id: item.companyId,
    source_id: item.orderItemMaterialId,
    material_id: item.materialId,
    unit_id: item.unitId,
    warehouse_id: item.outsourcedWarehouseId,
  }
}

function receiptByproductSnap(item: ReturnType<typeof mapReceiptByproduct>) {
  return {
    idx: item.idx,
    qty: item.qty,
    base_qty: item.baseQty,
    material_code: item.materialCode,
    material_name: item.materialName,
    material_spec: item.materialSpec,
    unit_name: item.unitName,
    order_no: item.orderNo,
    remarks: item.remarks,
    receipt_item_id: item.receiptItemId,
    company_id: item.companyId,
    source_id: item.orderItemByproductId,
    material_id: item.materialId,
    unit_id: item.unitId,
    warehouse_id: item.warehouseId,
  }
}
