/**
 * 销售/采购报价单：头/条目/价格档 + 订单套档解析。
 *
 * W2 聚合迁移：create/update 整单草稿与孙级价格档由 platform/standard 派生——
 * 头 createStandardService + 条目/价格档 createStandardChildService + createAggregateService。
 * 路由手写（URL/DTO 冻结）；本文件只装配描述符、领域钩子与公开 API。
 */
import type { ListQuery } from '@synie/shared'
import { decimal, type Decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { utcToday } from '~/db/dates.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
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
import {
  guardCustomerMaterial,
  guardMaterialType,
  ident,
  loadMaterialSnap,
  lowerParty,
  partyExists,
  toDateOnly,
  type TradingSide,
  wireRequiredDecimal,
} from '../common.ts'
import {
  assertAuditable,
  assertTierEditable,
  normalizeItemShape,
  purgeTiersForItem,
  QUOTATION_WRITE_ERRORS,
  readItemWire,
  resolveForOrder,
  validateHeadShape,
  validateTierShape,
} from './domain.ts'
import {
  HEAD_ALIAS,
  HEAD_EXTRA,
  headExtras,
  headSource,
  ITEM_ALIAS,
  ITEM_EXTRA,
  itemExtras,
  itemSource,
  TIER_ALIAS,
  TIER_EXTRA,
  tierExtras,
  tierSource,
} from './projection.ts'
import { quotationSpec, type QuotationSideSpec } from './spec.ts'
import type {
  Quotation,
  QuotationDraftInput,
  QuotationHeadCreateInput,
  QuotationHeadUpdateInput,
  QuotationItem,
  QuotationItemCreateInput,
  QuotationItemUpdateInput,
  QuotationSavedDraft,
  QuotationTier,
} from './types.ts'

export type {
  Quotation,
  QuotationDraftInput,
  QuotationDraftItemInput,
  QuotationDraftTierInput,
  QuotationHeadCreateInput,
  QuotationHeadUpdateInput,
  QuotationItem,
  QuotationItemCreateInput,
  QuotationItemUpdateInput,
  QuotationSavedDraft,
  QuotationTier,
  ResolveOrderInput,
  ResolveOrderResult,
} from './types.ts'

interface SideCtx {
  spec: QuotationSideSpec
  heads: StandardService<Quotation>
  items: StandardChildService<QuotationItem>
  tiers: StandardChildService<QuotationTier>
  aggregate: AggregateService
}

function applyItemShape(draft: Record<string, unknown>): void {
  const w = readItemWire(draft)
  const { mode, price, taxRate } = normalizeItemShape(
    w.pricingMode,
    w.price,
    w.taxRate,
    w.materialId,
    w.unitId,
    w.remarks,
  )
  draft.pricingMode = mode
  draft.price = price !== null ? wireRequiredDecimal(price) : null
  draft.taxRate = wireRequiredDecimal(taxRate)
}

function draftPayload(input: QuotationDraftInput | Record<string, unknown>): Record<string, unknown> {
  const raw = input as Record<string, unknown>
  const payload: Record<string, unknown> = {
    companyId: raw.companyId,
    quotationDate: raw.quotationDate ?? undefined,
    validUntil: raw.validUntil,
    partyType: raw.partyType,
    partyId: raw.partyId,
    currencyId: raw.currencyId ?? undefined,
    terms: raw.terms ?? null,
    remarks: raw.remarks ?? null,
  }
  // 缺 items 键原样透传，让聚合层 fail-closed（「必须显式提交数组」）
  if (Array.isArray(raw.items)) {
    payload.items = (raw.items as QuotationDraftInput['items']).map((item) => ({
      ...(item.id !== undefined ? { id: item.id } : {}),
      idx: item.idx,
      materialId: item.materialId,
      unitId: item.unitId,
      pricingMode: item.pricingMode,
      price: item.price,
      taxRate: item.taxRate,
      remarks: item.remarks ?? null,
      tiers: (item.tiers ?? []).map((t) => ({
        ...(t.id !== undefined ? { id: t.id } : {}),
        minQty: t.minQty,
        price: t.price,
      })),
    }))
  }
  if (raw.quotationNo != null && String(raw.quotationNo).trim() !== '') {
    payload.quotationNo = raw.quotationNo
  }
  return payload
}

export function createQuotationService(
  db: Kysely<Database>,
  numberer: NumberingService,
  registry: Registry,
) {
  const sides: Record<TradingSide, SideCtx> = {
    sales: buildSide('sales'),
    purchase: buildSide('purchase'),
  }

  function buildSide(side: TradingSide): SideCtx {
    const spec = quotationSpec(side)
    const tierMeta = registry.get(spec.tierResource)!
    const tierAudit = auditFieldsOf(tierMeta)

    const heads = createStandardService<Quotation>({
      db,
      registry,
      resource: spec.headResource,
      notFound: `${spec.label}不存在`,
      defaultOrder: sql`"quotation_date" DESC, "id" ASC`,
      writeErrors: QUOTATION_WRITE_ERRORS,
      numbering: { service: numberer, field: 'quotationNo' },
      projection: {
        source: headSource(spec),
        alias: HEAD_ALIAS,
        selectExtra: HEAD_EXTRA,
        mapExtra: headExtras,
      },
      hooks: {
        insertColumns: ({ permit }) => ({
          created_by_id: permit.actor.userId || null,
        }),
        validate: ({ action, draft, before }) => {
          if (action === 'create') {
            validateHeadShape(spec, {
              quotationNo: 'x',
              quotationDate: String(draft.quotationDate ?? utcToday()),
              validUntil: String(draft.validUntil ?? ''),
              partyType: lowerParty(String(draft.partyType ?? '')),
              partyId: String(draft.partyId ?? ''),
              companyId: String(draft.companyId ?? ''),
              currencyId: String(draft.currencyId ?? 'pending'),
              remarks: draft.remarks == null ? null : String(draft.remarks),
              requireQuotationNo: false,
              requireCurrency: draft.currencyId != null && draft.currencyId !== '',
            })
            return
          }
          validateHeadShape(spec, {
            quotationNo: String(draft.quotationNo ?? ''),
            quotationDate: String(draft.quotationDate ?? ''),
            validUntil: String(draft.validUntil ?? ''),
            partyType: lowerParty(String(draft.partyType ?? '')),
            partyId: String(draft.partyId ?? ''),
            companyId: String(draft.companyId ?? ''),
            currencyId: String(draft.currencyId ?? ''),
            remarks: draft.remarks == null ? null : String(draft.remarks),
            requireQuotationNo: true,
          })
          if (
            before &&
            draft.quotationNo !== undefined &&
            String(draft.quotationNo).trim() !== String(before.quotationNo)
          ) {
            throw ApiError.validation('报价参数不合法', {
              quotationNo: ['编号创建后不可修改'],
            })
          }
        },
        beforeWrite: async (trx, { action, draft, before }) => {
          if (action === 'create') {
            if (!draft.quotationDate) draft.quotationDate = utcToday()
            else draft.quotationDate = toDateOnly(String(draft.quotationDate))
            draft.validUntil = toDateOnly(String(draft.validUntil))
            const company = await trx
              .selectFrom('bas_company')
              .select(['id', 'base_currency_id'])
              .where('id', '=', String(draft.companyId))
              .executeTakeFirst()
            if (!company) {
              throw ApiError.validation('报价参数不合法', { companyId: ['公司不存在'] })
            }
            if (draft.currencyId == null || draft.currencyId === '') {
              draft.currencyId = company.base_currency_id
            }
            validateHeadShape(spec, {
              quotationNo: 'x',
              quotationDate: String(draft.quotationDate),
              validUntil: String(draft.validUntil),
              partyType: lowerParty(String(draft.partyType ?? '')),
              partyId: String(draft.partyId ?? ''),
              companyId: String(draft.companyId ?? ''),
              currencyId: String(draft.currencyId ?? ''),
              remarks: draft.remarks == null ? null : String(draft.remarks),
              requireQuotationNo: false,
            })
          } else {
            if (draft.quotationDate != null) {
              draft.quotationDate = toDateOnly(String(draft.quotationDate))
            }
            if (draft.validUntil != null) {
              draft.validUntil = toDateOnly(String(draft.validUntil))
            }
          }
          if (!(await partyExists(trx, String(draft.partyType ?? ''), String(draft.partyId ?? '')))) {
            throw ApiError.validation('报价参数不合法', { partyId: ['对手不存在'] })
          }
          if (action === 'update' && before) {
            const headChanged =
              lowerParty(String(draft.partyType)) !== lowerParty(String(before.partyType)) ||
              String(draft.partyId) !== String(before.partyId) ||
              String(draft.currencyId) !== String(before.currencyId)
            if (headChanged) {
              const has = await sql<{ e: boolean }>`
                SELECT EXISTS(
                  SELECT 1 FROM ${ident(spec.itemTable)} WHERE quotation_id=${String(before.id)}::uuid
                ) AS e
              `.execute(trx)
              if (has.rows[0]?.e) throw new ApiError('conflict', '请先删除报价条目')
            }
          }
        },
      },
      workflow: {
        mutableMessage: '仅草稿报价单可修改或删除',
        transitions: [
          {
            key: 'audit',
            label: '审核',
            from: ['DRAFT'],
            to: 'AUDITED',
            guardMessage: '仅草稿报价单可审核',
            stamps: ({ permit }) => auditStamp(permit),
            effect: async (trx, { before }) => {
              await assertAuditable(trx, spec, String(before.id))
            },
          },
          {
            key: 'void',
            label: '作废',
            from: ['AUDITED'],
            to: 'VOIDED',
            guardMessage: '仅已审核报价单可作废',
          },
        ],
      },
    })

    const tiers = createStandardChildService<QuotationTier>({
      db,
      registry,
      resource: spec.tierResource,
      notFound: '报价价格档不存在',
      defaultOrder: sql`"min_qty" ASC, "id" ASC`,
      writeErrors: QUOTATION_WRITE_ERRORS,
      recordLabel: (item) => String(item.minQty),
      projection: {
        source: tierSource(spec),
        alias: TIER_ALIAS,
        selectExtra: TIER_EXTRA,
        mapExtra: tierExtras,
      },
      parent: {
        resource: spec.itemResource,
        fkField: 'itemId',
        notFound: '报价条目不存在',
        inheritFields: ['companyId'],
      },
      hooks: {
        validate: ({ draft }) => {
          validateTierShape(decimal(String(draft.minQty ?? '0')), decimal(String(draft.price ?? '0')))
        },
        beforeWrite: async (trx, { draft, parent }) => {
          await assertTierEditable(trx, spec, parent)
          draft.minQty = wireRequiredDecimal(draft.minQty as string | number | Decimal)
          draft.price = wireRequiredDecimal(draft.price as string | number | Decimal)
        },
        beforeDelete: async (trx, { parent }) => {
          await assertTierEditable(trx, spec, parent)
        },
      },
    })

    const items = createStandardChildService<QuotationItem>({
      db,
      registry,
      resource: spec.itemResource,
      notFound: '报价条目不存在',
      defaultOrder: sql`"quotation_date" DESC, "idx" ASC, "id" ASC`,
      writeErrors: QUOTATION_WRITE_ERRORS,
      recordLabel: (item) => String(item.idx),
      derivedFields: [
        'materialCode',
        'materialName',
        'materialSpec',
        'customerPartNo',
        'unitName',
      ],
      projection: {
        source: itemSource(spec),
        alias: ITEM_ALIAS,
        selectExtra: ITEM_EXTRA,
        mapExtra: itemExtras,
      },
      parent: {
        resource: spec.headResource,
        fkField: 'quotationId',
        notFound: `${spec.label}不存在`,
        inheritFields: ['companyId'],
        gate: (parent) => {
          if (String(parent.status) !== 'DRAFT') {
            throw new ApiError('conflict', '仅草稿报价单可编辑条目')
          }
        },
      },
      hooks: {
        validate: ({ draft }) => {
          const w = readItemWire(draft)
          normalizeItemShape(w.pricingMode, w.price, w.taxRate, w.materialId, w.unitId, w.remarks)
        },
        beforeWrite: async (trx, { draft, parent }) => {
          applyItemShape(draft)
          const snap = await loadMaterialSnap(trx, String(draft.materialId), String(draft.unitId))
          if (spec.customerMaterialGuard) {
            guardCustomerMaterial(side, String(parent.partyType), String(parent.partyId), snap)
            guardMaterialType(snap, ['STOCK', 'VIRTUAL'], '报价条目')
          }
          draft.materialCode = snap.code
          draft.materialName = snap.name
          draft.materialSpec = snap.spec
          draft.customerPartNo = snap.customerPartNo
          draft.unitName = snap.unitName
        },
        afterWrite: async (trx, { action, permit, item, before }) => {
          if (action !== 'update' || !before) return
          if (
            String(before.pricingMode).toUpperCase() === 'QTY_TIERED' &&
            String(item.pricingMode).toUpperCase() === 'FIXED'
          ) {
            await purgeTiersForItem(
              trx,
              permit,
              { spec, tierMeta, tierAudit, tiers },
              String(item.id),
            )
          }
        },
      },
    })

    return {
      spec,
      heads,
      items,
      tiers,
      aggregate: createAggregateService({
        db,
        registry,
        head: heads,
        validationMessage: '报价草稿参数不合法',
        children: [
          {
            key: 'items',
            service: items,
            children: [{ key: 'tiers', service: tiers }],
          },
        ],
      }),
    }
  }

  return {
    listHeads: (p: Permit, side: TradingSide, q: Partial<ListQuery>) =>
      sides[side].heads.list(p, q),
    getHead: (p: Permit, side: TradingSide, id: string) => sides[side].heads.get(p, id),
    createHead: (p: Permit, side: TradingSide, input: QuotationHeadCreateInput) =>
      sides[side].heads.create(p, {
        companyId: input.companyId,
        quotationDate: input.quotationDate ?? undefined,
        validUntil: input.validUntil,
        partyType: input.partyType,
        partyId: input.partyId,
        currencyId: input.currencyId ?? undefined,
        terms: input.terms ?? null,
        remarks: input.remarks ?? null,
        ...(input.quotationNo != null && String(input.quotationNo).trim() !== ''
          ? { quotationNo: input.quotationNo }
          : {}),
      }),
    updateHead: (p: Permit, side: TradingSide, id: string, input: QuotationHeadUpdateInput) => {
      const patch: Record<string, unknown> = {}
      if (input.quotationDate !== undefined) patch.quotationDate = input.quotationDate
      if (input.validUntil !== undefined) patch.validUntil = input.validUntil
      if (input.partyType !== undefined) patch.partyType = input.partyType
      if (input.partyId !== undefined) patch.partyId = input.partyId
      if (input.currencyId !== undefined) patch.currencyId = input.currencyId
      if (input.termsPresent) patch.terms = input.terms ?? null
      if (input.remarksPresent) patch.remarks = input.remarks ?? null
      if (input.quotationNo !== undefined) patch.quotationNo = input.quotationNo
      return sides[side].heads.update(p, id, patch)
    },
    deleteHead: (p: Permit, side: TradingSide, id: string) => sides[side].heads.remove(p, id),
    auditHead: (p: Permit, side: TradingSide, id: string) =>
      sides[side].heads.transition(p, id, 'audit'),
    voidHead: (p: Permit, side: TradingSide, id: string) =>
      sides[side].heads.transition(p, id, 'void'),
    listItems: (p: Permit, side: TradingSide, q: Partial<ListQuery>) =>
      sides[side].items.list(p, q),
    getItem: (p: Permit, side: TradingSide, id: string) => sides[side].items.get(p, id),
    createItem: (p: Permit, side: TradingSide, input: QuotationItemCreateInput) =>
      sides[side].items.create(p, {
        quotationId: input.quotationId,
        idx: input.idx,
        materialId: input.materialId,
        unitId: input.unitId,
        pricingMode: input.pricingMode,
        price: input.price,
        taxRate: input.taxRate,
        remarks: input.remarks ?? null,
      }),
    updateItem: (p: Permit, side: TradingSide, id: string, input: QuotationItemUpdateInput) => {
      const patch: Record<string, unknown> = {}
      if (input.idx !== undefined) patch.idx = input.idx
      if (input.materialId !== undefined) patch.materialId = input.materialId
      if (input.unitId !== undefined) patch.unitId = input.unitId
      if (input.pricingMode !== undefined) patch.pricingMode = input.pricingMode
      if (input.pricePresent) patch.price = input.price ?? null
      if (input.taxRate !== undefined) patch.taxRate = input.taxRate
      if (input.remarksPresent) patch.remarks = input.remarks ?? null
      return sides[side].items.update(p, id, patch)
    },
    deleteItem: (p: Permit, side: TradingSide, id: string) => sides[side].items.remove(p, id),
    listTiers: (p: Permit, side: TradingSide, q: Partial<ListQuery>) =>
      sides[side].tiers.list(p, q),
    getTier: (p: Permit, side: TradingSide, id: string) => sides[side].tiers.get(p, id),
    createTier: (
      p: Permit,
      side: TradingSide,
      input: { itemId: string; minQty: string; price: string },
    ) => sides[side].tiers.create(p, input),
    updateTier: (
      p: Permit,
      side: TradingSide,
      id: string,
      input: { minQty?: string; price?: string },
    ) => sides[side].tiers.update(p, id, input),
    deleteTier: (p: Permit, side: TradingSide, id: string) => sides[side].tiers.remove(p, id),
    getDraft: (p: Permit, side: TradingSide, id: string) =>
      sides[side].aggregate.loadDraft(p, id) as Promise<QuotationSavedDraft>,
    createDraft: (p: Permit, side: TradingSide, input: QuotationDraftInput) =>
      sides[side].aggregate.createDraft(p, draftPayload(input)) as Promise<QuotationSavedDraft>,
    replaceDraft: (p: Permit, side: TradingSide, id: string, input: QuotationDraftInput) =>
      sides[side].aggregate.replaceDraft(
        p,
        id,
        draftPayload(input),
      ) as Promise<QuotationSavedDraft>,
    resolveForOrder,
  }
}

export type QuotationService = ReturnType<typeof createQuotationService>
