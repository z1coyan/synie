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

  test('extension 绑定 typed REST transport，basic 绑定 Catalog Basic Form', () => {
    const bindings = [
      ['./bank-transactions.tsx', 'bankTransactionClient'],
      ['./invoices.tsx', 'vatInvoiceClient'],
      ['./expense-reports.tsx', 'expenseReportClient'],
      ['./acceptance/transactions.tsx', 'billTransactionClient'],
      ['./acceptance/holdings.tsx', 'billHoldingClient'],
      ['./acceptance/holdings.tsx', 'billClient'],
    ] as const

    for (const [page, client] of bindings) {
      expect(source(page)).toContain(`client={${client}}`)
    }

    const bankAccounts = source('./bank-accounts.tsx')
    expect(bankAccounts).toContain("const RESOURCE = 'accBankAccounts'")
    expect(bankAccounts).toContain('useCatalogBasicForm(RESOURCE')
    expect(bankAccounts.match(/client=\{client\}/g)).toHaveLength(2)

    const importTemplates = source('./bank-import-templates.tsx')
    expect(importTemplates).toContain("useCatalogBasicForm(\n    'accBankImportTemplates'")
    expect(importTemplates.match(/client=\{client\}/g)).toHaveLength(2)
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
      // bills is a valid JS identifier → api.finance.bills; hyphenated use brackets
      const queryNeedle =
        resource.includes('-')
          ? `api.finance['${resource}'].query`
          : `api.finance.${resource}.query`
      const idNeedle =
        resource.includes('-')
          ? `api.finance['${resource}'][':id']`
          : `api.finance.${resource}[':id']`
      expect(client).toContain(queryNeedle)
      expect(client).toContain(idNeedle)
    }
    for (const endpoint of [
      "api.finance['bank-imports'][':id'].import",
      "api.finance['bank-reconciliations'].remaining",
      "api.finance['bank-reconciliations']['quick-create']",
      "api.finance['vat-invoices'][':id'].audit",
      "api.finance['vat-invoices'][':id'].void",
      "api.finance['vat-invoices'][':id'].reverse",
      "api.finance['vat-invoices'].ocr",
      "api.finance['expense-reports'][':id'].audit",
      "api.finance['expense-reports'][':id'].void",
      "api.finance['bill-transactions'][':id'].audit",
      "api.finance['bill-transactions'][':id'].void",
      "api.finance['bill-transactions'].ocr",
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
