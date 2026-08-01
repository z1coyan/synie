import { describe, expect, test } from 'bun:test'
import { mapAcceptanceOcr, mapInvoiceOcr } from './ocr.ts'

describe('OCR provider mapping', () => {
  test('maps invoice envelope without trusting numeric JSON wire values', () => {
    expect(mapInvoiceOcr({ data: {
      invoiceNumber: ' 123 ', invoiceDate: '2026年7月31日', invoiceType: '数电专用发票',
      totalAmount: '￥123.45', invoiceDetails: [{ itemName: '材料', amount: '100.00' }],
    } })).toMatchObject({
      invoiceNo: '123', invoiceDate: '2026-07-31', invoiceKind: 'DIGITAL_SPECIAL',
      grossTotal: '123.45', items: [{ name: '材料', net_amount: '100.00' }],
    })
  })

  test('maps acceptance sub-draft range to exact decimal amount', () => {
    expect(mapAcceptanceOcr({ draftNumber: 'B-1', subDraftNumber: '101-125' })).toMatchObject({
      bill_no: 'B-1', sub_start: 101, sub_end: 125, amount: '0.25', bill_kind: 'BANK_ACCEPTANCE',
    })
  })
})
