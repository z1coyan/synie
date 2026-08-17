import { describe, expect, test } from 'bun:test'
import { decimal } from '@synie/shared'
import {
  allocateExplodedItems,
  applyRunning,
  groupGlHits,
  lineAmountFromSnapshot,
  typeLabel,
  voucherAmount,
} from './party-ledger.ts'

describe('往来明细纯函数', () => {
  test('类型：发票按方向/员工拆，承兑按交易种类，红冲加标记', () => {
    expect(
      typeLabel({ voucherType: 'acc.vat_invoice', isReversal: false, invoiceDirection: 'OUTBOUND' }),
    ).toBe('发票开出')
    expect(
      typeLabel({
        voucherType: 'acc.vat_invoice',
        isReversal: false,
        invoiceDirection: 'INBOUND',
        invoicePartyType: 'employee',
      }),
    ).toBe('费用报销发票')
    expect(
      typeLabel({
        voucherType: 'acc.bill_transaction',
        isReversal: false,
        billTransactionType: 'receive',
      }),
    ).toBe('承兑接收')
    expect(typeLabel({ voucherType: 'sales.delivery', isReversal: true })).toBe('销售发货（红冲）')
  })

  test('金额：开票取应收账款发生额，收款为负', () => {
    expect(
      voucherAmount('ar', {
        receivable: decimal(1000),
        unbilledReceivable: decimal(-1000),
      }).toFixed(),
    ).toBe('1000')
    expect(
      voucherAmount('ar', {
        receivable: decimal(-600),
        unbilledReceivable: decimal(0),
      }).toFixed(),
    ).toBe('-600')
    expect(
      voucherAmount('ap', {
        otherPayable: decimal(80),
        payable: decimal(0),
        unbilledPayable: decimal(0),
      }).toFixed(),
    ).toBe('80')
  })

  test('发货条目按快照比例拆金额，最后一行吃尾差', () => {
    const items = [
      {
        id: 'a',
        idx: 1,
        parentId: 'd',
        qty: '1',
        unitName: '件',
        materialCode: 'M1',
        materialName: '甲',
        remarks: '行甲',
        lineAmount: lineAmountFromSnapshot({
          orderBaseQty: '2',
          orderBaseAmount: '100',
          baseQty: '1',
        }),
      },
      {
        id: 'b',
        idx: 2,
        parentId: 'd',
        qty: '1',
        unitName: '件',
        materialCode: 'M2',
        materialName: '乙',
        remarks: null,
        lineAmount: lineAmountFromSnapshot({
          orderBaseQty: '2',
          orderBaseAmount: '100',
          baseQty: '1',
        }),
      },
    ]
    const allocated = allocateExplodedItems(
      items,
      { unbilledReceivable: decimal('100.00') },
      { primaryRole: 'unbilled_receivable', sign: 1 },
      false,
    )
    expect(allocated).toHaveLength(2)
    expect(allocated[0]!.amount.toFixed()).toBe('50')
    expect(allocated[1]!.amount.toFixed()).toBe('50')
    expect(allocated[0]!.deltas.unbilledReceivable?.toFixed()).toBe('50')
  })

  test('分录按凭证+红冲分组；累计顺跑再倒排第一行是期末', () => {
    const groups = groupGlHits([
      {
        postingDate: '2026-07-01',
        seq: 2,
        voucherType: 'acc.gl_journal',
        voucherId: 'j1',
        voucherNo: 'J-1',
        isReversal: false,
        role: 'receivable',
        debit: '100',
        credit: '0',
      },
      {
        postingDate: '2026-07-01',
        seq: 1,
        voucherType: 'acc.gl_journal',
        voucherId: 'j1',
        voucherNo: 'J-1',
        isReversal: false,
        role: 'receivable',
        debit: '25.5',
        credit: '0',
      },
      {
        postingDate: '2026-07-10',
        seq: 3,
        voucherType: 'acc.gl_journal',
        voucherId: 'j2',
        voucherNo: 'J-2',
        isReversal: false,
        role: 'receivable',
        debit: '0',
        credit: '40',
      },
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]!.voucherId).toBe('j1')
    expect(groups[0]!.seq).toBe(1)
    expect(groups[0]!.deltas.receivable?.toFixed()).toBe('125.5')
    const running = applyRunning(groups, 'ar')
    expect(running[0]!.receivable).toBe('125.5')
    expect(running[1]!.receivable).toBe('85.5')
  })
})
