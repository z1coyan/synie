import { nullableString, requiredString } from './draft-fields'
import { api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { aggregateDraftTransport } from './aggregate-draft-transport'
import type { AggregateDraftAdapter } from './catalog/types'

export type QuotationSide = 'sales' | 'purchase'

export interface QuotationDraftTier {
  id?: string
  minQty: string
  price: string
}

export interface QuotationDraftItem {
  id?: string
  idx: number
  materialId: string
  unitId: string
  pricingMode: string
  price: string | null
  taxRate: string
  remarks: string | null
  tiers: QuotationDraftTier[]
}

export interface QuotationDraft {
  companyId: string
  quotationNo?: string | null
  quotationDate?: string | null
  validUntil: string
  partyType: string
  partyId: string
  currencyId?: string | null
  terms?: string | null
  remarks?: string | null
  items: QuotationDraftItem[]
}

export type QuotationSavedDraft = Row & {
  items: Array<Row & { tiers: Row[] }>
}

/** 表单状态到报价聚合 wire input 的唯一转换入口。 */
export function buildQuotationDraft(
  values: Record<string, unknown>,
  terms: string,
  rows: Row[],
): QuotationDraft {
  return {
    companyId: requiredString(values.companyId, '公司'),
    quotationNo: nullableString(values.quotationNo),
    quotationDate: nullableString(values.quotationDate),
    validUntil: requiredString(values.validUntil, '报价截止日期'),
    partyType: requiredString(values.partyType, '对手类型'),
    partyId: requiredString(values.partyId, '对手'),
    currencyId: nullableString(values.currencyId),
    terms: terms === '' ? null : terms,
    remarks: nullableString(values.remarks),
    items: rows.map((row) => {
      const tiered = String(row.pricingMode).toUpperCase() === 'QTY_TIERED'
      const tiers = ((row.tiers as Row[] | undefined) ?? []).map((tier) => ({
        ...(!isLocalRow(tier) ? { id: String(tier.id) } : {}),
        minQty: requiredString(
          tier.minQty,
          `第${String(row.idx)}行价格档起订量`,
        ),
        price: requiredString(
          tier.price,
          `第${String(row.idx)}行价格档单价`,
        ),
      }))
      return {
        ...(!isLocalRow(row) ? { id: String(row.id) } : {}),
        idx: Number(row.idx),
        materialId: requiredString(
          row.materialId,
          `第${String(row.idx)}行物料`,
        ),
        unitId: requiredString(row.unitId, `第${String(row.idx)}行单位`),
        pricingMode: requiredString(
          row.pricingMode,
          `第${String(row.idx)}行定价模式`,
        ),
        price: tiered ? null : nullableString(row.price),
        taxRate: requiredString(row.taxRate, `第${String(row.idx)}行税率`),
        remarks: nullableString(row.remarks),
        tiers: tiered ? tiers : [],
      }
    }),
  }
}

function wireDraft(input: QuotationDraft): QuotationDraft {
  return {
    ...input,
    items: input.items.map((item) => ({
      ...item,
      price: item.price == null ? null : String(item.price),
      taxRate: String(item.taxRate),
      tiers: item.tiers.map((tier) => ({
        ...tier,
        minQty: String(tier.minQty),
        price: String(tier.price),
      })),
    })),
  }
}

/** production Hono Adapters：销售与采购各占一个明确的聚合 seam。 */
export const salesQuotationDraftAdapter = aggregateDraftTransport<
  QuotationDraft,
  QuotationSavedDraft
>(api.sales.quotations, { wire: wireDraft })

export const purchaseQuotationDraftAdapter = aggregateDraftTransport<
  QuotationDraft,
  QuotationSavedDraft
>(api.purchase.quotations, { wire: wireDraft })

function clone<T>(value: T): T {
  return structuredClone(value)
}

/** 测试 Adapter；替换先构造完整下一快照，再一次性换入。 */
export function createInMemoryQuotationDraftAdapter(
  side: QuotationSide,
  initial: QuotationSavedDraft[] = [],
): AggregateDraftAdapter<QuotationDraft, QuotationSavedDraft> {
  const drafts = new Map(initial.map((draft) => [draft.id, clone(draft)]))
  let nextHead = initial.length + 1
  let nextItem =
    initial.reduce((count, draft) => count + draft.items.length, 0) + 1
  let nextTier =
    initial.reduce(
      (count, draft) =>
        count +
        draft.items.reduce((sum, item) => sum + item.tiers.length, 0),
      0,
    ) + 1

  const savedFrom = (
    input: QuotationDraft,
    id: string,
    previous?: QuotationSavedDraft,
  ): QuotationSavedDraft => {
    const oldItems = new Map(
      previous?.items.map((item) => [item.id, item]) ?? [],
    )
    const seenItems = new Set<string>()
    const seenTiers = new Set<string>()
    const items = input.items.map((item) => {
      if (item.id != null) {
        if (!oldItems.has(item.id)) {
          throw new Error(`条目 ${item.id} 不属于报价单 ${id}`)
        }
        if (seenItems.has(item.id)) throw new Error(`条目 ${item.id} 重复`)
        seenItems.add(item.id)
      }
      const itemId = item.id ?? `${side}-quotation-item-${nextItem++}`
      const oldTiers = new Set(oldItems.get(itemId)?.tiers.map((tier) => tier.id) ?? [])
      const tiers = item.tiers.map((tier) => {
        if (tier.id != null) {
          if (!oldTiers.has(tier.id)) {
            throw new Error(`价格档 ${tier.id} 不属于报价条目 ${itemId}`)
          }
          if (seenTiers.has(tier.id)) throw new Error(`价格档 ${tier.id} 重复`)
          seenTiers.add(tier.id)
        }
        return {
          ...tier,
          id: tier.id ?? `${side}-quotation-tier-${nextTier++}`,
          itemId,
        } as Row
      })
      return {
        ...item,
        id: itemId,
        quotationId: id,
        tiers,
      } as Row & { tiers: Row[] }
    })
    return {
      ...(previous ?? {}),
      ...input,
      id,
      status: previous?.status ?? 'DRAFT',
      items,
    } as QuotationSavedDraft
  }

  return {
    async loadDraft(id) {
      const draft = drafts.get(id)
      if (!draft) throw new Error(`报价单 ${id} 不存在`)
      return clone(draft)
    },
    async createDraft(input) {
      if (
        input.items.some(
          (item) =>
            item.id != null || item.tiers.some((tier) => tier.id != null),
        )
      ) {
        throw new Error('新报价草稿不能包含持久化子记录 id')
      }
      const id = `${side}-quotation-${nextHead++}`
      const saved = savedFrom(input, id)
      drafts.set(id, clone(saved))
      return clone(saved)
    },
    async replaceDraft(id, input) {
      const previous = drafts.get(id)
      if (!previous) throw new Error(`报价单 ${id} 不存在`)
      const saved = savedFrom(input, id, previous)
      drafts.set(id, clone(saved))
      return clone(saved)
    },
  }
}
