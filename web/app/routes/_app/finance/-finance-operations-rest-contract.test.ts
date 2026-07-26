import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

const operationPages = [
  './bank-accounts.tsx',
  './bank-transactions.tsx',
  './bank-import-templates.tsx',
  './invoices.tsx',
  './expense-reports.tsx',
  './-expense-role.tsx',
  './-bank-import-drawers.tsx',
  './-reconcile-drawer.tsx',
  './-ocr-button.tsx',
  './acceptance/transactions.tsx',
  './acceptance/holdings.tsx',
  './acceptance/-transaction-drawer.tsx',
] as const

describe('PR-2.20 财务业务操作 REST 边界', () => {
  test('十二资源页面不再包含 GraphQL transport 或 operation', () => {
    for (const page of operationPages) {
      const text = source(page)
      expect(text).not.toContain('gqlFetch')
      expect(text).not.toMatch(/\b(query|mutation)\s+\(\$/)
    }
  })

  test('十二个 Grid 与 Drawer 显式绑定 typed REST client', () => {
    const bindings = [
      ['./bank-accounts.tsx', 'bankAccountClient'],
      ['./bank-transactions.tsx', 'bankTransactionClient'],
      ['./bank-import-templates.tsx', 'bankImportTemplateClient'],
      ['./invoices.tsx', 'vatInvoiceClient'],
      ['./expense-reports.tsx', 'expenseReportClient'],
      ['./acceptance/transactions.tsx', 'billTransactionClient'],
      ['./acceptance/holdings.tsx', 'billHoldingClient'],
      ['./acceptance/holdings.tsx', 'billClient'],
    ] as const

    for (const [page, client] of bindings) {
      expect(source(page)).toContain(`client={${client}}`)
    }
  })

  test('client 覆盖十二资源 query/get 与全部公开 finance actions', () => {
    const client = source('../../../lib/resources/finance-operations.ts')
    expect(client).not.toContain('RawClient')
    expect(client).not.toMatch(/\bany\b/)
    for (const resource of [
      'bank-accounts',
      'bank-transactions',
      'bank-import-templates',
      'bank-imports',
      'bank-import-items',
      'bank-reconciliations',
      'vat-invoices',
      'expense-reports',
      'expense-report-items',
      'bills',
      'bill-transactions',
      'bill-holdings',
    ]) {
      expect(client).toContain(`'/finance/${resource}/query'`)
      expect(client).toContain(`'/finance/${resource}/{id}'`)
    }
    for (const endpoint of [
      "'/finance/bank-imports/{id}/import'",
      "'/finance/bank-reconciliations/remaining'",
      "'/finance/bank-reconciliations/quick-create'",
      "'/finance/vat-invoices/{id}/audit'",
      "'/finance/vat-invoices/{id}/void'",
      "'/finance/vat-invoices/{id}/reverse'",
      "'/finance/vat-invoices/ocr'",
      "'/finance/expense-reports/{id}/audit'",
      "'/finance/expense-reports/{id}/void'",
      "'/finance/bill-transactions/{id}/audit'",
      "'/finance/bill-transactions/{id}/void'",
      "'/finance/bill-transactions/ocr'",
    ]) {
      expect(client).toContain(endpoint)
    }
  })

  test('editable 子表、导入、对账与状态动作经 finance REST helper', () => {
    expect(source('./expense-reports.tsx')).toContain('saveExpenseReportItems')
    expect(source('./bank-transactions.tsx')).toContain('FinanceBankImportDrawers')
    expect(source('./bank-transactions.tsx')).toContain('FinanceReconcileDrawer')
    expect(source('./invoices.tsx')).toContain('auditVatInvoice')
    expect(source('./invoices.tsx')).toContain('reverseVatInvoice')
    expect(source('./acceptance/transactions.tsx')).toContain(
      'auditBillTransaction',
    )
  })
})
