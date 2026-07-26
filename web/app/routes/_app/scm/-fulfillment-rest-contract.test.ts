import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const salesDrawer = source('./sales-deliveries/-delivery-drawer.tsx')
const purchaseDrawer = source('./purchase-receipts/-receipt-drawer.tsx')
const issueDrawer = source('./outsourced-issues/-issue-drawer.tsx')
const outsourcedReceiptDrawer = source('./outsourced-receipts/-receipt-drawer.tsx')
const fulfillmentClients = source('../../../lib/resources/fulfillment.ts')
const registry = source('../../../lib/resources/registry.ts')
const defaults = source('./settings/-company-account-defaults.tsx')

const pageSources = [
  source('./sales-deliveries/deliveries.tsx'),
  source('./sales-deliveries/items.tsx'),
  source('./purchase-receipts/receipts.tsx'),
  source('./purchase-receipts/items.tsx'),
  source('./outsourced-issues/issues.tsx'),
  source('./outsourced-issues/items.tsx'),
  source('./outsourced-receipts/receipts.tsx'),
  source('./outsourced-receipts/items.tsx'),
]

describe('PR-2.15 标准与委外履约 REST 迁移契约', () => {
  test('四个抽屉与八个列表不再调用目标 GraphQL', () => {
    for (const page of [...pageSources, salesDrawer, purchaseDrawer, issueDrawer, outsourcedReceiptDrawer]) {
      expect(page).not.toContain('gqlFetch')
    }
  })

  test('十资源 Grid、Drawer 与 EditableTable 显式使用 REST client', () => {
    const expected = [
      'salesDeliveryClient',
      'salesDeliveryItemClient',
      'purchaseReceiptClient',
      'purchaseReceiptItemClient',
      'purchaseOutsourcedIssueClient',
      'purchaseOutsourcedIssueItemClient',
      'purchaseOutsourcedReceiptClient',
      'purchaseOutsourcedReceiptItemClient',
      'purchaseOutsourcedReceiptItemMaterialClient',
      'purchaseOutsourcedReceiptItemByproductClient',
    ]
    const combined = [...pageSources, salesDrawer, purchaseDrawer, issueDrawer, outsourcedReceiptDrawer].join('\n')
    for (const client of expected) expect(combined).toContain(`client={${client}}`)
  })

  test('ResourceClient 覆盖十资源 CRUD、审核作废与默认科目读取 seam', () => {
    for (const resource of [
      'salDeliveries',
      'salDeliveryItems',
      'purReceipts',
      'purReceiptItems',
      'purOutsourcedIssues',
      'purOutsourcedIssueItems',
      'purOutsourcedReceipts',
      'purOutsourcedReceiptItems',
      'purOutsourcedReceiptItemMaterials',
      'purOutsourcedReceiptItemByproducts',
    ]) {
      expect(fulfillmentClients).toContain(`'${resource}'`)
      expect(registry).toContain(`${resource}:`)
    }
    expect(fulfillmentClients).toContain("key === 'audit'")
    expect(fulfillmentClients).toContain("key === 'void'")
    expect(fulfillmentClients).toContain('fetchSalesCompanyAccountDefaults')
    expect(defaults).toContain('fetchSalesCompanyAccountDefaults(companyId)')
  })

  test('审核弹窗与全部子行保存均走 REST', () => {
    for (const drawer of [salesDrawer, purchaseDrawer, issueDrawer, outsourcedReceiptDrawer]) {
      expect(drawer).toContain('loadItems:')
      expect(drawer).toContain('audit:')
    }
    expect(outsourcedReceiptDrawer).toContain('purchaseOutsourcedReceiptItemMaterialClient')
    expect(outsourcedReceiptDrawer).toContain('purchaseOutsourcedReceiptItemByproductClient')
  })

  test('科目与履约来源候选使用结构化 FilterState', () => {
    expect(salesDrawer).toContain('filterState={accountFilter')
    expect(purchaseDrawer).toContain('filterState={accountFilter')
    expect(outsourcedReceiptDrawer).toContain('filterState={accountFilter')
    expect(salesDrawer).toContain("remainingBaseQty: { kind: 'number'")
    expect(issueDrawer).toContain("remainingIssueQty: { kind: 'number'")
    expect(outsourcedReceiptDrawer).toContain("orderIsOutsourced: { kind: 'bool', eq: true }")
  })
})
