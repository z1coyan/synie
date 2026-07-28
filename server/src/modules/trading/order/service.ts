/**
 * 销售/采购订单：头/条目/状态机/报价套档/样品限量/履约投影入口。
 * 采购扩展：发料/副产物清单、需求池、BOM 展开（工单 06 验收 verify-order 所需）。
 */
import type { ListQuery } from '@synie/shared'
import { decimal, type Decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
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
import { mapWriteError } from '../../base/dberr.ts'
import {
  asDate,
  asDateTime,
  asOptionalString,
  codeNamedRef,
  convertToBaseQty,
  guardCustomerMaterial,
  ident,
  loadMaterialSnap,
  lowerParty,
  namedRef,
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
import type { QuotationService } from '../quotation/service.ts'
import { deriveItemAmounts } from './amounts.ts'
import {
  postFulfillment,
  postOutsourcedIssue,
  reverseFulfillment,
  reverseOutsourcedIssue,
  type FulfillmentInput,
  type OutsourcedIssueInput,
} from './projection.ts'
import {
  orderByproductMeta,
  orderHeadMeta,
  orderItemMeta,
  orderMaterialMeta,
  orderSpec,
  type OrderSideSpec,
} from './spec.ts'

const HEAD_AUDIT = [
  'order_no', 'order_date', 'order_type', 'is_outsourced', 'party_type', 'party_id',
  'exchange_rate', 'terms', 'remarks', 'status', 'audited_at', 'company_id', 'currency_id',
  'created_by_id', 'audited_by_id',
] as const

const ITEM_AUDIT = [
  'idx', 'qty', 'base_qty', 'price', 'amount', 'base_price', 'base_amount', 'tax_rate',
  'material_code', 'material_name', 'material_spec', 'customer_part_no', 'unit_name',
  'remarks', 'demand_date', 'order_id', 'company_id', 'material_id', 'unit_id',
  'quotation_item_id', 'bom_id', 'demand_line_id',
] as const

export interface Order {
  id: string
  orderNo: string
  orderDate: string
  orderType: string
  isOutsourced: boolean
  partyType: string
  partyId: string
  exchangeRate: string
  terms: string | null
  remarks: string | null
  status: string
  auditedAt: string | null
  insertedAt: string
  updatedAt: string
  companyId: string
  currencyId: string
  createdById: string | null
  auditedById: string | null
  grossTotal: string
  baseGrossTotal: string
  company: { id: string; name: string }
  currency: { id: string; code: string; name: string }
  createdBy: { id: string; name: string } | null
  auditedBy: { id: string; name: string } | null
}

export interface OrderItem {
  id: string
  idx: number
  qty: string
  baseQty: string
  shippedQty?: string
  receivedQty?: string
  price: string
  amount: string
  basePrice: string
  baseAmount: string
  taxRate: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  customerPartNo: string | null
  unitName: string
  remarks: string | null
  demandDate?: string | null
  insertedAt: string
  updatedAt: string
  orderId: string
  companyId: string
  materialId: string
  unitId: string
  quotationItemId: string | null
  pricingMode: string | null
  bomId?: string | null
  bomCode?: string | null
  bomPlanName?: string | null
  demandLineId?: string | null
  demandNo?: string | null
  orderNo: string
  orderDate: string
  orderStatus: string
  orderIsOutsourced?: boolean
  partyType: string
  partyId: string
  currencyCode: string
  remainingBaseQty: string
  order: { id: string; orderNo: string }
  company: { id: string; name: string }
  material: { id: string; code: string; name: string }
  unit: { id: string; name: string }
}

type Numberer = Pick<NumberingService, 'nextInTx'>

export function createOrderService(
  db: Kysely<Database>,
  numberer: Numberer,
  quotations: QuotationService,
) {
  async function listHeads(actor: Actor, side: TradingSide, query: Partial<ListQuery>) {
    const spec = orderSpec(side)
    requirePerm(actor, spec.prefix, 'read', '无权限执行该订单操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as Order[] }
    const outsourcedCol = side === 'purchase' ? 'o.is_outsourced' : 'false'
    return listFromSource({
      db,
      resource: orderHeadMeta(side),
      source: sql` FROM (
        SELECT o.id,o.order_no,o.order_date,o.order_type,${sql.raw(outsourcedCol)} AS is_outsourced,
          o.party_type,o.party_id,o.exchange_rate,o.terms,o.remarks,o.status,o.audited_at,
          o.inserted_at,o.updated_at,o.company_id,o.currency_id,o.created_by_id,o.audited_by_id,
          coalesce((SELECT sum(i.amount) FROM ${ident(spec.itemTable)} i WHERE i.order_id=o.id),0) AS gross_total,
          coalesce((SELECT sum(i.base_amount) FROM ${ident(spec.itemTable)} i WHERE i.order_id=o.id),0) AS base_gross_total,
          c.name AS company_name,cur.iso_code AS currency_code,cur.name AS currency_name,
          creator.name AS created_by_name,auditor.name AS audited_by_name
        FROM ${ident(spec.headTable)} o
        JOIN bas_company c ON c.id=o.company_id
        JOIN bas_currency cur ON cur.id=o.currency_id
        LEFT JOIN sys_user creator ON creator.id=o.created_by_id
        LEFT JOIN sys_user auditor ON auditor.id=o.audited_by_id
      ) order_heads`,
      select: sql`SELECT id,order_no,order_date,order_type,is_outsourced,party_type,party_id,exchange_rate,
        terms,remarks,status,audited_at,inserted_at,updated_at,company_id,currency_id,created_by_id,
        audited_by_id,gross_total,base_gross_total,company_name,currency_code,currency_name,
        created_by_name,audited_by_name`,
      defaultOrder: sql`"order_date" DESC, "id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: (r) => mapHead(r),
    })
  }

  async function getHead(actor: Actor, side: TradingSide, id: string): Promise<Order> {
    const spec = orderSpec(side)
    requirePerm(actor, spec.prefix, 'read', '无权限执行该订单操作')
    const row = await loadHead(db, spec, id)
    if (!row || !canAccessCompany(actor, String(row.company_id))) {
      throw new ApiError('not_found', `${spec.label}不存在`)
    }
    return mapHead(row)
  }

  async function createHead(
    actor: Actor,
    side: TradingSide,
    input: {
      companyId: string
      orderNo?: string | null
      orderDate?: string | null
      orderType?: string
      isOutsourced?: boolean
      partyType: string
      partyId: string
      currencyId?: string | null
      exchangeRate?: string | null
      terms?: string | null
      remarks?: string | null
    },
  ): Promise<Order> {
    const spec = orderSpec(side)
    requirePerm(actor, spec.prefix, 'create', '无权限执行该订单操作')
    if (!canAccessCompany(actor, input.companyId)) {
      throw new ApiError('forbidden', '无权在该公司下操作数据')
    }
    return withTx(db, async (trx) => {
      const { currencyId, exchangeRate } = await normalizeCurrency(
        trx, input.companyId, input.currencyId ?? null, input.exchangeRate ?? null,
      )
      const orderDate = input.orderDate ? toDateOnly(input.orderDate) : todayUTC()
      let orderType = (input.orderType ?? 'REGULAR').toUpperCase()
      if (orderType !== 'REGULAR' && orderType !== spec.nonRegularType) {
        throw ApiError.validation(`${spec.label}参数不合法`, { orderType: ['订单类型不合法'] })
      }
      let orderNo = (input.orderNo ?? '').trim()
      const partyType = lowerParty(input.partyType)
      if (!orderNo) {
        orderNo = await numberer.nextInTx(trx, {
          resource: spec.numberResource,
          values: {
            company_id: input.companyId,
            order_date: orderDate,
            order_type: orderType.toLowerCase(),
            party_type: partyType,
            party_id: input.partyId,
            currency_id: currencyId,
          },
        })
      }
      validateOrderShape(spec, {
        orderNo, orderDate, orderType, partyType, partyId: input.partyId,
        companyId: input.companyId, currencyId, exchangeRate, remarks: input.remarks ?? null,
      })
      if (!(await partyExists(trx, partyType, input.partyId))) {
        throw ApiError.validation('订单参数不合法', { partyId: ['对手不存在'] })
      }
      const createdById = actor.userId || null
      const isOutsourced = side === 'purchase' ? Boolean(input.isOutsourced) : false
      try {
        let id: string
        if (side === 'purchase') {
          const ins = await sql<{ id: string }>`
            INSERT INTO pur_order (
              order_no,order_date,order_type,is_outsourced,party_type,party_id,exchange_rate,
              terms,remarks,company_id,currency_id,created_by_id
            ) VALUES (
              ${orderNo},${orderDate}::date,${orderType.toLowerCase()},${isOutsourced},
              ${partyType},${input.partyId}::uuid,${wireRequiredDecimal(exchangeRate)},
              ${input.terms ?? null},${input.remarks ?? null},
              ${input.companyId}::uuid,${currencyId}::uuid,${createdById}::uuid
            ) RETURNING id
          `.execute(trx)
          id = ins.rows[0]!.id
        } else {
          const ins = await sql<{ id: string }>`
            INSERT INTO sal_order (
              order_no,order_date,order_type,party_type,party_id,exchange_rate,
              terms,remarks,company_id,currency_id,created_by_id
            ) VALUES (
              ${orderNo},${orderDate}::date,${orderType.toLowerCase()},
              ${partyType},${input.partyId}::uuid,${wireRequiredDecimal(exchangeRate)},
              ${input.terms ?? null},${input.remarks ?? null},
              ${input.companyId}::uuid,${currencyId}::uuid,${createdById}::uuid
            ) RETURNING id
          `.execute(trx)
          id = ins.rows[0]!.id
        }
        const row = await loadHead(trx, spec, id)
        const item = mapHead(row!)
        await writeAudit(trx, actor, {
          resource: spec.headTable,
          recordId: id,
          recordLabel: item.orderNo,
          companyId: item.companyId,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(headSnap(item), HEAD_AUDIT),
        })
        return item
      } catch (err) {
        throw mapOrderWrite('创建订单失败', err)
      }
    })
  }

  async function updateHead(
    actor: Actor,
    side: TradingSide,
    id: string,
    input: {
      orderNo?: string
      orderDate?: string
      orderType?: string
      isOutsourced?: boolean
      partyType?: string
      partyId?: string
      currencyId?: string
      exchangeRate?: string
      terms?: string | null
      termsPresent?: boolean
      remarks?: string | null
      remarksPresent?: boolean
    },
  ): Promise<Order> {
    const spec = orderSpec(side)
    requirePerm(actor, spec.prefix, 'update', '无权限执行该订单操作')
    return withTx(db, async (trx) => {
      const locked = await lockOrder(trx, actor, spec, id)
      if (String(locked.status).toLowerCase() !== 'draft') {
        throw new ApiError('conflict', '仅草稿订单可修改')
      }
      const before = mapHead(locked)
      if (input.orderType !== undefined && input.orderType.toUpperCase() !== before.orderType) {
        throw ApiError.validation('订单参数不合法', { orderType: ['订单类型不可变更'] })
      }
      if (
        input.isOutsourced !== undefined &&
        Boolean(input.isOutsourced) !== before.isOutsourced
      ) {
        throw ApiError.validation('订单参数不合法', { isOutsourced: ['委外标记不可变更'] })
      }
      let after: Order = {
        ...before,
        orderNo: input.orderNo !== undefined ? input.orderNo.trim() : before.orderNo,
        orderDate: input.orderDate ? toDateOnly(input.orderDate) : before.orderDate,
        partyType: input.partyType ? input.partyType.trim().toUpperCase() : before.partyType,
        partyId: input.partyId ?? before.partyId,
        currencyId: input.currencyId ?? before.currencyId,
        exchangeRate: input.exchangeRate ?? before.exchangeRate,
        terms: input.termsPresent ? (input.terms ?? null) : before.terms,
        remarks: input.remarksPresent ? (input.remarks ?? null) : before.remarks,
      }
      const hasItems = await sql<{ e: boolean }>`
        SELECT EXISTS(SELECT 1 FROM ${ident(spec.itemTable)} WHERE order_id=${id}::uuid) AS e
      `.execute(trx)
      const headChanged =
        after.orderDate !== before.orderDate ||
        lowerParty(after.partyType) !== lowerParty(before.partyType) ||
        after.partyId !== before.partyId ||
        after.currencyId !== before.currencyId
      if (hasItems.rows[0]?.e && headChanged) {
        throw new ApiError('conflict', '请先删除订单条目')
      }
      const norm = await normalizeCurrency(
        trx,
        after.companyId,
        after.currencyId,
        after.exchangeRate,
      )
      after = { ...after, currencyId: norm.currencyId, exchangeRate: wireRequiredDecimal(norm.exchangeRate) }
      validateOrderShape(spec, {
        orderNo: after.orderNo,
        orderDate: after.orderDate,
        orderType: after.orderType,
        partyType: lowerParty(after.partyType),
        partyId: after.partyId,
        companyId: after.companyId,
        currencyId: after.currencyId,
        exchangeRate: decimal(after.exchangeRate),
        remarks: after.remarks,
      })
      if (!(await partyExists(trx, after.partyType, after.partyId))) {
        throw ApiError.validation('订单参数不合法', { partyId: ['对手不存在'] })
      }
      const changes = auditDiff(headSnap(before), headSnap(after), HEAD_AUDIT)
      if (Object.keys(changes).length === 0) return before
      try {
        await sql`
          UPDATE ${ident(spec.headTable)} SET
            order_no=${after.orderNo},
            order_date=${after.orderDate}::date,
            party_type=${lowerParty(after.partyType)},
            party_id=${after.partyId}::uuid,
            currency_id=${after.currencyId}::uuid,
            exchange_rate=${after.exchangeRate},
            terms=${after.terms},
            remarks=${after.remarks},
            updated_at=(now() AT TIME ZONE 'utc')
          WHERE id=${id}::uuid
        `.execute(trx)
        if (after.exchangeRate !== before.exchangeRate) {
          await sql`
            UPDATE ${ident(spec.itemTable)}
            SET base_price=round(price*${after.exchangeRate},4),
                base_amount=round(amount*${after.exchangeRate},2),
                updated_at=(now() AT TIME ZONE 'utc')
            WHERE order_id=${id}::uuid
          `.execute(trx)
        }
        const row = await loadHead(trx, spec, id)
        const item = mapHead(row!)
        await writeAudit(trx, actor, {
          resource: spec.headTable,
          recordId: id,
          recordLabel: item.orderNo,
          companyId: item.companyId,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
        return item
      } catch (err) {
        throw mapOrderWrite('更新订单失败', err)
      }
    })
  }

  async function deleteHead(actor: Actor, side: TradingSide, id: string): Promise<void> {
    const spec = orderSpec(side)
    requirePerm(actor, spec.prefix, 'delete', '无权限执行该订单操作')
    await withTx(db, async (trx) => {
      const locked = await lockOrder(trx, actor, spec, id)
      if (String(locked.status).toLowerCase() !== 'draft') {
        throw new ApiError('conflict', '仅草稿订单可删除')
      }
      const before = mapHead(locked)
      await sql`
        DELETE FROM sys_attachment WHERE owner_type=${spec.itemOwnerType}
          AND owner_id IN (SELECT id FROM ${ident(spec.itemTable)} WHERE order_id=${id}::uuid)
      `.execute(trx)
      await writeAudit(trx, actor, {
        resource: spec.headTable,
        recordId: id,
        recordLabel: before.orderNo,
        companyId: before.companyId,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(headSnap(before), HEAD_AUDIT),
      })
      try {
        await sql`DELETE FROM ${ident(spec.headTable)} WHERE id=${id}::uuid`.execute(trx)
      } catch (err) {
        throw mapOrderWrite('删除订单失败', err)
      }
    })
  }

  async function transition(
    actor: Actor,
    side: TradingSide,
    id: string,
    action: 'audit' | 'close' | 'void',
  ): Promise<Order> {
    const spec = orderSpec(side)
    requirePerm(actor, spec.prefix, action, '无权限执行该订单操作')
    return withTx(db, async (trx) => {
      const locked = await lockOrder(trx, actor, spec, id)
      const before = mapHead(locked)
      let target = ''
      if (action === 'audit') {
        if (before.status !== 'DRAFT') throw new ApiError('conflict', '仅草稿订单可审核')
        await verifyItems(trx, quotations, spec, locked)
        if (side === 'purchase') await adjustDemandOnAudit(trx, id, true)
        target = 'audited'
      } else if (action === 'close') {
        if (before.status !== 'AUDITED') throw new ApiError('conflict', '仅已审核订单可关闭')
        target = 'closed'
      } else {
        if (before.status !== 'AUDITED') throw new ApiError('conflict', '仅已审核订单可作废')
        await ensureVoidable(trx, side, id)
        if (side === 'purchase') await adjustDemandOnAudit(trx, id, false)
        target = 'voided'
      }
      const auditedById = action === 'audit' ? actor.userId || null : before.auditedById
      try {
        if (action === 'audit') {
          await sql`
            UPDATE ${ident(spec.headTable)} SET
              status=${target},
              audited_at=(now() AT TIME ZONE 'utc'),
              audited_by_id=${auditedById}::uuid,
              updated_at=(now() AT TIME ZONE 'utc')
            WHERE id=${id}::uuid
          `.execute(trx)
        } else {
          await sql`
            UPDATE ${ident(spec.headTable)} SET
              status=${target},
              updated_at=(now() AT TIME ZONE 'utc')
            WHERE id=${id}::uuid
          `.execute(trx)
        }
        const row = await loadHead(trx, spec, id)
        const item = mapHead(row!)
        await writeAudit(trx, actor, {
          resource: spec.headTable,
          recordId: id,
          recordLabel: item.orderNo,
          companyId: item.companyId,
          actionType: 'update',
          actionName: action,
          changes: auditDiff(headSnap(before), headSnap(item), HEAD_AUDIT),
        })
        return item
      } catch (err) {
        throw mapOrderWrite('变更订单状态失败', err)
      }
    })
  }

  async function listItems(actor: Actor, side: TradingSide, query: Partial<ListQuery>) {
    const spec = orderSpec(side)
    requirePerm(actor, spec.prefix, 'read', '无权限执行该订单操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as OrderItem[] }
    const proj = spec.projectionColumn
    const extraCols =
      side === 'purchase'
        ? `,i.bom_id,i.demand_line_id,i.demand_date,o.is_outsourced AS order_is_outsourced,
           bom.code AS bom_code,bom.plan_name AS bom_plan_name,d.demand_no`
        : ',null::uuid AS bom_id,null::uuid AS demand_line_id,null::date AS demand_date,false AS order_is_outsourced,null::text AS bom_code,null::text AS bom_plan_name,null::text AS demand_no'
    const joins =
      side === 'purchase'
        ? `LEFT JOIN mfg_bom bom ON bom.id=i.bom_id
           LEFT JOIN mfg_demand_item dl ON dl.id=i.demand_line_id
           LEFT JOIN mfg_demand d ON d.id=dl.demand_id`
        : ''
    return listFromSource({
      db,
      resource: orderItemMeta(side),
      source: sql` FROM (
        SELECT i.id,i.idx,i.qty,i.base_qty,i.${sql.raw(proj)} AS projection_qty,i.price,i.amount,
          i.base_price,i.base_amount,i.tax_rate,i.material_code,i.material_name,i.material_spec,
          i.customer_part_no,i.unit_name,i.remarks,i.inserted_at,i.updated_at,i.order_id,i.company_id,
          i.material_id,i.unit_id,i.quotation_item_id,
          o.order_no,o.order_date,o.status AS order_status,o.party_type,o.party_id,
          cur.iso_code AS currency_code,c.name AS company_name,m.name AS material_live_name,
          u.name AS unit_live_name,qi.pricing_mode
          ${sql.raw(extraCols)}
        FROM ${ident(spec.itemTable)} i
        JOIN ${ident(spec.headTable)} o ON o.id=i.order_id
        JOIN bas_company c ON c.id=i.company_id
        JOIN bas_currency cur ON cur.id=o.currency_id
        JOIN inv_material m ON m.id=i.material_id
        JOIN bas_unit u ON u.id=i.unit_id
        LEFT JOIN ${ident(side === 'sales' ? 'sal_quotation_item' : 'pur_quotation_item')} qi ON qi.id=i.quotation_item_id
        ${sql.raw(joins)}
      ) order_items`,
      select: sql`SELECT *`,
      defaultOrder: sql`"order_date" DESC, "idx" ASC, "id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: (r) => mapItem(side, r),
    })
  }

  async function getItem(actor: Actor, side: TradingSide, id: string): Promise<OrderItem> {
    const spec = orderSpec(side)
    requirePerm(actor, spec.prefix, 'read', '无权限执行该订单操作')
    const row = await loadItem(db, spec, side, id)
    if (!row || !canAccessCompany(actor, String(row.company_id))) {
      throw new ApiError('not_found', '订单条目不存在')
    }
    return mapItem(side, row)
  }

  async function createItem(
    actor: Actor,
    side: TradingSide,
    input: {
      orderId: string
      idx: number
      qty: string
      materialId: string
      unitId: string
      price?: string | null
      taxRate?: string | null
      remarks?: string | null
      quotationItemId?: string | null
      bomId?: string | null
      demandLineId?: string | null
      demandDate?: string | null
    },
  ): Promise<OrderItem> {
    const spec = orderSpec(side)
    requirePerm(actor, spec.prefix, 'create', '无权限执行该订单操作')
    return withTx(db, async (trx) => {
      const parent = await lockOrder(trx, actor, spec, input.orderId)
      if (String(parent.status).toLowerCase() !== 'draft') {
        throw new ApiError('conflict', '仅草稿订单可编辑条目')
      }
      const derived = await deriveAndValidateItem(trx, quotations, spec, parent, {
        idx: input.idx,
        qty: decimal(input.qty),
        materialId: input.materialId,
        unitId: input.unitId,
        price: input.price != null && input.price !== '' ? decimal(input.price) : decimal(0),
        taxRate: input.taxRate != null && input.taxRate !== '' ? decimal(input.taxRate) : decimal('0.13'),
        taxExplicit: input.taxRate != null && input.taxRate !== '',
        remarks: input.remarks ?? null,
        quotationItemId: input.quotationItemId ?? null,
        bomId: input.bomId ?? null,
        demandLineId: input.demandLineId ?? null,
        demandDate: input.demandDate ?? null,
      })
      try {
        let id: string
        if (side === 'purchase') {
          const ins = await sql<{ id: string }>`
            INSERT INTO pur_order_item (
              idx,qty,base_qty,price,amount,base_price,base_amount,tax_rate,
              material_code,material_name,material_spec,customer_part_no,unit_name,remarks,
              order_id,company_id,material_id,unit_id,quotation_item_id,bom_id,demand_line_id,demand_date
            ) VALUES (
              ${derived.idx},${wireRequiredDecimal(derived.qty)},${wireRequiredDecimal(derived.baseQty)},
              ${wireRequiredDecimal(derived.price)},${wireRequiredDecimal(derived.amount)},
              ${wireRequiredDecimal(derived.basePrice)},${wireRequiredDecimal(derived.baseAmount)},
              ${wireRequiredDecimal(derived.taxRate)},
              ${derived.materialCode},${derived.materialName},${derived.materialSpec},
              ${derived.customerPartNo},${derived.unitName},${derived.remarks},
              ${input.orderId}::uuid,${String(parent.company_id)}::uuid,
              ${derived.materialId}::uuid,${derived.unitId}::uuid,
              ${derived.quotationItemId}::uuid,${derived.bomId}::uuid,
              ${derived.demandLineId}::uuid,${derived.demandDate}::date
            ) RETURNING id
          `.execute(trx)
          id = ins.rows[0]!.id
        } else {
          const ins = await sql<{ id: string }>`
            INSERT INTO sal_order_item (
              idx,qty,base_qty,price,amount,base_price,base_amount,tax_rate,
              material_code,material_name,material_spec,customer_part_no,unit_name,remarks,
              order_id,company_id,material_id,unit_id,quotation_item_id
            ) VALUES (
              ${derived.idx},${wireRequiredDecimal(derived.qty)},${wireRequiredDecimal(derived.baseQty)},
              ${wireRequiredDecimal(derived.price)},${wireRequiredDecimal(derived.amount)},
              ${wireRequiredDecimal(derived.basePrice)},${wireRequiredDecimal(derived.baseAmount)},
              ${wireRequiredDecimal(derived.taxRate)},
              ${derived.materialCode},${derived.materialName},${derived.materialSpec},
              ${derived.customerPartNo},${derived.unitName},${derived.remarks},
              ${input.orderId}::uuid,${String(parent.company_id)}::uuid,
              ${derived.materialId}::uuid,${derived.unitId}::uuid,${derived.quotationItemId}::uuid
            ) RETURNING id
          `.execute(trx)
          id = ins.rows[0]!.id
        }
        await syncDrawingAttachments(trx, spec.itemOwnerType, id, derived.materialId, String(parent.company_id))
        const row = await loadItem(trx, spec, side, id)
        const item = mapItem(side, row!)
        await writeAudit(trx, actor, {
          resource: spec.itemTable,
          recordId: id,
          recordLabel: String(item.idx),
          companyId: item.companyId,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(itemSnap(item), ITEM_AUDIT),
        })
        return item
      } catch (err) {
        throw mapOrderWrite('创建订单条目失败', err)
      }
    })
  }

  async function updateItem(
    actor: Actor,
    side: TradingSide,
    id: string,
    input: {
      idx?: number
      qty?: string
      materialId?: string
      unitId?: string
      price?: string
      taxRate?: string
      remarks?: string | null
      remarksPresent?: boolean
      quotationItemId?: string | null
      quotationItemIdPresent?: boolean
      bomId?: string | null
      bomIdPresent?: boolean
      demandLineId?: string | null
      demandLineIdPresent?: boolean
      demandDate?: string | null
      demandDatePresent?: boolean
    },
  ): Promise<OrderItem> {
    const spec = orderSpec(side)
    requirePerm(actor, spec.prefix, 'update', '无权限执行该订单操作')
    return withTx(db, async (trx) => {
      const existing = await sql<{ order_id: string }>`
        SELECT order_id FROM ${ident(spec.itemTable)} WHERE id=${id}::uuid
      `.execute(trx)
      if (!existing.rows[0]) throw new ApiError('not_found', '订单条目不存在')
      const parent = await lockOrder(trx, actor, spec, existing.rows[0].order_id)
      if (String(parent.status).toLowerCase() !== 'draft') {
        throw new ApiError('conflict', '仅草稿订单可编辑条目')
      }
      const beforeRow = await loadItem(trx, spec, side, id)
      if (!beforeRow) throw new ApiError('not_found', '订单条目不存在')
      const before = mapItem(side, beforeRow)
      const derived = await deriveAndValidateItem(trx, quotations, spec, parent, {
        idx: input.idx ?? before.idx,
        qty: decimal(input.qty ?? before.qty),
        materialId: input.materialId ?? before.materialId,
        unitId: input.unitId ?? before.unitId,
        price: decimal(input.price ?? before.price),
        taxRate: decimal(input.taxRate ?? before.taxRate),
        taxExplicit: input.taxRate !== undefined,
        remarks: input.remarksPresent ? (input.remarks ?? null) : before.remarks,
        quotationItemId: input.quotationItemIdPresent
          ? (input.quotationItemId ?? null)
          : before.quotationItemId,
        bomId: input.bomIdPresent ? (input.bomId ?? null) : (before.bomId ?? null),
        demandLineId: input.demandLineIdPresent
          ? (input.demandLineId ?? null)
          : (before.demandLineId ?? null),
        demandDate: input.demandDatePresent
          ? (input.demandDate ?? null)
          : (before.demandDate ?? null),
      })
      const afterBase: OrderItem = {
        ...before,
        idx: derived.idx,
        qty: wireRequiredDecimal(derived.qty),
        baseQty: wireRequiredDecimal(derived.baseQty),
        price: wireRequiredDecimal(derived.price),
        amount: wireRequiredDecimal(derived.amount),
        basePrice: wireRequiredDecimal(derived.basePrice),
        baseAmount: wireRequiredDecimal(derived.baseAmount),
        taxRate: wireRequiredDecimal(derived.taxRate),
        materialId: derived.materialId,
        unitId: derived.unitId,
        materialCode: derived.materialCode,
        materialName: derived.materialName,
        materialSpec: derived.materialSpec,
        customerPartNo: derived.customerPartNo,
        unitName: derived.unitName,
        remarks: derived.remarks,
        quotationItemId: derived.quotationItemId,
        bomId: derived.bomId,
        demandLineId: derived.demandLineId,
        demandDate: derived.demandDate,
      }
      const changes = auditDiff(itemSnap(before), itemSnap(afterBase), ITEM_AUDIT)
      if (Object.keys(changes).length === 0) return before
      try {
        if (side === 'purchase') {
          await sql`
            UPDATE pur_order_item SET
              idx=${afterBase.idx}, qty=${afterBase.qty}, base_qty=${afterBase.baseQty},
              price=${afterBase.price}, amount=${afterBase.amount},
              base_price=${afterBase.basePrice}, base_amount=${afterBase.baseAmount},
              tax_rate=${afterBase.taxRate}, material_code=${afterBase.materialCode},
              material_name=${afterBase.materialName}, material_spec=${afterBase.materialSpec},
              customer_part_no=${afterBase.customerPartNo}, unit_name=${afterBase.unitName},
              remarks=${afterBase.remarks}, material_id=${afterBase.materialId}::uuid,
              unit_id=${afterBase.unitId}::uuid, quotation_item_id=${afterBase.quotationItemId}::uuid,
              bom_id=${afterBase.bomId}::uuid, demand_line_id=${afterBase.demandLineId}::uuid,
              demand_date=${afterBase.demandDate}::date,
              updated_at=(now() AT TIME ZONE 'utc')
            WHERE id=${id}::uuid
          `.execute(trx)
        } else {
          await sql`
            UPDATE sal_order_item SET
              idx=${afterBase.idx}, qty=${afterBase.qty}, base_qty=${afterBase.baseQty},
              price=${afterBase.price}, amount=${afterBase.amount},
              base_price=${afterBase.basePrice}, base_amount=${afterBase.baseAmount},
              tax_rate=${afterBase.taxRate}, material_code=${afterBase.materialCode},
              material_name=${afterBase.materialName}, material_spec=${afterBase.materialSpec},
              customer_part_no=${afterBase.customerPartNo}, unit_name=${afterBase.unitName},
              remarks=${afterBase.remarks}, material_id=${afterBase.materialId}::uuid,
              unit_id=${afterBase.unitId}::uuid, quotation_item_id=${afterBase.quotationItemId}::uuid,
              updated_at=(now() AT TIME ZONE 'utc')
            WHERE id=${id}::uuid
          `.execute(trx)
        }
        await syncDrawingAttachments(
          trx, spec.itemOwnerType, id, afterBase.materialId, afterBase.companyId,
        )
        const row = await loadItem(trx, spec, side, id)
        const item = mapItem(side, row!)
        await writeAudit(trx, actor, {
          resource: spec.itemTable,
          recordId: id,
          recordLabel: String(item.idx),
          companyId: item.companyId,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
        return item
      } catch (err) {
        throw mapOrderWrite('更新订单条目失败', err)
      }
    })
  }

  async function deleteItem(actor: Actor, side: TradingSide, id: string): Promise<void> {
    const spec = orderSpec(side)
    requirePerm(actor, spec.prefix, 'delete', '无权限执行该订单操作')
    await withTx(db, async (trx) => {
      const existing = await sql<{ order_id: string }>`
        SELECT order_id FROM ${ident(spec.itemTable)} WHERE id=${id}::uuid
      `.execute(trx)
      if (!existing.rows[0]) throw new ApiError('not_found', '订单条目不存在')
      const parent = await lockOrder(trx, actor, spec, existing.rows[0].order_id)
      if (String(parent.status).toLowerCase() !== 'draft') {
        throw new ApiError('conflict', '仅草稿订单可编辑条目')
      }
      const row = await loadItem(trx, spec, side, id)
      if (!row) throw new ApiError('not_found', '订单条目不存在')
      const item = mapItem(side, row)
      await writeAudit(trx, actor, {
        resource: spec.itemTable,
        recordId: id,
        recordLabel: String(item.idx),
        companyId: item.companyId,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(itemSnap(item), ITEM_AUDIT),
      })
      await sql`
        DELETE FROM sys_attachment WHERE owner_type=${spec.itemOwnerType} AND owner_id=${id}::uuid
      `.execute(trx)
      try {
        await sql`DELETE FROM ${ident(spec.itemTable)} WHERE id=${id}::uuid`.execute(trx)
      } catch (err) {
        throw mapOrderWrite('删除订单条目失败', err)
      }
    })
  }

  async function history(actor: Actor, side: TradingSide, orderId: string) {
    const spec = orderSpec(side)
    requirePerm(actor, spec.prefix, 'read', '无权限执行该订单操作')
    const head = await getHead(actor, side, orderId)
    void head
    // 收发货历史：销售读 sal_delivery_item；采购读 pur_receipt_item（标准段）
    if (side === 'sales') {
      const rows = await sql<Record<string, unknown>>`
        SELECT 'sales.delivery' AS flow_type, d.delivery_no AS document_no, d.delivery_date AS document_date,
          d.status, di.company_id, oi.order_id, di.order_item_id, di.material_code, di.material_name,
          di.material_spec, di.customer_part_no, di.unit_name, di.qty AS quantity
        FROM sal_delivery_item di
        JOIN sal_delivery d ON d.id=di.delivery_id
        JOIN sal_order_item oi ON oi.id=di.order_item_id
        WHERE oi.order_id=${orderId}::uuid
        ORDER BY d.delivery_date DESC, di.idx, di.id
      `.execute(db)
      return {
        results: rows.rows.map((r) => ({
          flowType: String(r.flow_type),
          documentNo: String(r.document_no),
          documentDate: asDate(r.document_date),
          status: upperStatus(String(r.status)),
          companyId: String(r.company_id),
          orderId: String(r.order_id),
          orderItemId: String(r.order_item_id),
          materialCode: String(r.material_code),
          materialName: String(r.material_name),
          materialSpec: asOptionalString(r.material_spec),
          customerPartNo: asOptionalString(r.customer_part_no),
          unitName: String(r.unit_name),
          quantity: wireRequiredDecimal(String(r.quantity)),
        })),
      }
    }
    const rows = await sql<Record<string, unknown>>`
      SELECT 'purchase.receipt' AS flow_type, d.receipt_no AS document_no, d.receipt_date AS document_date,
        d.status, di.company_id, oi.order_id, di.order_item_id, di.material_code, di.material_name,
        di.material_spec, di.customer_part_no, di.unit_name, di.qty AS quantity
      FROM pur_receipt_item di
      JOIN pur_receipt d ON d.id=di.receipt_id
      JOIN pur_order_item oi ON oi.id=di.order_item_id
      WHERE oi.order_id=${orderId}::uuid
      ORDER BY d.receipt_date DESC, di.idx, di.id
    `.execute(db)
    return {
      results: rows.rows.map((r) => ({
        flowType: String(r.flow_type),
        documentNo: String(r.document_no),
        documentDate: asDate(r.document_date),
        status: upperStatus(String(r.status)),
        companyId: String(r.company_id),
        orderId: String(r.order_id),
        orderItemId: String(r.order_item_id),
        materialCode: String(r.material_code),
        materialName: String(r.material_name),
        materialSpec: asOptionalString(r.material_spec),
        customerPartNo: asOptionalString(r.customer_part_no),
        unitName: String(r.unit_name),
        quantity: wireRequiredDecimal(String(r.quantity)),
      })),
    }
  }

  // --- purchase extras: materials / byproducts / demand pool / bom expand ---

  async function listMaterials(actor: Actor, query: Partial<ListQuery>) {
    requirePerm(actor, 'purchase.order', 'read', '无权限执行该采购订单操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as Record<string, unknown>[] }
    return listFromSource({
      db,
      resource: orderMaterialMeta(),
      source: sql` FROM (
        SELECT m.id,m.quantity,m.issued_qty,m.remarks,m.inserted_at,m.updated_at,m.order_item_id,
          m.company_id,m.material_id,mat.code AS material_code,mat.name AS material_name,mat.spec AS material_spec,
          m.unit_id,u.name AS unit_name,
          o.order_no,o.status AS order_status,o.is_outsourced AS order_is_outsourced,o.party_type,o.party_id,
          (m.quantity - m.issued_qty) AS remaining_issue_qty
        FROM pur_order_item_material m
        JOIN pur_order_item oi ON oi.id=m.order_item_id
        JOIN pur_order o ON o.id=oi.order_id
        JOIN inv_material mat ON mat.id=m.material_id
        JOIN bas_unit u ON u.id=m.unit_id
      ) order_item_materials`,
      select: sql`SELECT *`,
      defaultOrder: sql`"id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: (r) => mapMaterial(r),
    })
  }

  async function getMaterial(actor: Actor, id: string) {
    requirePerm(actor, 'purchase.order', 'read', '无权限执行该采购订单操作')
    const rows = await sql<Record<string, unknown>>`
      SELECT m.id,m.quantity,m.issued_qty,m.remarks,m.inserted_at,m.updated_at,m.order_item_id,
        m.company_id,m.material_id,mat.code AS material_code,mat.name AS material_name,mat.spec AS material_spec,
        m.unit_id,u.name AS unit_name,
        o.order_no,o.status AS order_status,o.is_outsourced AS order_is_outsourced,o.party_type,o.party_id,
        (m.quantity - m.issued_qty) AS remaining_issue_qty
      FROM pur_order_item_material m
      JOIN pur_order_item oi ON oi.id=m.order_item_id
      JOIN pur_order o ON o.id=oi.order_id
      JOIN inv_material mat ON mat.id=m.material_id
      JOIN bas_unit u ON u.id=m.unit_id
      WHERE m.id=${id}::uuid
    `.execute(db)
    if (!rows.rows[0] || !canAccessCompany(actor, String(rows.rows[0].company_id))) {
      throw new ApiError('not_found', '发料清单行不存在')
    }
    return mapMaterial(rows.rows[0])
  }

  async function createMaterial(
    actor: Actor,
    input: {
      orderItemId: string
      materialId: string
      unitId: string
      quantity: string
      remarks?: string | null
    },
  ) {
    requirePerm(actor, 'purchase.order', 'create', '无权限执行该采购订单操作')
    return withTx(db, async (trx) => {
      const parent = await lockPurchaseItemParent(trx, actor, input.orderItemId)
      if (!parent.isOutsourced) {
        throw ApiError.validation('发料清单参数不合法', { orderItemId: ['仅委外订单可维护发料清单'] })
      }
      const snap = await loadMaterialSnap(trx, input.materialId, input.unitId)
      const qty = decimal(input.quantity)
      if (!qty.isPositive()) {
        throw ApiError.validation('发料清单参数不合法', { quantity: ['必须大于 0'] })
      }
      const ins = await sql<{ id: string }>`
        INSERT INTO pur_order_item_material (
          quantity,remarks,order_item_id,company_id,material_id,unit_id
        ) VALUES (
          ${wireRequiredDecimal(qty)},${input.remarks ?? null},${input.orderItemId}::uuid,
          ${parent.companyId}::uuid,${input.materialId}::uuid,${input.unitId}::uuid
        ) RETURNING id
      `.execute(trx)
      const id = ins.rows[0]!.id
      const rows = await sql<Record<string, unknown>>`
        SELECT m.id,m.quantity,m.issued_qty,m.remarks,m.inserted_at,m.updated_at,m.order_item_id,
          m.company_id,m.material_id,mat.code AS material_code,mat.name AS material_name,mat.spec AS material_spec,
          m.unit_id,u.name AS unit_name,
          o.order_no,o.status AS order_status,o.is_outsourced AS order_is_outsourced,o.party_type,o.party_id,
          (m.quantity - m.issued_qty) AS remaining_issue_qty
        FROM pur_order_item_material m
        JOIN pur_order_item oi ON oi.id=m.order_item_id
        JOIN pur_order o ON o.id=oi.order_id
        JOIN inv_material mat ON mat.id=m.material_id
        JOIN bas_unit u ON u.id=m.unit_id
        WHERE m.id=${id}::uuid
      `.execute(trx)
      return mapMaterial(rows.rows[0]!)
    })
  }

  async function updateMaterial(
    actor: Actor,
    id: string,
    input: {
      materialId?: string
      unitId?: string
      quantity?: string
      remarks?: string | null
      remarksPresent?: boolean
    },
  ) {
    requirePerm(actor, 'purchase.order', 'update', '无权限执行该采购订单操作')
    return withTx(db, async (trx) => {
      const cur = await sql<{ order_item_id: string }>`
        SELECT order_item_id FROM pur_order_item_material WHERE id=${id}::uuid
      `.execute(trx)
      if (!cur.rows[0]) throw new ApiError('not_found', '发料清单行不存在')
      await lockPurchaseItemParent(trx, actor, cur.rows[0].order_item_id)
      const before = await getMaterial(actor, id)
      const materialId = input.materialId ?? before.materialId
      const unitId = input.unitId ?? before.unitId
      const snap = await loadMaterialSnap(trx, materialId, unitId)
      const quantity = input.quantity ?? before.quantity
      if (!decimal(quantity).isPositive()) {
        throw ApiError.validation('发料清单参数不合法', { quantity: ['必须大于 0'] })
      }
      await sql`
        UPDATE pur_order_item_material SET
          quantity=${quantity}, material_id=${materialId}::uuid, unit_id=${unitId}::uuid,
          remarks=${input.remarksPresent ? (input.remarks ?? null) : before.remarks},
          updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${id}::uuid
      `.execute(trx)
      const rows = await sql<Record<string, unknown>>`
        SELECT m.id,m.quantity,m.issued_qty,m.remarks,m.inserted_at,m.updated_at,m.order_item_id,
          m.company_id,m.material_id,mat.code AS material_code,mat.name AS material_name,mat.spec AS material_spec,
          m.unit_id,u.name AS unit_name,
          o.order_no,o.status AS order_status,o.is_outsourced AS order_is_outsourced,o.party_type,o.party_id,
          (m.quantity - m.issued_qty) AS remaining_issue_qty
        FROM pur_order_item_material m
        JOIN pur_order_item oi ON oi.id=m.order_item_id
        JOIN pur_order o ON o.id=oi.order_id
        JOIN inv_material mat ON mat.id=m.material_id
        JOIN bas_unit u ON u.id=m.unit_id
        WHERE m.id=${id}::uuid
      `.execute(trx)
      return mapMaterial(rows.rows[0]!)
    })
  }

  async function deleteMaterial(actor: Actor, id: string) {
    requirePerm(actor, 'purchase.order', 'delete', '无权限执行该采购订单操作')
    await withTx(db, async (trx) => {
      const cur = await sql<{ order_item_id: string }>`
        SELECT order_item_id FROM pur_order_item_material WHERE id=${id}::uuid
      `.execute(trx)
      if (!cur.rows[0]) throw new ApiError('not_found', '发料清单行不存在')
      await lockPurchaseItemParent(trx, actor, cur.rows[0].order_item_id)
      await sql`DELETE FROM pur_order_item_material WHERE id=${id}::uuid`.execute(trx)
    })
  }

  async function listByproducts(actor: Actor, query: Partial<ListQuery>) {
    requirePerm(actor, 'purchase.order', 'read', '无权限执行该采购订单操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as Record<string, unknown>[] }
    return listFromSource({
      db,
      resource: orderByproductMeta(),
      source: sql` FROM (
        SELECT b.id,b.quantity,b.remarks,b.inserted_at,b.updated_at,b.order_item_id,b.company_id,
          b.material_id,mat.code AS material_code,mat.name AS material_name,mat.spec AS material_spec,
          b.unit_id,u.name AS unit_name
        FROM pur_order_item_byproduct b
        JOIN inv_material mat ON mat.id=b.material_id
        JOIN bas_unit u ON u.id=b.unit_id
      ) order_item_byproducts`,
      select: sql`SELECT *`,
      defaultOrder: sql`"id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: (r) => mapByproduct(r),
    })
  }

  async function getByproduct(actor: Actor, id: string) {
    requirePerm(actor, 'purchase.order', 'read', '无权限执行该采购订单操作')
    const rows = await sql<Record<string, unknown>>`
      SELECT b.id,b.quantity,b.remarks,b.inserted_at,b.updated_at,b.order_item_id,b.company_id,
        b.material_id,mat.code AS material_code,mat.name AS material_name,mat.spec AS material_spec,
        b.unit_id,u.name AS unit_name
      FROM pur_order_item_byproduct b
      JOIN inv_material mat ON mat.id=b.material_id
      JOIN bas_unit u ON u.id=b.unit_id
      WHERE b.id=${id}::uuid
    `.execute(db)
    if (!rows.rows[0] || !canAccessCompany(actor, String(rows.rows[0].company_id))) {
      throw new ApiError('not_found', '副产物清单行不存在')
    }
    return mapByproduct(rows.rows[0])
  }

  async function createByproduct(
    actor: Actor,
    input: {
      orderItemId: string
      materialId: string
      unitId: string
      quantity: string
      remarks?: string | null
    },
  ) {
    requirePerm(actor, 'purchase.order', 'create', '无权限执行该采购订单操作')
    return withTx(db, async (trx) => {
      const parent = await lockPurchaseItemParent(trx, actor, input.orderItemId)
      if (!parent.isOutsourced) {
        throw ApiError.validation('副产物清单参数不合法', {
          orderItemId: ['仅委外订单可维护副产物清单'],
        })
      }
      const snap = await loadMaterialSnap(trx, input.materialId, input.unitId)
      const qty = decimal(input.quantity)
      if (!qty.isPositive()) {
        throw ApiError.validation('副产物清单参数不合法', { quantity: ['必须大于 0'] })
      }
      const ins = await sql<{ id: string }>`
        INSERT INTO pur_order_item_byproduct (
          quantity,remarks,order_item_id,company_id,material_id,unit_id
        ) VALUES (
          ${wireRequiredDecimal(qty)},${input.remarks ?? null},${input.orderItemId}::uuid,
          ${parent.companyId}::uuid,${input.materialId}::uuid,${input.unitId}::uuid
        ) RETURNING id
      `.execute(trx)
      const id = ins.rows[0]!.id
      const rows = await sql<Record<string, unknown>>`
        SELECT b.id,b.quantity,b.remarks,b.inserted_at,b.updated_at,b.order_item_id,b.company_id,
          b.material_id,mat.code AS material_code,mat.name AS material_name,mat.spec AS material_spec,
          b.unit_id,u.name AS unit_name
        FROM pur_order_item_byproduct b
        JOIN inv_material mat ON mat.id=b.material_id
        JOIN bas_unit u ON u.id=b.unit_id
        WHERE b.id=${id}::uuid
      `.execute(trx)
      return mapByproduct(rows.rows[0]!)
    })
  }

  async function updateByproduct(
    actor: Actor,
    id: string,
    input: {
      materialId?: string
      unitId?: string
      quantity?: string
      remarks?: string | null
      remarksPresent?: boolean
    },
  ) {
    requirePerm(actor, 'purchase.order', 'update', '无权限执行该采购订单操作')
    return withTx(db, async (trx) => {
      const cur = await sql<{ order_item_id: string }>`
        SELECT order_item_id FROM pur_order_item_byproduct WHERE id=${id}::uuid
      `.execute(trx)
      if (!cur.rows[0]) throw new ApiError('not_found', '副产物清单行不存在')
      await lockPurchaseItemParent(trx, actor, cur.rows[0].order_item_id)
      const before = await getByproduct(actor, id)
      const materialId = input.materialId ?? before.materialId
      const unitId = input.unitId ?? before.unitId
      const snap = await loadMaterialSnap(trx, materialId, unitId)
      const quantity = input.quantity ?? before.quantity
      await sql`
        UPDATE pur_order_item_byproduct SET
          quantity=${quantity}, material_id=${materialId}::uuid, unit_id=${unitId}::uuid,
          remarks=${input.remarksPresent ? (input.remarks ?? null) : before.remarks},
          updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${id}::uuid
      `.execute(trx)
      return getByproduct(actor, id)
    })
  }

  async function deleteByproduct(actor: Actor, id: string) {
    requirePerm(actor, 'purchase.order', 'delete', '无权限执行该采购订单操作')
    await withTx(db, async (trx) => {
      const cur = await sql<{ order_item_id: string }>`
        SELECT order_item_id FROM pur_order_item_byproduct WHERE id=${id}::uuid
      `.execute(trx)
      if (!cur.rows[0]) throw new ApiError('not_found', '副产物清单行不存在')
      await lockPurchaseItemParent(trx, actor, cur.rows[0].order_item_id)
      await sql`DELETE FROM pur_order_item_byproduct WHERE id=${id}::uuid`.execute(trx)
    })
  }

  async function queryDemandPool(
    actor: Actor,
    input: { companyId: string; isOutsourced?: boolean; limit?: number },
  ) {
    requirePerm(actor, 'purchase.order', 'read', '无权限执行该采购订单操作')
    if (!canAccessCompany(actor, input.companyId)) {
      throw new ApiError('not_found', '公司不存在')
    }
    const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 200) : 50
    const rows = await sql<Record<string, unknown>>`
      SELECT dl.id, dl.demand_id, d.demand_no, dl.idx, dl.need_date, d.company_id,
        dl.material_id, dl.unit_id, m.code AS material_code, m.name AS material_name, m.spec AS material_spec,
        u.name AS unit_name, dl.base_qty, dl.ordered_qty,
        (dl.base_qty - dl.ordered_qty) AS remaining_base_qty,
        (dl.base_qty - dl.ordered_qty) AS suggested_qty
      FROM mfg_demand_item dl
      JOIN mfg_demand d ON d.id=dl.demand_id
      JOIN inv_material m ON m.id=dl.material_id
      JOIN bas_unit u ON u.id=dl.unit_id
      WHERE d.company_id=${input.companyId}::uuid
        AND d.status IN ('audited','confirmed')
        AND (dl.base_qty - dl.ordered_qty) > 0
      ORDER BY dl.need_date NULLS LAST, dl.idx, dl.id
      LIMIT ${limit}
    `.execute(db)
    return {
      results: rows.rows.map((r) => ({
        id: String(r.id),
        demandId: String(r.demand_id),
        demandNo: String(r.demand_no),
        idx: Number(r.idx),
        needDate: r.need_date ? asDate(r.need_date) : null,
        companyId: String(r.company_id),
        materialId: String(r.material_id),
        unitId: String(r.unit_id),
        materialCode: String(r.material_code),
        materialName: String(r.material_name),
        materialSpec: asOptionalString(r.material_spec),
        unitName: String(r.unit_name),
        baseQty: wireRequiredDecimal(String(r.base_qty)),
        orderedQty: wireRequiredDecimal(String(r.ordered_qty)),
        remainingBaseQty: wireRequiredDecimal(String(r.remaining_base_qty)),
        suggestedQty: wireRequiredDecimal(String(r.suggested_qty)),
      })),
    }
  }

  async function expandBom(
    actor: Actor,
    input: { bomId: string; quantity: string },
  ) {
    requirePerm(actor, 'purchase.order', 'read', '无权限执行该采购订单操作')
    const qty = decimal(input.quantity)
    if (!qty.isPositive()) {
      throw ApiError.validation('BOM 展开参数不合法', { quantity: ['必须大于 0'] })
    }
    const bom = await sql<{ id: string }>`SELECT id FROM mfg_bom WHERE id=${input.bomId}::uuid`.execute(db)
    if (!bom.rows[0]) {
      throw ApiError.validation('BOM 展开参数不合法', { bomId: ['BOM 不存在'] })
    }
    const materials = await sql<Record<string, unknown>>`
      SELECT c.material_id, m.code AS material_code, m.name AS material_name, c.unit_id, u.name AS unit_name,
        (c.quantity * (1 + coalesce(c.loss_rate,0)) * ${wireRequiredDecimal(qty)}) AS quantity,
        c.note AS remarks
      FROM mfg_bom_component c
      JOIN inv_material m ON m.id=c.material_id
      JOIN bas_unit u ON u.id=c.unit_id
      WHERE c.bom_id=${input.bomId}::uuid
      ORDER BY c.id
    `.execute(db)
    const byproducts = await sql<Record<string, unknown>>`
      SELECT b.material_id, m.code AS material_code, m.name AS material_name, b.unit_id, u.name AS unit_name,
        (b.quantity * ${wireRequiredDecimal(qty)}) AS quantity, b.note AS remarks
      FROM mfg_bom_byproduct b
      JOIN inv_material m ON m.id=b.material_id
      JOIN bas_unit u ON u.id=b.unit_id
      WHERE b.bom_id=${input.bomId}::uuid
      ORDER BY b.id
    `.execute(db)
    const mapLine = (r: Record<string, unknown>) => ({
      materialId: String(r.material_id),
      materialCode: String(r.material_code),
      materialName: String(r.material_name),
      unitId: String(r.unit_id),
      unitName: String(r.unit_name),
      quantity: wireRequiredDecimal(String(r.quantity)),
      remarks: asOptionalString(r.remarks),
    })
    return {
      materials: materials.rows.map(mapLine),
      byproducts: byproducts.rows.map(mapLine),
    }
  }

  return {
    listHeads,
    getHead,
    createHead,
    updateHead,
    deleteHead,
    audit: (a: Actor, s: TradingSide, id: string) => transition(a, s, id, 'audit'),
    close: (a: Actor, s: TradingSide, id: string) => transition(a, s, id, 'close'),
    void: (a: Actor, s: TradingSide, id: string) => transition(a, s, id, 'void'),
    listItems,
    getItem,
    createItem,
    updateItem,
    deleteItem,
    history,
    listMaterials,
    getMaterial,
    createMaterial,
    updateMaterial,
    deleteMaterial,
    listByproducts,
    getByproduct,
    createByproduct,
    updateByproduct,
    deleteByproduct,
    queryDemandPool,
    expandBom,
    postFulfillment: (trx: DbHandle, side: TradingSide, input: FulfillmentInput) =>
      postFulfillment(trx, side, input),
    reverseFulfillment: (trx: DbHandle, side: TradingSide, input: FulfillmentInput) =>
      reverseFulfillment(trx, side, input),
    postOutsourcedIssue: (trx: DbHandle, input: OutsourcedIssueInput) =>
      postOutsourcedIssue(trx, input),
    reverseOutsourcedIssue: (trx: DbHandle, input: OutsourcedIssueInput) =>
      reverseOutsourcedIssue(trx, input),
  }
}

export type OrderService = ReturnType<typeof createOrderService>

// ---- helpers ----

function validateOrderShape(
  spec: OrderSideSpec,
  v: {
    orderNo: string
    orderDate: string
    orderType: string
    partyType: string
    partyId: string
    companyId: string
    currencyId: string
    exchangeRate: Decimal
    remarks: string | null
  },
) {
  const fields: Record<string, string[]> = {}
  if (!v.orderNo.trim() || runeLen(v.orderNo) > 32) fields.orderNo = ['不能为空且最多 32 个字符']
  if (!v.orderDate) fields.orderDate = ['必填']
  const ot = v.orderType.toUpperCase()
  if (ot !== 'REGULAR' && ot !== spec.nonRegularType) fields.orderType = ['订单类型不合法']
  if (!spec.allowedParty.has(lowerParty(v.partyType))) fields.partyType = ['对手类型不合法']
  if (!v.partyId) fields.partyId = ['必填']
  if (!v.companyId) fields.companyId = ['必填']
  if (!v.currencyId) fields.currencyId = ['必填']
  if (lowerParty(v.partyType) === 'company' && v.partyId === v.companyId) {
    fields.partyId = ['对手不能是本公司']
  }
  if (!v.exchangeRate.gt(0)) fields.exchangeRate = ['必须大于 0']
  if (v.remarks && runeLen(v.remarks) > 512) fields.remarks = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation(`${spec.label}参数不合法`, fields)
  }
}

async function normalizeCurrency(
  db: DbHandle,
  companyId: string,
  currencyId: string | null,
  exchangeRate: string | null,
): Promise<{ currencyId: string; exchangeRate: Decimal }> {
  const company = await db
    .selectFrom('bas_company')
    .select('base_currency_id')
    .where('id', '=', companyId)
    .executeTakeFirst()
  if (!company) {
    throw ApiError.validation('订单参数不合法', { companyId: ['公司不存在'] })
  }
  const chosen = currencyId ?? company.base_currency_id
  if (chosen === company.base_currency_id) {
    return { currencyId: chosen, exchangeRate: decimal(1) }
  }
  if (exchangeRate === null || exchangeRate === undefined || exchangeRate === '') {
    throw ApiError.validation('订单参数不合法', { exchangeRate: ['外币订单必须填写汇率'] })
  }
  const rate = decimal(exchangeRate)
  if (!rate.gt(0)) {
    throw ApiError.validation('订单参数不合法', { exchangeRate: ['必须大于 0'] })
  }
  return { currencyId: chosen, exchangeRate: rate }
}

async function lockOrder(
  db: DbHandle,
  actor: Actor,
  spec: OrderSideSpec,
  id: string,
): Promise<Record<string, unknown>> {
  const outsourcedCol = spec.side === 'purchase' ? 'o.is_outsourced' : 'false'
  const rows = await sql<Record<string, unknown>>`
    SELECT o.id,o.order_no,o.order_date,o.order_type,${sql.raw(outsourcedCol)} AS is_outsourced,
      o.party_type,o.party_id,o.exchange_rate,o.terms,o.remarks,o.status,o.audited_at,
      o.inserted_at,o.updated_at,o.company_id,o.currency_id,o.created_by_id,o.audited_by_id,
      coalesce((SELECT sum(i.amount) FROM ${ident(spec.itemTable)} i WHERE i.order_id=o.id),0) AS gross_total,
      coalesce((SELECT sum(i.base_amount) FROM ${ident(spec.itemTable)} i WHERE i.order_id=o.id),0) AS base_gross_total,
      c.name AS company_name,cur.iso_code AS currency_code,cur.name AS currency_name,
      creator.name AS created_by_name,auditor.name AS audited_by_name
    FROM ${ident(spec.headTable)} o
    JOIN bas_company c ON c.id=o.company_id
    JOIN bas_currency cur ON cur.id=o.currency_id
    LEFT JOIN sys_user creator ON creator.id=o.created_by_id
    LEFT JOIN sys_user auditor ON auditor.id=o.audited_by_id
    WHERE o.id=${id}::uuid
    FOR UPDATE OF o
  `.execute(db)
  const row = rows.rows[0]
  if (!row || !canAccessCompany(actor, String(row.company_id))) {
    throw new ApiError('not_found', `${spec.label}不存在`)
  }
  return row
}

async function loadHead(db: DbHandle, spec: OrderSideSpec, id: string) {
  const outsourcedCol = spec.side === 'purchase' ? 'o.is_outsourced' : 'false'
  const rows = await sql<Record<string, unknown>>`
    SELECT o.id,o.order_no,o.order_date,o.order_type,${sql.raw(outsourcedCol)} AS is_outsourced,
      o.party_type,o.party_id,o.exchange_rate,o.terms,o.remarks,o.status,o.audited_at,
      o.inserted_at,o.updated_at,o.company_id,o.currency_id,o.created_by_id,o.audited_by_id,
      coalesce((SELECT sum(i.amount) FROM ${ident(spec.itemTable)} i WHERE i.order_id=o.id),0) AS gross_total,
      coalesce((SELECT sum(i.base_amount) FROM ${ident(spec.itemTable)} i WHERE i.order_id=o.id),0) AS base_gross_total,
      c.name AS company_name,cur.iso_code AS currency_code,cur.name AS currency_name,
      creator.name AS created_by_name,auditor.name AS audited_by_name
    FROM ${ident(spec.headTable)} o
    JOIN bas_company c ON c.id=o.company_id
    JOIN bas_currency cur ON cur.id=o.currency_id
    LEFT JOIN sys_user creator ON creator.id=o.created_by_id
    LEFT JOIN sys_user auditor ON auditor.id=o.audited_by_id
    WHERE o.id=${id}::uuid
  `.execute(db)
  return rows.rows[0]
}

async function loadItem(
  db: DbHandle,
  spec: OrderSideSpec,
  side: TradingSide,
  id: string,
) {
  const proj = spec.projectionColumn
  const extra =
    side === 'purchase'
      ? `,i.bom_id,i.demand_line_id,i.demand_date,o.is_outsourced AS order_is_outsourced,
         bom.code AS bom_code,bom.plan_name AS bom_plan_name,d.demand_no`
      : ',null::uuid AS bom_id,null::uuid AS demand_line_id,null::date AS demand_date,false AS order_is_outsourced,null::text AS bom_code,null::text AS bom_plan_name,null::text AS demand_no'
  const joins =
    side === 'purchase'
      ? `LEFT JOIN mfg_bom bom ON bom.id=i.bom_id
         LEFT JOIN mfg_demand_item dl ON dl.id=i.demand_line_id
         LEFT JOIN mfg_demand d ON d.id=dl.demand_id`
      : ''
  const rows = await sql<Record<string, unknown>>`
    SELECT i.id,i.idx,i.qty,i.base_qty,i.${sql.raw(proj)} AS projection_qty,i.price,i.amount,
      i.base_price,i.base_amount,i.tax_rate,i.material_code,i.material_name,i.material_spec,
      i.customer_part_no,i.unit_name,i.remarks,i.inserted_at,i.updated_at,i.order_id,i.company_id,
      i.material_id,i.unit_id,i.quotation_item_id,
      o.order_no,o.order_date,o.status AS order_status,o.party_type,o.party_id,
      cur.iso_code AS currency_code,c.name AS company_name,m.name AS material_live_name,
      u.name AS unit_live_name,qi.pricing_mode
      ${sql.raw(extra)}
    FROM ${ident(spec.itemTable)} i
    JOIN ${ident(spec.headTable)} o ON o.id=i.order_id
    JOIN bas_company c ON c.id=i.company_id
    JOIN bas_currency cur ON cur.id=o.currency_id
    JOIN inv_material m ON m.id=i.material_id
    JOIN bas_unit u ON u.id=i.unit_id
    LEFT JOIN ${ident(side === 'sales' ? 'sal_quotation_item' : 'pur_quotation_item')} qi ON qi.id=i.quotation_item_id
    ${sql.raw(joins)}
    WHERE i.id=${id}::uuid
  `.execute(db)
  return rows.rows[0]
}

interface DerivedItem {
  idx: number
  qty: Decimal
  baseQty: Decimal
  price: Decimal
  amount: Decimal
  basePrice: Decimal
  baseAmount: Decimal
  taxRate: Decimal
  materialId: string
  unitId: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  customerPartNo: string | null
  unitName: string
  remarks: string | null
  quotationItemId: string | null
  bomId: string | null
  demandLineId: string | null
  demandDate: string | null
}

async function deriveAndValidateItem(
  db: DbHandle,
  quotations: QuotationService,
  spec: OrderSideSpec,
  parent: Record<string, unknown>,
  draft: {
    idx: number
    qty: Decimal
    materialId: string
    unitId: string
    price: Decimal
    taxRate: Decimal
    taxExplicit: boolean
    remarks: string | null
    quotationItemId: string | null
    bomId: string | null
    demandLineId: string | null
    demandDate: string | null
  },
): Promise<DerivedItem> {
  const fields: Record<string, string[]> = {}
  if (!draft.qty.gt(0)) fields.qty = ['必须大于 0']
  if (draft.remarks && runeLen(draft.remarks) > 512) fields.remarks = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('订单条目参数不合法', fields)
  }
  let materialId = draft.materialId
  let unitId = draft.unitId
  let price = draft.price
  let taxRate = draft.taxRate
  const orderType = String(parent.order_type).toLowerCase()
  if (orderType === 'regular') {
    if (!draft.quotationItemId) {
      throw ApiError.validation('订单条目参数不合法', {
        quotationItemId: ['常规订单条目必须选择报价条目'],
      })
    }
    const resolved = await quotations.resolveForOrder(db, spec.side, {
      quotationItemId: draft.quotationItemId,
      orderDate: asDate(parent.order_date),
      companyId: String(parent.company_id),
      partyType: String(parent.party_type),
      partyId: String(parent.party_id),
      currencyId: String(parent.currency_id),
      qty: draft.qty,
    })
    materialId = resolved.materialId
    unitId = resolved.unitId
    price = resolved.price
    if (!draft.taxExplicit) taxRate = resolved.taxRate
  } else {
    if (draft.quotationItemId) {
      throw ApiError.validation('订单条目参数不合法', {
        quotationItemId: ['非常规订单不得选择报价条目'],
      })
    }
    const maxRows = await sql<{ m: string }>`
      SELECT ${sql.raw(spec.nonRegularSetting)}::text AS m FROM sal_setting LIMIT 1
    `.execute(db)
    const maximum = decimal(maxRows.rows[0]?.m ?? '100')
    if (draft.qty.gt(maximum)) {
      throw ApiError.validation('订单条目参数不合法', {
        qty: ['超过非常规订单单行数量上限'],
      })
    }
  }
  if (!materialId) fields.materialId = ['必填']
  if (!unitId) fields.unitId = ['必填']
  if (price.isNegative()) fields.price = ['不能小于 0']
  if (taxRate.isNegative() || taxRate.gte(1)) fields.taxRate = ['必须在 0(含)与 1 之间']
  if (spec.side === 'sales' && (draft.bomId || draft.demandLineId || draft.demandDate)) {
    fields.orderItem = ['销售订单条目不支持采购扩展字段']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('订单条目参数不合法', fields)
  }
  const snap = await loadMaterialSnap(db, materialId, unitId)
  guardCustomerMaterial(spec.side, String(parent.party_type), String(parent.party_id), snap)
  if (spec.side === 'purchase' && draft.bomId) {
    const bom = await sql<{ material_id: string }>`
      SELECT material_id FROM mfg_bom WHERE id=${draft.bomId}::uuid
    `.execute(db)
    if (!bom.rows[0]) {
      throw ApiError.validation('订单条目参数不合法', { bomId: ['BOM 不存在'] })
    }
    if (bom.rows[0].material_id !== materialId) {
      throw ApiError.validation('订单条目参数不合法', {
        bomId: ['BOM 必须是条目物料自身的 BOM'],
      })
    }
  }
  const baseQty = convertToBaseQty(draft.qty, unitId, snap)
  const amounts = deriveItemAmounts(draft.qty, price, String(parent.exchange_rate))
  return {
    idx: draft.idx,
    qty: draft.qty,
    baseQty,
    price,
    amount: amounts.amount,
    basePrice: amounts.basePrice,
    baseAmount: amounts.baseAmount,
    taxRate,
    materialId,
    unitId,
    materialCode: snap.code,
    materialName: snap.name,
    materialSpec: snap.spec,
    customerPartNo: snap.customerPartNo,
    unitName: snap.unitName,
    remarks: draft.remarks,
    quotationItemId: draft.quotationItemId,
    bomId: draft.bomId,
    demandLineId: draft.demandLineId,
    demandDate: draft.demandDate ? toDateOnly(draft.demandDate) : null,
  }
}

async function verifyItems(
  db: DbHandle,
  quotations: QuotationService,
  spec: OrderSideSpec,
  parent: Record<string, unknown>,
) {
  const rows = await sql<{ id: string; idx: number; qty: string; material_id: string; unit_id: string; price: string; quotation_item_id: string | null }>`
    SELECT id, idx, qty::text AS qty, material_id, unit_id, price::text AS price, quotation_item_id
    FROM ${ident(spec.itemTable)} WHERE order_id=${String(parent.id)}::uuid ORDER BY idx, id
  `.execute(db)
  if (rows.rows.length === 0) {
    throw new ApiError('conflict', '订单至少需要一条条目')
  }
  const orderType = String(parent.order_type).toLowerCase()
  for (const row of rows.rows) {
    if (orderType === 'regular') {
      if (!row.quotation_item_id) {
        throw new ApiError('conflict', `第${row.idx}行:缺少报价条目`)
      }
      try {
        const resolved = await quotations.resolveForOrder(db, spec.side, {
          quotationItemId: row.quotation_item_id,
          orderDate: asDate(parent.order_date),
          companyId: String(parent.company_id),
          partyType: String(parent.party_type),
          partyId: String(parent.party_id),
          currencyId: String(parent.currency_id),
          qty: row.qty,
        })
        if (
          resolved.materialId !== row.material_id ||
          resolved.unitId !== row.unit_id ||
          !resolved.price.equals(decimal(row.price))
        ) {
          throw new ApiError('conflict', `第${row.idx}行:单价或报价派生信息与当前报价不一致`)
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'conflict') {
          const msg = err.message.startsWith('第') ? err.message : `第${row.idx}行:${err.message}`
          throw new ApiError('conflict', msg)
        }
        throw err
      }
    } else {
      if (row.quotation_item_id) {
        throw new ApiError('conflict', `第${row.idx}行:非常规订单不得引用报价条目`)
      }
      const maxRows = await sql<{ m: string }>`
        SELECT ${sql.raw(spec.nonRegularSetting)}::text AS m FROM sal_setting LIMIT 1
      `.execute(db)
      if (decimal(row.qty).gt(decimal(maxRows.rows[0]?.m ?? '100'))) {
        throw new ApiError('conflict', `第${row.idx}行:数量超过当前上限`)
      }
    }
  }
}

async function ensureVoidable(db: DbHandle, side: TradingSide, orderId: string) {
  let blocked = false
  if (side === 'sales') {
    const r = await sql<{ e: boolean }>`
      SELECT EXISTS(
        SELECT 1 FROM sal_delivery_item i
        JOIN sal_delivery d ON d.id=i.delivery_id
        JOIN sal_order_item oi ON oi.id=i.order_item_id
        WHERE oi.order_id=${orderId}::uuid AND d.status IN ('draft','audited')
      ) AS e
    `.execute(db)
    blocked = Boolean(r.rows[0]?.e)
  } else {
    const r = await sql<{ e: boolean }>`
      SELECT EXISTS(
        SELECT 1 FROM pur_receipt_item i
        JOIN pur_receipt d ON d.id=i.receipt_id
        JOIN pur_order_item oi ON oi.id=i.order_item_id
        WHERE oi.order_id=${orderId}::uuid AND d.status IN ('draft','audited')
      ) AS e
    `.execute(db)
    blocked = Boolean(r.rows[0]?.e)
  }
  if (blocked) {
    throw new ApiError('conflict', '订单存在未删除或已审核的下游单据,不可作废')
  }
}

async function adjustDemandOnAudit(db: DbHandle, orderId: string, occupy: boolean) {
  const rows = await sql<{ demand_line_id: string | null; base_qty: string }>`
    SELECT demand_line_id, base_qty::text AS base_qty
    FROM pur_order_item WHERE order_id=${orderId}::uuid AND demand_line_id IS NOT NULL
  `.execute(db)
  for (const row of rows.rows) {
    if (!row.demand_line_id) continue
    const delta = occupy ? decimal(row.base_qty) : decimal(row.base_qty).neg()
    await sql`
      UPDATE mfg_demand_item
      SET ordered_qty = ordered_qty + ${wireRequiredDecimal(delta)},
          updated_at=(now() AT TIME ZONE 'utc')
      WHERE id=${row.demand_line_id}::uuid
    `.execute(db)
  }
}

async function lockPurchaseItemParent(
  db: DbHandle,
  actor: Actor,
  orderItemId: string,
): Promise<{ companyId: string; isOutsourced: boolean; status: string }> {
  const rows = await sql<{
    company_id: string
    is_outsourced: boolean
    status: string
    order_id: string
  }>`
    SELECT o.company_id, o.is_outsourced, o.status, o.id AS order_id
    FROM pur_order_item oi
    JOIN pur_order o ON o.id=oi.order_id
    WHERE oi.id=${orderItemId}::uuid
    FOR UPDATE OF o
  `.execute(db)
  const row = rows.rows[0]
  if (!row || !canAccessCompany(actor, row.company_id)) {
    throw new ApiError('not_found', '订单条目不存在')
  }
  if (row.status.toLowerCase() !== 'draft') {
    throw new ApiError('conflict', '仅草稿订单可编辑条目')
  }
  return {
    companyId: row.company_id,
    isOutsourced: row.is_outsourced,
    status: row.status,
  }
}

function mapHead(row: Record<string, unknown>): Order {
  const id = String(row.id)
  const companyId = String(row.company_id)
  const currencyId = String(row.currency_id)
  const createdById = row.created_by_id ? String(row.created_by_id) : null
  const auditedById = row.audited_by_id ? String(row.audited_by_id) : null
  return {
    id,
    orderNo: String(row.order_no),
    orderDate: asDate(row.order_date),
    orderType: upperStatus(String(row.order_type)),
    isOutsourced: Boolean(row.is_outsourced),
    partyType: upperStatus(String(row.party_type)),
    partyId: String(row.party_id),
    exchangeRate: wireRequiredDecimal(String(row.exchange_rate)),
    terms: asOptionalString(row.terms),
    remarks: asOptionalString(row.remarks),
    status: upperStatus(String(row.status)),
    auditedAt: asDateTime(row.audited_at),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    companyId,
    currencyId,
    createdById,
    auditedById,
    grossTotal: wireRequiredDecimal(String(row.gross_total ?? 0)),
    baseGrossTotal: wireRequiredDecimal(String(row.base_gross_total ?? 0)),
    company: namedRef(companyId, String(row.company_name)),
    currency: codeNamedRef(currencyId, String(row.currency_code), String(row.currency_name)),
    createdBy: createdById ? namedRef(createdById, String(row.created_by_name ?? '')) : null,
    auditedBy: auditedById ? namedRef(auditedById, String(row.audited_by_name ?? '')) : null,
  }
}

function mapItem(side: TradingSide, row: Record<string, unknown>): OrderItem {
  const id = String(row.id)
  const companyId = String(row.company_id)
  const materialId = String(row.material_id)
  const unitId = String(row.unit_id)
  const orderId = String(row.order_id)
  const baseQty = decimal(String(row.base_qty))
  const projection = decimal(String(row.projection_qty ?? 0))
  const remaining = baseQty.sub(projection)
  const item: OrderItem = {
    id,
    idx: Number(row.idx),
    qty: wireRequiredDecimal(String(row.qty)),
    baseQty: wireRequiredDecimal(baseQty),
    price: wireRequiredDecimal(String(row.price)),
    amount: wireRequiredDecimal(String(row.amount)),
    basePrice: wireRequiredDecimal(String(row.base_price)),
    baseAmount: wireRequiredDecimal(String(row.base_amount)),
    taxRate: wireRequiredDecimal(String(row.tax_rate)),
    materialCode: String(row.material_code),
    materialName: String(row.material_name),
    materialSpec: asOptionalString(row.material_spec),
    customerPartNo: asOptionalString(row.customer_part_no),
    unitName: String(row.unit_name),
    remarks: asOptionalString(row.remarks),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    orderId,
    companyId,
    materialId,
    unitId,
    quotationItemId: row.quotation_item_id ? String(row.quotation_item_id) : null,
    pricingMode: row.pricing_mode ? upperStatus(String(row.pricing_mode)) : null,
    orderNo: String(row.order_no),
    orderDate: asDate(row.order_date),
    orderStatus: upperStatus(String(row.order_status)),
    partyType: upperStatus(String(row.party_type)),
    partyId: String(row.party_id),
    currencyCode: String(row.currency_code),
    remainingBaseQty: wireRequiredDecimal(remaining),
    order: { id: orderId, orderNo: String(row.order_no) },
    company: namedRef(companyId, String(row.company_name)),
    material: codeNamedRef(
      materialId,
      String(row.material_code),
      String(row.material_live_name ?? row.material_name),
    ),
    unit: namedRef(unitId, String(row.unit_live_name ?? row.unit_name)),
  }
  if (side === 'sales') item.shippedQty = wireRequiredDecimal(projection)
  else {
    item.receivedQty = wireRequiredDecimal(projection)
    item.bomId = row.bom_id ? String(row.bom_id) : null
    item.bomCode = asOptionalString(row.bom_code)
    item.bomPlanName = asOptionalString(row.bom_plan_name)
    item.demandLineId = row.demand_line_id ? String(row.demand_line_id) : null
    item.demandNo = asOptionalString(row.demand_no)
    item.demandDate = row.demand_date ? asDate(row.demand_date) : null
    item.orderIsOutsourced = Boolean(row.order_is_outsourced)
  }
  return item
}

function mapMaterial(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    quantity: wireRequiredDecimal(String(row.quantity)),
    issuedQty: wireRequiredDecimal(String(row.issued_qty ?? 0)),
    remarks: asOptionalString(row.remarks),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    orderItemId: String(row.order_item_id),
    companyId: String(row.company_id),
    materialId: String(row.material_id),
    materialCode: String(row.material_code),
    materialName: String(row.material_name),
    materialSpec: asOptionalString(row.material_spec),
    unitId: String(row.unit_id),
    unitName: String(row.unit_name),
    orderNo: String(row.order_no ?? ''),
    orderStatus: upperStatus(String(row.order_status ?? 'DRAFT')),
    orderIsOutsourced: Boolean(row.order_is_outsourced),
    partyType: upperStatus(String(row.party_type ?? '')),
    partyId: String(row.party_id ?? ''),
    remainingIssueQty: wireRequiredDecimal(String(row.remaining_issue_qty ?? 0)),
  }
}

function mapByproduct(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    quantity: wireRequiredDecimal(String(row.quantity)),
    remarks: asOptionalString(row.remarks),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    orderItemId: String(row.order_item_id),
    companyId: String(row.company_id),
    materialId: String(row.material_id),
    materialCode: String(row.material_code),
    materialName: String(row.material_name),
    materialSpec: asOptionalString(row.material_spec),
    unitId: String(row.unit_id),
    unitName: String(row.unit_name),
  }
}

function headSnap(item: Order): Record<string, unknown> {
  return {
    order_no: item.orderNo,
    order_date: item.orderDate,
    order_type: item.orderType,
    is_outsourced: item.isOutsourced,
    party_type: item.partyType,
    party_id: item.partyId,
    exchange_rate: item.exchangeRate,
    terms: item.terms,
    remarks: item.remarks,
    status: item.status,
    audited_at: item.auditedAt,
    company_id: item.companyId,
    currency_id: item.currencyId,
    created_by_id: item.createdById,
    audited_by_id: item.auditedById,
  }
}

function itemSnap(item: OrderItem): Record<string, unknown> {
  return {
    idx: item.idx,
    qty: item.qty,
    base_qty: item.baseQty,
    price: item.price,
    amount: item.amount,
    base_price: item.basePrice,
    base_amount: item.baseAmount,
    tax_rate: item.taxRate,
    material_code: item.materialCode,
    material_name: item.materialName,
    material_spec: item.materialSpec,
    customer_part_no: item.customerPartNo,
    unit_name: item.unitName,
    remarks: item.remarks,
    demand_date: item.demandDate ?? null,
    order_id: item.orderId,
    company_id: item.companyId,
    material_id: item.materialId,
    unit_id: item.unitId,
    quotation_item_id: item.quotationItemId,
    bom_id: item.bomId ?? null,
    demand_line_id: item.demandLineId ?? null,
  }
}

function mapOrderWrite(message: string, err: unknown): ApiError {
  return mapWriteError(err, message, [
    { code: '23505', constraint: 'order_unique_order_no', message: '订单号已存在' },
    { code: '23505', message: '订单数据已存在' },
    { code: '23503', message: '订单数据已被业务引用,不可删除' },
  ])
}
