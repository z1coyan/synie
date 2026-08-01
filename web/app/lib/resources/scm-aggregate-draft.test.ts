import { describe, expect, test } from 'bun:test'
import type { Row } from '~/components/synie-data-grid/types'
import {
  buildOutsourcedIssueDraft,
  buildOutsourcedReceiptDraft,
  buildReconciliationDraft,
  decodeFlatSavedDraft,
  decodeOutsourcedReceiptSavedDraft,
} from './scm-aggregate-draft'

const reconciliationHead = {
  companyId: 'company-1',
  reconciliationNo: 'REC-1',
  reconciliationType: 'REGULAR',
  partyType: 'SUPPLIER',
  partyId: 'supplier-1',
  postingDate: '2026-08-01',
  remarks: null,
  debitAccountId: 'debit-1',
  creditAccountId: 'credit-1',
}

describe('SCM Aggregate Draft wire 构造', () => {
  test('销售/采购对账保留存量 id、剥离本地 id，并只发送单一来源引用', () => {
    const sales = buildReconciliationDraft(
      'sales',
      {
        ...reconciliationHead,
        partyType: 'CUSTOMER',
        partyId: 'customer-1',
        grossTotal: '999',
        baseGrossTotal: '999',
        status: 'AUDITED',
      },
      [
        {
          id: 'local:new',
          idx: 1,
          deliveryItemId: 'delivery-item-1',
          qty: 2,
          amount: '999',
          materialName: '只读快照',
        } as Row,
        {
          id: 'saved-item',
          idx: 2,
          deliveryItemId: 'delivery-item-2',
          qty: '3',
          remarks: '保留',
        } as Row,
      ],
    )
    expect(sales.items).toEqual([
      {
        idx: 1,
        deliveryItemId: 'delivery-item-1',
        qty: '2',
        remarks: null,
      },
      {
        id: 'saved-item',
        idx: 2,
        deliveryItemId: 'delivery-item-2',
        qty: '3',
        remarks: '保留',
      },
    ])
    expect(sales).not.toHaveProperty('grossTotal')
    expect(sales).not.toHaveProperty('baseGrossTotal')
    expect(sales).not.toHaveProperty('status')

    const purchase = buildReconciliationDraft('purchase', reconciliationHead, [
      {
        id: 'saved-purchase-item',
        idx: 1,
        receiptItemId: null,
        outsourcedReceiptItemId: 'outsourced-receipt-item-1',
        qty: '4',
      } as Row,
    ])
    expect(purchase.items[0]).toEqual({
      id: 'saved-purchase-item',
      idx: 1,
      receiptItemId: null,
      outsourcedReceiptItemId: 'outsourced-receipt-item-1',
      qty: '4',
      remarks: null,
    })
    expect(() =>
      buildReconciliationDraft('purchase', reconciliationHead, [
        {
          id: 'local:bad',
          idx: 1,
          receiptItemId: 'normal-1',
          outsourcedReceiptItemId: 'outsourced-1',
          qty: '1',
        } as Row,
      ]),
    ).toThrow('必须且只能选择一个')
  })

  test('委外发料一次提交头与完整条目，服务端快照字段不越过 seam', () => {
    const draft = buildOutsourcedIssueDraft(
      {
        companyId: 'company-1',
        issueNo: 'OI-1',
        issueDate: '2026-08-01',
        partyType: 'SUPPLIER',
        partyId: 'supplier-1',
        fromWarehouseId: 'warehouse-1',
        outsourcedWarehouseId: 'warehouse-2',
      },
      [
        {
          id: 'local:new',
          idx: 1,
          orderItemMaterialId: 'order-material-1',
          qty: 5,
          fromWarehouseId: 'warehouse-1',
          outsourcedWarehouseId: 'warehouse-2',
          materialName: '只读材料名',
        } as Row,
      ],
    )
    expect(draft.items).toEqual([
      {
        idx: 1,
        orderItemMaterialId: 'order-material-1',
        qty: '5',
        fromWarehouseId: 'warehouse-1',
        outsourcedWarehouseId: 'warehouse-2',
        remarks: null,
      },
    ])
  })

  test('委外入库按 policy 组装 items/materialLines/byproductLines 多层树并保留各层存量 id', () => {
    const items = [
      {
        id: 'saved-item',
        idx: 1,
        orderItemId: 'order-item-1',
        unitId: 'unit-1',
        qty: '10',
        warehouseId: 'warehouse-1',
        reconciledQty: '2', // 受控投影不得进入 wire tree
        materialId: 'server-derived',
      } as Row,
      {
        id: 'local:item',
        idx: 2,
        orderItemId: 'order-item-2',
        unitId: 'unit-2',
        qty: 3,
        warehouseId: 'warehouse-1',
      } as Row,
    ]
    const draft = buildOutsourcedReceiptDraft(
      {
        companyId: 'company-1',
        receiptNo: 'OR-1',
        receiptDate: '2026-08-01',
        postingDate: '2026-08-01',
        partyType: 'SUPPLIER',
        partyId: 'supplier-1',
        warehouseId: 'warehouse-1',
        outsourcedWarehouseId: 'warehouse-2',
        debitAccountId: 'debit-1',
        creditAccountId: 'credit-1',
      },
      items,
      [
        {
          id: 'saved-material-line',
          idx: 1,
          receiptItemId: 'saved-item',
          orderItemMaterialId: 'material-line-1',
          qty: '6',
          outsourcedWarehouseId: 'warehouse-2',
          materialName: '只读快照',
        } as Row,
        {
          id: 'local:material',
          idx: 1,
          receiptItemId: 'local:item',
          orderItemMaterialId: 'material-line-2',
          qty: 2,
        } as Row,
      ],
      [
        {
          id: 'local:byproduct',
          idx: 1,
          receiptItemId: 'saved-item',
          orderItemByproductId: 'byproduct-line-1',
          qty: '1',
          warehouseId: 'warehouse-1',
        } as Row,
      ],
    )

    expect(draft.items[0]?.id).toBe('saved-item')
    expect(draft.items[0]?.materialLines).toEqual([
      {
        id: 'saved-material-line',
        idx: 1,
        orderItemMaterialId: 'material-line-1',
        qty: '6',
        outsourcedWarehouseId: 'warehouse-2',
        remarks: null,
      },
    ])
    expect(draft.items[0]?.byproductLines[0]).not.toHaveProperty('id')
    expect(draft.items[1]).not.toHaveProperty('id')
    expect(draft.items[1]?.materialLines[0]).not.toHaveProperty(
      'receiptItemId',
    )
    expect(draft.items[1]?.materialLines[0]?.qty).toBe('2')
    expect(draft.items[0]).not.toHaveProperty('materialId')
    expect(draft.items[0]).not.toHaveProperty('reconciledQty')
  })

  test('委外入库拒绝孤儿子行，load 解码拒绝缺失任一层 collection', () => {
    const head = {
      companyId: 'company-1',
      partyType: 'SUPPLIER',
      partyId: 'supplier-1',
      debitAccountId: 'debit-1',
      creditAccountId: 'credit-1',
    }
    expect(() =>
      buildOutsourcedReceiptDraft(head, [], [
        {
          id: 'local:line',
          idx: 1,
          receiptItemId: 'missing-item',
          orderItemMaterialId: 'material-line-1',
          qty: '1',
        } as Row,
      ], []),
    ).toThrow('不属于当前草稿')

    expect(() => decodeFlatSavedDraft({ id: 'head' }, '对账草稿')).toThrow(
      '不是完整数组',
    )
    expect(() =>
      decodeOutsourcedReceiptSavedDraft({
        id: 'receipt',
        items: [{ id: 'item', materialLines: [] }],
      }),
    ).toThrow('byproductLines不是完整数组')
  })
})
