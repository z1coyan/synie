/**
 * 委外发料 / 委外入库：完整 CRUD、审核（库存+投影+总账）、作废回滚、比例带出材料/副产物。
 * 行为对齐 server-go/internal/domain/fulfillment/outsourced。
 */
import type { ListQuery } from '@synie/shared'
import { decimal, roundAmount } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { createInventoryEngine } from '~/engines/inventory/index.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import { canAccessCompany, type Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { companyScopeWhere, listFromSource } from '../../base/list.ts'
import { mapWriteError as mapWriteErrorBase } from '../../base/dberr.ts'

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
  loadMaterialSnap,
  lowerParty,
  partyExists,
  requirePerm,
  runeLen,
  todayUTC,
  toDateOnly,
  upperStatus,
  wireRequiredDecimal,
} from '../common.ts'
import type { OrderService } from '../order/service.ts'
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

const inventory = createInventoryEngine()
const gl = createGlEngine()

const ISSUE_PREFIX = 'purchase.outsourced_issue'
const RECEIPT_PREFIX = 'purchase.outsourced_receipt'
const ISSUE_TABLE = 'pur_outsourced_issue'
const ISSUE_ITEM_TABLE = 'pur_outsourced_issue_item'
const RECEIPT_TABLE = 'pur_outsourced_receipt'
const RECEIPT_ITEM_TABLE = 'pur_outsourced_receipt_item'
const MATERIAL_TABLE = 'pur_outsourced_receipt_item_material'
const BYPRODUCT_TABLE = 'pur_outsourced_receipt_item_byproduct'

const ISSUE_AUDIT = [
  'issue_no',
  'issue_date',
  'party_type',
  'party_id',
  'remarks',
  'status',
  'audited_at',
  'company_id',
  'from_warehouse_id',
  'outsourced_warehouse_id',
  'created_by_id',
  'audited_by_id',
] as const

const RECEIPT_AUDIT = [
  'receipt_no',
  'receipt_date',
  'posting_date',
  'party_type',
  'party_id',
  'remarks',
  'status',
  'audited_at',
  'company_id',
  'warehouse_id',
  'outsourced_warehouse_id',
  'debit_account_id',
  'credit_account_id',
  'created_by_id',
  'audited_by_id',
] as const

const ISSUE_ITEM_AUDIT = [
  'idx',
  'qty',
  'base_qty',
  'material_code',
  'material_name',
  'material_spec',
  'unit_name',
  'order_no',
  'remarks',
  'issue_id',
  'company_id',
  'order_item_material_id',
  'material_id',
  'unit_id',
  'from_warehouse_id',
  'outsourced_warehouse_id',
] as const

const RECEIPT_ITEM_AUDIT = [
  'idx',
  'qty',
  'base_qty',
  'material_code',
  'material_name',
  'material_spec',
  'customer_part_no',
  'unit_name',
  'order_no',
  'order_qty',
  'order_base_qty',
  'order_unit_name',
  'order_price',
  'order_amount',
  'order_base_price',
  'order_base_amount',
  'order_tax_rate',
  'order_currency_code',
  'reconciled_qty',
  'remarks',
  'receipt_id',
  'company_id',
  'order_item_id',
  'material_id',
  'unit_id',
  'warehouse_id',
] as const

const CHILD_AUDIT = [
  'idx',
  'qty',
  'base_qty',
  'material_code',
  'material_name',
  'material_spec',
  'unit_name',
  'order_no',
  'remarks',
  'receipt_item_id',
  'company_id',
  'source_id',
  'material_id',
  'unit_id',
  'warehouse_id',
] as const

type Numberer = Pick<NumberingService, 'nextInTx'>

export function createOutsourcedService(
  db: Kysely<Database>,
  numberer: Numberer,
  orders: Pick<OrderService, 'postFulfillment' | 'reverseFulfillment' | 'postOutsourcedIssue' | 'reverseOutsourcedIssue'>,
) {
  // ---------- Issue head ----------

  async function listIssues(actor: Actor, query: Partial<ListQuery>) {
    requirePerm(actor, ISSUE_PREFIX, 'read', '无权限执行该委外操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as Record<string, unknown>[] }
    return listFromSource({
      db,
      resource: outsourcedIssueMeta(),
      source: sql` FROM pur_outsourced_issue`,
      select: sql`SELECT *`,
      defaultOrder: sql`"inserted_at" DESC, "id" DESC`,
      query,
      extraWhere: scope.where,
      mapRow: mapIssue,
    })
  }

  async function getIssue(actor: Actor, id: string) {
    requirePerm(actor, ISSUE_PREFIX, 'read', '无权限执行该委外操作')
    const row = await loadIssue(db, id)
    if (!row || !canAccessCompany(actor, String(row.company_id))) {
      throw new ApiError('not_found', '委外发料单不存在')
    }
    return mapIssue(row)
  }

  async function createIssue(
    actor: Actor,
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
    requirePerm(actor, ISSUE_PREFIX, 'create', '无权限执行该委外操作')
    if (!canAccessCompany(actor, input.companyId)) {
      throw new ApiError('forbidden', '无权在该公司创建委外发料单')
    }
    return withTx(db, async (trx) => {
      const issueDate = input.issueDate ? toDateOnly(input.issueDate) : todayUTC()
      let issueNo = (input.issueNo ?? '').trim()
      if (!issueNo) {
        issueNo = await numberer.nextInTx(trx, {
          resource: ISSUE_PREFIX,
          values: { company_id: input.companyId, issue_date: issueDate },
        })
      }
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
            ${actor.userId || null}::uuid
          ) RETURNING id
        `.execute(trx)
        const id = ins.rows[0]!.id
        const row = await loadIssue(trx, id)
        const dto = mapIssue(row!)
        await writeAudit(trx, actor, {
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
    actor: Actor,
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
    requirePerm(actor, ISSUE_PREFIX, 'update', '无权限执行该委外操作')
    return withTx(db, async (trx) => {
      const beforeRow = await lockDraftIssue(trx, actor, id)
      const before = mapIssue(beforeRow)
      const after = {
        issueNo: input.issueNo !== undefined ? input.issueNo.trim() : before.issueNo,
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
        await writeAudit(trx, actor, {
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

  async function deleteIssue(actor: Actor, id: string) {
    requirePerm(actor, ISSUE_PREFIX, 'delete', '无权限执行该委外操作')
    await withTx(db, async (trx) => {
      const row = await lockDraftIssue(trx, actor, id)
      const dto = mapIssue(row)
      await writeAudit(trx, actor, {
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

  async function auditIssue(actor: Actor, id: string) {
    requirePerm(actor, ISSUE_PREFIX, 'audit', '无权限执行该委外操作')
    return withTx(db, async (trx) => {
      const beforeRow = await lockDraftIssue(trx, actor, id)
      const before = mapIssue(beforeRow)
      const items = await loadIssueActionItems(trx, id)
      if (items.length === 0) {
        throw new ApiError('conflict', '委外发料单至少需要一条发料行')
      }
      const stockLines: Array<{
        warehouseId: string
        materialId: string
        quantity: string
        remarks: string | null
      }> = []
      const projection: Array<{ orderItemMaterialId: string; baseQty: string }> = []
      for (const item of items) {
        await deriveIssueItem(trx, before, {
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
            quantity: wireRequiredDecimal(decimal(item.baseQty).neg()),
            remarks: item.remarks,
          },
          {
            warehouseId: item.outsourcedWarehouseId,
            materialId: item.materialId,
            quantity: wireRequiredDecimal(item.baseQty),
            remarks: item.remarks,
          },
        )
      }
      await orders.postOutsourcedIssue(trx, {
        companyId: before.companyId,
        partyType: before.partyType,
        partyId: before.partyId,
        lines: projection,
      })
      await inventory.post(
        trx,
        {
          type: ISSUE_PREFIX,
          id: before.id,
          no: before.issueNo,
          companyId: before.companyId,
          postingDate: before.issueDate,
        },
        stockLines,
      )
      const auditedById = actor.userId || null
      await sql`
        UPDATE pur_outsourced_issue SET
          status='audited',
          audited_at=(now() AT TIME ZONE 'utc'),
          audited_by_id=${auditedById}::uuid,
          updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${id}::uuid
      `.execute(trx)
      const row = await loadIssue(trx, id)
      const after = mapIssue(row!)
      await writeAudit(trx, actor, {
        resource: ISSUE_TABLE,
        recordId: id,
        recordLabel: after.issueNo,
        companyId: after.companyId,
        actionType: 'update',
        actionName: 'audit',
        changes: auditDiff(issueSnap(before), issueSnap(after), ISSUE_AUDIT),
      })
      return after
    })
  }

  async function voidIssue(actor: Actor, id: string) {
    requirePerm(actor, ISSUE_PREFIX, 'void', '无权限执行该委外操作')
    return withTx(db, async (trx) => {
      const beforeRow = await lockIssue(trx, actor, id)
      const before = mapIssue(beforeRow)
      if (before.status !== 'AUDITED') {
        throw new ApiError('conflict', '仅已审核委外发料单可作废')
      }
      const items = await loadIssueActionItems(trx, id)
      await orders.reverseOutsourcedIssue(trx, {
        companyId: before.companyId,
        partyType: before.partyType,
        partyId: before.partyId,
        lines: items.map((i) => ({
          orderItemMaterialId: i.orderItemMaterialId,
          baseQty: i.baseQty,
        })),
      })
      await inventory.cancel(trx, { type: ISSUE_PREFIX, id: before.id })
      await sql`
        UPDATE pur_outsourced_issue SET status='voided', updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${id}::uuid
      `.execute(trx)
      const row = await loadIssue(trx, id)
      const after = mapIssue(row!)
      await writeAudit(trx, actor, {
        resource: ISSUE_TABLE,
        recordId: id,
        recordLabel: after.issueNo,
        companyId: after.companyId,
        actionType: 'update',
        actionName: 'void',
        changes: auditDiff(issueSnap(before), issueSnap(after), ISSUE_AUDIT),
      })
      return after
    })
  }

  // ---------- Issue items ----------

  async function listIssueItems(actor: Actor, query: Partial<ListQuery>) {
    requirePerm(actor, ISSUE_PREFIX, 'read', '无权限执行该委外操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as Record<string, unknown>[] }
    return listFromSource({
      db,
      resource: outsourcedIssueItemMeta(),
      source: sql` FROM (
        SELECT i.id,i.idx,i.qty,i.base_qty,i.material_code,i.material_name,i.material_spec,
          i.unit_name,i.order_no,i.remarks,i.inserted_at,i.updated_at,i.issue_id,i.company_id,
          i.order_item_material_id,i.material_id,i.unit_id,i.from_warehouse_id,i.outsourced_warehouse_id,
          h.issue_no,h.issue_date,h.status AS issue_status,h.party_type,h.party_id
        FROM pur_outsourced_issue_item i
        JOIN pur_outsourced_issue h ON h.id=i.issue_id
      ) issue_items`,
      select: sql`SELECT *`,
      defaultOrder: sql`"idx" ASC, "id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: mapIssueItem,
    })
  }

  async function getIssueItem(actor: Actor, id: string) {
    requirePerm(actor, ISSUE_PREFIX, 'read', '无权限执行该委外操作')
    const row = await loadIssueItem(db, id)
    if (!row || !canAccessCompany(actor, String(row.company_id))) {
      throw new ApiError('not_found', '委外发料行不存在')
    }
    return mapIssueItem(row)
  }

  async function createIssueItem(
    actor: Actor,
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
    requirePerm(actor, ISSUE_PREFIX, 'create', '无权限执行该委外操作')
    return withTx(db, async (trx) => {
      const parent = mapIssue(await lockDraftIssue(trx, actor, input.issueId))
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
        await writeAudit(trx, actor, {
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
    actor: Actor,
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
    requirePerm(actor, ISSUE_PREFIX, 'update', '无权限执行该委外操作')
    return withTx(db, async (trx) => {
      const cur = await sql<{ issue_id: string }>`
        SELECT issue_id FROM pur_outsourced_issue_item WHERE id=${id}::uuid
      `.execute(trx)
      if (!cur.rows[0]) throw new ApiError('not_found', '委外发料行不存在')
      const parent = mapIssue(await lockDraftIssue(trx, actor, cur.rows[0].issue_id))
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
        await writeAudit(trx, actor, {
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

  async function deleteIssueItem(actor: Actor, id: string) {
    requirePerm(actor, ISSUE_PREFIX, 'delete', '无权限执行该委外操作')
    await withTx(db, async (trx) => {
      const cur = await sql<{ issue_id: string }>`
        SELECT issue_id FROM pur_outsourced_issue_item WHERE id=${id}::uuid
      `.execute(trx)
      if (!cur.rows[0]) throw new ApiError('not_found', '委外发料行不存在')
      await lockDraftIssue(trx, actor, cur.rows[0].issue_id)
      const before = mapIssueItem((await loadIssueItem(trx, id))!)
      await writeAudit(trx, actor, {
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

  async function listReceipts(actor: Actor, query: Partial<ListQuery>) {
    requirePerm(actor, RECEIPT_PREFIX, 'read', '无权限执行该委外操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as Record<string, unknown>[] }
    return listFromSource({
      db,
      resource: outsourcedReceiptMeta(),
      source: sql` FROM pur_outsourced_receipt`,
      select: sql`SELECT *`,
      defaultOrder: sql`"inserted_at" DESC, "id" DESC`,
      query,
      extraWhere: scope.where,
      mapRow: mapReceipt,
    })
  }

  async function getReceipt(actor: Actor, id: string) {
    requirePerm(actor, RECEIPT_PREFIX, 'read', '无权限执行该委外操作')
    const row = await loadReceipt(db, id)
    if (!row || !canAccessCompany(actor, String(row.company_id))) {
      throw new ApiError('not_found', '委外入库单不存在')
    }
    return mapReceipt(row)
  }

  async function createReceipt(
    actor: Actor,
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
    requirePerm(actor, RECEIPT_PREFIX, 'create', '无权限执行该委外操作')
    if (!canAccessCompany(actor, input.companyId)) {
      throw new ApiError('forbidden', '无权在该公司创建委外入库单')
    }
    return withTx(db, async (trx) => {
      const receiptDate = input.receiptDate ? toDateOnly(input.receiptDate) : todayUTC()
      let receiptNo = (input.receiptNo ?? '').trim()
      if (!receiptNo) {
        receiptNo = await numberer.nextInTx(trx, {
          resource: RECEIPT_PREFIX,
          values: { company_id: input.companyId, receipt_date: receiptDate },
        })
      }
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
            ${debit}::uuid, ${credit}::uuid, ${actor.userId || null}::uuid
          ) RETURNING id
        `.execute(trx)
        const id = ins.rows[0]!.id
        const row = await loadReceipt(trx, id)
        const dto = mapReceipt(row!)
        await writeAudit(trx, actor, {
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
    actor: Actor,
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
    requirePerm(actor, RECEIPT_PREFIX, 'update', '无权限执行该委外操作')
    return withTx(db, async (trx) => {
      const beforeRow = await lockDraftReceipt(trx, actor, id)
      const before = mapReceipt(beforeRow)
      const after = {
        receiptNo: input.receiptNo !== undefined ? input.receiptNo.trim() : before.receiptNo,
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
        await writeAudit(trx, actor, {
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

  async function deleteReceipt(actor: Actor, id: string) {
    requirePerm(actor, RECEIPT_PREFIX, 'delete', '无权限执行该委外操作')
    await withTx(db, async (trx) => {
      const row = await lockDraftReceipt(trx, actor, id)
      const dto = mapReceipt(row)
      await writeAudit(trx, actor, {
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

  async function auditReceipt(actor: Actor, id: string, input: { postingDate?: string | null } = {}) {
    requirePerm(actor, RECEIPT_PREFIX, 'audit', '无权限执行该委外操作')
    return withTx(db, async (trx) => {
      const beforeRow = await lockDraftReceipt(trx, actor, id)
      const before = mapReceipt(beforeRow)
      const { items, materials, byproducts } = await loadReceiptActionLines(trx, id)
      if (items.length === 0) {
        throw new ApiError('conflict', '委外入库单至少需要一条成品行')
      }
      const stockLines: Array<{
        warehouseId: string
        materialId: string
        quantity: string
        remarks: string | null
      }> = []
      const projection: Array<{ orderItemId: string; baseQty: string }> = []
      let amount = decimal(0)
      for (const item of items) {
        await deriveReceiptItem(
          trx,
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
        projection.push({ orderItemId: item.orderItemId, baseQty: item.baseQty })
        stockLines.push({
          warehouseId: item.warehouseId,
          materialId: item.materialId,
          quantity: wireRequiredDecimal(item.baseQty),
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
          trx,
          before.companyId,
          before.partyType,
          before.partyId,
          m.outsourcedWarehouseId,
        )
        stockLines.push({
          warehouseId: m.outsourcedWarehouseId,
          materialId: m.materialId,
          quantity: wireRequiredDecimal(decimal(m.baseQty).neg()),
          remarks: m.remarks,
        })
      }
      for (const b of byproducts) {
        if (!b.warehouseId) {
          throw new ApiError('conflict', '副产物行必须填写入仓')
        }
        await validateWarehouse(trx, before.companyId, b.warehouseId)
        stockLines.push({
          warehouseId: b.warehouseId,
          materialId: b.materialId,
          quantity: wireRequiredDecimal(b.baseQty),
          remarks: b.remarks,
        })
      }
      await orders.postFulfillment(trx, 'purchase', {
        companyId: before.companyId,
        partyType: before.partyType,
        partyId: before.partyId,
        requireOutsourced: true,
        lines: projection,
      })
      await inventory.post(
        trx,
        {
          type: RECEIPT_PREFIX,
          id: before.id,
          no: before.receiptNo,
          companyId: before.companyId,
          postingDate: before.receiptDate,
        },
        stockLines,
      )
      let postingDate = before.postingDate ?? before.receiptDate
      if (input.postingDate) postingDate = toDateOnly(input.postingDate)
      amount = decimal(roundAmount(amount))
      if (amount.gt(0)) {
        if (!postingDate) {
          throw ApiError.validation('审核委外入库单参数不合法', {
            postingDate: ['有金额过账时必填'],
          })
        }
        const currencies = await accountCurrencies(trx, before.debitAccountId, before.creditAccountId)
        await gl.post(
          trx,
          {
            type: RECEIPT_PREFIX,
            id: before.id,
            no: before.receiptNo,
            companyId: before.companyId,
            postingDate,
          },
          [
            {
              accountId: before.debitAccountId,
              currencyId: currencies.debit,
              debit: amount,
              credit: 0,
            },
            {
              accountId: before.creditAccountId,
              currencyId: currencies.credit,
              debit: 0,
              credit: amount,
              partyType: lowerParty(before.partyType),
              partyId: before.partyId,
            },
          ],
        )
      }
      const auditedById = actor.userId || null
      await sql`
        UPDATE pur_outsourced_receipt SET
          status='audited',
          posting_date=${postingDate}::date,
          audited_at=(now() AT TIME ZONE 'utc'),
          audited_by_id=${auditedById}::uuid,
          updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${id}::uuid
      `.execute(trx)
      const row = await loadReceipt(trx, id)
      const after = mapReceipt(row!)
      await writeAudit(trx, actor, {
        resource: RECEIPT_TABLE,
        recordId: id,
        recordLabel: after.receiptNo,
        companyId: after.companyId,
        actionType: 'update',
        actionName: 'audit',
        changes: auditDiff(receiptSnap(before), receiptSnap(after), RECEIPT_AUDIT),
      })
      return after
    })
  }

  async function voidReceipt(actor: Actor, id: string) {
    requirePerm(actor, RECEIPT_PREFIX, 'void', '无权限执行该委外操作')
    return withTx(db, async (trx) => {
      const beforeRow = await lockReceipt(trx, actor, id)
      const before = mapReceipt(beforeRow)
      if (before.status !== 'AUDITED') {
        throw new ApiError('conflict', '仅已审核委外入库单可作废')
      }
      const { items } = await loadReceiptActionLines(trx, id)
      for (const item of items) {
        if (decimal(item.reconciledQty).gt(0)) {
          throw new ApiError('conflict', '存在已对账成品行,不可作废')
        }
      }
      await orders.reverseFulfillment(trx, 'purchase', {
        companyId: before.companyId,
        partyType: before.partyType,
        partyId: before.partyId,
        requireOutsourced: true,
        lines: items.map((i) => ({ orderItemId: i.orderItemId, baseQty: i.baseQty })),
      })
      await inventory.cancel(trx, { type: RECEIPT_PREFIX, id: before.id })
      await gl.cancel(trx, { type: RECEIPT_PREFIX, id: before.id })
      await sql`
        UPDATE pur_outsourced_receipt SET status='voided', updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${id}::uuid
      `.execute(trx)
      const row = await loadReceipt(trx, id)
      const after = mapReceipt(row!)
      await writeAudit(trx, actor, {
        resource: RECEIPT_TABLE,
        recordId: id,
        recordLabel: after.receiptNo,
        companyId: after.companyId,
        actionType: 'update',
        actionName: 'void',
        changes: auditDiff(receiptSnap(before), receiptSnap(after), RECEIPT_AUDIT),
      })
      return after
    })
  }

  // ---------- Receipt items ----------

  async function listReceiptItems(actor: Actor, query: Partial<ListQuery>) {
    requirePerm(actor, RECEIPT_PREFIX, 'read', '无权限执行该委外操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as Record<string, unknown>[] }
    return listFromSource({
      db,
      resource: outsourcedReceiptItemMeta(),
      source: sql` FROM (
        SELECT i.id,i.idx,i.qty,i.base_qty,i.material_code,i.material_name,i.material_spec,
          i.customer_part_no,i.unit_name,i.order_no,i.order_qty,i.order_base_qty,i.order_unit_name,
          i.order_price,i.order_amount,i.order_base_price,i.order_base_amount,i.order_tax_rate,
          i.order_currency_code,i.reconciled_qty,i.remarks,i.inserted_at,i.updated_at,
          i.receipt_id,i.company_id,i.order_item_id,i.material_id,i.unit_id,i.warehouse_id,
          h.receipt_no,h.receipt_date,h.status AS receipt_status,h.party_type,h.party_id,
          (i.base_qty - i.reconciled_qty) AS remaining_reconcilable_qty
        FROM pur_outsourced_receipt_item i
        JOIN pur_outsourced_receipt h ON h.id=i.receipt_id
      ) receipt_items`,
      select: sql`SELECT *`,
      defaultOrder: sql`"idx" ASC, "id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: mapReceiptItem,
    })
  }

  async function getReceiptItem(actor: Actor, id: string) {
    requirePerm(actor, RECEIPT_PREFIX, 'read', '无权限执行该委外操作')
    const row = await loadReceiptItem(db, id)
    if (!row || !canAccessCompany(actor, String(row.company_id))) {
      throw new ApiError('not_found', '委外入库成品行不存在')
    }
    return mapReceiptItem(row)
  }

  async function createReceiptItem(
    actor: Actor,
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
    requirePerm(actor, RECEIPT_PREFIX, 'create', '无权限执行该委外操作')
    return withTx(db, async (trx) => {
      const parent = mapReceipt(await lockDraftReceipt(trx, actor, input.receiptId))
      return createReceiptItemInTx(trx, actor, parent, input, true)
    })
  }

  async function createReceiptItemInTx(
    trx: DbHandle,
    actor: Actor,
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
      await writeAudit(trx, actor, {
        resource: RECEIPT_ITEM_TABLE,
        recordId: id,
        recordLabel: String(dto.idx),
        companyId: dto.companyId,
        actionType: 'create',
        actionName: 'create',
        changes: auditCreated(receiptItemSnap(dto), RECEIPT_ITEM_AUDIT),
      })
      if (carry && decimal(dto.orderBaseQty).gt(0)) {
        await carryReceiptChildren(trx, actor, parent, dto)
      }
      return dto
    } catch (err) {
      throw mapWriteError(err, '创建委外入库成品行')
    }
  }

  async function updateReceiptItem(
    actor: Actor,
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
    requirePerm(actor, RECEIPT_PREFIX, 'update', '无权限执行该委外操作')
    return withTx(db, async (trx) => {
      const cur = await sql<{ receipt_id: string }>`
        SELECT receipt_id FROM pur_outsourced_receipt_item WHERE id=${id}::uuid
      `.execute(trx)
      if (!cur.rows[0]) throw new ApiError('not_found', '委外入库成品行不存在')
      const parent = mapReceipt(await lockDraftReceipt(trx, actor, cur.rows[0].receipt_id))
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
        await writeAudit(trx, actor, {
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

  async function deleteReceiptItem(actor: Actor, id: string) {
    requirePerm(actor, RECEIPT_PREFIX, 'delete', '无权限执行该委外操作')
    await withTx(db, async (trx) => {
      const cur = await sql<{ receipt_id: string }>`
        SELECT receipt_id FROM pur_outsourced_receipt_item WHERE id=${id}::uuid
      `.execute(trx)
      if (!cur.rows[0]) throw new ApiError('not_found', '委外入库成品行不存在')
      await lockDraftReceipt(trx, actor, cur.rows[0].receipt_id)
      const before = mapReceiptItem((await loadReceiptItem(trx, id))!)
      await writeAudit(trx, actor, {
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

  async function listReceiptMaterials(actor: Actor, query: Partial<ListQuery>) {
    requirePerm(actor, RECEIPT_PREFIX, 'read', '无权限执行该委外操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as Record<string, unknown>[] }
    return listFromSource({
      db,
      resource: outsourcedReceiptItemMaterialMeta(),
      source: sql` FROM (
        SELECT c.id,c.idx,c.qty,c.base_qty,c.material_code,c.material_name,c.material_spec,
          c.unit_name,c.order_no,c.remarks,c.inserted_at,c.updated_at,c.receipt_item_id,
          c.company_id,c.order_item_material_id,c.material_id,c.unit_id,c.outsourced_warehouse_id,
          h.receipt_no
        FROM pur_outsourced_receipt_item_material c
        JOIN pur_outsourced_receipt_item i ON i.id=c.receipt_item_id
        JOIN pur_outsourced_receipt h ON h.id=i.receipt_id
      ) receipt_materials`,
      select: sql`SELECT *`,
      defaultOrder: sql`"idx" ASC, "id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: mapReceiptMaterial,
    })
  }

  async function getReceiptMaterial(actor: Actor, id: string) {
    requirePerm(actor, RECEIPT_PREFIX, 'read', '无权限执行该委外操作')
    const row = await loadReceiptMaterial(db, id)
    if (!row || !canAccessCompany(actor, String(row.company_id))) {
      throw new ApiError('not_found', '委外入库材料行不存在')
    }
    return mapReceiptMaterial(row)
  }

  async function createReceiptMaterial(
    actor: Actor,
    input: {
      receiptItemId: string
      idx: number
      qty: string
      orderItemMaterialId: string
      outsourcedWarehouseId?: string | null
      remarks?: string | null
    },
  ) {
    requirePerm(actor, RECEIPT_PREFIX, 'create', '无权限执行该委外操作')
    return withTx(db, async (trx) => {
      const { item: parentItem, receipt } = await lockReceiptForItem(trx, actor, input.receiptItemId)
      return createReceiptMaterialInTx(trx, actor, receipt, parentItem, input)
    })
  }

  async function createReceiptMaterialInTx(
    trx: DbHandle,
    actor: Actor,
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
      await writeAudit(trx, actor, {
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
    actor: Actor,
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
    requirePerm(actor, RECEIPT_PREFIX, 'update', '无权限执行该委外操作')
    return withTx(db, async (trx) => {
      const cur = await sql<{ receipt_item_id: string }>`
        SELECT receipt_item_id FROM pur_outsourced_receipt_item_material WHERE id=${id}::uuid
      `.execute(trx)
      if (!cur.rows[0]) throw new ApiError('not_found', '委外入库材料行不存在')
      const { item: parentItem, receipt } = await lockReceiptForItem(
        trx,
        actor,
        cur.rows[0].receipt_item_id,
      )
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
        await writeAudit(trx, actor, {
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

  async function deleteReceiptMaterial(actor: Actor, id: string) {
    return deleteReceiptChild(actor, id, true)
  }

  async function listReceiptByproducts(actor: Actor, query: Partial<ListQuery>) {
    requirePerm(actor, RECEIPT_PREFIX, 'read', '无权限执行该委外操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as Record<string, unknown>[] }
    return listFromSource({
      db,
      resource: outsourcedReceiptItemByproductMeta(),
      source: sql` FROM (
        SELECT c.id,c.idx,c.qty,c.base_qty,c.material_code,c.material_name,c.material_spec,
          c.unit_name,c.order_no,c.remarks,c.inserted_at,c.updated_at,c.receipt_item_id,
          c.company_id,c.order_item_byproduct_id,c.material_id,c.unit_id,c.warehouse_id,
          h.receipt_no
        FROM pur_outsourced_receipt_item_byproduct c
        JOIN pur_outsourced_receipt_item i ON i.id=c.receipt_item_id
        JOIN pur_outsourced_receipt h ON h.id=i.receipt_id
      ) receipt_byproducts`,
      select: sql`SELECT *`,
      defaultOrder: sql`"idx" ASC, "id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: mapReceiptByproduct,
    })
  }

  async function getReceiptByproduct(actor: Actor, id: string) {
    requirePerm(actor, RECEIPT_PREFIX, 'read', '无权限执行该委外操作')
    const row = await loadReceiptByproduct(db, id)
    if (!row || !canAccessCompany(actor, String(row.company_id))) {
      throw new ApiError('not_found', '委外入库副产物行不存在')
    }
    return mapReceiptByproduct(row)
  }

  async function createReceiptByproduct(
    actor: Actor,
    input: {
      receiptItemId: string
      idx: number
      qty: string
      orderItemByproductId: string
      warehouseId?: string | null
      remarks?: string | null
    },
  ) {
    requirePerm(actor, RECEIPT_PREFIX, 'create', '无权限执行该委外操作')
    return withTx(db, async (trx) => {
      const { item: parentItem, receipt } = await lockReceiptForItem(trx, actor, input.receiptItemId)
      return createReceiptByproductInTx(trx, actor, receipt, parentItem, input)
    })
  }

  async function createReceiptByproductInTx(
    trx: DbHandle,
    actor: Actor,
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
      await writeAudit(trx, actor, {
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
    actor: Actor,
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
    requirePerm(actor, RECEIPT_PREFIX, 'update', '无权限执行该委外操作')
    return withTx(db, async (trx) => {
      const cur = await sql<{ receipt_item_id: string }>`
        SELECT receipt_item_id FROM pur_outsourced_receipt_item_byproduct WHERE id=${id}::uuid
      `.execute(trx)
      if (!cur.rows[0]) throw new ApiError('not_found', '委外入库副产物行不存在')
      const { item: parentItem, receipt } = await lockReceiptForItem(
        trx,
        actor,
        cur.rows[0].receipt_item_id,
      )
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
        await writeAudit(trx, actor, {
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

  async function deleteReceiptByproduct(actor: Actor, id: string) {
    return deleteReceiptChild(actor, id, false)
  }

  async function deleteReceiptChild(actor: Actor, id: string, material: boolean) {
    requirePerm(actor, RECEIPT_PREFIX, 'delete', '无权限执行该委外操作')
    await withTx(db, async (trx) => {
      const table = material ? MATERIAL_TABLE : BYPRODUCT_TABLE
      const cur = await sql<{ receipt_item_id: string }>`
        SELECT receipt_item_id FROM ${sql.raw(table)} WHERE id=${id}::uuid
      `.execute(trx)
      if (!cur.rows[0]) throw new ApiError('not_found', '委外入库子行不存在')
      await lockReceiptForItem(trx, actor, cur.rows[0].receipt_item_id)
      if (material) {
        const before = mapReceiptMaterial((await loadReceiptMaterial(trx, id))!)
        await writeAudit(trx, actor, {
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
        await writeAudit(trx, actor, {
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
    actor: Actor,
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
          await createReceiptMaterialInTx(trx, actor, receipt, parent, {
            receiptItemId: parent.id,
            idx,
            qty: wireRequiredDecimal(qty),
            orderItemMaterialId: source.id,
            outsourcedWarehouseId: receipt.outsourcedWarehouseId,
          })
        } else {
          await createReceiptByproductInTx(trx, actor, receipt, parent, {
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
  const pt = lowerParty(partyType)
  if (pt !== 'supplier' && pt !== 'company') fields.partyType = ['只允许供应商或内部公司']
  if (!partyId) fields.partyId = ['必填']
  if (!companyId) fields.companyId = ['必填']
  if (pt === 'company' && partyId === companyId) fields.partyId = ['对手不能是本公司']
  if (remarks && runeLen(remarks) > 512) fields.remarks = ['最多 512 个字符']
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

async function lockIssue(db: DbHandle, actor: Actor, id: string) {
  const rows = await sql<Record<string, unknown>>`
    SELECT * FROM pur_outsourced_issue WHERE id=${id}::uuid FOR UPDATE
  `.execute(db)
  const row = rows.rows[0]
  if (!row || !canAccessCompany(actor, String(row.company_id))) {
    throw new ApiError('not_found', '委外发料单不存在')
  }
  return row
}

async function lockDraftIssue(db: DbHandle, actor: Actor, id: string) {
  const row = await lockIssue(db, actor, id)
  if (String(row.status).toLowerCase() !== 'draft') {
    throw new ApiError('conflict', '仅草稿委外发料单可编辑')
  }
  return row
}

async function lockReceipt(db: DbHandle, actor: Actor, id: string) {
  const rows = await sql<Record<string, unknown>>`
    SELECT * FROM pur_outsourced_receipt WHERE id=${id}::uuid FOR UPDATE
  `.execute(db)
  const row = rows.rows[0]
  if (!row || !canAccessCompany(actor, String(row.company_id))) {
    throw new ApiError('not_found', '委外入库单不存在')
  }
  return row
}

async function lockDraftReceipt(db: DbHandle, actor: Actor, id: string) {
  const row = await lockReceipt(db, actor, id)
  if (String(row.status).toLowerCase() !== 'draft') {
    throw new ApiError('conflict', '仅草稿委外入库单可编辑')
  }
  return row
}

async function lockReceiptForItem(db: DbHandle, actor: Actor, itemId: string) {
  const cur = await sql<{ receipt_id: string }>`
    SELECT receipt_id FROM pur_outsourced_receipt_item WHERE id=${itemId}::uuid
  `.execute(db)
  if (!cur.rows[0]) throw new ApiError('not_found', '委外入库成品行不存在')
  const receipt = mapReceipt(await lockDraftReceipt(db, actor, cur.rows[0].receipt_id))
  const item = mapReceiptItem((await loadReceiptItem(db, itemId))!)
  return { item, receipt }
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

async function accountCurrencies(db: DbHandle, debitId: string, creditId: string) {
  const rows = await sql<{ id: string; currency_id: string | null }>`
    SELECT id, currency_id FROM bas_account WHERE id = ANY(${[debitId, creditId]}::uuid[])
  `.execute(db)
  const map = new Map(rows.rows.map((r) => [r.id, r.currency_id]))
  return { debit: map.get(debitId) ?? null, credit: map.get(creditId) ?? null }
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
