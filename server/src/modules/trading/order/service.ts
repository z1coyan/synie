/**
 * 销售/采购订单：头/条目/状态机/报价套档/样品限量。
 *
 * W3 聚合迁移：create/update 整单草稿与子行由 platform/standard 派生——
 * 头 createStandardService + 条目 createStandardChildService + createAggregateService；
 * audit/close/void → workflow（D7）；审核 effect 报价复核/采购占量。
 * OutsourcedDraftPort 保留：委外发料/副产物子树仍走 outsourced-config.draft。
 * 路由手写（URL/DTO 冻结）；本文件只装配描述符、领域钩子与公开 API。
 */
import type { ListQuery } from '@synie/shared'
import { decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withReadSnapshot, withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { utcToday } from '~/db/dates.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { createAggregateService, type AggregateService } from '~/platform/standard/aggregate.ts'
import {
  createStandardChildService,
  type StandardChildService,
} from '~/platform/standard/child.ts'
import {
  auditStamp,
  createStandardService,
  type StandardService,
} from '~/platform/standard/service.ts'
import { withIndexedFields } from '~/platform/posting/text.ts'
import {
  lowerParty,
  partyExists,
  syncDrawingAttachments,
  toDateOnly,
  type TradingSide,
  wireRequiredDecimal,
} from '../common.ts'
import type { QuotationService } from '../quotation/service.ts'
import {
  adjustDemandOnAudit,
  deriveAndValidateItem,
  ensureVoidable,
  groupDraftLinesByItem,
  loadOrderHistory,
  normalizeCurrency,
  ORDER_WRITE_ERRORS,
  validateNewOrderDraftIdentities,
  validateOrderDraftIdentities,
  validateOrderShape,
  validateSalesOrderDraftHasNoOutsourcedLines,
  verifyItems,
} from './domain.ts'
import {
  createOutsourcedConfigService,
  type OutsourcedConfigService,
} from './outsourced-config.ts'
import {
  HEAD_ALIAS,
  headExtras,
  headSelectExtra,
  headSource,
  ITEM_ALIAS,
  itemExtras,
  itemSelectExtra,
  itemSource,
  presentHead,
  presentItem,
} from './views.ts'
import { orderSpec, type OrderSideSpec } from './spec.ts'
import type {
  Order,
  OrderDraftInput,
  OrderHeadCreateInput,
  OrderHeadUpdateInput,
  OrderItem,
  OrderItemCreateInput,
  OrderItemUpdateInput,
  OrderSavedDraft,
} from './types.ts'

export type {
  Order,
  OrderDraftInput,
  OrderDraftItemInput,
  OrderHeadCreateInput,
  OrderHeadUpdateInput,
  OrderItem,
  OrderItemCreateInput,
  OrderItemUpdateInput,
  OrderSavedDraft,
} from './types.ts'

type OutsourcedDraftPort = OutsourcedConfigService['draft']

interface SideCtx {
  spec: OrderSideSpec
  heads: StandardService<Order>
  items: StandardChildService<OrderItem>
  aggregate: AggregateService
}

function headPayload(input: OrderHeadCreateInput | OrderDraftInput | Record<string, unknown>): Record<string, unknown> {
  const raw = input as Record<string, unknown>
  const payload: Record<string, unknown> = {
    companyId: raw.companyId,
    orderDate: raw.orderDate ?? undefined,
    orderType: raw.orderType ?? undefined,
    partyType: raw.partyType,
    partyId: raw.partyId,
    currencyId: raw.currencyId ?? undefined,
    exchangeRate: raw.exchangeRate ?? undefined,
    terms: raw.terms ?? null,
    remarks: raw.remarks ?? null,
  }
  if (raw.isOutsourced !== undefined) payload.isOutsourced = raw.isOutsourced
  // 编号系统生成：非空 orderNo 由内核 400；空/缺省不传
  if (raw.orderNo != null && String(raw.orderNo).trim() !== '') {
    payload.orderNo = raw.orderNo
  }
  return payload
}

function itemWritePayload(
  input: OrderItemCreateInput | OrderItemUpdateInput | Record<string, unknown>,
  orderId?: string,
): Record<string, unknown> {
  const raw = input as Record<string, unknown>
  const payload: Record<string, unknown> = {}
  if (orderId !== undefined) payload.orderId = orderId
  if (raw.idx !== undefined) payload.idx = raw.idx
  if (raw.qty !== undefined) payload.qty = raw.qty
  if (raw.materialId !== undefined) payload.materialId = raw.materialId
  if (raw.unitId !== undefined) payload.unitId = raw.unitId
  if (raw.price !== undefined && raw.price !== null && raw.price !== '') payload.price = raw.price
  if (raw.taxRate !== undefined && raw.taxRate !== null && raw.taxRate !== '') {
    payload.taxRate = raw.taxRate
  }
  if (raw.remarks !== undefined) payload.remarks = raw.remarks
  if (raw.quotationItemId !== undefined) payload.quotationItemId = raw.quotationItemId
  if (raw.bomId !== undefined) payload.bomId = raw.bomId
  if (raw.demandLineId !== undefined) payload.demandLineId = raw.demandLineId
  if (raw.demandDate !== undefined) payload.demandDate = raw.demandDate
  return payload
}

/** 聚合草稿条目：去掉委外子树键（由 OutsourcedDraftPort 处理） */
function aggregateItemPayload(item: OrderDraftInput['items'][number]): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    idx: item.idx,
    qty: item.qty,
    materialId: item.materialId,
    unitId: item.unitId,
    price: item.price ?? null,
    taxRate: item.taxRate ?? null,
    remarks: item.remarks ?? null,
    quotationItemId: item.quotationItemId ?? null,
    bomId: item.bomId ?? null,
    demandLineId: item.demandLineId ?? null,
    demandDate: item.demandDate ?? null,
  }
  if (item.id !== undefined) payload.id = item.id
  // 空串价税 → 缺省（create 路径）
  if (payload.price === '' || payload.price === null) delete payload.price
  if (payload.taxRate === '' || payload.taxRate === null) delete payload.taxRate
  return payload
}

export function createOrderService(
  db: Kysely<Database>,
  numberer: NumberingService,
  quotations: QuotationService,
  registry: Registry,
  outsourcedDraft: OutsourcedDraftPort = createOutsourcedConfigService(db, registry).draft,
) {
  const sides: Record<TradingSide, SideCtx> = {
    sales: buildSide('sales'),
    purchase: buildSide('purchase'),
  }

  function buildSide(side: TradingSide): SideCtx {
    const spec = orderSpec(side)

    const heads = createStandardService<Order>({
      db,
      registry,
      resource: spec.headResource,
      notFound: `${spec.label}不存在`,
      defaultOrder: sql`"order_date" DESC, "id" ASC`,
      writeErrors: ORDER_WRITE_ERRORS,
      numbering: { service: numberer, field: 'orderNo' },
      projection: {
        source: headSource(spec),
        alias: HEAD_ALIAS,
        selectExtra: headSelectExtra(side),
        mapExtra: headExtras,
      },
      hooks: {
        insertColumns: ({ permit, draft }) => {
          const cols: Record<string, unknown> = {
            created_by_id: permit.actor.userId || null,
          }
          // sales 无 is_outsourced 列；purchase 缺省 false
          if (side === 'purchase' && draft.isOutsourced === undefined) {
            cols.is_outsourced = false
          }
          return cols
        },
        validate: ({ action, draft, before }) => {
          if (action === 'create') {
            const orderType = String(draft.orderType ?? 'REGULAR').toUpperCase()
            validateOrderShape(spec, {
              orderNo: 'x',
              orderDate: String(draft.orderDate ?? utcToday()),
              orderType,
              partyType: lowerParty(String(draft.partyType ?? '')),
              partyId: String(draft.partyId ?? ''),
              companyId: String(draft.companyId ?? ''),
              currencyId: String(draft.currencyId ?? 'pending'),
              exchangeRate: decimal(String(draft.exchangeRate ?? '1')),
              remarks: draft.remarks == null ? null : String(draft.remarks),
              requireOrderNo: false,
            })
            return
          }
          validateOrderShape(spec, {
            orderNo: String(draft.orderNo ?? ''),
            orderDate: String(draft.orderDate ?? ''),
            orderType: String(draft.orderType ?? ''),
            partyType: lowerParty(String(draft.partyType ?? '')),
            partyId: String(draft.partyId ?? ''),
            companyId: String(draft.companyId ?? ''),
            currencyId: String(draft.currencyId ?? ''),
            exchangeRate: decimal(String(draft.exchangeRate ?? '1')),
            remarks: draft.remarks == null ? null : String(draft.remarks),
            requireOrderNo: true,
          })
          if (
            before &&
            draft.orderNo !== undefined &&
            String(draft.orderNo).trim() !== String(before.orderNo)
          ) {
            throw ApiError.validation('订单参数不合法', { orderNo: ['编号创建后不可修改'] })
          }
          if (
            before &&
            draft.orderType !== undefined &&
            String(draft.orderType).toUpperCase() !== String(before.orderType).toUpperCase()
          ) {
            throw ApiError.validation('订单参数不合法', { orderType: ['订单类型不可变更'] })
          }
          if (
            before &&
            side === 'purchase' &&
            draft.isOutsourced !== undefined &&
            Boolean(draft.isOutsourced) !== Boolean(before.isOutsourced)
          ) {
            throw ApiError.validation('订单参数不合法', { isOutsourced: ['委外标记不可变更'] })
          }
        },
        beforeWrite: async (trx, { action, draft, before }) => {
          if (action === 'create') {
            if (!draft.orderDate) draft.orderDate = utcToday()
            else draft.orderDate = toDateOnly(String(draft.orderDate))
            if (!draft.orderType) draft.orderType = 'REGULAR'
            else draft.orderType = String(draft.orderType).toUpperCase()
            draft.partyType = lowerParty(String(draft.partyType ?? ''))
            const norm = await normalizeCurrency(
              trx,
              String(draft.companyId),
              draft.currencyId == null || draft.currencyId === ''
                ? null
                : String(draft.currencyId),
              draft.exchangeRate == null || draft.exchangeRate === ''
                ? null
                : String(draft.exchangeRate),
            )
            draft.currencyId = norm.currencyId
            draft.exchangeRate = wireRequiredDecimal(norm.exchangeRate)
            if (side === 'purchase') {
              draft.isOutsourced = Boolean(draft.isOutsourced)
            }
            validateOrderShape(spec, {
              orderNo: 'x',
              orderDate: String(draft.orderDate),
              orderType: String(draft.orderType),
              partyType: lowerParty(String(draft.partyType)),
              partyId: String(draft.partyId ?? ''),
              companyId: String(draft.companyId ?? ''),
              currencyId: String(draft.currencyId),
              exchangeRate: decimal(String(draft.exchangeRate)),
              remarks: draft.remarks == null ? null : String(draft.remarks),
              requireOrderNo: false,
            })
          } else {
            if (draft.orderDate != null) draft.orderDate = toDateOnly(String(draft.orderDate))
            if (draft.partyType != null) draft.partyType = lowerParty(String(draft.partyType))
            if (draft.orderType != null) draft.orderType = String(draft.orderType).toUpperCase()
            const norm = await normalizeCurrency(
              trx,
              String(draft.companyId ?? before?.companyId),
              draft.currencyId == null ? null : String(draft.currencyId),
              draft.exchangeRate == null ? null : String(draft.exchangeRate),
            )
            draft.currencyId = norm.currencyId
            draft.exchangeRate = wireRequiredDecimal(norm.exchangeRate)
          }
          if (!(await partyExists(trx, String(draft.partyType ?? ''), String(draft.partyId ?? '')))) {
            throw ApiError.validation('订单参数不合法', { partyId: ['对手不存在'] })
          }
          if (action === 'update' && before) {
            const headChanged =
              String(draft.orderDate) !== String(before.orderDate) ||
              lowerParty(String(draft.partyType)) !== lowerParty(String(before.partyType)) ||
              String(draft.partyId) !== String(before.partyId) ||
              String(draft.currencyId) !== String(before.currencyId)
            if (headChanged) {
              const has = await sql<{ e: boolean }>`
                SELECT EXISTS(
                  SELECT 1 FROM ${sql.raw(spec.itemTable)} WHERE order_id=${String(before.id)}::uuid
                ) AS e
              `.execute(trx)
              if (has.rows[0]?.e) throw new ApiError('conflict', '请先删除订单条目')
            }
          }
        },
        afterWrite: async (trx, { action, item, before }) => {
          if (action !== 'update' || !before) return
          if (String(item.exchangeRate) === String(before.exchangeRate)) return
          // 汇率变更：重算各行本币价额（与迁前手写一致）
          await sql`
            UPDATE ${sql.raw(spec.itemTable)}
            SET base_price=round(price*${String(item.exchangeRate)},4),
                base_amount=round(amount*${String(item.exchangeRate)},2),
                updated_at=(now() AT TIME ZONE 'utc')
            WHERE order_id=${String(item.id)}::uuid
          `.execute(trx)
        },
        beforeDelete: async (trx, { item }) => {
          await sql`
            DELETE FROM sys_attachment WHERE owner_type=${spec.itemOwnerType}
              AND owner_id IN (
                SELECT id FROM ${sql.raw(spec.itemTable)} WHERE order_id=${String(item.id)}::uuid
              )
          `.execute(trx)
        },
      },
      workflow: {
        mutableMessage: '仅草稿订单可修改或删除',
        transitions: [
          {
            key: 'audit',
            label: '审核',
            from: ['DRAFT'],
            to: 'AUDITED',
            guardMessage: '仅草稿订单可审核',
            stamps: ({ permit }) => auditStamp(permit),
            effect: async (trx, { before }) => {
              await verifyItems(trx, quotations, spec, before)
              if (side === 'purchase') {
                await adjustDemandOnAudit(trx, String(before.id), true)
              }
            },
          },
          {
            key: 'close',
            label: '关闭',
            from: ['AUDITED'],
            to: 'CLOSED',
            guardMessage: '仅已审核订单可关闭',
          },
          {
            key: 'void',
            label: '作废',
            from: ['AUDITED'],
            to: 'VOIDED',
            guardMessage: '仅已审核订单可作废',
            effect: async (trx, { before }) => {
              await ensureVoidable(trx, side, String(before.id))
              if (side === 'purchase') {
                await adjustDemandOnAudit(trx, String(before.id), false)
              }
            },
          },
        ],
      },
    })

    const items = createStandardChildService<OrderItem>({
      db,
      registry,
      resource: spec.itemResource,
      notFound: '订单条目不存在',
      defaultOrder: sql`"order_date" DESC, "idx" ASC, "id" ASC`,
      writeErrors: ORDER_WRITE_ERRORS,
      recordLabel: (item) => String(item.idx),
      derivedFields: [
        'baseQty',
        'amount',
        'basePrice',
        'baseAmount',
        'materialCode',
        'materialName',
        'materialSpec',
        'customerPartNo',
        'unitName',
      ],
      projection: {
        source: itemSource(spec),
        alias: ITEM_ALIAS,
        selectExtra: itemSelectExtra(spec),
        mapExtra: (row) => itemExtras(side, row),
      },
      parent: {
        resource: spec.headResource,
        fkField: 'orderId',
        notFound: `${spec.label}不存在`,
        inheritFields: ['companyId'],
        gate: (parent) => {
          if (String(parent.status) !== 'DRAFT') {
            throw new ApiError('conflict', '仅草稿订单可编辑条目')
          }
        },
      },
      hooks: {
        validate: ({ draft }) => {
          const qty = draft.qty
          if (qty === undefined || qty === null || qty === '') {
            throw ApiError.validation('订单条目参数不合法', { qty: ['必填'] })
          }
          if (!decimal(String(qty)).gt(0)) {
            throw ApiError.validation('订单条目参数不合法', { qty: ['必须大于 0'] })
          }
        },
        beforeWrite: async (trx, { action, draft, parent, before }) => {
          const taxExplicit =
            action === 'create'
              ? draft.taxRate != null && draft.taxRate !== ''
              : // update：patch 合并后难区分；有 taxRate 键且与 before 不同或显式同值均视为已提供
                // 全量草稿 replace 总会带 taxRate；独立 PATCH 未带时保留 before（见决策日志）
                draft.taxRate !== undefined
          const derived = await deriveAndValidateItem(trx, quotations, spec, parent, {
            idx: Number(draft.idx),
            qty: decimal(String(draft.qty)),
            materialId: String(draft.materialId ?? ''),
            unitId: String(draft.unitId ?? ''),
            price:
              draft.price != null && draft.price !== ''
                ? decimal(String(draft.price))
                : decimal(0),
            taxRate:
              draft.taxRate != null && draft.taxRate !== ''
                ? decimal(String(draft.taxRate))
                : decimal('0.13'),
            taxExplicit: Boolean(taxExplicit),
            remarks: draft.remarks == null ? null : String(draft.remarks),
            quotationItemId:
              draft.quotationItemId == null || draft.quotationItemId === ''
                ? null
                : String(draft.quotationItemId),
            bomId: draft.bomId == null || draft.bomId === '' ? null : String(draft.bomId),
            demandLineId:
              draft.demandLineId == null || draft.demandLineId === ''
                ? null
                : String(draft.demandLineId),
            demandDate:
              draft.demandDate == null || draft.demandDate === ''
                ? null
                : String(draft.demandDate),
          })
          draft.idx = derived.idx
          draft.qty = wireRequiredDecimal(derived.qty)
          draft.baseQty = wireRequiredDecimal(derived.baseQty)
          draft.price = wireRequiredDecimal(derived.price)
          draft.amount = wireRequiredDecimal(derived.amount)
          draft.basePrice = wireRequiredDecimal(derived.basePrice)
          draft.baseAmount = wireRequiredDecimal(derived.baseAmount)
          draft.taxRate = wireRequiredDecimal(derived.taxRate)
          draft.materialId = derived.materialId
          draft.unitId = derived.unitId
          draft.materialCode = derived.materialCode
          draft.materialName = derived.materialName
          draft.materialSpec = derived.materialSpec
          draft.customerPartNo = derived.customerPartNo
          draft.unitName = derived.unitName
          draft.remarks = derived.remarks
          draft.quotationItemId = derived.quotationItemId
          if (side === 'purchase') {
            draft.bomId = derived.bomId
            draft.demandLineId = derived.demandLineId
            draft.demandDate = derived.demandDate
          }
          void before
        },
        afterWrite: async (trx, { item, parent }) => {
          await syncDrawingAttachments(
            trx,
            spec.itemOwnerType,
            String(item.id),
            String(item.materialId),
            String(parent.companyId),
          )
        },
        beforeDelete: async (trx, { item }) => {
          await sql`
            DELETE FROM sys_attachment
            WHERE owner_type=${spec.itemOwnerType} AND owner_id=${String(item.id)}::uuid
          `.execute(trx)
        },
      },
    })

    return {
      spec,
      heads,
      items,
      aggregate: createAggregateService({
        db,
        registry,
        head: heads,
        validationMessage: '订单草稿参数不合法',
        children: [{ key: 'items', service: items }],
      }),
    }
  }

  async function attachOutsourced(
    handle: DbHandle,
    permit: Permit,
    side: TradingSide,
    orderId: string,
    head: Order,
    items: OrderItem[],
  ): Promise<OrderSavedDraft> {
    const outsourcedLines =
      side === 'purchase'
        ? await outsourcedDraft.loadOrderLines(handle, permit, orderId)
        : { issueLines: [], byproductLines: [] }
    const issueByItem = groupDraftLinesByItem(outsourcedLines.issueLines)
    const byproductByItem = groupDraftLinesByItem(outsourcedLines.byproductLines)
    return {
      ...presentHead(head),
      items: items.map((item) => ({
        ...presentItem(item),
        issueLines: issueByItem.get(item.id) ?? [],
        byproductLines: byproductByItem.get(item.id) ?? [],
      })),
    }
  }

  async function loadFullDraft(
    handle: DbHandle,
    permit: Permit,
    side: TradingSide,
    id: string,
  ): Promise<OrderSavedDraft> {
    const ctx = sides[side]
    // head.getOn + items.listByParentOn：支持 trx / snapshot（aggregate.loadDraft 自开 RR）
    const head = presentHead(await ctx.heads.getOn(handle, permit, id))
    const items = (await ctx.items.listByParentOn(handle, id)).map(presentItem)
    return attachOutsourced(handle, permit, side, id, head, items)
  }

  /** 领域专用完整订单草稿读取：表头、全部条目及采购委外配置。 */
  async function getDraft(
    permit: Permit,
    side: TradingSide,
    id: string,
  ): Promise<OrderSavedDraft> {
    return withReadSnapshot(db, (snapshot) => loadFullDraft(snapshot, permit, side, id))
  }

  /**
   * 整单创建：头+条目走 InTx；采购委外子树走 OutsourcedDraftPort（同事务）。
   * 不直接调 aggregate.createDraft——委外子树非 standard child。
   */
  async function createDraft(
    permit: Permit,
    side: TradingSide,
    input: OrderDraftInput,
  ): Promise<OrderSavedDraft> {
    validateNewOrderDraftIdentities(side, input)
    const ctx = sides[side]
    return withTx(db, async (trx) => {
      const head = await withIndexedFields('header', () =>
        ctx.heads.createInTx(trx, permit, headPayload(input)),
      )
      for (let itemIndex = 0; itemIndex < input.items.length; itemIndex++) {
        const inputItem = input.items[itemIndex]!
        const item = await withIndexedFields(`items[${itemIndex}]`, () =>
          ctx.items.createInTx(trx, permit, {
            ...aggregateItemPayload(inputItem),
            orderId: head.id,
          }),
        )
        if (side === 'purchase') {
          await withIndexedFields(`items[${itemIndex}]`, () =>
            outsourcedDraft.replaceItemLines(trx, permit, item.id, {
              issueLines: inputItem.issueLines,
              byproductLines: inputItem.byproductLines,
            }),
          )
        }
      }
      return loadFullDraft(trx, permit, side, head.id)
    })
  }

  /**
   * 整单替换（D4）：omitted 条目先删 → 头更新 → 条目增/改 → 委外子树。
   * 身份校验覆盖委外行（OutsourcedDraftPort 保留）。
   */
  async function replaceDraft(
    permit: Permit,
    side: TradingSide,
    id: string,
    input: OrderDraftInput,
  ): Promise<OrderSavedDraft> {
    // 与聚合内核 requireArray 对齐：缺集合键 fail-closed（合同套件）
    if (!Array.isArray(input.items)) {
      throw ApiError.validation('订单草稿参数不合法', {
        items: ['必须显式提交数组'],
      })
    }
    validateSalesOrderDraftHasNoOutsourcedLines(side, input)
    const ctx = sides[side]
    return withTx(db, async (trx) => {
      const before = presentHead(await ctx.heads.getOn(trx, permit, id))
      if (input.companyId !== before.companyId) {
        throw ApiError.validation('订单草稿参数不合法', {
          companyId: ['创建后不可修改公司'],
        })
      }
      const existing = await ctx.items.listByParentOn(trx, id)
      const existingItemIds = new Set(existing.map((item) => item.id))
      const existingOutsourcedLines =
        side === 'purchase'
          ? await outsourcedDraft.loadOrderLines(trx, permit, id)
          : { issueLines: [], byproductLines: [] }
      const issueLineOwner = new Map(
        existingOutsourcedLines.issueLines.map((line) => [line.id, line.orderItemId]),
      )
      const byproductLineOwner = new Map(
        existingOutsourcedLines.byproductLines.map((line) => [line.id, line.orderItemId]),
      )
      validateOrderDraftIdentities(
        input,
        existingItemIds,
        issueLineOwner,
        byproductLineOwner,
      )

      const requested = new Set(
        input.items.flatMap((item) => (typeof item.id === 'string' ? [item.id] : [])),
      )
      for (const old of existing) {
        if (!requested.has(old.id)) {
          await ctx.items.removeInTx(trx, permit, old.id)
        }
      }

      await withIndexedFields('header', () =>
        ctx.heads.updateInTx(trx, permit, id, {
          orderDate: input.orderDate ?? before.orderDate,
          orderType: input.orderType ?? before.orderType,
          ...(side === 'purchase'
            ? { isOutsourced: input.isOutsourced ?? before.isOutsourced }
            : {}),
          partyType: input.partyType,
          partyId: input.partyId,
          currencyId: input.currencyId ?? before.currencyId,
          exchangeRate: input.exchangeRate ?? before.exchangeRate,
          terms: input.terms ?? null,
          remarks: input.remarks ?? null,
        }),
      )

      for (let itemIndex = 0; itemIndex < input.items.length; itemIndex++) {
        const inputItem = input.items[itemIndex]!
        const payload = aggregateItemPayload(inputItem)
        const savedItem =
          inputItem.id === undefined
            ? await withIndexedFields(`items[${itemIndex}]`, () =>
                ctx.items.createInTx(trx, permit, { ...payload, orderId: id }),
              )
            : await withIndexedFields(`items[${itemIndex}]`, () =>
                ctx.items.updateInTx(trx, permit, inputItem.id!, payload),
              )
        if (side === 'purchase') {
          await withIndexedFields(`items[${itemIndex}]`, () =>
            outsourcedDraft.replaceItemLines(trx, permit, savedItem.id, {
              issueLines: inputItem.issueLines,
              byproductLines: inputItem.byproductLines,
            }),
          )
        }
      }
      return loadFullDraft(trx, permit, side, id)
    })
  }

  function updateHeadPatch(input: OrderHeadUpdateInput): Record<string, unknown> {
    const patch: Record<string, unknown> = {}
    if (input.orderDate !== undefined) patch.orderDate = input.orderDate
    if (input.orderType !== undefined) patch.orderType = input.orderType
    if (input.isOutsourced !== undefined) patch.isOutsourced = input.isOutsourced
    if (input.partyType !== undefined) patch.partyType = input.partyType
    if (input.partyId !== undefined) patch.partyId = input.partyId
    if (input.currencyId !== undefined) patch.currencyId = input.currencyId
    if (input.exchangeRate !== undefined) patch.exchangeRate = input.exchangeRate
    if (input.termsPresent) patch.terms = input.terms ?? null
    if (input.remarksPresent) patch.remarks = input.remarks ?? null
    if (input.orderNo !== undefined) patch.orderNo = input.orderNo
    return patch
  }

  function updateItemPatch(input: OrderItemUpdateInput): Record<string, unknown> {
    const patch: Record<string, unknown> = {}
    if (input.idx !== undefined) patch.idx = input.idx
    if (input.qty !== undefined) patch.qty = input.qty
    if (input.materialId !== undefined) patch.materialId = input.materialId
    if (input.unitId !== undefined) patch.unitId = input.unitId
    if (input.price !== undefined) patch.price = input.price
    if (input.taxRate !== undefined) patch.taxRate = input.taxRate
    if (input.remarksPresent) patch.remarks = input.remarks ?? null
    if (input.quotationItemIdPresent) patch.quotationItemId = input.quotationItemId ?? null
    if (input.bomIdPresent) patch.bomId = input.bomId ?? null
    if (input.demandLineIdPresent) patch.demandLineId = input.demandLineId ?? null
    if (input.demandDatePresent) patch.demandDate = input.demandDate ?? null
    return patch
  }

  return {
    listHeads: async (p: Permit, side: TradingSide, q: Partial<ListQuery>) => {
      const r = await sides[side].heads.list(p, q)
      return { count: r.count, results: r.results.map((row) => presentHead(row)) }
    },
    getHead: async (p: Permit, side: TradingSide, id: string) =>
      presentHead(await sides[side].heads.get(p, id)),
    createHead: async (p: Permit, side: TradingSide, input: OrderHeadCreateInput) =>
      presentHead(await sides[side].heads.create(p, headPayload(input))),
    updateHead: async (p: Permit, side: TradingSide, id: string, input: OrderHeadUpdateInput) =>
      presentHead(await sides[side].heads.update(p, id, updateHeadPatch(input))),
    deleteHead: (p: Permit, side: TradingSide, id: string) => sides[side].heads.remove(p, id),
    audit: async (p: Permit, side: TradingSide, id: string) =>
      presentHead(await sides[side].heads.transition(p, id, 'audit')),
    close: async (p: Permit, side: TradingSide, id: string) =>
      presentHead(await sides[side].heads.transition(p, id, 'close')),
    void: async (p: Permit, side: TradingSide, id: string) =>
      presentHead(await sides[side].heads.transition(p, id, 'void')),
    listItems: async (p: Permit, side: TradingSide, q: Partial<ListQuery>) => {
      const r = await sides[side].items.list(p, q)
      return { count: r.count, results: r.results.map((row) => presentItem(row)) }
    },
    getItem: async (p: Permit, side: TradingSide, id: string) =>
      presentItem(await sides[side].items.get(p, id)),
    createItem: async (p: Permit, side: TradingSide, input: OrderItemCreateInput) =>
      presentItem(
        await sides[side].items.create(p, itemWritePayload(input, input.orderId)),
      ),
    updateItem: async (p: Permit, side: TradingSide, id: string, input: OrderItemUpdateInput) =>
      presentItem(await sides[side].items.update(p, id, updateItemPatch(input))),
    deleteItem: (p: Permit, side: TradingSide, id: string) => sides[side].items.remove(p, id),
    getDraft,
    createDraft,
    replaceDraft,
    history: async (p: Permit, side: TradingSide, orderId: string) => {
      await sides[side].heads.get(p, orderId)
      return loadOrderHistory(db, side, orderId)
    },
    /** 合同套件 / 判官：暴露两侧聚合（头+条目；委外子树不在 CASES 内） */
    _aggregateForContract: (side: TradingSide): AggregateService => ({
      loadDraft: (p, id) => getDraft(p, side, id) as Promise<Record<string, unknown>>,
      createDraft: (p, input) =>
        createDraft(p, side, input as unknown as OrderDraftInput) as Promise<
          Record<string, unknown>
        >,
      replaceDraft: (p, id, input) =>
        replaceDraft(p, side, id, input as unknown as OrderDraftInput) as Promise<
          Record<string, unknown>
        >,
      head: sides[side].heads,
      children: sides[side].aggregate.children,
    }),
  }
}

export type OrderService = ReturnType<typeof createOrderService>
