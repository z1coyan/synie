/**
 * 交易链装配：报价 / 订单 / 标准履约 / 委外头 / 对账。
 */
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { createInventoryEngine } from '~/engines/inventory/index.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { createQuotationService } from './quotation/service.ts'
import {
  quotationHeadMeta,
  quotationItemMeta,
  quotationTierMeta,
} from './quotation/spec.ts'
import {
  quotationHeadRoutes,
  quotationItemRoutes,
  quotationTierRoutes,
} from './quotation/routes.ts'
import { createOrderService } from './order/service.ts'
import { createOutsourcedConfigService } from './order/outsourced-config.ts'
import {
  orderByproductMeta,
  orderHeadMeta,
  orderItemMeta,
  orderMaterialMeta,
} from './order/spec.ts'
import {
  orderHeadRoutes,
  orderItemRoutes,
  purchaseOrderExtraRoutes,
} from './order/routes.ts'
import { createFulfillmentService } from './fulfillment/service.ts'
import {
  fulfillmentHeadMeta,
  fulfillmentItemMeta,
  packBoxMeta,
  packLineMeta,
} from './fulfillment/spec.ts'
import {
  packBoxRoutes,
  packLineRoutes,
  purchaseFulfillmentHeadRoutes,
  purchaseFulfillmentItemRoutes,
  salesFulfillmentHeadRoutes,
  salesFulfillmentItemRoutes,
} from './fulfillment/routes.ts'
import {
  createOutsourcedService,
  outsourcedIssueItemMeta,
  outsourcedIssueMeta,
  outsourcedReceiptItemByproductMeta,
  outsourcedReceiptItemMaterialMeta,
  outsourcedReceiptItemMeta,
  outsourcedReceiptMeta,
} from './outsourced/service.ts'
import {
  outsourcedIssueItemRoutes,
  outsourcedIssueRoutes,
  outsourcedReceiptByproductRoutes,
  outsourcedReceiptItemRoutes,
  outsourcedReceiptMaterialRoutes,
  outsourcedReceiptRoutes,
} from './outsourced/routes.ts'
import { createReconciliationService } from './reconciliation/service.ts'
import {
  reconciliationHeadMeta,
  reconciliationItemMeta,
} from './reconciliation/spec.ts'
import {
  reconciliationHeadRoutes,
  reconciliationItemRoutes,
} from './reconciliation/routes.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AuthzEnforcer } from '~/platform/authz/enforce.ts'
import { registerTradingSettingResources } from './settings.ts'

export {
  createSalesSettingService,
  salesResourceMeta,
  registerTradingSettingResources,
  type SalesSettingService,
  type SalesSetting,
  type SalesUpdate,
  SALES_RESOURCE_NAME,
} from './settings.ts'

export function registerTradingResources(registry: Registry): void {
  registerTradingSettingResources(registry)
  for (const side of ['sales', 'purchase'] as const) {
    registry.register(quotationHeadMeta(side))
    registry.register(quotationItemMeta(side))
    registry.register(quotationTierMeta(side))
    registry.register(orderHeadMeta(side))
    registry.register(orderItemMeta(side))
    registry.register(fulfillmentHeadMeta(side))
    registry.register(fulfillmentItemMeta(side))
    registry.register(reconciliationHeadMeta(side))
    registry.register(reconciliationItemMeta(side))
  }
  registry.register(packBoxMeta())
  registry.register(packLineMeta())
  registry.register(orderMaterialMeta())
  registry.register(orderByproductMeta())
  registry.register(outsourcedIssueMeta())
  registry.register(outsourcedIssueItemMeta())
  registry.register(outsourcedReceiptMeta())
  registry.register(outsourcedReceiptItemMeta())
  registry.register(outsourcedReceiptItemMaterialMeta())
  registry.register(outsourcedReceiptItemByproductMeta())
}

export function createTradingServices(
  db: Kysely<Database>,
  numbering: NumberingService,
  registry: Registry,
) {
  const gl = createGlEngine()
  const inventory = createInventoryEngine()
  const engines = { inventory, gl }
  const quotations = createQuotationService(db, numbering, registry)
  const outsourcedConfig = createOutsourcedConfigService(db, registry)
  const orders = createOrderService(db, numbering, quotations, registry, outsourcedConfig.draft)
  const fulfillment = createFulfillmentService(db, numbering, engines, registry)
  const outsourced = createOutsourcedService(db, numbering, engines, registry)
  const reconciliations = createReconciliationService(db, numbering, gl, registry)
  return { quotations, orders, outsourcedConfig, fulfillment, outsourced, reconciliations }
}

export type TradingServices = ReturnType<typeof createTradingServices>

export function tradingRouteMounts(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  trading: TradingServices
}) {
  const { auth, authz, trading } = deps
  const { quotations, orders, outsourcedConfig, fulfillment, outsourced, reconciliations } =
    trading
  const purchaseExtra = purchaseOrderExtraRoutes({ auth, authz, outsourcedConfig })
  return {
    salesQuotations: quotationHeadRoutes({ auth, authz, quotations, side: 'sales' }),
    salesQuotationItems: quotationItemRoutes({ auth, authz, quotations, side: 'sales' }),
    salesQuotationTiers: quotationTierRoutes({ auth, authz, quotations, side: 'sales' }),
    purchaseQuotations: quotationHeadRoutes({ auth, authz, quotations, side: 'purchase' }),
    purchaseQuotationItems: quotationItemRoutes({ auth, authz, quotations, side: 'purchase' }),
    purchaseQuotationTiers: quotationTierRoutes({ auth, authz, quotations, side: 'purchase' }),
    salesOrders: orderHeadRoutes({ auth, authz, orders, side: 'sales' }),
    salesOrderItems: orderItemRoutes({ auth, authz, orders, side: 'sales' }),
    purchaseOrders: orderHeadRoutes({ auth, authz, orders, side: 'purchase' }),
    purchaseOrderItems: orderItemRoutes({ auth, authz, orders, side: 'purchase' }),
    purchaseOrderItemMaterials: purchaseExtra.material,
    purchaseOrderItemByproducts: purchaseExtra.byproduct,
    purchaseOrderDemandLines: purchaseExtra.demand,
    purchaseOrderBom: purchaseExtra.bom,
    salesDeliveries: salesFulfillmentHeadRoutes({ auth, authz, fulfillment }),
    salesDeliveryItems: salesFulfillmentItemRoutes({ auth, authz, fulfillment }),
    salesDeliveryPackBoxes: packBoxRoutes({ auth, authz, fulfillment }),
    salesDeliveryPackLines: packLineRoutes({ auth, authz, fulfillment }),
    purchaseReceipts: purchaseFulfillmentHeadRoutes({ auth, authz, fulfillment }),
    purchaseReceiptItems: purchaseFulfillmentItemRoutes({ auth, authz, fulfillment }),
    outsourcedIssues: outsourcedIssueRoutes({ auth, authz, outsourced }),
    outsourcedIssueItems: outsourcedIssueItemRoutes({ auth, authz, outsourced }),
    outsourcedReceipts: outsourcedReceiptRoutes({ auth, authz, outsourced }),
    outsourcedReceiptItems: outsourcedReceiptItemRoutes({ auth, authz, outsourced }),
    outsourcedReceiptItemMaterials: outsourcedReceiptMaterialRoutes({ auth, authz, outsourced }),
    outsourcedReceiptItemByproducts: outsourcedReceiptByproductRoutes({ auth, authz, outsourced }),
    salesReconciliations: reconciliationHeadRoutes({
      auth,
      authz,
      reconciliations,
      side: 'sales',
    }),
    salesReconciliationItems: reconciliationItemRoutes({
      auth,
      authz,
      reconciliations,
      side: 'sales',
    }),
    purchaseReconciliations: reconciliationHeadRoutes({
      auth,
      authz,
      reconciliations,
      side: 'purchase',
    }),
    purchaseReconciliationItems: reconciliationItemRoutes({
      auth,
      authz,
      reconciliations,
      side: 'purchase',
    }),
  }
}

export type { QuotationService } from './quotation/service.ts'
export type { OrderService } from './order/service.ts'
export type { OutsourcedConfigService } from './order/outsourced-config.ts'
export type { FulfillmentService } from './fulfillment/service.ts'
export type { ReconciliationService } from './reconciliation/service.ts'
export {
  createSalesOrderDocBuilder,
  registerSalesOrderDocBuilder,
} from './order/docbuilder.ts'
