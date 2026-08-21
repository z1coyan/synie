/**
 * 标准履约：销售发货 / 采购入库 + 装箱清单。
 * 审核单事务：库存引擎 + 订单投影 + 金额>0 时 GL 引擎（零金额跳总账）。
 *
 * W2/W3：头/条目/装箱 + 整单草稿由 platform/standard 派生
 * （createStandardService + createStandardChildService + createAggregateService）。
 * 销售发货 3 层平行子树：条目 + 装箱箱→装箱行（孙级 D3 第二消费者）。
 * 审核/作废迁 workflow transition（D7 收尾）：锁行/闸门/盖章/审计/重载由内核承担，
 * 跨引擎领域效果在 workflow.ts 的 effect 函数（不进聚合草稿钩子）。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit。
 * 装箱行的可达性经两级 via（pack_line → pack_box → sal_delivery）递归到发货单谓词。
 */
import type { ListQuery } from '@synie/shared'
import { decimal } from '@synie/shared'
// ListQuery used in public API signatures
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { GlEngine } from '~/engines/gl/index.ts'
import type { InventoryEngine } from '~/engines/inventory/index.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import {
  createAggregateService,
  withAggregateWireAdapter,
  type AggregateService,
} from '~/platform/standard/aggregate.ts'
import { createStandardChildService } from '~/platform/standard/child.ts'
import { auditStamp, createStandardService, type TransitionContext } from '~/platform/standard/service.ts'
import { listAuthorized } from '~/db/list.ts'
import {
  convertToBaseQty,
  loadMaterialSnap,
  lowerParty,
  runeLen,
  syncDrawingAttachments,
  toDateOnly,
  type TradingSide,
  wireRequiredDecimal,
} from '../common.ts'
import { utcToday } from '~/db/dates.ts'
import {
  applyDerivedItem,
  assertDeliveryDraft,
  deriveItem,
  FULFILLMENT_WRITE_ERRORS,
  headFromWire,
  headLikeFromDraft,
  ITEM_ALIAS,
  ITEM_DERIVED,
  ITEM_SELECT,
  ITEM_SOURCE,
  PACK_LINE_DERIVED,
  validateHeadRefs,
  validatePurchaseHeadWire,
  validateSalesHeadWire,
} from './domain.ts'
import { effectAuditHead, effectVoidHead } from './workflow.ts'
import {
  fulfillmentItemListMeta,
  fulfillmentSpec,
  PACK_BOX_RESOURCE,
  PACK_LINE_RESOURCE,
  type FulfillmentSideSpec,
} from './spec.ts'
import type {
  FulfillmentHeadDraftInput,
  FulfillmentHeadUpdateInput,
  FulfillmentItemUpdateInput,
  PurchaseReceiptDraftDto,
  PurchaseReceiptDraftInput,
  SalesDraftDto,
  SalesDraftInput,
  SalesDraftItemInput,
} from './types.ts'
import {
  mapItemDto,
  mapPurchaseItemExtras,
  mapSalesItemExtras,
  presentPackBox,
  presentPackLine,
  presentPurchaseDraft,
  presentPurchaseHead,
  presentPurchaseItem,
  presentSalesDraft,
  presentSalesHead,
  presentSalesItem,
  purchaseDraftPayload,
  purchaseHeadPayload,
  salesDraftPayload,
} from './views.ts'

export type {
  FulfillmentHead,
  FulfillmentHeadDraftInput,
  FulfillmentHeadUpdateInput,
  FulfillmentItemUpdateInput,
  PurchaseReceiptDraftDto,
  PurchaseReceiptDraftInput,
  SalesDraftDto,
  SalesDraftInput,
  SalesDraftItemInput,
  SalesDraftPackBoxInput,
  SalesDraftPackLineInput,
} from './types.ts'

type Numberer = Pick<NumberingService, 'assignedInTx' | 'nextInTx'>

export function createFulfillmentService(
  db: Kysely<Database>,
  numberer: Numberer,
  engines: {
    inventory: Pick<InventoryEngine, 'post' | 'cancel'>
    gl: Pick<GlEngine, 'post' | 'cancel'>
  },
  registry: Registry,
) {
  const { inventory, gl } = engines

  const purSpec = fulfillmentSpec('purchase')
  const salSpec = fulfillmentSpec('sales')

  /** 审核/作废转移声明（D7）：外壳（锁/闸门/盖章/审计/重载）内核承担，领域效果进 effect */
  function headWorkflow(spec: FulfillmentSideSpec) {
    return {
      mutableMessage: `仅草稿${spec.label}可编辑`,
      transitions: [
        {
          key: 'audit',
          label: '审核',
          from: ['DRAFT'],
          to: 'AUDITED',
          guardMessage: `仅草稿${spec.label}可审核`,
          stamps: ({ permit }: { permit: Permit }) => auditStamp(permit),
          effect: async (trx: TrxHandle, { before, input }: TransitionContext) => {
            const override = input.postingDate == null ? null : String(input.postingDate)
            return effectAuditHead(trx, engines, spec, headFromWire(spec, before), override)
          },
        },
        {
          key: 'void',
          label: '作废',
          from: ['AUDITED'],
          to: 'VOIDED',
          guardMessage: `仅已审核${spec.label}可作废`,
          effect: async (trx: TrxHandle, { before }: TransitionContext) => {
            await effectVoidHead(trx, engines, spec, headFromWire(spec, before))
          },
        },
      ],
    }
  }

  const purHeads = createStandardService({
    db,
    registry,
    resource: purSpec.headResource,
    notFound: `${purSpec.label}不存在`,
    defaultOrder: sql`"receipt_date" DESC, "id" ASC`,
    writeErrors: [{ code: '23505', message: `${purSpec.label}单号已存在` }],
    numbering: { service: numberer, field: 'receiptNo' },
    hooks: headHooks(purSpec, {
      noKey: 'receiptNo',
      dateKey: 'receiptDate',
      validateWire: (d, o) =>
        validatePurchaseHeadWire(d, {
          requireReceiptNo: Boolean(o.requireReceiptNo),
          requireDate: Boolean(o.requireDate),
        }),
      requireNo: 'requireReceiptNo',
    }),
    workflow: headWorkflow(purSpec),
  })

  const salHeads = createStandardService({
    db,
    registry,
    resource: salSpec.headResource,
    notFound: `${salSpec.label}不存在`,
    defaultOrder: sql`"delivery_date" DESC, "id" ASC`,
    writeErrors: [{ code: '23505', message: `${salSpec.label}单号已存在` }],
    numbering: { service: numberer, field: 'deliveryNo' },
    hooks: headHooks(salSpec, {
      noKey: 'deliveryNo',
      dateKey: 'deliveryDate',
      validateWire: (d, o) =>
        validateSalesHeadWire(d, {
          requireDeliveryNo: Boolean(o.requireDeliveryNo),
          requireDate: Boolean(o.requireDate),
        }),
      requireNo: 'requireDeliveryNo',
      partyConflictAsValidation: true,
    }),
    workflow: headWorkflow(salSpec),
  })

  const purItems = createStandardChildService({
    db,
    registry,
    resource: purSpec.itemResource,
    notFound: `${purSpec.itemLabel}不存在`,
    defaultOrder: sql`"idx" ASC, "id" ASC`,
    writeErrors: FULFILLMENT_WRITE_ERRORS,
    recordLabel: (item) => String(item.idx),
    derivedFields: [...ITEM_DERIVED],
    projection: {
      source: ITEM_SOURCE.purchase,
      alias: ITEM_ALIAS,
      selectExtra: sql`receipt_no, receipt_date, receipt_status, party_type, remaining_reconcilable_qty, remaining_returnable_qty`,
      mapExtra: mapPurchaseItemExtras,
    },
    parent: {
      resource: purSpec.headResource,
      fkField: 'receiptId',
      notFound: `${purSpec.label}不存在`,
      inheritFields: ['companyId'],
      gate: draftGate(purSpec),
    },
    hooks: itemHooks(purSpec),
  })

  const salItems = createStandardChildService({
    db,
    registry,
    resource: salSpec.itemResource,
    notFound: `${salSpec.itemLabel}不存在`,
    defaultOrder: sql`"idx" ASC, "id" ASC`,
    writeErrors: FULFILLMENT_WRITE_ERRORS,
    recordLabel: (item) => String(item.idx),
    derivedFields: [...ITEM_DERIVED],
    projection: {
      source: ITEM_SOURCE.sales,
      alias: ITEM_ALIAS,
      selectExtra: sql`delivery_no, delivery_date, delivery_status, party_type, remaining_reconcilable_qty, remaining_returnable_qty`,
      mapExtra: mapSalesItemExtras,
    },
    parent: {
      resource: salSpec.headResource,
      fkField: 'deliveryId',
      notFound: `${salSpec.label}不存在`,
      inheritFields: ['companyId'],
      gate: draftGate(salSpec),
    },
    hooks: itemHooks(salSpec),
  })

  const packLines = createStandardChildService({
    db,
    registry,
    resource: PACK_LINE_RESOURCE,
    notFound: '装箱行不存在',
    defaultOrder: sql`"idx" ASC, "id" ASC`,
    writeErrors: FULFILLMENT_WRITE_ERRORS,
    recordLabel: (item) => String(item.idx),
    derivedFields: [...PACK_LINE_DERIVED],
    parent: {
      resource: PACK_BOX_RESOURCE,
      fkField: 'packBoxId',
      notFound: '装箱箱不存在',
      inheritFields: ['companyId', 'deliveryId'],
    },
    hooks: {
      validate: ({ draft }) => {
        const qty = draft.qty
        if (qty === undefined || qty === null || qty === '') {
          throw ApiError.validation('装箱行参数不合法', { qty: ['必填'] })
        }
        if (!decimal(String(qty)).gt(0)) {
          throw ApiError.validation('装箱行参数不合法', { qty: ['必须大于 0'] })
        }
        if (!draft.materialId) {
          throw ApiError.validation('装箱行参数不合法', { materialId: ['必填'] })
        }
        if (draft.remarks != null && runeLen(String(draft.remarks)) > 512) {
          throw ApiError.validation('装箱行参数不合法', { remarks: ['最多 512 个字符'] })
        }
      },
      beforeWrite: async (trx, { draft, parent }) => {
        await assertDeliveryDraft(trx, String(parent.deliveryId))
        let unitId =
          draft.unitId == null || draft.unitId === '' ? null : String(draft.unitId)
        if (!unitId) {
          const m = await trx
            .selectFrom('inv_material')
            .select('default_unit_id')
            .where('id', '=', String(draft.materialId))
            .executeTakeFirst()
          if (!m) {
            throw ApiError.validation('装箱行参数不合法', { materialId: ['物料不存在'] })
          }
          unitId = m.default_unit_id
        }
        const snap = await loadMaterialSnap(trx, String(draft.materialId), unitId)
        const qty = decimal(String(draft.qty))
        if (!qty.gt(0)) {
          throw ApiError.validation('装箱行参数不合法', { qty: ['必须大于 0'] })
        }
        const baseQty = convertToBaseQty(qty, unitId, snap)
        draft.qty = wireRequiredDecimal(qty)
        draft.baseQty = wireRequiredDecimal(baseQty)
        draft.unitId = unitId
        draft.materialCode = snap.code
        draft.materialName = snap.name
        draft.materialSpec = snap.spec
        draft.customerPartNo = snap.customerPartNo
        draft.unitName = snap.unitName
        draft.remarks = draft.remarks == null ? null : String(draft.remarks)
      },
      beforeDelete: async (trx, { parent }) => {
        await assertDeliveryDraft(trx, String(parent.deliveryId))
      },
    },
  })

  const packBoxes = createStandardChildService({
    db,
    registry,
    resource: PACK_BOX_RESOURCE,
    notFound: '装箱箱不存在',
    defaultOrder: sql`"box_no" ASC, "id" ASC`,
    writeErrors: FULFILLMENT_WRITE_ERRORS,
    recordLabel: (item) => String(item.boxNo),
    derivedFields: ['boxNo'],
    parent: {
      resource: salSpec.headResource,
      fkField: 'deliveryId',
      notFound: `${salSpec.label}不存在`,
      inheritFields: ['companyId'],
      gate: draftGate(salSpec),
    },
    hooks: {
      beforeWrite: async (trx, { action, draft, parent }) => {
        if (action !== 'create') return
        const next = await sql<{ n: string }>`
          SELECT (COALESCE(MAX(box_no), 0) + 1)::text AS n
          FROM sal_delivery_pack_box WHERE delivery_id=${String(parent.id)}::uuid
        `.execute(trx)
        draft.boxNo = Number(next.rows[0]!.n)
      },
    },
  })

  const purAggregate = createAggregateService({
    db,
    registry,
    head: purHeads,
    validationMessage: '采购入库草稿参数不合法',
    children: [{ key: 'items', service: purItems }],
  })

  const salAggregate = createAggregateService({
    db,
    registry,
    head: salHeads,
    validationMessage: '销售发货草稿参数不合法',
    children: [
      { key: 'items', service: salItems },
      {
        key: 'packBoxes',
        service: packBoxes,
        children: [{ key: 'lines', service: packLines }],
      },
    ],
  })

  // 合同适配聚合（toPayload + present 包装由内核承担）
  const purContractAggregate = withAggregateWireAdapter(purAggregate, {
    toPayload: (input) => purchaseDraftPayload(input as unknown as PurchaseReceiptDraftInput),
    present: (draft) => presentPurchaseDraft(draft) as unknown as Record<string, unknown>,
  })
  const salContractAggregate = withAggregateWireAdapter(salAggregate, {
    toPayload: (input) => salesDraftPayload(input as unknown as SalesDraftInput),
    present: (draft) => presentSalesDraft(draft) as unknown as Record<string, unknown>,
  })

  function draftGate(spec: FulfillmentSideSpec) {
    return (parent: Record<string, unknown>) => {
      if (String(parent.status) !== 'DRAFT') {
        throw new ApiError('conflict', `仅草稿${spec.label}可编辑`)
      }
    }
  }

  function headHooks(
    spec: FulfillmentSideSpec,
    opts: {
      noKey: string
      dateKey: string
      validateWire: (draft: Record<string, unknown>, o: Record<string, boolean>) => void
      requireNo: string
      partyConflictAsValidation?: boolean
    },
  ) {
    return {
      insertColumns: ({ permit }: { permit: Permit }) => ({
        status: 'draft',
        created_by_id: permit.actor.userId || null,
      }),
      validate: ({
        action,
        draft,
        before,
      }: {
        action: 'create' | 'update'
        draft: Record<string, unknown>
        before?: Record<string, unknown>
      }) => {
        opts.validateWire(draft, {
          [opts.requireNo]: action === 'update',
          requireDate: action === 'update' || draft[opts.dateKey] != null,
        } as Record<string, boolean>)
        if (
          action === 'update' &&
          before &&
          draft[opts.noKey] !== undefined &&
          String(draft[opts.noKey]).trim() !== String(before[opts.noKey])
        ) {
          throw ApiError.validation(`${spec.label}参数不合法`, {
            [opts.noKey]: ['编号创建后不可修改'],
          })
        }
      },
      beforeWrite: async (
        trx: TrxHandle,
        {
          action,
          draft,
          before,
        }: {
          action: 'create' | 'update'
          draft: Record<string, unknown>
          before?: Record<string, unknown>
        },
      ) => {
        if (action === 'create') {
          if (!draft[opts.dateKey]) draft[opts.dateKey] = utcToday()
          else draft[opts.dateKey] = toDateOnly(String(draft[opts.dateKey]))
        } else if (draft[opts.dateKey] != null) {
          draft[opts.dateKey] = toDateOnly(String(draft[opts.dateKey]))
        }
        if (draft.postingDate != null && draft.postingDate !== '') {
          draft.postingDate = toDateOnly(String(draft.postingDate))
        } else if (draft.postingDate === '') {
          draft.postingDate = null
        }
        if (draft.partyType != null) draft.partyType = lowerParty(String(draft.partyType))
        opts.validateWire(draft, {
          [opts.requireNo]: action === 'update',
          requireDate: true,
        } as Record<string, boolean>)
        await validateHeadRefs(
          trx,
          spec,
          headLikeFromDraft(draft, before, { no: opts.noKey, date: opts.dateKey }),
        )
        if (action === 'update' && before) {
          const partyTypeChanged =
            lowerParty(String(draft.partyType ?? before.partyType)) !==
            lowerParty(String(before.partyType))
          const partyIdChanged =
            String(draft.partyId ?? before.partyId) !== String(before.partyId)
          if (partyTypeChanged || partyIdChanged) {
            const has = await sql<{ e: boolean }>`
              SELECT EXISTS(
                SELECT 1 FROM ${sql.raw(spec.itemTable)}
                WHERE ${sql.raw(spec.parentCol)}=${String(before.id)}::uuid
              ) AS e
            `.execute(trx)
            if (has.rows[0]?.e) {
              if (opts.partyConflictAsValidation) {
                const fields: Record<string, string[]> = {}
                if (partyTypeChanged) fields.partyType = ['已有条目时不可修改']
                if (partyIdChanged) fields.partyId = ['已有条目时不可修改']
                throw ApiError.validation('已有条目时不可修改履约对手', fields)
              }
              throw new ApiError('conflict', '已有条目时不可修改履约对手')
            }
          }
        }
      },
      beforeDelete: async (trx: TrxHandle, { item }: { item: Record<string, unknown> }) => {
        await sql`
          DELETE FROM sys_attachment
          WHERE owner_type=${spec.itemOwnerType}
            AND owner_id IN (
              SELECT id FROM ${sql.raw(spec.itemTable)}
              WHERE ${sql.raw(spec.parentCol)}=${String(item.id)}::uuid
            )
        `.execute(trx)
      },
    }
  }

  function itemHooks(spec: FulfillmentSideSpec) {
    return {
      validate: ({ draft }: { draft: Record<string, unknown> }) => {
        const qty = draft.qty
        if (qty === undefined || qty === null || qty === '') {
          throw ApiError.validation(`${spec.itemLabel}参数不合法`, { qty: ['必填'] })
        }
        if (!decimal(String(qty)).gt(0)) {
          throw ApiError.validation(`${spec.itemLabel}参数不合法`, { qty: ['必须大于 0'] })
        }
        if (!draft.orderItemId) {
          throw ApiError.validation(`${spec.itemLabel}参数不合法`, {
            orderItemId: ['必填'],
          })
        }
        if (draft.remarks != null && runeLen(String(draft.remarks)) > 512) {
          throw ApiError.validation(`${spec.itemLabel}参数不合法`, {
            remarks: ['最多 512 个字符'],
          })
        }
      },
      beforeWrite: async (
        trx: TrxHandle,
        {
          draft,
          parent,
        }: { draft: Record<string, unknown>; parent: Record<string, unknown> },
      ) => {
        const derived = await deriveItem(
          trx,
          spec,
          {
            companyId: String(parent.companyId),
            partyType: String(parent.partyType),
            partyId: String(parent.partyId),
          },
          {
            idx: Number(draft.idx),
            qty: decimal(String(draft.qty)),
            orderItemId: String(draft.orderItemId),
            unitId: draft.unitId == null || draft.unitId === '' ? null : String(draft.unitId),
            warehouseId:
              draft.warehouseId === undefined ||
              draft.warehouseId === null ||
              draft.warehouseId === ''
                ? null
                : String(draft.warehouseId),
            remarks: draft.remarks == null ? null : String(draft.remarks),
          },
        )
        applyDerivedItem(draft, derived)
      },
      afterWrite: async (
        trx: TrxHandle,
        {
          item,
          parent,
        }: { item: Record<string, unknown>; parent: Record<string, unknown> },
      ) => {
        await syncDrawingAttachments(
          trx,
          spec.itemOwnerType,
          String(item.id),
          String(item.materialId),
          String(parent.companyId),
        )
      },
      beforeDelete: async (
        trx: TrxHandle,
        { item }: { item: Record<string, unknown> },
      ) => {
        await sql`
          DELETE FROM sys_attachment
          WHERE owner_type=${spec.itemOwnerType} AND owner_id=${String(item.id)}::uuid
        `.execute(trx)
      },
    }
  }

  const listMapped = <T,>(
    r: { count: number; results: readonly unknown[] },
    present: (row: Record<string, unknown>) => T,
  ) => ({ count: r.count, results: r.results.map((row) => present(row as Record<string, unknown>)) })

  return {
    getSalesDraft: async (p: Permit, id: string): Promise<SalesDraftDto> =>
      presentSalesDraft(await salAggregate.loadDraft(p, id)),
    createSalesDraft: async (p: Permit, input: SalesDraftInput): Promise<SalesDraftDto> =>
      presentSalesDraft(await salAggregate.createDraft(p, salesDraftPayload(input))),
    replaceSalesDraft: async (
      p: Permit,
      id: string,
      input: SalesDraftInput,
    ): Promise<SalesDraftDto> =>
      presentSalesDraft(await salAggregate.replaceDraft(p, id, salesDraftPayload(input))),
    getPurchaseReceiptDraft: async (p: Permit, id: string): Promise<PurchaseReceiptDraftDto> =>
      presentPurchaseDraft(await purAggregate.loadDraft(p, id)),
    createPurchaseReceiptDraft: async (
      p: Permit,
      input: PurchaseReceiptDraftInput,
    ): Promise<PurchaseReceiptDraftDto> =>
      presentPurchaseDraft(await purAggregate.createDraft(p, purchaseDraftPayload(input))),
    replacePurchaseReceiptDraft: async (
      p: Permit,
      id: string,
      input: PurchaseReceiptDraftInput,
    ): Promise<PurchaseReceiptDraftDto> =>
      presentPurchaseDraft(await purAggregate.replaceDraft(p, id, purchaseDraftPayload(input))),
    listHeads: async (p: Permit, side: TradingSide, q: Partial<ListQuery>) => {
      if (side === 'purchase') return listMapped(await purHeads.list(p, q), presentPurchaseHead)
      return listMapped(await salHeads.list(p, q), presentSalesHead)
    },
    getHead: async (p: Permit, side: TradingSide, id: string) =>
      side === 'purchase'
        ? presentPurchaseHead((await purHeads.get(p, id)) as Record<string, unknown>)
        : presentSalesHead((await salHeads.get(p, id)) as Record<string, unknown>),
    createPurchaseHead: async (p: Permit, input: FulfillmentHeadDraftInput) =>
      presentPurchaseHead(
        (await purHeads.create(p, purchaseHeadPayload(input))) as Record<string, unknown>,
      ),
    updatePurchaseHead: async (p: Permit, id: string, input: FulfillmentHeadUpdateInput) => {
      const patch: Record<string, unknown> = {}
      if (input.no !== undefined) patch.receiptNo = input.no
      if (input.documentDate !== undefined) patch.receiptDate = input.documentDate
      if (input.postingDatePresent) patch.postingDate = input.postingDate ?? null
      if (input.partyType !== undefined) patch.partyType = input.partyType
      if (input.partyId !== undefined) patch.partyId = input.partyId
      if (input.remarksPresent) patch.remarks = input.remarks ?? null
      if (input.warehouseIdPresent) patch.warehouseId = input.warehouseId ?? null
      if (input.debitAccountId !== undefined) patch.debitAccountId = input.debitAccountId
      if (input.creditAccountId !== undefined) patch.creditAccountId = input.creditAccountId
      return presentPurchaseHead((await purHeads.update(p, id, patch)) as Record<string, unknown>)
    },
    deleteHead: (p: Permit, side: TradingSide, id: string) =>
      side === 'purchase' ? purHeads.remove(p, id) : salHeads.remove(p, id),
    auditHead: async (p: Permit, side: TradingSide, id: string, postingDateOverride?: string | null) => {
      // postingDateOverride 经转移 input 传入（照 bill-service 先例），不再是 deps hack
      const input = { postingDate: postingDateOverride ?? null }
      return side === 'purchase'
        ? presentPurchaseHead((await purHeads.transition(p, id, 'audit', input)) as Record<string, unknown>)
        : presentSalesHead((await salHeads.transition(p, id, 'audit', input)) as Record<string, unknown>)
    },
    voidHead: async (p: Permit, side: TradingSide, id: string) =>
      side === 'purchase'
        ? presentPurchaseHead((await purHeads.transition(p, id, 'void')) as Record<string, unknown>)
        : presentSalesHead((await salHeads.transition(p, id, 'void')) as Record<string, unknown>),
    listItems: async (p: Permit, side: TradingSide, q: Partial<ListQuery>) => {
      if (side === 'purchase') return listMapped(await purItems.list(p, q), presentPurchaseItem)
      return listAuthorized({
        db,
        permit: p,
        target: registry.authzTarget(salSpec.itemResource),
        alias: ITEM_ALIAS,
        resource: fulfillmentItemListMeta('sales'),
        source: ITEM_SOURCE.sales,
        select: ITEM_SELECT,
        defaultOrder: sql`"idx" ASC, "id" ASC`,
        query: q,
        mapRow: (r) => mapItemDto('sales', r),
      })
    },
    getItem: async (p: Permit, side: TradingSide, id: string) =>
      side === 'purchase'
        ? presentPurchaseItem((await purItems.get(p, id)) as Record<string, unknown>)
        : presentSalesItem((await salItems.get(p, id)) as Record<string, unknown>),
    createPurchaseItem: async (p: Permit, input: SalesDraftItemInput & { receiptId: string }) =>
      presentPurchaseItem(
        (await purItems.create(p, {
          receiptId: input.receiptId,
          idx: input.idx,
          qty: input.qty,
          orderItemId: input.orderItemId,
          unitId: input.unitId ?? null,
          warehouseId: input.warehouseId,
          remarks: input.remarks ?? null,
        })) as Record<string, unknown>,
      ),
    updatePurchaseItem: async (p: Permit, id: string, input: FulfillmentItemUpdateInput) => {
      const patch: Record<string, unknown> = {}
      if (input.idx !== undefined) patch.idx = input.idx
      if (input.qty !== undefined) patch.qty = input.qty
      if (input.orderItemId !== undefined) patch.orderItemId = input.orderItemId
      if (input.unitIdPresent) patch.unitId = input.unitId ?? null
      if (input.warehouseIdPresent) patch.warehouseId = input.warehouseId ?? null
      if (input.remarksPresent) patch.remarks = input.remarks ?? null
      return presentPurchaseItem((await purItems.update(p, id, patch)) as Record<string, unknown>)
    },
    deletePurchaseItem: (p: Permit, id: string) => purItems.remove(p, id),
    listPackBoxes: async (p: Permit, q: Partial<ListQuery>) =>
      listMapped(await packBoxes.list(p, q), presentPackBox),
    getPackBox: async (p: Permit, id: string) =>
      presentPackBox((await packBoxes.get(p, id)) as Record<string, unknown>),
    listPackLines: async (p: Permit, q: Partial<ListQuery>) =>
      listMapped(await packLines.list(p, q), presentPackLine),
    getPackLine: async (p: Permit, id: string) =>
      presentPackLine((await packLines.get(p, id)) as Record<string, unknown>),
    _aggregateForContract: (side: 'sales' | 'purchase'): AggregateService =>
      side === 'purchase' ? purContractAggregate : salContractAggregate,
  }
}

export type FulfillmentService = ReturnType<typeof createFulfillmentService>
