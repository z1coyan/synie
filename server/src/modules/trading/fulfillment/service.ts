/**
 * 标准履约：销售发货 / 采购入库 + 装箱清单。
 * 审核单事务：库存引擎 + 订单投影 + 金额>0 时 GL 引擎（零金额跳总账）。
 */
import type { ListQuery } from '@synie/shared'
import { decimal } from '@synie/shared'
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
import { companyScopeWhere, listFromSource } from '~/db/list.ts'
import { mapWriteError } from '~/db/dberr.ts'
import {
  asDate,
  asDateTime,
  asOptionalString,
  convertToBaseQty,
  ident,
  loadMaterialSnap,
  lowerParty,
  partyExists,
  requirePerm,
  runeLen,
  syncDrawingAttachments,
  todayUTC,
  toDateOnly,
  type TradingSide,
  upperStatus,
  wireRequiredDecimal,
} from '../common.ts'
import type { OrderService } from '../order/service.ts'
import { auditFulfillmentInTx, voidFulfillmentInTx } from '../posting.ts'
import {
  fulfillmentHeadMeta,
  fulfillmentItemListMeta,
  fulfillmentItemMeta,
  fulfillmentSpec,
  packLineMeta,
  type FulfillmentSideSpec,
} from './spec.ts'

const gl = createGlEngine()
const inventory = createInventoryEngine()

const HEAD_AUDIT = [
  'number', 'document_date', 'posting_date', 'party_type', 'party_id', 'remarks',
  'status', 'audited_at', 'company_id', 'warehouse_id', 'debit_account_id',
  'credit_account_id', 'created_by_id', 'audited_by_id',
] as const

const ITEM_AUDIT = [
  'idx', 'qty', 'base_qty', 'material_code', 'material_name', 'material_spec',
  'customer_part_no', 'unit_name', 'order_no', 'order_qty', 'order_base_qty',
  'order_unit_name', 'order_price', 'order_amount', 'order_base_price',
  'order_base_amount', 'order_tax_rate', 'order_currency_code', 'reconciled_qty',
  'remarks', 'head_id', 'company_id', 'order_item_id', 'material_id', 'unit_id',
  'warehouse_id',
] as const

const PACK_AUDIT = [
  'idx', 'box_no', 'qty', 'base_qty', 'material_code', 'material_name',
  'material_spec', 'customer_part_no', 'unit_name', 'remarks',
  'delivery_id', 'company_id', 'material_id', 'unit_id',
] as const

export interface FulfillmentHead {
  id: string
  no: string
  documentDate: string
  postingDate: string | null
  partyType: string
  partyId: string
  remarks: string | null
  status: string
  auditedAt: string | null
  insertedAt: string
  updatedAt: string
  companyId: string
  warehouseId: string | null
  debitAccountId: string
  creditAccountId: string
  createdById: string | null
  auditedById: string | null
}

type Numberer = Pick<NumberingService, 'nextInTx'>

export function createFulfillmentService(
  db: Kysely<Database>,
  numberer: Numberer,
  orders: OrderService,
) {
  async function listHeads(actor: Actor, side: TradingSide, query: Partial<ListQuery>) {
    const spec = fulfillmentSpec(side)
    requirePerm(actor, spec.prefix, 'read', '无权限执行该履约操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as Record<string, unknown>[] }
    return listFromSource({
      db,
      resource: fulfillmentHeadMeta(side),
      source: sql` FROM ${ident(spec.headTable)}`,
      select: sql`SELECT *`,
      defaultOrder: sql`"${sql.raw(spec.dateCol)}" DESC, "id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: (r) => mapHeadDto(side, r),
    })
  }

  async function getHead(actor: Actor, side: TradingSide, id: string) {
    const spec = fulfillmentSpec(side)
    requirePerm(actor, spec.prefix, 'read', '无权限执行该履约操作')
    const row = await loadHead(db, spec, id)
    if (!row || !canAccessCompany(actor, String(row.company_id))) {
      throw new ApiError('not_found', `${spec.label}不存在`)
    }
    return mapHeadDto(side, row)
  }

  async function createHead(
    actor: Actor,
    side: TradingSide,
    input: {
      companyId: string
      no?: string | null
      documentDate?: string | null
      postingDate?: string | null
      partyType: string
      partyId: string
      remarks?: string | null
      warehouseId?: string | null
      debitAccountId: string
      creditAccountId: string
    },
  ) {
    const spec = fulfillmentSpec(side)
    requirePerm(actor, spec.prefix, 'create', '无权限执行该履约操作')
    if (!canAccessCompany(actor, input.companyId)) {
      throw new ApiError('forbidden', '无权在该公司创建履约单')
    }
    return withTx(db, async (trx) => {
      const documentDate = input.documentDate ? toDateOnly(input.documentDate) : todayUTC()
      let no = (input.no ?? '').trim()
      if (!no) {
        no = await numberer.nextInTx(trx, {
          resource: spec.numberResource,
          values: { company_id: input.companyId, document_date: documentDate },
        })
      }
      const partyType = lowerParty(input.partyType)
      const head: FulfillmentHead = {
        id: '',
        no,
        documentDate,
        postingDate: input.postingDate ? toDateOnly(input.postingDate) : null,
        partyType,
        partyId: input.partyId,
        remarks: input.remarks ?? null,
        status: 'DRAFT',
        auditedAt: null,
        insertedAt: '',
        updatedAt: '',
        companyId: input.companyId,
        warehouseId: input.warehouseId ?? null,
        debitAccountId: input.debitAccountId,
        creditAccountId: input.creditAccountId,
        createdById: actor.userId || null,
        auditedById: null,
      }
      validateHeadShape(spec, head)
      await validateHeadRefs(trx, spec, head)
      try {
        const ins = await sql<{ id: string }>`
          INSERT INTO ${ident(spec.headTable)} (
            ${sql.raw(spec.numberCol)}, ${sql.raw(spec.dateCol)}, posting_date, party_type, party_id,
            remarks, status, company_id, warehouse_id, debit_account_id, credit_account_id, created_by_id
          ) VALUES (
            ${no}, ${documentDate}::date, ${head.postingDate}::date, ${partyType}, ${input.partyId}::uuid,
            ${head.remarks}, 'draft', ${input.companyId}::uuid, ${head.warehouseId}::uuid,
            ${input.debitAccountId}::uuid, ${input.creditAccountId}::uuid, ${head.createdById}::uuid
          ) RETURNING id
        `.execute(trx)
        const id = ins.rows[0]!.id
        const row = await loadHead(trx, spec, id)
        const dto = mapHeadDto(side, row!)
        await writeAudit(trx, actor, {
          resource: spec.headTable,
          recordId: id,
          recordLabel: no,
          companyId: input.companyId,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(headSnap(mapHead(row!)), HEAD_AUDIT),
        })
        return dto
      } catch (err) {
        throw mapWriteError(err, `创建${spec.label}失败`, [
          { code: '23505', message: `${spec.label}单号已存在` },
        ])
      }
    })
  }

  async function updateHead(
    actor: Actor,
    side: TradingSide,
    id: string,
    input: {
      no?: string
      documentDate?: string
      postingDate?: string | null
      postingDatePresent?: boolean
      partyType?: string
      partyId?: string
      remarks?: string | null
      remarksPresent?: boolean
      warehouseId?: string | null
      warehouseIdPresent?: boolean
      debitAccountId?: string
      creditAccountId?: string
    },
  ) {
    const spec = fulfillmentSpec(side)
    requirePerm(actor, spec.prefix, 'update', '无权限执行该履约操作')
    return withTx(db, async (trx) => {
      const beforeRow = await lockDraftHead(trx, actor, spec, id)
      const before = mapHead(beforeRow)
      const after: FulfillmentHead = {
        ...before,
        no: input.no !== undefined ? input.no.trim() : before.no,
        documentDate: input.documentDate ? toDateOnly(input.documentDate) : before.documentDate,
        postingDate: input.postingDatePresent
          ? (input.postingDate ? toDateOnly(input.postingDate) : null)
          : before.postingDate,
        partyType: input.partyType ? lowerParty(input.partyType) : before.partyType,
        partyId: input.partyId ?? before.partyId,
        remarks: input.remarksPresent ? (input.remarks ?? null) : before.remarks,
        warehouseId: input.warehouseIdPresent
          ? (input.warehouseId ?? null)
          : before.warehouseId,
        debitAccountId: input.debitAccountId ?? before.debitAccountId,
        creditAccountId: input.creditAccountId ?? before.creditAccountId,
      }
      if (before.partyType !== after.partyType || before.partyId !== after.partyId) {
        const has = await sql<{ e: boolean }>`
          SELECT EXISTS(SELECT 1 FROM ${ident(spec.itemTable)} WHERE ${sql.raw(spec.parentCol)}=${id}::uuid) AS e
        `.execute(trx)
        if (has.rows[0]?.e) throw new ApiError('conflict', '已有条目时不可修改履约对手')
      }
      validateHeadShape(spec, after)
      await validateHeadRefs(trx, spec, after)
      const changes = auditDiff(headSnap(before), headSnap(after), HEAD_AUDIT)
      if (Object.keys(changes).length === 0) return mapHeadDto(side, beforeRow)
      try {
        await sql`
          UPDATE ${ident(spec.headTable)} SET
            ${sql.raw(spec.numberCol)}=${after.no},
            ${sql.raw(spec.dateCol)}=${after.documentDate}::date,
            posting_date=${after.postingDate}::date,
            party_type=${lowerParty(after.partyType)},
            party_id=${after.partyId}::uuid,
            remarks=${after.remarks},
            warehouse_id=${after.warehouseId}::uuid,
            debit_account_id=${after.debitAccountId}::uuid,
            credit_account_id=${after.creditAccountId}::uuid,
            updated_at=(now() AT TIME ZONE 'utc')
          WHERE id=${id}::uuid
        `.execute(trx)
        const row = await loadHead(trx, spec, id)
        await writeAudit(trx, actor, {
          resource: spec.headTable,
          recordId: id,
          recordLabel: after.no,
          companyId: after.companyId,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
        return mapHeadDto(side, row!)
      } catch (err) {
        throw mapWriteError(err, `更新${spec.label}失败`, [
          { code: '23505', message: `${spec.label}单号已存在` },
        ])
      }
    })
  }

  async function deleteHead(actor: Actor, side: TradingSide, id: string) {
    const spec = fulfillmentSpec(side)
    requirePerm(actor, spec.prefix, 'delete', '无权限执行该履约操作')
    await withTx(db, async (trx) => {
      const item = mapHead(await lockDraftHead(trx, actor, spec, id))
      await sql`
        DELETE FROM sys_attachment WHERE owner_type=${spec.itemOwnerType}
          AND owner_id IN (SELECT id FROM ${ident(spec.itemTable)} WHERE ${sql.raw(spec.parentCol)}=${id}::uuid)
      `.execute(trx)
      if (side === 'sales') {
        await sql`DELETE FROM sal_delivery_pack_line WHERE delivery_id=${id}::uuid`.execute(trx)
      }
      await sql`DELETE FROM ${ident(spec.headTable)} WHERE id=${id}::uuid`.execute(trx)
      await writeAudit(trx, actor, {
        resource: spec.headTable,
        recordId: id,
        recordLabel: item.no,
        companyId: item.companyId,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(headSnap(item), HEAD_AUDIT),
      })
    })
  }

  async function auditHead(actor: Actor, side: TradingSide, id: string, postingDateOverride?: string | null) {
    const spec = fulfillmentSpec(side)
    requirePerm(actor, spec.prefix, 'audit', '无权限执行该履约操作')
    return withTx(db, async (trx) => {
      await auditFulfillmentInTx(trx, actor, { inventory, gl }, {
        voucherType: spec.voucherType,
        headTable: spec.headTable,
        partySide: side === 'sales' ? 'debit' : 'credit',
        postingDateOverride,
        lockDraft: async (t) => {
          const before = mapHead(await lockHead(t, actor, spec, id))
          if (before.status !== 'DRAFT') throw new ApiError('conflict', `仅草稿${spec.label}可审核`)
          validateHeadShape(spec, before)
          await validateHeadRefs(t, spec, before)
          return before
        },
        collect: async (t, before) => {
          const items = await loadActionItems(t, spec, id)
          if (items.length === 0) throw new ApiError('conflict', '审核前必须至少填写一条履约条目')
          if (side === 'sales') await validatePackEquality(t, id, items)
          const projectionLines = items.map((i) => ({
            orderItemId: i.orderItemId,
            baseQty: i.baseQty,
          }))
          const stockLines = items.map((i) => ({
            warehouseId: i.warehouseId,
            materialId: i.materialId,
            quantity: decimal(i.baseQty).mul(spec.stockDirection),
            remarks: before.remarks,
          }))
          let amount = decimal(0)
          for (const item of items) {
            if (!decimal(item.orderBaseQty).isZero()) {
              amount = amount.add(
                decimal(item.orderBaseAmount).mul(decimal(item.baseQty)).div(decimal(item.orderBaseQty)),
              )
            }
          }
          return { projectionLines, stockLines, amount }
        },
        postProjection: (t, before, lines) =>
          orders.postFulfillment(t, side, {
            companyId: before.companyId,
            partyType: before.partyType,
            partyId: before.partyId,
            lines,
          }),
        voucherOf: (h) => h,
        reload: async (t, headId) => mapHead((await loadHead(t, spec, headId))!),
        snapshot: headSnap,
        auditFields: HEAD_AUDIT,
      })
      const row = await loadHead(trx, spec, id)
      return mapHeadDto(side, row!)
    })
  }

  async function voidHead(actor: Actor, side: TradingSide, id: string) {
    const spec = fulfillmentSpec(side)
    requirePerm(actor, spec.prefix, 'void', '无权限执行该履约操作')
    return withTx(db, async (trx) => {
      await voidFulfillmentInTx(trx, actor, { inventory, gl }, {
        voucherType: spec.voucherType,
        headTable: spec.headTable,
        lockAudited: async (t) => {
          const before = mapHead(await lockHead(t, actor, spec, id))
          if (before.status !== 'AUDITED') throw new ApiError('conflict', `仅已审核${spec.label}可作废`)
          return before
        },
        voidableLines: async (t) => {
          const items = await loadActionItems(t, spec, id)
          for (const item of items) {
            if (decimal(item.reconciledQty).gt(0)) {
              throw new ApiError('conflict', '存在已对账履约条目,不可作废')
            }
          }
          return items.map((i) => ({ orderItemId: i.orderItemId, baseQty: i.baseQty }))
        },
        reverseProjection: (t, before, lines) =>
          orders.reverseFulfillment(t, side, {
            companyId: before.companyId,
            partyType: before.partyType,
            partyId: before.partyId,
            lines,
          }),
        voucherOf: (h) => h,
        reload: async (t, headId) => mapHead((await loadHead(t, spec, headId))!),
        snapshot: headSnap,
        auditFields: HEAD_AUDIT,
      })
      const row = await loadHead(trx, spec, id)
      return mapHeadDto(side, row!)
    })
  }

  async function listItems(actor: Actor, side: TradingSide, query: Partial<ListQuery>) {
    const spec = fulfillmentSpec(side)
    requirePerm(actor, spec.prefix, 'read', '无权限执行该履约操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as Record<string, unknown>[] }
    // 列名必须与 ResourceMeta.dbColumn 一致（listFromSource / filterbuild 按 apiName→dbColumn 排序筛选）
    const statusCol = side === 'sales' ? 'delivery_status' : 'receipt_status'
    const orderTypeSql =
      side === 'sales'
        ? `(SELECT o.order_type FROM sal_order_item oi
            JOIN sal_order o ON o.id=oi.order_id WHERE oi.id=i.order_item_id) AS order_type`
        : `NULL::text AS order_type`
    return listFromSource({
      db,
      resource: fulfillmentItemListMeta(side),
      source: sql` FROM (
        SELECT i.*, h.${sql.raw(spec.numberCol)}, h.${sql.raw(spec.dateCol)},
          h.status AS ${sql.raw(statusCol)}, h.party_type, h.party_id,
          (i.base_qty - i.reconciled_qty) AS remaining_reconcilable_qty,
          ${sql.raw(orderTypeSql)}
        FROM ${ident(spec.itemTable)} i
        JOIN ${ident(spec.headTable)} h ON h.id=i.${sql.raw(spec.parentCol)}
      ) fulfillment_items`,
      select: sql`SELECT *`,
      defaultOrder: sql`"idx" ASC, "id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: (r) => mapItemDto(side, r),
    })
  }

  async function getItem(actor: Actor, side: TradingSide, id: string) {
    const spec = fulfillmentSpec(side)
    requirePerm(actor, spec.prefix, 'read', '无权限执行该履约操作')
    const row = await loadItem(db, spec, id)
    if (!row || !canAccessCompany(actor, String(row.company_id))) {
      throw new ApiError('not_found', `${spec.itemLabel}不存在`)
    }
    return mapItemDto(side, row)
  }

  async function createItem(
    actor: Actor,
    side: TradingSide,
    input: {
      headId: string
      idx: number
      qty: string
      orderItemId: string
      unitId?: string | null
      warehouseId: string
      remarks?: string | null
    },
  ) {
    const spec = fulfillmentSpec(side)
    requirePerm(actor, spec.prefix, 'create', '无权限执行该履约操作')
    return withTx(db, async (trx) => {
      const parent = mapHead(await lockDraftHead(trx, actor, spec, input.headId))
      const derived = await deriveItem(trx, spec, parent, {
        idx: input.idx,
        qty: decimal(input.qty),
        orderItemId: input.orderItemId,
        unitId: input.unitId ?? null,
        warehouseId: input.warehouseId,
        remarks: input.remarks ?? null,
      })
      const ins = await sql<{ id: string }>`
        INSERT INTO ${ident(spec.itemTable)} (
          idx,qty,base_qty,material_code,material_name,material_spec,customer_part_no,unit_name,
          order_no,order_qty,order_base_qty,order_unit_name,order_price,order_amount,
          order_base_price,order_base_amount,order_tax_rate,order_currency_code,reconciled_qty,
          remarks,${sql.raw(spec.parentCol)},company_id,order_item_id,material_id,unit_id,warehouse_id
        ) VALUES (
          ${derived.idx},${wireRequiredDecimal(derived.qty)},${wireRequiredDecimal(derived.baseQty)},
          ${derived.materialCode},${derived.materialName},${derived.materialSpec},${derived.customerPartNo},
          ${derived.unitName},${derived.orderNo},${wireRequiredDecimal(derived.orderQty)},
          ${wireRequiredDecimal(derived.orderBaseQty)},${derived.orderUnitName},
          ${wireRequiredDecimal(derived.orderPrice)},${wireRequiredDecimal(derived.orderAmount)},
          ${wireRequiredDecimal(derived.orderBasePrice)},${wireRequiredDecimal(derived.orderBaseAmount)},
          ${wireRequiredDecimal(derived.orderTaxRate)},${derived.orderCurrencyCode},0,
          ${derived.remarks},${input.headId}::uuid,${parent.companyId}::uuid,
          ${input.orderItemId}::uuid,${derived.materialId}::uuid,${derived.unitId}::uuid,${input.warehouseId}::uuid
        ) RETURNING id
      `.execute(trx)
      const id = ins.rows[0]!.id
      await syncDrawingAttachments(trx, spec.itemOwnerType, id, derived.materialId, parent.companyId)
      const row = await loadItem(trx, spec, id)
      const dto = mapItemDto(side, row!)
      await writeAudit(trx, actor, {
        resource: spec.itemTable,
        recordId: id,
        recordLabel: String(derived.idx),
        companyId: parent.companyId,
        actionType: 'create',
        actionName: 'create',
        changes: auditCreated(itemSnap(derived, input.headId, parent.companyId, input.orderItemId, input.warehouseId), ITEM_AUDIT),
      })
      return dto
    })
  }

  async function updateItem(
    actor: Actor,
    side: TradingSide,
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
    const spec = fulfillmentSpec(side)
    requirePerm(actor, spec.prefix, 'update', '无权限执行该履约操作')
    return withTx(db, async (trx) => {
      const cur = await sql<Record<string, unknown>>`
        SELECT ${sql.raw(spec.parentCol)} AS head_id FROM ${ident(spec.itemTable)} WHERE id=${id}::uuid
      `.execute(trx)
      if (!cur.rows[0]) throw new ApiError('not_found', `${spec.itemLabel}不存在`)
      const parent = mapHead(await lockDraftHead(trx, actor, spec, String(cur.rows[0].head_id)))
      const beforeRow = await loadItem(trx, spec, id)
      if (!beforeRow) throw new ApiError('not_found', `${spec.itemLabel}不存在`)
      const beforeDto = mapItemDto(side, beforeRow)
      const derived = await deriveItem(trx, spec, parent, {
        idx: input.idx ?? Number(beforeDto.idx),
        qty: decimal(input.qty ?? String(beforeDto.qty)),
        orderItemId: input.orderItemId ?? String(beforeDto.orderItemId),
        unitId: input.unitIdPresent ? (input.unitId ?? null) : String(beforeDto.unitId),
        warehouseId: input.warehouseId ?? String(beforeDto.warehouseId),
        remarks: input.remarksPresent ? (input.remarks ?? null) : (beforeDto.remarks as string | null),
      })
      await sql`
        UPDATE ${ident(spec.itemTable)} SET
          idx=${derived.idx}, qty=${wireRequiredDecimal(derived.qty)}, base_qty=${wireRequiredDecimal(derived.baseQty)},
          material_code=${derived.materialCode}, material_name=${derived.materialName},
          material_spec=${derived.materialSpec}, customer_part_no=${derived.customerPartNo},
          unit_name=${derived.unitName}, order_no=${derived.orderNo},
          order_qty=${wireRequiredDecimal(derived.orderQty)}, order_base_qty=${wireRequiredDecimal(derived.orderBaseQty)},
          order_unit_name=${derived.orderUnitName}, order_price=${wireRequiredDecimal(derived.orderPrice)},
          order_amount=${wireRequiredDecimal(derived.orderAmount)},
          order_base_price=${wireRequiredDecimal(derived.orderBasePrice)},
          order_base_amount=${wireRequiredDecimal(derived.orderBaseAmount)},
          order_tax_rate=${wireRequiredDecimal(derived.orderTaxRate)},
          order_currency_code=${derived.orderCurrencyCode}, remarks=${derived.remarks},
          order_item_id=${derived.orderItemId}::uuid, material_id=${derived.materialId}::uuid,
          unit_id=${derived.unitId}::uuid, warehouse_id=${derived.warehouseId}::uuid,
          updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${id}::uuid
      `.execute(trx)
      await syncDrawingAttachments(trx, spec.itemOwnerType, id, derived.materialId, parent.companyId)
      const row = await loadItem(trx, spec, id)
      return mapItemDto(side, row!)
    })
  }

  async function deleteItem(actor: Actor, side: TradingSide, id: string) {
    const spec = fulfillmentSpec(side)
    requirePerm(actor, spec.prefix, 'delete', '无权限执行该履约操作')
    await withTx(db, async (trx) => {
      const cur = await sql<Record<string, unknown>>`
        SELECT ${sql.raw(spec.parentCol)} AS head_id, company_id, idx
        FROM ${ident(spec.itemTable)} WHERE id=${id}::uuid
      `.execute(trx)
      if (!cur.rows[0]) throw new ApiError('not_found', `${spec.itemLabel}不存在`)
      await lockDraftHead(trx, actor, spec, String(cur.rows[0].head_id))
      await sql`
        DELETE FROM sys_attachment WHERE owner_type=${spec.itemOwnerType} AND owner_id=${id}::uuid
      `.execute(trx)
      await sql`DELETE FROM ${ident(spec.itemTable)} WHERE id=${id}::uuid`.execute(trx)
    })
  }

  // ---- pack lines (sales only) ----
  async function listPackLines(actor: Actor, query: Partial<ListQuery>) {
    requirePerm(actor, 'sales.delivery', 'read', '无权限执行该履约操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as Record<string, unknown>[] }
    return listFromSource({
      db,
      resource: packLineMeta(),
      source: sql` FROM sal_delivery_pack_line`,
      select: sql`SELECT *`,
      defaultOrder: sql`"idx" ASC, "id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: (r) => mapPackDto(r),
    })
  }

  async function getPackLine(actor: Actor, id: string) {
    requirePerm(actor, 'sales.delivery', 'read', '无权限执行该履约操作')
    const rows = await sql<Record<string, unknown>>`
      SELECT * FROM sal_delivery_pack_line WHERE id=${id}::uuid
    `.execute(db)
    if (!rows.rows[0] || !canAccessCompany(actor, String(rows.rows[0].company_id))) {
      throw new ApiError('not_found', '装箱行不存在')
    }
    return mapPackDto(rows.rows[0])
  }

  async function createPackLine(
    actor: Actor,
    input: {
      deliveryId: string
      idx: number
      boxNo: string
      qty: string
      materialId: string
      unitId?: string | null
      remarks?: string | null
    },
  ) {
    requirePerm(actor, 'sales.delivery', 'create', '无权限执行该履约操作')
    return withTx(db, async (trx) => {
      const parent = mapHead(await lockDraftHead(trx, actor, fulfillmentSpec('sales'), input.deliveryId))
      // material must appear on delivery items
      const onDoc = await sql<{ e: boolean }>`
        SELECT EXISTS(
          SELECT 1 FROM sal_delivery_item WHERE delivery_id=${input.deliveryId}::uuid AND material_id=${input.materialId}::uuid
        ) AS e
      `.execute(trx)
      if (!onDoc.rows[0]?.e) {
        throw ApiError.validation('装箱行参数不合法', { materialId: ['须为本单发货条目中的物料'] })
      }
      const unitId = input.unitId ?? null
      let resolvedUnit = unitId
      if (!resolvedUnit) {
        const m = await trx.selectFrom('inv_material').select('default_unit_id').where('id', '=', input.materialId).executeTakeFirst()
        if (!m) throw ApiError.validation('装箱行参数不合法', { materialId: ['物料不存在'] })
        resolvedUnit = m.default_unit_id
      }
      const snap = await loadMaterialSnap(trx, input.materialId, resolvedUnit)
      const qty = decimal(input.qty)
      if (!qty.isPositive()) throw ApiError.validation('装箱行参数不合法', { qty: ['必须大于 0'] })
      if (!input.boxNo.trim()) throw ApiError.validation('装箱行参数不合法', { boxNo: ['必填'] })
      const baseQty = convertToBaseQty(qty, resolvedUnit, snap)
      const ins = await sql<{ id: string }>`
        INSERT INTO sal_delivery_pack_line (
          idx,box_no,qty,base_qty,material_code,material_name,material_spec,customer_part_no,unit_name,
          remarks,delivery_id,company_id,material_id,unit_id
        ) VALUES (
          ${input.idx},${input.boxNo.trim()},${wireRequiredDecimal(qty)},${wireRequiredDecimal(baseQty)},
          ${snap.code},${snap.name},${snap.spec},${snap.customerPartNo},${snap.unitName},
          ${input.remarks ?? null},${input.deliveryId}::uuid,${parent.companyId}::uuid,
          ${input.materialId}::uuid,${resolvedUnit}::uuid
        ) RETURNING id
      `.execute(trx)
      return getPackLine(actor, ins.rows[0]!.id)
    })
  }

  async function updatePackLine(
    actor: Actor,
    id: string,
    input: {
      idx?: number
      boxNo?: string
      qty?: string
      materialId?: string
      unitId?: string | null
      unitIdPresent?: boolean
      remarks?: string | null
      remarksPresent?: boolean
    },
  ) {
    requirePerm(actor, 'sales.delivery', 'update', '无权限执行该履约操作')
    return withTx(db, async (trx) => {
      const cur = await sql<{ delivery_id: string }>`
        SELECT delivery_id FROM sal_delivery_pack_line WHERE id=${id}::uuid
      `.execute(trx)
      if (!cur.rows[0]) throw new ApiError('not_found', '装箱行不存在')
      await lockDraftHead(trx, actor, fulfillmentSpec('sales'), cur.rows[0].delivery_id)
      const before = await getPackLine(actor, id)
      const materialId = input.materialId ?? before.materialId
      let unitId = input.unitIdPresent ? (input.unitId ?? null) : before.unitId
      if (!unitId) {
        const m = await trx.selectFrom('inv_material').select('default_unit_id').where('id', '=', materialId).executeTakeFirst()
        unitId = m!.default_unit_id
      }
      const snap = await loadMaterialSnap(trx, materialId, unitId)
      const qty = decimal(input.qty ?? before.qty)
      const baseQty = convertToBaseQty(qty, unitId, snap)
      await sql`
        UPDATE sal_delivery_pack_line SET
          idx=${input.idx ?? before.idx},
          box_no=${input.boxNo !== undefined ? input.boxNo.trim() : before.boxNo},
          qty=${wireRequiredDecimal(qty)}, base_qty=${wireRequiredDecimal(baseQty)},
          material_code=${snap.code}, material_name=${snap.name}, material_spec=${snap.spec},
          customer_part_no=${snap.customerPartNo}, unit_name=${snap.unitName},
          remarks=${input.remarksPresent ? (input.remarks ?? null) : before.remarks},
          material_id=${materialId}::uuid, unit_id=${unitId}::uuid,
          updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${id}::uuid
      `.execute(trx)
      return getPackLine(actor, id)
    })
  }

  async function deletePackLine(actor: Actor, id: string) {
    requirePerm(actor, 'sales.delivery', 'delete', '无权限执行该履约操作')
    await withTx(db, async (trx) => {
      const cur = await sql<{ delivery_id: string }>`
        SELECT delivery_id FROM sal_delivery_pack_line WHERE id=${id}::uuid
      `.execute(trx)
      if (!cur.rows[0]) throw new ApiError('not_found', '装箱行不存在')
      await lockDraftHead(trx, actor, fulfillmentSpec('sales'), cur.rows[0].delivery_id)
      await sql`DELETE FROM sal_delivery_pack_line WHERE id=${id}::uuid`.execute(trx)
    })
  }

  return {
    listHeads, getHead, createHead, updateHead, deleteHead, auditHead, voidHead,
    listItems, getItem, createItem, updateItem, deleteItem,
    listPackLines, getPackLine, createPackLine, updatePackLine, deletePackLine,
  }
}

export type FulfillmentService = ReturnType<typeof createFulfillmentService>

// ---- helpers ----

function validateHeadShape(spec: FulfillmentSideSpec, item: FulfillmentHead) {
  const fields: Record<string, string[]> = {}
  if (!item.no.trim() || runeLen(item.no) > 32) fields.number = ['不能为空且最多 32 个字符']
  if (!item.documentDate) fields.documentDate = ['必填']
  if (!spec.allowedParty.has(lowerParty(item.partyType))) fields.partyType = ['对手类型不合法']
  if (!item.partyId) fields.partyId = ['必填']
  if (!item.companyId) fields.companyId = ['必填']
  if (lowerParty(item.partyType) === 'company' && item.partyId === item.companyId) {
    fields.partyId = ['对手不能是本公司']
  }
  if (!item.debitAccountId) fields.debitAccountId = ['必填']
  if (!item.creditAccountId) fields.creditAccountId = ['必填']
  if (item.remarks && runeLen(item.remarks) > 512) fields.remarks = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation(`${spec.label}参数不合法`, fields)
  }
}

async function validateHeadRefs(db: DbHandle, spec: FulfillmentSideSpec, item: FulfillmentHead) {
  if (!(await partyExists(db, item.partyType, item.partyId))) {
    throw ApiError.validation(`${spec.label}参数不合法`, { partyId: ['对手不存在'] })
  }
  if (item.warehouseId) await validateWarehouse(db, item.companyId, item.warehouseId)
  for (const [field, accountId] of [
    ['debitAccountId', item.debitAccountId],
    ['creditAccountId', item.creditAccountId],
  ] as const) {
    const acc = await db
      .selectFrom('bas_account')
      .select(['company_id', 'is_group', 'active', 'role'])
      .where('id', '=', accountId)
      .executeTakeFirst()
    if (!acc || acc.company_id !== item.companyId || acc.is_group || !acc.active) {
      throw ApiError.validation(`${spec.label}参数不合法`, {
        [field]: ['科目须属于单据公司、启用且非汇总'],
      })
    }
    if (
      field === `${spec.requiredRoleSide}AccountId` &&
      (!acc.role || acc.role.toLowerCase() !== spec.requiredRole)
    ) {
      throw ApiError.validation(`${spec.label}参数不合法`, {
        [field]: ['科目角色不符合履约要求'],
      })
    }
  }
}

async function validateWarehouse(db: DbHandle, companyId: string, warehouseId: string) {
  const wh = await db
    .selectFrom('inv_warehouse')
    .select(['company_id', 'active', 'is_leaf'])
    .where('id', '=', warehouseId)
    .executeTakeFirst()
  if (!wh || wh.company_id !== companyId || !wh.active || !wh.is_leaf) {
    throw ApiError.validation('履约仓库不合法', { warehouseId: ['须为单据公司启用叶子仓'] })
  }
}

async function lockHead(db: DbHandle, actor: Actor, spec: FulfillmentSideSpec, id: string) {
  const rows = await sql<Record<string, unknown>>`
    SELECT * FROM ${ident(spec.headTable)} WHERE id=${id}::uuid FOR UPDATE
  `.execute(db)
  const row = rows.rows[0]
  if (!row || !canAccessCompany(actor, String(row.company_id))) {
    throw new ApiError('not_found', `${spec.label}不存在`)
  }
  return row
}

async function lockDraftHead(db: DbHandle, actor: Actor, spec: FulfillmentSideSpec, id: string) {
  const row = await lockHead(db, actor, spec, id)
  if (String(row.status).toLowerCase() !== 'draft') {
    throw new ApiError('conflict', `仅草稿${spec.label}可编辑`)
  }
  return row
}

async function loadHead(db: DbHandle, spec: FulfillmentSideSpec, id: string) {
  const rows = await sql<Record<string, unknown>>`
    SELECT * FROM ${ident(spec.headTable)} WHERE id=${id}::uuid
  `.execute(db)
  return rows.rows[0]
}

async function loadItem(db: DbHandle, spec: FulfillmentSideSpec, id: string) {
  const statusCol = spec.side === 'sales' ? 'delivery_status' : 'receipt_status'
  const rows = await sql<Record<string, unknown>>`
    SELECT i.*, h.${sql.raw(spec.numberCol)}, h.${sql.raw(spec.dateCol)},
      h.status AS ${sql.raw(statusCol)}, h.party_type, h.party_id,
      (i.base_qty - i.reconciled_qty) AS remaining_reconcilable_qty
    FROM ${ident(spec.itemTable)} i
    JOIN ${ident(spec.headTable)} h ON h.id=i.${sql.raw(spec.parentCol)}
    WHERE i.id=${id}::uuid
  `.execute(db)
  return rows.rows[0]
}

interface ActionItem {
  id: string
  orderItemId: string
  baseQty: string
  materialId: string
  warehouseId: string
  materialCode: string
  materialName: string
  orderBaseQty: string
  orderBaseAmount: string
  reconciledQty: string
}

async function loadActionItems(db: DbHandle, spec: FulfillmentSideSpec, headId: string): Promise<ActionItem[]> {
  const rows = await sql<Record<string, unknown>>`
    SELECT id, order_item_id, base_qty, material_id, warehouse_id, material_code, material_name,
      order_base_qty, order_base_amount, reconciled_qty
    FROM ${ident(spec.itemTable)}
    WHERE ${sql.raw(spec.parentCol)}=${headId}::uuid
    ORDER BY idx, id
    FOR UPDATE
  `.execute(db)
  return rows.rows.map((r) => ({
    id: String(r.id),
    orderItemId: String(r.order_item_id),
    baseQty: String(r.base_qty),
    materialId: String(r.material_id),
    warehouseId: String(r.warehouse_id),
    materialCode: String(r.material_code),
    materialName: String(r.material_name),
    orderBaseQty: String(r.order_base_qty),
    orderBaseAmount: String(r.order_base_amount),
    reconciledQty: String(r.reconciled_qty ?? 0),
  }))
}

async function deriveItem(
  db: DbHandle,
  spec: FulfillmentSideSpec,
  parent: FulfillmentHead,
  draft: {
    idx: number
    qty: ReturnType<typeof decimal>
    orderItemId: string
    unitId: string | null
    warehouseId: string
    remarks: string | null
  },
) {
  if (!draft.qty.isPositive()) {
    throw ApiError.validation(`${spec.itemLabel}参数不合法`, { qty: ['必须大于 0'] })
  }
  if (draft.remarks && runeLen(draft.remarks) > 512) {
    throw ApiError.validation(`${spec.itemLabel}参数不合法`, { remarks: ['最多 512 个字符'] })
  }
  await validateWarehouse(db, parent.companyId, draft.warehouseId)
  const oi = await sql<Record<string, unknown>>`
    SELECT oi.*, o.order_no, o.status, o.company_id, o.party_type, o.party_id, o.currency_id,
      cur.iso_code AS currency_code
    FROM ${ident(spec.orderItemTable)} oi
    JOIN ${ident(spec.orderTable)} o ON o.id=oi.order_id
    JOIN bas_currency cur ON cur.id=o.currency_id
    WHERE oi.id=${draft.orderItemId}::uuid
    FOR UPDATE OF o, oi
  `.execute(db)
  const orderItem = oi.rows[0]
  if (!orderItem) {
    throw ApiError.validation(`${spec.itemLabel}参数不合法`, { orderItemId: ['订单条目不存在'] })
  }
  if (String(orderItem.status).toLowerCase() !== 'audited') {
    throw ApiError.validation(`${spec.itemLabel}参数不合法`, { orderItemId: ['订单须已审核'] })
  }
  if (String(orderItem.company_id) !== parent.companyId) {
    throw ApiError.validation(`${spec.itemLabel}参数不合法`, { orderItemId: ['订单公司不一致'] })
  }
  if (
    String(orderItem.party_type) !== lowerParty(parent.partyType) ||
    String(orderItem.party_id) !== parent.partyId
  ) {
    throw ApiError.validation(`${spec.itemLabel}参数不合法`, { orderItemId: ['订单对手不一致'] })
  }
  const unitId = draft.unitId ?? String(orderItem.unit_id)
  const snap = await loadMaterialSnap(db, String(orderItem.material_id), unitId)
  const baseQty = convertToBaseQty(draft.qty, unitId, snap)
  return {
    idx: draft.idx,
    qty: draft.qty,
    baseQty,
    materialId: String(orderItem.material_id),
    unitId,
    warehouseId: draft.warehouseId,
    materialCode: String(orderItem.material_code),
    materialName: String(orderItem.material_name),
    materialSpec: asOptionalString(orderItem.material_spec),
    customerPartNo: asOptionalString(orderItem.customer_part_no),
    unitName: snap.unitName,
    orderNo: String(orderItem.order_no),
    orderQty: String(orderItem.qty),
    orderBaseQty: String(orderItem.base_qty),
    orderUnitName: String(orderItem.unit_name),
    orderPrice: String(orderItem.price),
    orderAmount: String(orderItem.amount),
    orderBasePrice: String(orderItem.base_price),
    orderBaseAmount: String(orderItem.base_amount),
    orderTaxRate: String(orderItem.tax_rate),
    orderCurrencyCode: String(orderItem.currency_code),
    remarks: draft.remarks,
    orderItemId: draft.orderItemId,
  }
}

async function validatePackEquality(db: DbHandle, headId: string, items: ActionItem[]) {
  const rows = await sql<{ material_id: string; code: string; name: string; qty: string }>`
    SELECT material_id, min(material_code) AS code, min(material_name) AS name, sum(base_qty)::text AS qty
    FROM sal_delivery_pack_line WHERE delivery_id=${headId}::uuid
    GROUP BY material_id
  `.execute(db)
  if (rows.rows.length === 0) return
  const packed = new Map(rows.rows.map((r) => [r.material_id, { label: `${r.code} ${r.name}`, qty: decimal(r.qty) }]))
  const shipped = new Map<string, { label: string; qty: ReturnType<typeof decimal> }>()
  for (const item of items) {
    const cur = shipped.get(item.materialId) ?? { label: `${item.materialCode} ${item.materialName}`, qty: decimal(0) }
    cur.qty = cur.qty.add(item.baseQty)
    shipped.set(item.materialId, cur)
  }
  const mismatches: string[] = []
  for (const [mid, pack] of packed) {
    const ship = shipped.get(mid)
    if (!ship) {
      mismatches.push(`${pack.label}: 装箱有而发货无 (装箱 ${pack.qty})`)
    } else if (!pack.qty.equals(ship.qty)) {
      mismatches.push(`${ship.label}: 发货 ${ship.qty} ≠ 装箱 ${pack.qty}`)
    }
  }
  for (const [mid, ship] of shipped) {
    if (!packed.has(mid)) {
      mismatches.push(`${ship.label}: 发货有而装箱无 (发货 ${ship.qty})`)
    }
  }
  if (mismatches.length > 0) {
    throw new ApiError('conflict', `装箱清单与发货量不一致: ${mismatches.join('; ')}`)
  }
}

function mapHead(row: Record<string, unknown>): FulfillmentHead {
  const numberCol = 'delivery_no' in row || row.delivery_no !== undefined ? 'delivery_no' : 'receipt_no'
  const dateCol = numberCol === 'delivery_no' ? 'delivery_date' : 'receipt_date'
  // support both
  const no = String(row.delivery_no ?? row.receipt_no ?? row.number ?? '')
  const documentDate = asDate(row.delivery_date ?? row.receipt_date ?? row.document_date)
  return {
    id: String(row.id),
    no,
    documentDate,
    postingDate: row.posting_date ? asDate(row.posting_date) : null,
    partyType: String(row.party_type),
    partyId: String(row.party_id),
    remarks: asOptionalString(row.remarks),
    status: upperStatus(String(row.status)),
    auditedAt: asDateTime(row.audited_at),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    companyId: String(row.company_id),
    warehouseId: row.warehouse_id ? String(row.warehouse_id) : null,
    debitAccountId: String(row.debit_account_id),
    creditAccountId: String(row.credit_account_id),
    createdById: row.created_by_id ? String(row.created_by_id) : null,
    auditedById: row.audited_by_id ? String(row.audited_by_id) : null,
  }
}

function mapHeadDto(side: TradingSide, row: Record<string, unknown>) {
  const h = mapHead(row)
  const numberKey = side === 'sales' ? 'deliveryNo' : 'receiptNo'
  const dateKey = side === 'sales' ? 'deliveryDate' : 'receiptDate'
  return {
    id: h.id,
    [numberKey]: h.no,
    [dateKey]: h.documentDate,
    postingDate: h.postingDate,
    partyType: upperStatus(h.partyType),
    partyId: h.partyId,
    remarks: h.remarks,
    status: h.status,
    auditedAt: h.auditedAt,
    insertedAt: h.insertedAt,
    updatedAt: h.updatedAt,
    companyId: h.companyId,
    warehouseId: h.warehouseId,
    debitAccountId: h.debitAccountId,
    creditAccountId: h.creditAccountId,
    createdById: h.createdById,
    auditedById: h.auditedById,
  }
}

function mapItemDto(side: TradingSide, row: Record<string, unknown>) {
  const parentIdKey = side === 'sales' ? 'deliveryId' : 'receiptId'
  const parentNoKey = side === 'sales' ? 'deliveryNo' : 'receiptNo'
  const parentDateKey = side === 'sales' ? 'deliveryDate' : 'receiptDate'
  const parentStatusKey = side === 'sales' ? 'deliveryStatus' : 'receiptStatus'
  const baseQty = String(row.base_qty)
  const reconciled = String(row.reconciled_qty ?? 0)
  return {
    id: String(row.id),
    idx: Number(row.idx),
    qty: wireRequiredDecimal(String(row.qty)),
    baseQty: wireRequiredDecimal(baseQty),
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
    reconciledQty: wireRequiredDecimal(reconciled),
    remarks: asOptionalString(row.remarks),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    [parentIdKey]: String(row[side === 'sales' ? 'delivery_id' : 'receipt_id'] ?? row.head_id),
    companyId: String(row.company_id),
    orderItemId: String(row.order_item_id),
    materialId: String(row.material_id),
    unitId: String(row.unit_id),
    warehouseId: String(row.warehouse_id),
    [parentNoKey]: String(row[side === 'sales' ? 'delivery_no' : 'receipt_no'] ?? ''),
    [parentDateKey]: asDate(row[side === 'sales' ? 'delivery_date' : 'receipt_date']),
    [parentStatusKey]: upperStatus(
      String(row[side === 'sales' ? 'delivery_status' : 'receipt_status'] ?? 'DRAFT'),
    ),
    partyType: upperStatus(String(row.party_type)),
    partyId: String(row.party_id),
    remainingReconcilableQty: wireRequiredDecimal(
      String(row.remaining_reconcilable_qty ?? decimal(baseQty).sub(reconciled)),
    ),
  }
}

function mapPackDto(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    idx: Number(row.idx),
    boxNo: String(row.box_no),
    qty: wireRequiredDecimal(String(row.qty)),
    baseQty: wireRequiredDecimal(String(row.base_qty)),
    materialCode: String(row.material_code),
    materialName: String(row.material_name),
    materialSpec: asOptionalString(row.material_spec),
    customerPartNo: asOptionalString(row.customer_part_no),
    unitName: String(row.unit_name),
    remarks: asOptionalString(row.remarks),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    deliveryId: String(row.delivery_id),
    companyId: String(row.company_id),
    materialId: String(row.material_id),
    unitId: String(row.unit_id),
  }
}

function headSnap(item: FulfillmentHead): Record<string, unknown> {
  return {
    number: item.no,
    document_date: item.documentDate,
    posting_date: item.postingDate,
    party_type: item.partyType,
    party_id: item.partyId,
    remarks: item.remarks,
    status: item.status,
    audited_at: item.auditedAt,
    company_id: item.companyId,
    warehouse_id: item.warehouseId,
    debit_account_id: item.debitAccountId,
    credit_account_id: item.creditAccountId,
    created_by_id: item.createdById,
    audited_by_id: item.auditedById,
  }
}

function itemSnap(
  d: {
    idx: number
    qty: ReturnType<typeof decimal>
    baseQty: ReturnType<typeof decimal>
    materialCode: string
    materialName: string
    materialSpec: string | null
    customerPartNo: string | null
    unitName: string
    orderNo: string
    orderQty: string
    orderBaseQty: string
    orderUnitName: string
    orderPrice: string
    orderAmount: string
    orderBasePrice: string
    orderBaseAmount: string
    orderTaxRate: string
    orderCurrencyCode: string
    remarks: string | null
    materialId: string
    unitId: string
  },
  headId: string,
  companyId: string,
  orderItemId: string,
  warehouseId: string,
): Record<string, unknown> {
  return {
    idx: d.idx,
    qty: wireRequiredDecimal(d.qty),
    base_qty: wireRequiredDecimal(d.baseQty),
    material_code: d.materialCode,
    material_name: d.materialName,
    material_spec: d.materialSpec,
    customer_part_no: d.customerPartNo,
    unit_name: d.unitName,
    order_no: d.orderNo,
    order_qty: d.orderQty,
    order_base_qty: d.orderBaseQty,
    order_unit_name: d.orderUnitName,
    order_price: d.orderPrice,
    order_amount: d.orderAmount,
    order_base_price: d.orderBasePrice,
    order_base_amount: d.orderBaseAmount,
    order_tax_rate: d.orderTaxRate,
    order_currency_code: d.orderCurrencyCode,
    reconciled_qty: '0',
    remarks: d.remarks,
    head_id: headId,
    company_id: companyId,
    order_item_id: orderItemId,
    material_id: d.materialId,
    unit_id: d.unitId,
    warehouse_id: warehouseId,
  }
}
