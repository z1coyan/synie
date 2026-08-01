import { describe, expect, test } from 'bun:test'
import {
  purchaseReceiptCommandAdapter,
  salesDeliveryCommandAdapter,
  salesDeliveryDraftAdapter,
} from './fulfillment'
import {
  purchaseOrderCommandAdapter,
  salesOrderCommandAdapter,
} from './orders'
import {
  purchaseQuotationCommandAdapter,
  salesQuotationCommandAdapter,
} from './quotations'
import { purchaseReceiptDraftAdapter } from './purchase-receipt-draft'
import {
  purchaseQuotationDraftAdapter,
  salesQuotationDraftAdapter,
} from './quotation-draft'
import {
  purchaseOrderDraftAdapter,
  salesOrderDraftAdapter,
} from './order-draft'
import { expenseReportDraftAdapter } from './expense-report-draft'
import { CONVEX_DOMAIN_MANIFEST } from './convex-domain-manifest'
import {
  aggregateDraftFor,
  listAggregateDraftResourceKeys,
  resourceBindingFor,
} from './registry'

const aggregateResources = {
  purOrders: {
    draft: purchaseOrderDraftAdapter,
    commands: purchaseOrderCommandAdapter,
  },
  purQuotations: {
    draft: purchaseQuotationDraftAdapter,
    commands: purchaseQuotationCommandAdapter,
  },
  purReceipts: {
    draft: purchaseReceiptDraftAdapter,
    commands: purchaseReceiptCommandAdapter,
  },
  salDeliveries: {
    draft: salesDeliveryDraftAdapter,
    commands: salesDeliveryCommandAdapter,
  },
  salOrders: {
    draft: salesOrderDraftAdapter,
    commands: salesOrderCommandAdapter,
  },
  salQuotations: {
    draft: salesQuotationDraftAdapter,
    commands: salesQuotationCommandAdapter,
  },
} as const

const manifestAggregateResources = Object.entries(CONVEX_DOMAIN_MANIFEST)
  .filter(([, manifest]) => manifest.aggregate)
  .map(([resource]) => resource)
  .sort()

describe('Aggregate Draft ResourceBinding 能力边界', () => {
  test('生成 manifest 中全部聚合头均只经 draft 创建/替换，普通 writer 仅保留删除', () => {
    const registered = listAggregateDraftResourceKeys()
    expect(registered.map(String)).toEqual(manifestAggregateResources)

    for (const resource of registered) {
      const binding = resourceBindingFor(resource)
      const writer = binding.writer as
        | {
            create?: unknown
            update?: unknown
            delete?: unknown
          }
        | undefined

      expect(binding.draft, `${resource}.draft`).toBeDefined()
      expect(aggregateDraftFor(resource), `${resource} typed draft`).toBe(binding.draft!)
      expect(writer?.create, `${resource}.writer.create`).toBeUndefined()
      expect(writer?.update, `${resource}.writer.update`).toBeUndefined()
      expect(typeof writer?.delete, `${resource}.writer.delete`).toBe(
        'function',
      )
    }
  })

  test('既有具名 adapter 与费用报销 adapter 保持模块级对象身份', () => {
    for (const [resource, expected] of Object.entries(aggregateResources)) {
      const key = resource as keyof typeof aggregateResources
      expect(aggregateDraftFor(key), `${resource}.draft`).toBe(expected.draft)
    }
    expect(aggregateDraftFor('accExpenseReports')).toBe(expenseReportDraftAdapter)
  })

  test('挂载 draft 不替换既有语义命令适配器', () => {
    for (const [resource, expected] of Object.entries(aggregateResources)) {
      const key = resource as keyof typeof aggregateResources
      expect(resourceBindingFor(key).commands, `${resource}.commands`).toBe(
        expected.commands,
      )
    }
  })
})
