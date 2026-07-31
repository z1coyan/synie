import { describe, expect, test } from 'bun:test'
import type { Row } from '~/components/synie-data-grid/types'
import {
  buildQuotationDraft,
  createInMemoryQuotationDraftAdapter,
  purchaseQuotationDraftAdapter,
  salesQuotationDraftAdapter,
  type QuotationDraft,
  type QuotationSide,
} from './quotation-draft'

const header = {
  companyId: 'company-1',
  quotationNo: 'Q-1',
  quotationDate: '2026-07-31',
  validUntil: '2026-08-31',
  partyType: 'CUSTOMER',
  partyId: 'party-1',
  currencyId: 'currency-1',
  remarks: null,
}

function fixedItem(idx: number) {
  return {
    idx,
    materialId: `material-${idx}`,
    unitId: `unit-${idx}`,
    pricingMode: 'FIXED',
    price: String(idx * 10),
    taxRate: '0.13',
    remarks: null,
    tiers: [],
  }
}

async function exerciseSide(side: QuotationSide) {
  const adapter = createInMemoryQuotationDraftAdapter(side)
  const created = await adapter.createDraft({
    ...header,
    items: [
      fixedItem(1),
      {
        ...fixedItem(2),
        pricingMode: 'QTY_TIERED',
        price: null,
        tiers: [
          { minQty: '10', price: '8' },
          { minQty: '100', price: '7' },
        ],
      },
    ],
  })
  const keptItem = created.items[1]!
  const keptTier = keptItem.tiers[0]!

  const replaced = await adapter.replaceDraft(created.id, {
    ...header,
    terms: '整体替换',
    items: [
      {
        ...fixedItem(2),
        id: keptItem.id,
        pricingMode: 'QTY_TIERED',
        price: null,
        tiers: [
          { id: keptTier.id, minQty: '20', price: '6' },
          { minQty: '200', price: '5' },
        ],
      },
      fixedItem(3),
    ],
  })

  expect(replaced.items).toHaveLength(2)
  expect(replaced.items.some((item) => item.id === created.items[0]?.id)).toBe(false)
  expect(replaced.items[0]?.id).toBe(keptItem.id)
  expect(replaced.items[0]?.tiers[0]?.id).toBe(keptTier.id)
  expect(replaced.items[0]?.tiers[0]?.minQty).toBe('20')
  expect(await adapter.loadDraft(created.id)).toEqual(replaced)
}

describe('销售/采购报价 Aggregate Draft module', () => {
  test('两个 production Adapter 与测试 Adapter 共享同一 interface', () => {
    for (const adapter of [
      salesQuotationDraftAdapter,
      purchaseQuotationDraftAdapter,
      createInMemoryQuotationDraftAdapter('sales'),
      createInMemoryQuotationDraftAdapter('purchase'),
    ]) {
      expect(typeof adapter.loadDraft).toBe('function')
      expect(typeof adapter.createDraft).toBe('function')
      expect(typeof adapter.replaceDraft).toBe('function')
    }
  })

  test('表单转换保留持久化身份、剥离本地身份和展示快照', () => {
    const draft = buildQuotationDraft(header, '报价条款', [
      {
        id: 'saved-item',
        ...fixedItem(1),
      } as Row,
      {
        id: 'local:item',
        ...fixedItem(2),
        pricingMode: 'QTY_TIERED',
        materialName: '仅展示',
        tiers: [
          { id: 'saved-tier', minQty: 10, price: 8 },
          { id: 'local:tier', minQty: 100, price: 7 },
        ],
      } as Row,
    ])

    expect(draft.terms).toBe('报价条款')
    expect(draft.items[0]?.id).toBe('saved-item')
    expect(draft.items[1]).not.toHaveProperty('id')
    expect(draft.items[1]).not.toHaveProperty('materialName')
    expect(draft.items[1]?.tiers[0]?.id).toBe('saved-tier')
    expect(draft.items[1]?.tiers[1]).not.toHaveProperty('id')
    expect(draft.items[1]?.tiers[0]?.minQty).toBe('10')
  })

  test('销售/采购均可通过 interface 整体增改删条目与价格档', async () => {
    await exerciseSide('sales')
    await exerciseSide('purchase')
  })

  test('嵌套身份失败时替换前快照保持不变', async () => {
    const adapter = createInMemoryQuotationDraftAdapter('sales')
    const created = await adapter.createDraft({
      ...header,
      items: [{
        ...fixedItem(1),
        pricingMode: 'QTY_TIERED',
        price: null,
        tiers: [{ minQty: '10', price: '8' }],
      }],
    })
    const before = await adapter.loadDraft(created.id)

    await expect(
      adapter.replaceDraft(created.id, {
        ...header,
        terms: '不应可见',
        items: [{
          ...fixedItem(1),
          id: created.items[0]!.id,
          pricingMode: 'QTY_TIERED',
          price: null,
          tiers: [{ id: 'foreign-tier', minQty: '20', price: '6' }],
        }],
      }),
    ).rejects.toThrow(/不属于报价条目/)

    expect(await adapter.loadDraft(created.id)).toEqual(before)
  })

  test('固定价 wire 草稿不会携带残留价格档', () => {
    const draft = buildQuotationDraft(header, '', [{
      id: 'saved-item',
      ...fixedItem(1),
      tiers: [{ id: 'saved-tier', minQty: '10', price: '8' }],
    } as Row])
    expect(draft.items[0]?.tiers).toEqual([])
  })

  test('测试 Adapter 返回隔离快照', async () => {
    const adapter = createInMemoryQuotationDraftAdapter('purchase')
    const created = await adapter.createDraft({
      ...header,
      items: [fixedItem(1)],
    } satisfies QuotationDraft)
    const loaded = await adapter.loadDraft(created.id)
    loaded.items[0]!.price = '999'
    expect((await adapter.loadDraft(created.id)).items[0]?.price).toBe('10')
  })
})
