import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

describe('供应链对账 REST 边界', () => {
  test('对账抽屉、设置卡片与资源注册不再经过 GraphQL', () => {
    const sales = read('./sales-reconciliations/-reconciliation-drawer.tsx')
    const purchase = read(
      './purchase-reconciliations/-reconciliation-drawer.tsx',
    )
    const defaults = read('./settings/-company-account-defaults.tsx')
    const clients = read('../../../lib/resources/reconciliations.ts')
    const registry = read('../../../lib/resources/registry.ts')

    for (const source of [sales, purchase, defaults]) {
      expect(source).not.toContain('gqlFetch')
      expect(source).not.toContain('api.graphql')
    }

    for (const resource of [
      'salReconciliations',
      'salReconciliationItems',
      'purReconciliations',
      'purReconciliationItems',
      'salCompanyAccountDefaults',
      'scmOrderFlowItems',
    ]) {
      expect(registry).toContain(`${resource}:`)
      expect(clients).toContain(`'${resource}'`)
    }

    expect(clients).toContain("api.sales.reconciliations[':id'].confirm")
    expect(clients).toContain("api.sales.reconciliations[':id'].unconfirm")
    expect(clients).toContain("api.purchase.reconciliations[':id'].audit")
    expect(clients).toContain("api.purchase.reconciliations[':id'].void")
  })

  test('筛选与数量使用 REST 结构化 wire 形态', () => {
    const sales = read('./sales-reconciliations/-reconciliation-drawer.tsx')
    const purchase = read(
      './purchase-reconciliations/-reconciliation-drawer.tsx',
    )
    const clients = read('../../../lib/resources/reconciliations.ts')

    expect(sales).toContain("kind: 'number'")
    expect(sales).toContain("orderType: { kind: 'enum'")
    expect(sales).toContain("values: ['REGULAR']")
    expect(purchase).toContain("kind: 'polyFk'")
    expect(sales).not.toContain('toGqlLiteral')
    expect(purchase).not.toContain('gqlEnum')
    expect(clients).toContain("decimalInput(input, ['qty'])")
  })

  test('头行 Grid、头 Drawer 与 Drawer 内条目表均显式绑定 REST client', () => {
    const salesHeads = read('./sales-reconciliations/reconciliations.tsx')
    const salesItems = read('./sales-reconciliations/items.tsx')
    const purchaseHeads = read('./purchase-reconciliations/reconciliations.tsx')
    const purchaseItems = read('./purchase-reconciliations/items.tsx')
    const salesDrawer = read(
      './sales-reconciliations/-reconciliation-drawer.tsx',
    )
    const purchaseDrawer = read(
      './purchase-reconciliations/-reconciliation-drawer.tsx',
    )

    expect(salesHeads).toContain('client={salesReconciliationClient}')
    expect(salesItems).toContain('client={salesReconciliationItemClient}')
    expect(purchaseHeads).toContain('client={purchaseReconciliationClient}')
    expect(purchaseItems).toContain('client={purchaseReconciliationItemClient}')
    expect(salesDrawer).toContain('client={salesReconciliationClient}')
    expect(salesDrawer).toContain('client={salesReconciliationItemClient}')
    expect(purchaseDrawer).toContain('client={purchaseReconciliationClient}')
    expect(purchaseDrawer).toContain(
      'client={purchaseReconciliationItemClient}',
    )
  })
})
