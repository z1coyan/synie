import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(import.meta.dirname, path), 'utf8')

const categories = read('material-categories.tsx')
const materials = read('materials.tsx')
const warehouses = read('warehouses.tsx')
const inventory = read('inventory.tsx')
const stockEntries = read('stock-entries.tsx')
const stockDocs = read('other-stock/docs.tsx')
const transfers = read('other-stock/transfers.tsx')
const counts = read('other-stock/counts.tsx')
const otherStock = read('other-stock.tsx')
const outsourcedIssues = read('outsourced-issues/-issue-drawer.tsx')
const outsourcedReceipts = read('outsourced-receipts/-receipt-drawer.tsx')
const setup = read('../../setup.tsx')
const materialUnitSelect = read('../../../components/synie-material-unit-select/MaterialUnitSelect.tsx')
const stockDoc = read('-stock-doc.tsx')
const drawerRegistry = read('../../../components/synie-record-drawer/registry.tsx')
const resourceRegistry = read('../../../lib/resources/registry.ts')
const inventoryClients = read('../../../lib/resources/inventory.ts')

describe('库存四主数据 REST 迁移契约', () => {
  test('三主页面不再包含四资源旧 GraphQL operation', () => {
    for (const marker of ['gqlFetch', 'createInvMaterialCategory', 'updateInvMaterialCategory']) {
      expect(categories).not.toContain(marker)
    }
    for (const marker of [
      'gqlFetch',
      'invMaterialUnits(',
      'createInvMaterial',
      'updateInvMaterial',
      'createInvMaterialUnit',
      'updateInvMaterialUnit',
      'destroyInvMaterialUnit',
    ]) {
      expect(materials).not.toContain(marker)
    }
    for (const marker of ['gqlFetch', 'createInvWarehouse', 'updateInvWarehouse']) {
      expect(warehouses).not.toContain(marker)
    }
  })

  test('三主页面 Grid/Drawer 与单位转换表显式传入对应 client', () => {
    expect(categories.match(/client=\{materialCategoryClient\}/g)).toHaveLength(2)
    expect(materials.match(/client=\{materialClient\}/g)).toHaveLength(2)
    expect(materials.match(/client=\{materialUnitClient\}/g)).toHaveLength(1)
    expect(warehouses.match(/client={warehouseClient}/g)).toHaveLength(2)
    expect(warehouses).toContain('fixedFilter={companyFilterState}')
    expect(inventoryClients).toContain('...((input.fixedFilter ?? {}) as FilterState)')
  })

  test('共享物料单位与仓库选择器使用 REST 且保留业务筛选', () => {
    expect(materialUnitSelect).not.toContain('gqlFetch')
    expect(materialUnitSelect).toContain('materialClient.get')
    expect(materialUnitSelect).toContain('materialUnitClient.query')
    expect(stockDoc).toContain('filterState={warehouseFilterState(companyId)}')
    expect(stockDoc).toContain("isLeaf: { kind: 'bool', eq: true }")
    expect(stockDoc).toContain("active: { kind: 'bool', eq: true }")
    expect(inventory).toContain('filterState={warehouseFilterState(companyId)}')
  })

  test('四 ResourceClient 注册后覆盖跨页面 RemoteSelect 与 FK 速览', () => {
    for (const resource of ['invMaterialCategories', 'invMaterials', 'invMaterialUnits', 'invWarehouses']) {
      expect(resourceRegistry).toContain(`${resource}:`)
    }
    expect(drawerRegistry).toContain("filterState: {\n            isLeaf: { kind: 'bool', eq: true },")
  })

  test('跨业务页持续复用库存 REST client，履约页面同步切换 REST', () => {
    expect(transfers).not.toContain('invWarehouses(')
    expect(outsourcedIssues).not.toContain('invOutsourcedWarehouses')
    expect(outsourcedReceipts).not.toContain('invOutsourcedWarehouses')
    expect(transfers).toContain('warehouseClient')
    expect(outsourcedIssues).toContain('queryOutsourcedWarehouses')
    expect(outsourcedReceipts).toContain('queryOutsourcedWarehouses')
    expect(setup).toContain('seedWarehouseDefaults(companyId)')
    expect(setup).not.toContain('seedInvWarehouseDefaults')
    expect(transfers).not.toContain('gqlFetch')
    expect(otherStock).not.toContain('gqlFetch')
    expect(otherStock).toContain('fetchMe')
    expect(transfers).toContain('stockTransferClient')
    expect(transfers).toContain('stockTransferItemClient')
    expect(outsourcedIssues).not.toContain('gqlFetch')
    expect(outsourcedReceipts).not.toContain('gqlFetch')
    expect(outsourcedIssues).toContain('purchaseOutsourcedIssueClient')
    expect(outsourcedReceipts).toContain('purchaseOutsourcedReceiptClient')
  })

  test('库存流水与三类单据把 Grid、Drawer、明细表全部接到 REST client', () => {
    expect(stockEntries).not.toContain('gqlFetch')
    expect(stockEntries.match(/client=\{stockEntryClient\}/g)).toHaveLength(2)

    expect(stockDocs).not.toContain('gqlFetch')
    expect(stockDocs).toContain('docClient: stockDocClient')
    expect(stockDocs).toContain('itemClient: stockDocItemClient')
    expect(stockDoc).toContain('client={cfg.docClient}')
    expect(stockDoc).toContain('client={cfg.itemClient}')

    expect(transfers).not.toContain('gqlFetch')
    expect(transfers).toContain('client={stockTransferClient}')
    expect(transfers).toContain('client={stockTransferItemClient}')

    expect(counts).not.toContain('gqlFetch')
    expect(counts).toContain('client={stockCountClient}')
    expect(counts).toContain('client={stockCountItemClient}')
  })
})
