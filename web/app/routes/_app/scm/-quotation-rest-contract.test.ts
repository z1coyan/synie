import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  purchaseQuotationClient,
  purchaseQuotationItemClient,
  purchaseQuotationTierClient,
  salesQuotationClient,
  salesQuotationItemClient,
  salesQuotationTierClient,
} from '~/lib/resources/quotations'
import { resolveSource } from '~/components/synie-remote-select/remote-query'

const read = (path: string) => readFileSync(join(import.meta.dirname, path), 'utf8')
const salesDrawer = read('quotations/-quotation-drawer.tsx')
const salesHeads = read('quotations/quotations.tsx')
const salesItems = read('quotations/items.tsx')
const purchaseDrawer = read('purchase-quotations/-quotation-drawer.tsx')
const purchaseHeads = read('purchase-quotations/quotations.tsx')
const purchaseItems = read('purchase-quotations/items.tsx')
const salesOrder = read('sales-orders/-order-drawer.tsx')
const purchaseOrder = read('purchase/-order-drawer.tsx')
const clients = read('../../../lib/resources/quotations.ts')
const auditDoc = read('-audit-doc.tsx')
const auditConfigSources = [
  read('../mfg/outputs.tsx'),
  salesDrawer,
  purchaseDrawer,
  salesOrder,
  purchaseOrder,
  read('sales-deliveries/-delivery-drawer.tsx'),
  read('purchase-receipts/-receipt-drawer.tsx'),
  read('outsourced-issues/-issue-drawer.tsx'),
  read('outsourced-receipts/-receipt-drawer.tsx'),
  read('sales-reconciliations/-reconciliation-drawer.tsx'),
  read('purchase-reconciliations/-reconciliation-drawer.tsx'),
]

describe('PR-2.13 销售/采购报价 REST 迁移契约', () => {
  test('两个报价消费面不再包含目标 GraphQL operation', () => {
    for (const source of [
      salesDrawer,
      salesHeads,
      salesItems,
      purchaseDrawer,
      purchaseHeads,
      purchaseItems,
    ]) {
      expect(source).not.toContain('gqlFetch')
      expect(source).not.toMatch(/(?:sal|pur)Quotation(?:s|Items|Tiers)\s*\(/)
    }
  })

  test('六个 Grid/Drawer/EditableTable 显式使用报价 REST client', () => {
    expect(salesHeads).toContain('client={salesQuotationClient}')
    expect(salesItems).toContain('client={salesQuotationItemClient}')
    expect(salesDrawer).toContain('client={salesQuotationClient}')
    expect(salesDrawer).toContain('client={salesQuotationItemClient}')
    expect(salesDrawer).toContain('client={salesQuotationTierClient}')
    expect(purchaseHeads).toContain('client={purchaseQuotationClient}')
    expect(purchaseItems).toContain('client={purchaseQuotationItemClient}')
    expect(purchaseDrawer).toContain('client={purchaseQuotationClient}')
    expect(purchaseDrawer).toContain('client={purchaseQuotationItemClient}')
    expect(purchaseDrawer).toContain('client={purchaseQuotationTierClient}')
  })

  test('ResourceClient 覆盖两侧头行档 CRUD 与审核/作废', () => {
    for (const path of [
      '/sales/quotations/query',
      '/sales/quotations/{id}/audit',
      '/sales/quotations/{id}/void',
      '/sales/quotation-items/query',
      '/sales/quotation-tiers/query',
      '/purchase/quotations/query',
      '/purchase/quotations/{id}/audit',
      '/purchase/quotations/{id}/void',
      '/purchase/quotation-items/query',
      '/purchase/quotation-tiers/query',
    ]) {
      expect(clients).toContain(path)
    }
    expect(salesQuotationClient.id).toBe('rest:salQuotations')
    expect(salesQuotationItemClient.id).toBe('rest:salQuotationItems')
    expect(salesQuotationTierClient.id).toBe('rest:salQuotationTiers')
    expect(purchaseQuotationClient.id).toBe('rest:purQuotations')
    expect(purchaseQuotationItemClient.id).toBe('rest:purQuotationItems')
    expect(purchaseQuotationTierClient.id).toBe('rest:purQuotationTiers')
  })

  test('共享审核弹窗强制通过 REST 回调加载条目并审核', () => {
    expect(auditDoc).toContain('loadItems: (docId: string) => Promise<Row[]>')
    expect(auditDoc).toContain('audit: (docId: string) => Promise<unknown>')
    expect(auditDoc).not.toContain('gqlFetch')
    expect(auditDoc).not.toContain('mutation: string')
    expect(auditDoc).not.toContain('docIdField: string')
    expect(auditDoc).not.toContain('itemFields: string')
    const configs = auditConfigSources.flatMap((source) =>
      [...source.matchAll(/(?:const|export const) \w*(?:Audit|AUDIT|Confirm)\w* = \{[\s\S]*?\} satisfies AuditDocConfig/g)].map(
        ([config]) => config,
      ),
    )
    expect(configs).toHaveLength(13)
    for (const config of configs) {
      expect(config).not.toMatch(/^  (?:mutation|docIdField|itemFields):/m)
    }
    expect(salesDrawer).toContain('loadItems: (quotationId: string)')
    expect(salesDrawer).toContain('audit: auditSalesQuotation')
    expect(purchaseDrawer).toContain('loadItems: (quotationId: string)')
    expect(purchaseDrawer).toContain('audit: auditPurchaseQuotation')
  })

  test('销售/采购订单的有效报价候选使用结构化 REST 筛选', () => {
    for (const [source, clientName] of [
      [salesOrder, 'salesQuotationItemClient'],
      [purchaseOrder, 'purchaseQuotationItemClient'],
    ] as const) {
      expect(source).toContain(`client={${clientName}}`)
      expect(source).toContain('filterState={quotationFilter ?? undefined}')
      expect(source).toContain("quotationStatus: { kind: 'enum', values: ['AUDITED'] }")
      expect(source).toContain("quotationDate: { kind: 'date', op: 'between'")
      expect(source).toContain("validUntil: { kind: 'date', op: 'between'")
      expect(source).not.toContain(
        'quotation: {status: {eq: AUDITED}, companyId:',
      )
    }
  })

  test('registry 让共享远程选择器和 FK 预览解析到 REST', () => {
    for (const [resource, id] of [
      ['salQuotations', 'rest:salQuotations'],
      ['salQuotationItems', 'rest:salQuotationItems'],
      ['salQuotationTiers', 'rest:salQuotationTiers'],
      ['purQuotations', 'rest:purQuotations'],
      ['purQuotationItems', 'rest:purQuotationItems'],
      ['purQuotationTiers', 'rest:purQuotationTiers'],
    ]) {
      expect(resolveSource({ resource })?.client?.id).toBe(id)
    }
  })
})
