import { describe, expect, test } from 'bun:test'
import { expenseReportGlLines } from './commands'
import {
  assertExpenseInvoiceAvailableForItem,
  assertExpenseReportHeadRules,
  assertExpenseReportItemParentDraft,
} from './shared/records'

type Stored = ReturnType<typeof stored>

function stored(
  id: string,
  resource: string,
  data: Record<string, unknown>,
  options: {
    companyId?: string | null
    parentId?: string | null
    status?: string | null
    decimals?: Record<string, bigint>
  } = {},
) {
  return {
    _id: id,
    _creationTime: 1,
    resource,
    companyId: options.companyId ?? (typeof data.companyId === 'string' ? data.companyId : null),
    parentId: options.parentId ?? null,
    status: options.status ?? (typeof data.status === 'string' ? data.status : null),
    sortKey: '',
    searchText: '',
    decimalValues: options.decimals ?? {},
    data,
    insertedAt: 1,
    updatedAt: 1,
  }
}

function context(
  documents: Record<string, Stored>,
  references: Array<Record<string, string>> = [],
) {
  return {
    db: {
      normalizeId(_table: string, id: string) { return documents[id] ? id : null },
      async get(id: string) { return documents[id] ?? null },
      query(table: string) {
        return {
          withIndex(_name: string, configure: (q: { eq: (field: string, value: unknown) => unknown }) => unknown) {
            const equals: Array<[string, unknown]> = []
            const q = { eq(field: string, value: unknown) { equals.push([field, value]); return q } }
            configure(q)
            return {
              async collect() {
                const source = table === 'domainReferences' ? references : Object.values(documents)
                return source.filter((row) => equals.every(([field, value]) =>
                  row[field as keyof typeof row] === value,
                ))
              },
            }
          },
        }
      },
    },
  } as never
}

describe('费用报销挂票规则', () => {
  test('报销单员工必须存在，付款科目必须为本公司启用非汇总科目', async () => {
    const employee = stored('employee-1', 'hrEmployees', {})
    const account = {
      ...stored('payment-account', 'basAccounts', {}, { companyId: 'company-1' }),
      active: true,
      isGroup: false,
    }
    const wire = {
      companyId: 'company-1', employeeId: 'employee-1', paymentAccountId: 'payment-account',
    }
    await expect(assertExpenseReportHeadRules(
      context({ 'employee-1': employee, 'payment-account': account }),
      wire,
    )).resolves.toBeUndefined()

    for (const documents of [
      { 'payment-account': account },
      { 'employee-1': employee },
      { 'employee-1': employee, 'payment-account': { ...account, companyId: 'company-2' } },
      { 'employee-1': employee, 'payment-account': { ...account, active: false } },
      { 'employee-1': employee, 'payment-account': { ...account, isGroup: true } },
    ]) {
      await expect(assertExpenseReportHeadRules(context(documents), wire)).rejects.toThrow('员工或付款科目不合法')
    }
  })

  test('写入挂票行时权威校验同公司、同员工、开入与已审核资格', async () => {
    const report = stored('report-1', 'accExpenseReports', {
      employeeId: 'employee-1',
    }, { companyId: 'company-1', status: 'DRAFT' })
    const validInvoice = stored('invoice-1', 'accVatInvoices', {
      direction: 'INBOUND', partyType: 'EMPLOYEE', partyId: 'employee-1',
    }, { companyId: 'company-1', status: 'AUDITED' })
    const wire = {
      idx: 1, kind: 'INVOICED', reportId: 'report-1', companyId: 'company-1',
      invoiceId: 'invoice-1', amount: null, summary: null, expenseAccountId: null,
    }

    await expect(assertExpenseInvoiceAvailableForItem(
      context({ 'report-1': report, 'invoice-1': validInvoice }),
      'item-new',
      wire,
    )).resolves.toBeUndefined()

    const invalidInvoices = [
      stored('invoice-1', 'accVatInvoices', {
        direction: 'INBOUND', partyType: 'EMPLOYEE', partyId: 'employee-1',
      }, { companyId: 'company-2', status: 'AUDITED' }),
      stored('invoice-1', 'accVatInvoices', {
        direction: 'INBOUND', partyType: 'SUPPLIER', partyId: 'employee-1',
      }, { companyId: 'company-1', status: 'AUDITED' }),
      stored('invoice-1', 'accVatInvoices', {
        direction: 'INBOUND', partyType: 'EMPLOYEE', partyId: 'employee-2',
      }, { companyId: 'company-1', status: 'AUDITED' }),
      stored('invoice-1', 'accVatInvoices', {
        direction: 'OUTBOUND', partyType: 'EMPLOYEE', partyId: 'employee-1',
      }, { companyId: 'company-1', status: 'AUDITED' }),
      stored('invoice-1', 'accVatInvoices', {
        direction: 'INBOUND', partyType: 'EMPLOYEE', partyId: 'employee-1',
      }, { companyId: 'company-1', status: 'DRAFT' }),
    ]
    for (const invoice of invalidInvoices) {
      await expect(assertExpenseInvoiceAvailableForItem(
        context({ 'report-1': report, 'invoice-1': invoice }),
        'item-new',
        wire,
      )).rejects.toThrow('同公司同员工的已审核未报销开入发票')
    }

    for (const invalidShape of [
      { ...wire, summary: '不应填写' },
      { ...wire, amount: '1' },
      { ...wire, expenseAccountId: 'expense-account' },
      { ...wire, invoiceId: null },
    ]) {
      await expect(assertExpenseInvoiceAvailableForItem(
        context({ 'report-1': report, 'invoice-1': validInvoice }),
        'item-new',
        invalidShape,
      )).rejects.toThrow('挂票行仅允许发票与备注')
    }
  })

  test('无票行只接受摘要、正金额与本公司启用非汇总科目', async () => {
    const report = stored('report-1', 'accExpenseReports', {
      employeeId: 'employee-1',
    }, { companyId: 'company-1', status: 'DRAFT' })
    const account = {
      ...stored('expense-account', 'basAccounts', {}, { companyId: 'company-1' }),
      active: true,
      isGroup: false,
    }
    const valid = {
      idx: 1, kind: 'MANUAL', reportId: 'report-1', companyId: 'company-1', invoiceId: null,
      summary: '无票餐费', amount: '50', expenseAccountId: 'expense-account',
    }
    await expect(assertExpenseInvoiceAvailableForItem(
      context({ 'report-1': report, 'expense-account': account }),
      'item-new',
      valid,
    )).resolves.toBeUndefined()

    for (const invalid of [
      { ...valid, kind: 'UNKNOWN' },
      { ...valid, invoiceId: 'invoice-1' },
      { ...valid, summary: '   ' },
      { ...valid, amount: '0' },
      { ...valid, amount: '-1' },
      { ...valid, expenseAccountId: null },
      { ...valid, idx: 0 },
      { ...valid, idx: 1.5 },
    ]) {
      await expect(assertExpenseInvoiceAvailableForItem(
        context({ 'report-1': report, 'expense-account': account }),
        'item-new',
        invalid,
      )).rejects.toThrow()
    }

    for (const invalidAccount of [
      { ...account, companyId: 'company-2' },
      { ...account, active: false },
      { ...account, isGroup: true },
    ]) {
      await expect(assertExpenseInvoiceAvailableForItem(
        context({ 'report-1': report, 'expense-account': invalidAccount }),
        'item-new',
        valid,
      )).rejects.toThrow('本公司启用非汇总科目')
    }
  })

  test('增删改报销行均以父报销单草稿状态为权威边界', async () => {
    const draft = stored('report-1', 'accExpenseReports', {}, {
      companyId: 'company-1', status: 'DRAFT',
    })
    const audited = stored('report-1', 'accExpenseReports', {}, {
      companyId: 'company-1', status: 'AUDITED',
    })
    const item = { reportId: 'report-1' }

    await expect(assertExpenseReportItemParentDraft(
      context({ 'report-1': draft }),
      item,
    )).resolves.toBeUndefined()
    await expect(assertExpenseReportItemParentDraft(
      context({ 'report-1': audited }),
      item,
    )).rejects.toThrow('仅草稿报销单可增删改行')
  })

  test('审核混合行时挂票取发票往来科目/价税合计，无票取行科目/金额', async () => {
    const documents = {
      'employee-1': stored('employee-1', 'hrEmployees', {}),
      'payment-account': {
        ...stored('payment-account', 'basAccounts', {}, { companyId: 'company-1' }),
        active: true,
        isGroup: false,
      },
      'report-1': stored('report-1', 'accExpenseReports', {
        employeeId: 'employee-1',
      }, { companyId: 'company-1', status: 'DRAFT' }),
      invoiced: stored('invoiced', 'accExpenseReportItems', {
        idx: 1, kind: 'INVOICED', reportId: 'report-1', invoiceId: 'invoice-1',
      }, { companyId: 'company-1', parentId: 'report-1' }),
      manual: stored('manual', 'accExpenseReportItems', {
        idx: 2, kind: 'MANUAL', reportId: 'report-1', summary: '无票餐费',
        expenseAccountId: 'expense-account',
      }, { companyId: 'company-1', parentId: 'report-1', decimals: { amount: 5_000n } }),
      'invoice-1': stored('invoice-1', 'accVatInvoices', {
        direction: 'INBOUND', partyType: 'EMPLOYEE', partyId: 'employee-1',
        partyAccountId: 'payable-account',
      }, { companyId: 'company-1', status: 'AUDITED', decimals: { grossTotal: 11_300n } }),
      'expense-account': {
        ...stored('expense-account', 'basAccounts', {}, { companyId: 'company-1' }),
        active: true,
        isGroup: false,
      },
    }

    const lines = await expenseReportGlLines(context(documents), 'report-1', {
      companyId: 'company-1', employeeId: 'employee-1', paymentAccountId: 'payment-account',
    })
    expect(lines).toEqual([
      {
        accountId: 'payable-account', debit: '113.00', credit: '0',
        partyType: 'EMPLOYEE', partyId: 'employee-1',
      },
      { accountId: 'expense-account', debit: '50.00', credit: '0' },
      { accountId: 'payment-account', debit: '0', credit: '163.00' },
    ])
  })
})
