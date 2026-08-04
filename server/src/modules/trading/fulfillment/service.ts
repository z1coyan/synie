/**
 * 标准履约：销售发货 / 采购入库 + 装箱清单。
 * 审核单事务：库存引擎 + 订单投影 + 金额>0 时 GL 引擎（零金额跳总账）。
 */
import type { ListQuery } from '@synie/shared'
import { decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withReadSnapshot, withTx, type DbHandle, type TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { GlEngine } from '~/engines/gl/index.ts'
import type { InventoryEngine } from '~/engines/inventory/index.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import { auditFieldsOf, mergeAuditFields } from '~/platform/audit/spec.ts'
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
  guardMaterialType,
  ident,
  loadMaterialSnap,
  lowerParty,
  partyExists,
  requirePerm,
  runeLen,
  syncDrawingAttachments,
  toDateOnly,
  type TradingSide,
  upperStatus,
  wireRequiredDecimal,
} from '../common.ts'
import { utcToday } from '~/db/dates.ts'
import {
  postFulfillment,
  reverseFulfillment,
} from '../order/projection.ts'
import { auditFulfillmentInTx, voidFulfillmentInTx } from '~/platform/posting/skeleton.ts'
import {
  fulfillmentHeadMeta,
  fulfillmentItemListMeta,
  fulfillmentItemMeta,
  fulfillmentSpec,
  packBoxMeta,
  packLineMeta,
  type FulfillmentSideSpec,
} from './spec.ts'

// 双侧共用引擎：白名单取两侧 meta 派生并集；单号/日期列经 spec 映射为通用审计键
const HEAD_AUDIT = mergeAuditFields(
  ...(['sales', 'purchase'] as const).map((s) => {
    const spec = fulfillmentSpec(s)
    return auditFieldsOf(fulfillmentHeadMeta(s), {
      rename: { [spec.numberCol]: 'number', [spec.dateCol]: 'document_date' },
    })
  }),
)

const ITEM_AUDIT = mergeAuditFields(
  ...(['sales', 'purchase'] as const).map((s) =>
    auditFieldsOf(fulfillmentItemMeta(s), {
      rename: { [fulfillmentSpec(s).parentCol]: 'head_id' },
    }),
  ),
)

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

export interface FulfillmentHeadDraftInput {
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
}

export interface FulfillmentHeadUpdateInput {
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
}

export interface SalesDraftItemInput {
  id?: string
  idx: number
  qty: string
  orderItemId: string
  unitId?: string | null
  /** 非库存类（VIRTUAL/ASSET）行可空；STOCK 行保存时强制必填 */
  warehouseId: string | null
  remarks?: string | null
}

export interface FulfillmentItemUpdateInput {
  idx?: number
  qty?: string
  orderItemId?: string
  unitId?: string | null
  unitIdPresent?: boolean
  warehouseId?: string | null
  warehouseIdPresent?: boolean
  remarks?: string | null
  remarksPresent?: boolean
}

export interface SalesDraftPackLineInput {
  id?: string
  idx: number
  qty: string
  materialId: string
  unitId?: string | null
  remarks?: string | null
}

export interface SalesDraftPackLineUpdateInput {
  idx?: number
  packBoxId?: string
  qty?: string
  materialId?: string
  unitId?: string | null
  unitIdPresent?: boolean
  remarks?: string | null
  remarksPresent?: boolean
}

export interface SalesDraftPackBoxInput {
  id?: string
  lines: SalesDraftPackLineInput[]
}

export interface SalesDraftInput extends FulfillmentHeadDraftInput {
  items: SalesDraftItemInput[]
  packBoxes: SalesDraftPackBoxInput[]
}

/** 采购入库聚合草稿：表头与全部入库条目作为一个事务写入。 */
export interface PurchaseReceiptDraftInput extends FulfillmentHeadDraftInput {
  items: SalesDraftItemInput[]
}

export interface SalesDraftDto {
  id: string
  deliveryNo: string
  deliveryDate: string
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
  items: ReturnType<typeof mapItemDto>[]
  packBoxes: Array<ReturnType<typeof mapPackBoxDto> & {
    lines: ReturnType<typeof mapPackDto>[]
  }>
}

export interface PurchaseReceiptDraftDto {
  id: string
  receiptNo: string
  receiptDate: string
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
  items: ReturnType<typeof mapItemDto>[]
}

type Numberer = Pick<NumberingService, 'nextInTx'>

export function createFulfillmentService(
  db: Kysely<Database>,
  numberer: Numberer,
  engines: {
    inventory: Pick<InventoryEngine, 'post' | 'cancel'>
    gl: Pick<GlEngine, 'post' | 'cancel'>
  },
) {
  const { inventory, gl } = engines
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
    input: FulfillmentHeadDraftInput,
  ) {
    const spec = fulfillmentSpec(side)
    requirePerm(actor, spec.prefix, 'create', '无权限执行该履约操作')
    if (!canAccessCompany(actor, input.companyId)) {
      throw new ApiError('forbidden', '无权在该公司创建履约单')
    }
    return withTx(db, (trx) => createHeadInTx(trx, actor, side, input))
  }

  async function createHeadInTx(
    trx: TrxHandle,
    actor: Actor,
    side: TradingSide,
    input: FulfillmentHeadDraftInput,
  ) {
    const spec = fulfillmentSpec(side)
    const documentDate = input.documentDate ? toDateOnly(input.documentDate) : utcToday()
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
  }

  async function updateHead(
    actor: Actor,
    side: TradingSide,
    id: string,
    input: FulfillmentHeadUpdateInput,
  ) {
    const spec = fulfillmentSpec(side)
    requirePerm(actor, spec.prefix, 'update', '无权限执行该履约操作')
    return withTx(db, (trx) => updateHeadInTx(trx, actor, side, id, input))
  }

  async function updateHeadInTx(
    trx: TrxHandle,
    actor: Actor,
    side: TradingSide,
    id: string,
    input: FulfillmentHeadUpdateInput,
  ) {
    const spec = fulfillmentSpec(side)
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
      if (has.rows[0]?.e) {
        if (side === 'sales') {
          const fields: Record<string, string[]> = {}
          if (before.partyType !== after.partyType) fields.partyType = ['已有条目时不可修改']
          if (before.partyId !== after.partyId) fields.partyId = ['已有条目时不可修改']
          throw ApiError.validation('已有条目时不可修改履约对手', fields)
        }
        throw new ApiError('conflict', '已有条目时不可修改履约对手')
      }
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
          // 库存分录只对审核时点仍为库存类的物料落账；非库存类行投影/金额链照常。
          // 物料类型在有库存分录后不可改，故这里只会拦到「从未入库、草稿后被改类型」的行。
          const stockLines = items
            .filter((i) => i.materialType === 'STOCK')
            .map((i) => {
              if (!i.warehouseId) {
                throw new ApiError(
                  'conflict',
                  `物料 ${i.materialCode} ${i.materialName} 已转为库存类,行仓必填后才可审核`,
                )
              }
              return {
                warehouseId: i.warehouseId,
                materialId: i.materialId,
                quantity: decimal(i.baseQty),
                direction: (spec.stockDirection < 0 ? 'out' : 'in') as 'in' | 'out',
                remarks: before.remarks,
              }
            })
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
          postFulfillment(t, side, {
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
          reverseFulfillment(t, side, {
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
    input: SalesDraftItemInput & { headId: string },
  ) {
    const spec = fulfillmentSpec(side)
    requirePerm(actor, spec.prefix, 'create', '无权限执行该履约操作')
    return withTx(db, (trx) => createItemInTx(trx, actor, side, input))
  }

  async function createItemInTx(
    trx: TrxHandle,
    actor: Actor,
    side: TradingSide,
    input: SalesDraftItemInput & { headId: string },
  ) {
    const spec = fulfillmentSpec(side)
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
      changes: auditCreated(
        itemSnap(derived, input.headId, parent.companyId, input.orderItemId, input.warehouseId),
        ITEM_AUDIT,
      ),
    })
    return dto
  }

  async function updateItem(
    actor: Actor,
    side: TradingSide,
    id: string,
    input: FulfillmentItemUpdateInput,
  ) {
    const spec = fulfillmentSpec(side)
    requirePerm(actor, spec.prefix, 'update', '无权限执行该履约操作')
    return withTx(db, (trx) => updateItemInTx(trx, actor, side, id, input))
  }

  async function updateItemInTx(
    trx: TrxHandle,
    actor: Actor,
    side: TradingSide,
    id: string,
    input: FulfillmentItemUpdateInput,
  ) {
    const spec = fulfillmentSpec(side)
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
      warehouseId: input.warehouseIdPresent
        ? (input.warehouseId ?? null)
        : (beforeDto.warehouseId as string | null),
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

  // ---- pack boxes (sales only) ----
  async function listPackBoxes(actor: Actor, query: Partial<ListQuery>) {
    requirePerm(actor, 'sales.delivery', 'read', '无权限执行该履约操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as Record<string, unknown>[] }
    return listFromSource({
      db,
      resource: packBoxMeta(),
      source: sql` FROM sal_delivery_pack_box`,
      select: sql`SELECT *`,
      defaultOrder: sql`"box_no" ASC, "id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: (r) => mapPackBoxDto(r),
    })
  }

  async function readPackBox(handle: DbHandle, actor: Actor, id: string) {
    const rows = await sql<Record<string, unknown>>`
      SELECT * FROM sal_delivery_pack_box WHERE id=${id}::uuid
    `.execute(handle)
    if (!rows.rows[0] || !canAccessCompany(actor, String(rows.rows[0].company_id))) {
      throw new ApiError('not_found', '装箱箱不存在')
    }
    return mapPackBoxDto(rows.rows[0])
  }

  async function getPackBox(actor: Actor, id: string) {
    requirePerm(actor, 'sales.delivery', 'read', '无权限执行该履约操作')
    return readPackBox(db, actor, id)
  }

  async function createPackBoxInTx(
    trx: TrxHandle,
    actor: Actor,
    deliveryId: string,
  ) {
    const parent = mapHead(await lockDraftHead(trx, actor, fulfillmentSpec('sales'), deliveryId))
    // 头行已 FOR UPDATE，单内取号串行化；UNIQUE(delivery_id, box_no) 兜底
    const next = await sql<{ n: string }>`
      SELECT (COALESCE(MAX(box_no), 0) + 1)::text AS n
      FROM sal_delivery_pack_box WHERE delivery_id=${deliveryId}::uuid
    `.execute(trx)
    const ins = await sql<{ id: string }>`
      INSERT INTO sal_delivery_pack_box (box_no, delivery_id, company_id)
      VALUES (${next.rows[0]!.n}::bigint, ${deliveryId}::uuid, ${parent.companyId}::uuid)
      RETURNING id
    `.execute(trx)
    return readPackBox(trx, actor, ins.rows[0]!.id)
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

  async function readPackLine(handle: DbHandle, actor: Actor, id: string) {
    const rows = await sql<Record<string, unknown>>`
      SELECT * FROM sal_delivery_pack_line WHERE id=${id}::uuid
    `.execute(handle)
    if (!rows.rows[0] || !canAccessCompany(actor, String(rows.rows[0].company_id))) {
      throw new ApiError('not_found', '装箱行不存在')
    }
    return mapPackDto(rows.rows[0])
  }

  async function getPackLine(actor: Actor, id: string) {
    requirePerm(actor, 'sales.delivery', 'read', '无权限执行该履约操作')
    return readPackLine(db, actor, id)
  }

  async function createPackLineInTx(
    trx: TrxHandle,
    actor: Actor,
    input: SalesDraftPackLineInput & { deliveryId: string; packBoxId: string },
  ) {
    const parent = mapHead(await lockDraftHead(trx, actor, fulfillmentSpec('sales'), input.deliveryId))
    await requireOwnBox(trx, input.deliveryId, input.packBoxId)
    // 装箱行不依赖本单发货条目（可先装箱后补条目,见销售发货产品文档）;
    // 装箱与发货的物料一致性由审核「全有或全无」校验兜底,草稿不卡
    const unitId = input.unitId ?? null
    let resolvedUnit = unitId
    if (!resolvedUnit) {
      const m = await trx
        .selectFrom('inv_material')
        .select('default_unit_id')
        .where('id', '=', input.materialId)
        .executeTakeFirst()
      if (!m) throw ApiError.validation('装箱行参数不合法', { materialId: ['物料不存在'] })
      resolvedUnit = m.default_unit_id
    }
    const snap = await loadMaterialSnap(trx, input.materialId, resolvedUnit)
    const qty = decimal(input.qty)
    if (!qty.gt(0)) throw ApiError.validation('装箱行参数不合法', { qty: ['必须大于 0'] })
    const baseQty = convertToBaseQty(qty, resolvedUnit, snap)
    const ins = await sql<{ id: string }>`
      INSERT INTO sal_delivery_pack_line (
        idx,pack_box_id,qty,base_qty,material_code,material_name,material_spec,customer_part_no,unit_name,
        remarks,delivery_id,company_id,material_id,unit_id
      ) VALUES (
        ${input.idx},${input.packBoxId}::uuid,${wireRequiredDecimal(qty)},${wireRequiredDecimal(baseQty)},
        ${snap.code},${snap.name},${snap.spec},${snap.customerPartNo},${snap.unitName},
        ${input.remarks ?? null},${input.deliveryId}::uuid,${parent.companyId}::uuid,
        ${input.materialId}::uuid,${resolvedUnit}::uuid
      ) RETURNING id
    `.execute(trx)
    return readPackLine(trx, actor, ins.rows[0]!.id)
  }

  async function updatePackLineInTx(
    trx: TrxHandle,
    actor: Actor,
    id: string,
    input: SalesDraftPackLineUpdateInput,
  ) {
    const cur = await sql<{ delivery_id: string }>`
      SELECT delivery_id FROM sal_delivery_pack_line WHERE id=${id}::uuid
    `.execute(trx)
    if (!cur.rows[0]) throw new ApiError('not_found', '装箱行不存在')
    const deliveryId = cur.rows[0].delivery_id
    await lockDraftHead(trx, actor, fulfillmentSpec('sales'), deliveryId)
    const before = await readPackLine(trx, actor, id)
    if (input.packBoxId !== undefined) await requireOwnBox(trx, deliveryId, input.packBoxId)
    const materialId = input.materialId ?? before.materialId
    let unitId = input.unitIdPresent ? (input.unitId ?? null) : before.unitId
    if (!unitId) {
      const m = await trx
        .selectFrom('inv_material')
        .select('default_unit_id')
        .where('id', '=', materialId)
        .executeTakeFirst()
      if (!m) throw ApiError.validation('装箱行参数不合法', { materialId: ['物料不存在'] })
      unitId = m.default_unit_id
    }
    const snap = await loadMaterialSnap(trx, materialId, unitId)
    const qty = decimal(input.qty ?? before.qty)
    if (!qty.gt(0)) throw ApiError.validation('装箱行参数不合法', { qty: ['必须大于 0'] })
    const baseQty = convertToBaseQty(qty, unitId, snap)
    await sql`
      UPDATE sal_delivery_pack_line SET
        idx=${input.idx ?? before.idx},
        pack_box_id=${input.packBoxId ?? before.packBoxId}::uuid,
        qty=${wireRequiredDecimal(qty)}, base_qty=${wireRequiredDecimal(baseQty)},
        material_code=${snap.code}, material_name=${snap.name}, material_spec=${snap.spec},
        customer_part_no=${snap.customerPartNo}, unit_name=${snap.unitName},
        remarks=${input.remarksPresent ? (input.remarks ?? null) : before.remarks},
        material_id=${materialId}::uuid, unit_id=${unitId}::uuid,
        updated_at=(now() AT TIME ZONE 'utc')
      WHERE id=${id}::uuid
    `.execute(trx)
    return readPackLine(trx, actor, id)
  }

  async function loadSalesDraft(
    handle: DbHandle,
    actor: Actor,
    id: string,
  ): Promise<SalesDraftDto> {
    const headRow = await loadHead(handle, fulfillmentSpec('sales'), id)
    if (!headRow || !canAccessCompany(actor, String(headRow.company_id))) {
      throw new ApiError('not_found', '销售发货单不存在')
    }
    const itemRows = await sql<Record<string, unknown>>`
      SELECT i.*, h.delivery_no, h.delivery_date, h.status AS delivery_status,
        h.party_type, h.party_id,
        (i.base_qty - i.reconciled_qty) AS remaining_reconcilable_qty
      FROM sal_delivery_item i
      JOIN sal_delivery h ON h.id=i.delivery_id
      WHERE i.delivery_id=${id}::uuid
      ORDER BY i.idx, i.id
    `.execute(handle)
    const boxRows = await sql<Record<string, unknown>>`
      SELECT * FROM sal_delivery_pack_box
      WHERE delivery_id=${id}::uuid
      ORDER BY box_no, id
    `.execute(handle)
    const lineRows = await sql<Record<string, unknown>>`
      SELECT * FROM sal_delivery_pack_line
      WHERE delivery_id=${id}::uuid
      ORDER BY idx, id
    `.execute(handle)
    const linesByBox = new Map<string, ReturnType<typeof mapPackDto>[]>()
    for (const row of lineRows.rows) {
      const line = mapPackDto(row)
      const lines = linesByBox.get(line.packBoxId) ?? []
      lines.push(line)
      linesByBox.set(line.packBoxId, lines)
    }
    return {
      ...mapHeadDto('sales', headRow),
      id: String(headRow.id),
      deliveryNo: String(headRow.delivery_no),
      deliveryDate: asDate(headRow.delivery_date),
      items: itemRows.rows.map((row) => mapItemDto('sales', row)),
      packBoxes: boxRows.rows.map((row) => {
        const box = mapPackBoxDto(row)
        return { ...box, lines: linesByBox.get(box.id) ?? [] }
      }),
    }
  }

  /**
   * 领域专用完整草稿读取：表头 + 全部发货条目 + 全部装箱箱/行。
   * 无分页截断；供 AggregateDraftAdapter.loadDraft 与 create/replace 权威快照共用。
   */
  async function getSalesDraft(actor: Actor, id: string): Promise<SalesDraftDto> {
    requirePerm(actor, 'sales.delivery', 'read', '无权限执行该履约操作')
    return withReadSnapshot(db, (snapshot) => loadSalesDraft(snapshot, actor, id))
  }

  async function createSalesDraft(actor: Actor, input: SalesDraftInput) {
    requirePerm(actor, 'sales.delivery', 'create', '无权限执行该履约操作')
    if (!canAccessCompany(actor, input.companyId)) {
      throw new ApiError('forbidden', '无权在该公司创建履约单')
    }
    const identityFields: Record<string, string[]> = {}
    input.items.forEach((item, itemIndex) => {
      if (item.id !== undefined) identityFields[`items[${itemIndex}].id`] = ['新记录不能包含 id']
    })
    input.packBoxes.forEach((box, boxIndex) => {
      if (box.id !== undefined) identityFields[`packBoxes[${boxIndex}].id`] = ['新记录不能包含 id']
      box.lines.forEach((line, lineIndex) => {
        if (line.id !== undefined) {
          identityFields[`packBoxes[${boxIndex}].lines[${lineIndex}].id`] = ['新记录不能包含 id']
        }
      })
    })
    if (Object.keys(identityFields).length > 0) {
      throw ApiError.validation('销售发货草稿参数不合法', identityFields)
    }

    return withTx(db, async (trx) => {
      const head = await withIndexedFields(
        'header',
        () => createHeadInTx(trx, actor, 'sales', input),
        { number: 'deliveryNo', documentDate: 'deliveryDate' },
      )
      const deliveryId = String(head.id)
      for (let itemIndex = 0; itemIndex < input.items.length; itemIndex++) {
        const item = input.items[itemIndex]!
        await withIndexedFields(`items[${itemIndex}]`, () =>
          createItemInTx(trx, actor, 'sales', { ...item, headId: deliveryId }),
        )
      }
      for (let boxIndex = 0; boxIndex < input.packBoxes.length; boxIndex++) {
        const inputBox = input.packBoxes[boxIndex]!
        const box = await createPackBoxInTx(trx, actor, deliveryId)
        for (let lineIndex = 0; lineIndex < inputBox.lines.length; lineIndex++) {
          const line = inputBox.lines[lineIndex]!
          await withIndexedFields(`packBoxes[${boxIndex}].lines[${lineIndex}]`, () =>
            createPackLineInTx(trx, actor, {
              ...line,
              deliveryId,
              packBoxId: String(box.id),
            }),
          )
        }
      }
      return loadSalesDraft(trx, actor, deliveryId)
    })
  }

  async function replaceSalesDraft(actor: Actor, id: string, input: SalesDraftInput) {
    requirePerm(actor, 'sales.delivery', 'update', '无权限执行该履约操作')
    return withTx(db, async (trx) => {
      const before = mapHead(await lockDraftHead(trx, actor, fulfillmentSpec('sales'), id))
      if (input.companyId !== before.companyId) {
        throw ApiError.validation('销售发货草稿参数不合法', {
          'header.companyId': ['创建后不可修改公司'],
        })
      }

      const existingItems = await trx
        .selectFrom('sal_delivery_item')
        .select('id')
        .where('delivery_id', '=', id)
        .execute()
      const existingBoxes = await trx
        .selectFrom('sal_delivery_pack_box')
        .select('id')
        .where('delivery_id', '=', id)
        .execute()
      const existingLines = await trx
        .selectFrom('sal_delivery_pack_line')
        .select('id')
        .where('delivery_id', '=', id)
        .execute()
      const existingItemIds = new Set(existingItems.map((item) => item.id))
      const existingBoxIds = new Set(existingBoxes.map((box) => box.id))
      const existingLineIds = new Set(existingLines.map((line) => line.id))
      validateSalesDraftIdentities(input, {
        items: existingItemIds,
        boxes: existingBoxIds,
        lines: existingLineIds,
      })

      const requestedItems = new Set(input.items.flatMap((item) => item.id ?? []))
      const requestedBoxes = new Set(input.packBoxes.flatMap((box) => box.id ?? []))
      const requestedLines = new Set(
        input.packBoxes.flatMap((box) => box.lines.flatMap((line) => line.id ?? [])),
      )

      // 先删 omitted 发货条目，再修改头：完整快照清空旧条目时可同步换对手。
      // 删除、头修改与后续子树写入共用同一 transaction，任一失败整体回滚。
      for (const oldId of existingItemIds) {
        if (requestedItems.has(oldId)) continue
        await sql`
          DELETE FROM sys_attachment
          WHERE owner_type='sal_delivery_item' AND owner_id=${oldId}::uuid
        `.execute(trx)
        await trx.deleteFrom('sal_delivery_item').where('id', '=', oldId).execute()
      }

      await withIndexedFields(
        'header',
        () =>
          updateHeadInTx(trx, actor, 'sales', id, {
            no: input.no ?? before.no,
            documentDate: input.documentDate ?? before.documentDate,
            postingDate: input.postingDate ?? null,
            postingDatePresent: true,
            partyType: input.partyType,
            partyId: input.partyId,
            remarks: input.remarks ?? null,
            remarksPresent: true,
            warehouseId: input.warehouseId ?? null,
            warehouseIdPresent: true,
            debitAccountId: input.debitAccountId,
            creditAccountId: input.creditAccountId,
          }),
        { number: 'deliveryNo', documentDate: 'deliveryDate' },
      )

      for (let itemIndex = 0; itemIndex < input.items.length; itemIndex++) {
        const item = input.items[itemIndex]!
        if (item.id === undefined) {
          await withIndexedFields(`items[${itemIndex}]`, () =>
            createItemInTx(trx, actor, 'sales', { ...item, headId: id }),
          )
        } else {
          await withIndexedFields(`items[${itemIndex}]`, () =>
            updateItemInTx(trx, actor, 'sales', item.id!, {
              idx: item.idx,
              qty: item.qty,
              orderItemId: item.orderItemId,
              unitId: item.unitId ?? null,
              unitIdPresent: true,
              warehouseId: item.warehouseId,
              warehouseIdPresent: true,
              remarks: item.remarks ?? null,
              remarksPresent: true,
            }),
          )
        }
      }

      for (let boxIndex = 0; boxIndex < input.packBoxes.length; boxIndex++) {
        const inputBox = input.packBoxes[boxIndex]!
        const box = inputBox.id === undefined
          ? await createPackBoxInTx(trx, actor, id)
          : await readPackBox(trx, actor, inputBox.id)
        const boxId = String(box.id)
        for (let lineIndex = 0; lineIndex < inputBox.lines.length; lineIndex++) {
          const line = inputBox.lines[lineIndex]!
          const prefix = `packBoxes[${boxIndex}].lines[${lineIndex}]`
          if (line.id === undefined) {
            await withIndexedFields(prefix, () =>
              createPackLineInTx(trx, actor, { ...line, deliveryId: id, packBoxId: boxId }),
            )
          } else {
            await withIndexedFields(prefix, () =>
              updatePackLineInTx(trx, actor, line.id!, {
                idx: line.idx,
                packBoxId: boxId,
                qty: line.qty,
                materialId: line.materialId,
                unitId: line.unitId ?? null,
                unitIdPresent: true,
                remarks: line.remarks ?? null,
                remarksPresent: true,
              }),
            )
          }
        }
      }
      for (const oldId of existingLineIds) {
        if (!requestedLines.has(oldId)) {
          await trx.deleteFrom('sal_delivery_pack_line').where('id', '=', oldId).execute()
        }
      }
      for (const oldId of existingBoxIds) {
        if (!requestedBoxes.has(oldId)) {
          await trx.deleteFrom('sal_delivery_pack_box').where('id', '=', oldId).execute()
        }
      }
      return loadSalesDraft(trx, actor, id)
    })
  }

  async function loadPurchaseReceiptDraft(
    handle: DbHandle,
    actor: Actor,
    id: string,
  ): Promise<PurchaseReceiptDraftDto> {
    const spec = fulfillmentSpec('purchase')
    const headRow = await loadHead(handle, spec, id)
    if (!headRow || !canAccessCompany(actor, String(headRow.company_id))) {
      throw new ApiError('not_found', '采购入库单不存在')
    }
    const itemRows = await sql<Record<string, unknown>>`
      SELECT i.*, h.receipt_no, h.receipt_date, h.status AS receipt_status,
        h.party_type, h.party_id,
        (i.base_qty - i.reconciled_qty) AS remaining_reconcilable_qty
      FROM pur_receipt_item i
      JOIN pur_receipt h ON h.id=i.receipt_id
      WHERE i.receipt_id=${id}::uuid
      ORDER BY i.idx, i.id
    `.execute(handle)
    return {
      ...mapHeadDto('purchase', headRow),
      id: String(headRow.id),
      receiptNo: String(headRow.receipt_no),
      receiptDate: asDate(headRow.receipt_date),
      items: itemRows.rows.map((row) => mapItemDto('purchase', row)),
    }
  }

  /** 领域专用完整草稿读取；不经过分页子资源 query。 */
  async function getPurchaseReceiptDraft(
    actor: Actor,
    id: string,
  ): Promise<PurchaseReceiptDraftDto> {
    requirePerm(actor, 'purchase.receipt', 'read', '无权限执行该履约操作')
    return withReadSnapshot(db, (snapshot) => loadPurchaseReceiptDraft(snapshot, actor, id))
  }

  async function createPurchaseReceiptDraft(
    actor: Actor,
    input: PurchaseReceiptDraftInput,
  ): Promise<PurchaseReceiptDraftDto> {
    requirePerm(actor, 'purchase.receipt', 'create', '无权限执行该履约操作')
    if (!canAccessCompany(actor, input.companyId)) {
      throw new ApiError('forbidden', '无权在该公司创建履约单')
    }
    const identityFields: Record<string, string[]> = {}
    input.items.forEach((item, itemIndex) => {
      if (item.id !== undefined) {
        identityFields[`items[${itemIndex}].id`] = ['新记录不能包含 id']
      }
    })
    if (Object.keys(identityFields).length > 0) {
      throw ApiError.validation('采购入库草稿参数不合法', identityFields)
    }

    return withTx(db, async (trx) => {
      const head = await withIndexedFields(
        'header',
        () => createHeadInTx(trx, actor, 'purchase', input),
        { number: 'receiptNo', documentDate: 'receiptDate' },
      )
      const receiptId = String(head.id)
      for (let itemIndex = 0; itemIndex < input.items.length; itemIndex++) {
        const item = input.items[itemIndex]!
        await withIndexedFields(`items[${itemIndex}]`, () =>
          createItemInTx(trx, actor, 'purchase', { ...item, headId: receiptId }),
        )
      }
      return loadPurchaseReceiptDraft(trx, actor, receiptId)
    })
  }

  async function replacePurchaseReceiptDraft(
    actor: Actor,
    id: string,
    input: PurchaseReceiptDraftInput,
  ): Promise<PurchaseReceiptDraftDto> {
    requirePerm(actor, 'purchase.receipt', 'update', '无权限执行该履约操作')
    return withTx(db, async (trx) => {
      const spec = fulfillmentSpec('purchase')
      const before = mapHead(await lockDraftHead(trx, actor, spec, id))
      if (input.companyId !== before.companyId) {
        throw ApiError.validation('采购入库草稿参数不合法', {
          'header.companyId': ['创建后不可修改公司'],
        })
      }

      const existingItems = await trx
        .selectFrom('pur_receipt_item')
        .select('id')
        .where('receipt_id', '=', id)
        .execute()
      const existingItemIds = new Set(existingItems.map((item) => item.id))
      validatePurchaseReceiptDraftIdentities(input, existingItemIds)

      const effects = purchaseReceiptDraftChildEffects(input, existingItemIds)
      if (effects.creates) {
        requirePerm(actor, spec.prefix, 'create', '无权限执行该履约操作')
      }
      if (effects.deletes) {
        requirePerm(actor, spec.prefix, 'delete', '无权限执行该履约操作')
      }

      for (const oldId of existingItemIds) {
        if (effects.requestedItems.has(oldId)) continue
        await sql`
          DELETE FROM sys_attachment
          WHERE owner_type=${spec.itemOwnerType} AND owner_id=${oldId}::uuid
        `.execute(trx)
        await trx.deleteFrom('pur_receipt_item').where('id', '=', oldId).execute()
      }

      await withIndexedFields(
        'header',
        () =>
          updateHeadInTx(trx, actor, 'purchase', id, {
            no: input.no ?? before.no,
            documentDate: input.documentDate ?? before.documentDate,
            postingDate: input.postingDate ?? null,
            postingDatePresent: true,
            partyType: input.partyType,
            partyId: input.partyId,
            remarks: input.remarks ?? null,
            remarksPresent: true,
            warehouseId: input.warehouseId ?? null,
            warehouseIdPresent: true,
            debitAccountId: input.debitAccountId,
            creditAccountId: input.creditAccountId,
          }),
        { number: 'receiptNo', documentDate: 'receiptDate' },
      )

      for (let itemIndex = 0; itemIndex < input.items.length; itemIndex++) {
        const item = input.items[itemIndex]!
        if (item.id === undefined) {
          await withIndexedFields(`items[${itemIndex}]`, () =>
            createItemInTx(trx, actor, 'purchase', { ...item, headId: id }),
          )
        } else {
          await withIndexedFields(`items[${itemIndex}]`, () =>
            updateItemInTx(trx, actor, 'purchase', item.id!, {
              idx: item.idx,
              qty: item.qty,
              orderItemId: item.orderItemId,
              unitId: item.unitId ?? null,
              unitIdPresent: true,
              warehouseId: item.warehouseId,
              warehouseIdPresent: true,
              remarks: item.remarks ?? null,
              remarksPresent: true,
            }),
          )
        }
      }
      return loadPurchaseReceiptDraft(trx, actor, id)
    })
  }

  async function createPurchaseItem(
    actor: Actor,
    input: SalesDraftItemInput & { receiptId: string },
  ) {
    return createItem(actor, 'purchase', { ...input, headId: input.receiptId })
  }

  async function updatePurchaseItem(
    actor: Actor,
    id: string,
    input: FulfillmentItemUpdateInput,
  ) {
    return updateItem(actor, 'purchase', id, input)
  }

  async function deletePurchaseItem(actor: Actor, id: string) {
    return deleteItem(actor, 'purchase', id)
  }

  async function createPurchaseHead(actor: Actor, input: FulfillmentHeadDraftInput) {
    return createHead(actor, 'purchase', input)
  }

  async function updatePurchaseHead(
    actor: Actor,
    id: string,
    input: FulfillmentHeadUpdateInput,
  ) {
    return updateHead(actor, 'purchase', id, input)
  }

  return {
    getSalesDraft, createSalesDraft, replaceSalesDraft,
    getPurchaseReceiptDraft, createPurchaseReceiptDraft, replacePurchaseReceiptDraft,
    listHeads, getHead, createPurchaseHead, updatePurchaseHead, deleteHead, auditHead, voidHead,
    listItems, getItem, createPurchaseItem, updatePurchaseItem, deletePurchaseItem,
    listPackBoxes, getPackBox,
    listPackLines, getPackLine,
  }
}

export type FulfillmentService = ReturnType<typeof createFulfillmentService>

// ---- helpers ----

async function withIndexedFields<T>(
  prefix: string,
  run: () => Promise<T>,
  aliases: Record<string, string> = {},
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'validation' || !error.fields) throw error
    const fields = Object.fromEntries(
      Object.entries(error.fields).map(([field, messages]) => [
        `${prefix}.${aliases[field] ?? field}`,
        messages,
      ]),
    )
    throw ApiError.validation(error.message, fields)
  }
}

function validateSalesDraftIdentities(
  input: SalesDraftInput,
  existing: {
    items: ReadonlySet<string>
    boxes: ReadonlySet<string>
    lines: ReadonlySet<string>
  },
): void {
  const fields: Record<string, string[]> = {}
  const seenItems = new Set<string>()
  const seenBoxes = new Set<string>()
  const seenLines = new Set<string>()
  input.items.forEach((item, itemIndex) => {
    if (item.id === undefined) return
    const field = `items[${itemIndex}].id`
    if (seenItems.has(item.id)) fields[field] = ['同一草稿中不能重复']
    else if (!existing.items.has(item.id)) fields[field] = ['不属于该销售发货单']
    seenItems.add(item.id)
  })
  input.packBoxes.forEach((box, boxIndex) => {
    if (box.id !== undefined) {
      const field = `packBoxes[${boxIndex}].id`
      if (seenBoxes.has(box.id)) fields[field] = ['同一草稿中不能重复']
      else if (!existing.boxes.has(box.id)) fields[field] = ['不属于该销售发货单']
      seenBoxes.add(box.id)
    }
    box.lines.forEach((line, lineIndex) => {
      if (line.id === undefined) return
      const field = `packBoxes[${boxIndex}].lines[${lineIndex}].id`
      if (seenLines.has(line.id)) fields[field] = ['同一草稿中不能重复']
      else if (!existing.lines.has(line.id)) fields[field] = ['不属于该销售发货单']
      seenLines.add(line.id)
    })
  })
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('销售发货草稿子记录身份不合法', fields)
  }
}

function validatePurchaseReceiptDraftIdentities(
  input: PurchaseReceiptDraftInput,
  existingItems: ReadonlySet<string>,
): void {
  const fields: Record<string, string[]> = {}
  const seenItems = new Set<string>()
  input.items.forEach((item, itemIndex) => {
    if (item.id === undefined) return
    const field = `items[${itemIndex}].id`
    if (seenItems.has(item.id)) fields[field] = ['同一草稿中不能重复']
    else if (!existingItems.has(item.id)) fields[field] = ['不属于该采购入库单']
    seenItems.add(item.id)
  })
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('采购入库草稿子记录身份不合法', fields)
  }
}

function purchaseReceiptDraftChildEffects(
  input: PurchaseReceiptDraftInput,
  existingItems: ReadonlySet<string>,
) {
  const requestedItems = new Set<string>()
  let creates = false
  for (const item of input.items) {
    if (item.id === undefined) creates = true
    else requestedItems.add(item.id)
  }
  const deletes = [...existingItems].some((itemId) => !requestedItems.has(itemId))
  return { creates, deletes, requestedItems }
}

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
  /** 非库存类行可空 */
  warehouseId: string | null
  /** 审核时点物料当前类型（草稿保存后可能被改） */
  materialType: string
  materialCode: string
  materialName: string
  orderBaseQty: string
  orderBaseAmount: string
  reconciledQty: string
}

async function loadActionItems(db: DbHandle, spec: FulfillmentSideSpec, headId: string): Promise<ActionItem[]> {
  const rows = await sql<Record<string, unknown>>`
    SELECT i.id, i.order_item_id, i.base_qty, i.material_id, i.warehouse_id, i.material_code,
      i.material_name, i.order_base_qty, i.order_base_amount, i.reconciled_qty,
      m.material_type
    FROM ${ident(spec.itemTable)} i
    JOIN inv_material m ON m.id=i.material_id
    WHERE i.${sql.raw(spec.parentCol)}=${headId}::uuid
    ORDER BY i.idx, i.id
    FOR UPDATE OF i
  `.execute(db)
  return rows.rows.map((r) => ({
    id: String(r.id),
    orderItemId: String(r.order_item_id),
    baseQty: String(r.base_qty),
    materialId: String(r.material_id),
    warehouseId: r.warehouse_id ? String(r.warehouse_id) : null,
    materialType: String(r.material_type),
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
    warehouseId: string | null
    remarks: string | null
  },
) {
  if (!draft.qty.gt(0)) {
    throw ApiError.validation(`${spec.itemLabel}参数不合法`, { qty: ['必须大于 0'] })
  }
  if (draft.remarks && runeLen(draft.remarks) > 512) {
    throw ApiError.validation(`${spec.itemLabel}参数不合法`, { remarks: ['最多 512 个字符'] })
  }
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
  if (spec.side === 'sales') {
    // 销售发货行：库存/虚拟可进，资产不可进（采购入库三类皆可，不拦）
    guardMaterialType(snap, ['STOCK', 'VIRTUAL'], spec.itemLabel)
  }
  // 行仓：库存类物料必填（要写库存分录）；非库存类行可空，给了仍校验合法叶子仓
  if (!draft.warehouseId) {
    if (snap.materialType === 'STOCK') {
      throw ApiError.validation(`${spec.itemLabel}参数不合法`, {
        warehouseId: ['库存类物料必须填写行仓'],
      })
    }
  } else {
    await validateWarehouse(db, parent.companyId, draft.warehouseId)
  }
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

/** 校验箱属于本发货单（装箱行挂箱前提）。 */
async function requireOwnBox(db: DbHandle, deliveryId: string, packBoxId: string) {
  const rows = await sql<{ e: boolean }>`
    SELECT EXISTS(
      SELECT 1 FROM sal_delivery_pack_box WHERE id=${packBoxId}::uuid AND delivery_id=${deliveryId}::uuid
    ) AS e
  `.execute(db)
  if (!rows.rows[0]?.e) {
    throw ApiError.validation('装箱行参数不合法', { packBoxId: ['须为本单的箱'] })
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
    // 虚拟/资产行无实物不装箱,不参与「全有或全无」复核(口径同审核跳过库存分录)
    if (item.materialType !== 'STOCK') continue
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
    warehouseId: row.warehouse_id ? String(row.warehouse_id) : null,
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

function mapPackBoxDto(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    boxNo: String(row.box_no),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    deliveryId: String(row.delivery_id),
    companyId: String(row.company_id),
  }
}

function mapPackDto(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    idx: Number(row.idx),
    packBoxId: String(row.pack_box_id),
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
  warehouseId: string | null,
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
