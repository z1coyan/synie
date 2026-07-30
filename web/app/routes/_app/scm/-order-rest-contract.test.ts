import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  purchaseOrderClient,
  purchaseOrderItemByproductClient,
  purchaseOrderItemClient,
  purchaseOrderItemMaterialClient,
  salesOrderClient,
  salesOrderItemClient,
} from '~/lib/resources/orders'
import { resolveSource } from '~/components/synie-remote-select/remote-query'

const read = (path: string) => readFileSync(join(import.meta.dirname, path), 'utf8')
const salesDrawer = read('sales-orders/-order-drawer.tsx')
const purchaseDrawer = read('purchase/-order-drawer.tsx')
const demandPicker = read('purchase/-demand-line-picker.tsx')
const flowHistory = read('-order-flow-history.tsx')
const outsourcedIssue = read('outsourced-issues/-issue-drawer.tsx')
const outsourcedReceipt = read('outsourced-receipts/-receipt-drawer.tsx')
const purchaseReceipt = read('purchase-receipts/-receipt-drawer.tsx')
const salesDelivery = read('sales-deliveries/-delivery-drawer.tsx')
const clients = read('../../../lib/resources/orders.ts')

describe('PR-2.14 销售/采购订单 REST 迁移契约', () => {
  test('订单抽屉、需求池与履约历史不再包含目标 GraphQL operation', () => {
    for (const source of [salesDrawer, purchaseDrawer, demandPicker, flowHistory]) {
      expect(source).not.toContain('gqlFetch')
      expect(source).not.toMatch(/(?:sal|pur)Order(?:s|Items|ItemMaterials|ItemByproducts)\s*\(/)
    }
    expect(demandPicker).not.toContain('purDemandLinePool')
    expect(flowHistory).not.toContain('scmOrderFlowItems')
  })

  test('六资源 Grid/Drawer/EditableTable 显式使用订单 REST client', () => {
    expect(salesDrawer).toContain('client={salesOrderClient}')
    expect(salesDrawer).toContain('client={salesOrderItemClient}')
    expect(purchaseDrawer).toContain('client={purchaseOrderClient}')
    expect(purchaseDrawer).toContain('client={purchaseOrderItemClient}')
    expect(purchaseDrawer).toContain('client={purchaseOrderItemMaterialClient}')
    expect(purchaseDrawer).toContain('client={purchaseOrderItemByproductClient}')
  })

  test('销售订单条目录入不展示系统折算与发货进度字段', () => {
    expect(salesDrawer).toContain(
      "'baseQty',\n              'shippedQty',\n              'remainingBaseQty',",
    )
  })

  test('ResourceClient 覆盖六资源 CRUD、状态动作与三个专用读取端点', () => {
    for (const path of [
      "api.sales.orders.query",
      "api.sales.orders[':id'].audit",
      "api.sales.orders[':id'].close",
      "api.sales.orders[':id'].void",
      "api.sales.orders[':id'].history",
      "api.sales['order-items'].query",
      "api.purchase.orders.query",
      "api.purchase.orders[':id'].audit",
      "api.purchase.orders[':id'].close",
      "api.purchase.orders[':id'].void",
      "api.purchase.orders[':id'].history",
      "api.purchase['order-items'].query",
      "api.purchase['order-item-materials'].query",
      "api.purchase['order-item-byproducts'].query",
      "api.purchase['order-demand-lines'].query",
      "api.purchase['order-bom'].expand",
    ]) {
      expect(clients).toContain(path)
    }
    expect(salesOrderClient.id).toBe('rest:salOrders')
    expect(salesOrderItemClient.id).toBe('rest:salOrderItems')
    expect(purchaseOrderClient.id).toBe('rest:purOrders')
    expect(purchaseOrderItemClient.id).toBe('rest:purOrderItems')
    expect(purchaseOrderItemMaterialClient.id).toBe('rest:purOrderItemMaterials')
    expect(purchaseOrderItemByproductClient.id).toBe('rest:purOrderItemByproducts')
  })

  test('审核弹窗、需求池、BOM 和历史均走订单 REST 回调', () => {
    expect(salesDrawer).toContain('loadItems: (orderId: string)')
    expect(salesDrawer).toContain('audit: auditSalesOrder')
    expect(purchaseDrawer).toContain('loadItems: (orderId: string)')
    expect(purchaseDrawer).toContain('audit: auditPurchaseOrder')
    expect(demandPicker).toContain('queryPurchaseOrderDemandLines')
    expect(purchaseDrawer).toContain('expandPurchaseOrderBom')
    expect(flowHistory).toContain('getSalesOrderHistory')
    expect(flowHistory).toContain('getPurchaseOrderHistory')
  })

  test('四个下游候选选择器复用订单 REST 与结构化筛选', () => {
    for (const [source, clientName] of [
      [outsourcedIssue, 'purchaseOrderItemMaterialClient'],
      [outsourcedReceipt, 'purchaseOrderItemClient'],
      [purchaseReceipt, 'purchaseOrderItemClient'],
      [salesDelivery, 'salesOrderItemClient'],
    ] as const) {
      expect(source).toContain(`client={${clientName}}`)
      expect(source).toContain("orderStatus: { kind: 'enum', values: ['AUDITED'] }")
      expect(source).toContain("partyId: {\n      kind: 'polyFk'")
      expect(source).not.toMatch(/(?:sal|pur)Order(?:Items|ItemMaterials)\s*\(filter/)
    }
  })

  test('registry 让共享远程选择器与 FK 预览解析到订单 REST', () => {
    for (const [resource, id] of [
      ['salOrders', 'rest:salOrders'],
      ['salOrderItems', 'rest:salOrderItems'],
      ['purOrders', 'rest:purOrders'],
      ['purOrderItems', 'rest:purOrderItems'],
      ['purOrderItemMaterials', 'rest:purOrderItemMaterials'],
      ['purOrderItemByproducts', 'rest:purOrderItemByproducts'],
    ]) {
      expect(resolveSource({ resource })?.client?.id).toBe(id)
    }
  })
})
