/**
 * 交易链装配：报价 / 订单 / 标准履约 / 委外头 / 对账。
 */
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
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
  packLineMeta,
} from './fulfillment/spec.ts'
import {
  fulfillmentHeadRoutes,
  fulfillmentItemRoutes,
  packLineRoutes,
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

export function registerTradingResources(registry: Registry): void {
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

export function createTradingServices(db: Kysely<Database>, numbering: NumberingService) {
  const quotations = createQuotationService(db, numbering)
  const orders = createOrderService(db, numbering, quotations)
  const fulfillment = createFulfillmentService(db, numbering, orders)
  const outsourced = createOutsourcedService(db, numbering, orders)
  const reconciliations = createReconciliationService(db, numbering)
  return { quotations, orders, fulfillment, outsourced, reconciliations }
}

export type TradingServices = ReturnType<typeof createTradingServices>

export function tradingRouteMounts(deps: {
  auth: AuthService
  trading: TradingServices
}) {
  const { auth, trading } = deps
  const { quotations, orders, fulfillment, outsourced, reconciliations } = trading
  const purchaseExtra = purchaseOrderExtraRoutes({ auth, orders })
  return {
    salesQuotations: quotationHeadRoutes({ auth, quotations, side: 'sales' }),
    salesQuotationItems: quotationItemRoutes({ auth, quotations, side: 'sales' }),
    salesQuotationTiers: quotationTierRoutes({ auth, quotations, side: 'sales' }),
    purchaseQuotations: quotationHeadRoutes({ auth, quotations, side: 'purchase' }),
    purchaseQuotationItems: quotationItemRoutes({ auth, quotations, side: 'purchase' }),
    purchaseQuotationTiers: quotationTierRoutes({ auth, quotations, side: 'purchase' }),
    salesOrders: orderHeadRoutes({ auth, orders, side: 'sales' }),
    salesOrderItems: orderItemRoutes({ auth, orders, side: 'sales' }),
    purchaseOrders: orderHeadRoutes({ auth, orders, side: 'purchase' }),
    purchaseOrderItems: orderItemRoutes({ auth, orders, side: 'purchase' }),
    purchaseOrderItemMaterials: purchaseExtra.material,
    purchaseOrderItemByproducts: purchaseExtra.byproduct,
    purchaseOrderDemandLines: purchaseExtra.demand,
    purchaseOrderBom: purchaseExtra.bom,
    salesDeliveries: fulfillmentHeadRoutes({ auth, fulfillment, side: 'sales' }),
    salesDeliveryItems: fulfillmentItemRoutes({ auth, fulfillment, side: 'sales' }),
    salesDeliveryPackLines: packLineRoutes({ auth, fulfillment }),
    purchaseReceipts: fulfillmentHeadRoutes({ auth, fulfillment, side: 'purchase' }),
    purchaseReceiptItems: fulfillmentItemRoutes({ auth, fulfillment, side: 'purchase' }),
    outsourcedIssues: outsourcedIssueRoutes({ auth, outsourced }),
    outsourcedIssueItems: outsourcedIssueItemRoutes({ auth, outsourced }),
    outsourcedReceipts: outsourcedReceiptRoutes({ auth, outsourced }),
    outsourcedReceiptItems: outsourcedReceiptItemRoutes({ auth, outsourced }),
    outsourcedReceiptItemMaterials: outsourcedReceiptMaterialRoutes({ auth, outsourced }),
    outsourcedReceiptItemByproducts: outsourcedReceiptByproductRoutes({ auth, outsourced }),
    salesReconciliations: reconciliationHeadRoutes({
      auth,
      reconciliations,
      side: 'sales',
    }),
    salesReconciliationItems: reconciliationItemRoutes({
      auth,
      reconciliations,
      side: 'sales',
    }),
    purchaseReconciliations: reconciliationHeadRoutes({
      auth,
      reconciliations,
      side: 'purchase',
    }),
    purchaseReconciliationItems: reconciliationItemRoutes({
      auth,
      reconciliations,
      side: 'purchase',
    }),
  }
}

export type { QuotationService } from './quotation/service.ts'
export type { OrderService } from './order/service.ts'
export type { FulfillmentService } from './fulfillment/service.ts'
export type { ReconciliationService } from './reconciliation/service.ts'
