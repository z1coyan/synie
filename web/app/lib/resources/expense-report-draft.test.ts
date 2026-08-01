import { describe, expect, test } from 'bun:test'
import { buildExpenseReportDraft, itemInput } from './expense-report-draft'

describe('报销单聚合草稿 wire input', () => {
  test('挂票行保留存量 id 且只提交发票槽位，不泄漏 UI 发票快照', () => {
    expect(itemInput({
      id: 'item-1',
      idx: 1,
      kind: 'INVOICED',
      invoiceId: 'invoice-1',
      summary: '不得提交',
      amount: '99',
      expenseAccountId: 'account-1',
      remarks: '差旅票',
      invoiceGrossTotal: '128.00',
      invoice: { id: 'invoice-1', invoiceNo: 'INV-1' },
    })).toEqual({
      id: 'item-1',
      idx: 1,
      kind: 'INVOICED',
      invoiceId: 'invoice-1',
      summary: null,
      amount: null,
      expenseAccountId: null,
      remarks: '差旅票',
    })
  })

  test('无票本地行不提交临时 id，且只提交手工费用槽位', () => {
    expect(itemInput({
      id: 'local:item-2',
      idx: 2,
      kind: 'MANUAL',
      invoiceId: '不得提交',
      summary: '打车费',
      amount: '35.50',
      expenseAccountId: 'account-2',
      remarks: null,
    })).toEqual({
      idx: 2,
      kind: 'MANUAL',
      invoiceId: null,
      summary: '打车费',
      amount: '35.50',
      expenseAccountId: 'account-2',
      remarks: null,
    })
  })

  test('头与全部行组成同一个草稿输入', () => {
    const draft = buildExpenseReportDraft(
      { companyId: 'company-1', employeeId: 'employee-1', remarks: null },
      [{
        id: 'local:item-1',
        idx: 1,
        kind: 'INVOICED',
        invoiceId: 'invoice-1',
      }],
    )

    expect(draft).toEqual({
      companyId: 'company-1',
      employeeId: 'employee-1',
      remarks: null,
      items: [{
        idx: 1,
        kind: 'INVOICED',
        invoiceId: 'invoice-1',
        summary: null,
        amount: null,
        expenseAccountId: null,
        remarks: null,
      }],
    })
  })
})
