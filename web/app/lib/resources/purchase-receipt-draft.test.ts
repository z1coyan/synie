import { describe, expect, test } from 'bun:test'
import type { Row } from '~/components/synie-data-grid/types'
import type { AggregateDraftAdapter } from './catalog/types'
import {
  buildPurchaseReceiptDraft,
  createInMemoryPurchaseReceiptDraftAdapter,
  purchaseReceiptDraftAdapter,
  type PurchaseReceiptDraft,
  type PurchaseReceiptSavedDraft,
} from './purchase-receipt-draft'

const header = {
  companyId: 'company-1',
  receiptNo: 'PR-1',
  receiptDate: '2026-07-31',
  postingDate: '2026-07-31',
  partyType: 'SUPPLIER',
  partyId: 'supplier-1',
  remarks: null,
  warehouseId: 'warehouse-1',
  debitAccountId: 'debit-1',
  creditAccountId: 'credit-1',
}

function item(idx: number, overrides: Partial<PurchaseReceiptDraft['items'][number]> = {}) {
  return {
    idx,
    qty: String(idx),
    orderItemId: `order-item-${idx}`,
    unitId: `unit-${idx}`,
    warehouseId: 'warehouse-1',
    remarks: null,
    ...overrides,
  }
}

async function createOne(
  adapter: AggregateDraftAdapter<PurchaseReceiptDraft, PurchaseReceiptSavedDraft>,
) {
  return adapter.createDraft({
    ...header,
    items: [item(1), item(2)],
  })
}

describe('采购入库 Aggregate Draft module', () => {
  test('production 与测试 Adapter 共享 load/create/replace interface', () => {
    for (const adapter of [
      purchaseReceiptDraftAdapter,
      createInMemoryPurchaseReceiptDraftAdapter(),
    ]) {
      expect(typeof adapter.loadDraft).toBe('function')
      expect(typeof adapter.createDraft).toBe('function')
      expect(typeof adapter.replaceDraft).toBe('function')
    }
  })

  test('表单草稿只保留 wire 所需字段，本地行 id 不越过 seam', () => {
    const draft = buildPurchaseReceiptDraft(header, [
      {
        id: 'local:new',
        idx: 1,
        qty: 3,
        orderItemId: 'order-item-1',
        materialId: 'derived-on-server',
        materialName: '仅展示快照',
        unitId: 'unit-1',
        warehouseId: 'warehouse-1',
      } as Row,
      {
        id: 'saved-item',
        idx: 2,
        qty: '4.5',
        orderItemId: 'order-item-2',
        unitId: 'unit-2',
        warehouseId: 'warehouse-1',
      } as Row,
    ])

    expect(draft.items[0]).toEqual({
      idx: 1,
      qty: '3',
      orderItemId: 'order-item-1',
      unitId: 'unit-1',
      warehouseId: 'warehouse-1',
      remarks: null,
    })
    expect(draft.items[1]?.id).toBe('saved-item')
    expect(draft.items[0]).not.toHaveProperty('materialId')
    expect(draft.items[0]).not.toHaveProperty('materialName')
  })

  test('通过 interface 整体创建、读取与替换完整草稿', async () => {
    const adapter = createInMemoryPurchaseReceiptDraftAdapter()
    const created = await createOne(adapter)

    expect(created.items).toHaveLength(2)
    expect(created.items.every((row) => row.receiptId === created.id)).toBe(true)

    const kept = created.items[0]!
    const replaced = await adapter.replaceDraft(created.id, {
      ...header,
      remarks: '整单替换',
      items: [
        item(1, { id: kept.id, qty: '9' }),
        item(3),
      ],
    })

    expect(replaced.remarks).toBe('整单替换')
    expect(replaced.items).toHaveLength(2)
    expect(replaced.items.find((row) => row.id === kept.id)?.qty).toBe('9')
    expect(replaced.items.some((row) => row.id === created.items[1]?.id)).toBe(false)
    expect(await adapter.loadDraft(created.id)).toEqual(replaced)
  })

  test('替换身份校验失败时原草稿保持不变', async () => {
    const adapter = createInMemoryPurchaseReceiptDraftAdapter()
    const created = await createOne(adapter)
    const before = await adapter.loadDraft(created.id)

    await expect(
      adapter.replaceDraft(created.id, {
        ...header,
        remarks: '不应可见',
        items: [item(1, { id: 'foreign-item', qty: '99' })],
      }),
    ).rejects.toThrow(/不属于采购入库单/)

    expect(await adapter.loadDraft(created.id)).toEqual(before)
  })

  test('load 返回隔离快照，调用者修改不会穿透 Adapter 状态', async () => {
    const adapter = createInMemoryPurchaseReceiptDraftAdapter()
    const created = await createOne(adapter)
    const loaded = await adapter.loadDraft(created.id)
    loaded.items[0]!.qty = '999'

    expect((await adapter.loadDraft(created.id)).items[0]?.qty).toBe('1')
  })
})
