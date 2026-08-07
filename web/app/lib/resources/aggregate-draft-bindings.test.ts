import { describe, expect, test } from 'bun:test'
import {
  purchaseOutsourcedIssueCommandAdapter,
  purchaseOutsourcedReceiptCommandAdapter,
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
import {
  purchaseReconciliationCommandAdapter,
  salesReconciliationCommandAdapter,
} from './reconciliations'
import { purchaseReceiptDraftAdapter } from './purchase-receipt-draft'
import {
  purchaseQuotationDraftAdapter,
  salesQuotationDraftAdapter,
} from './quotation-draft'
import {
  purchaseOrderDraftAdapter,
  salesOrderDraftAdapter,
} from './order-draft'
import {
  purchaseReconciliationDraftAdapter,
  salesReconciliationDraftAdapter,
} from './reconciliation-draft'
import {
  purchaseOutsourcedIssueDraftAdapter,
  purchaseOutsourcedReceiptDraftAdapter,
} from './outsourced-draft'
import {
  aggregateDraftFor,
  resourceBindingFor,
} from './registry'

const aggregateResources = {
  purOrders: {
    draft: purchaseOrderDraftAdapter,
    commands: purchaseOrderCommandAdapter,
  },
  purOutsourcedIssues: {
    draft: purchaseOutsourcedIssueDraftAdapter,
    commands: purchaseOutsourcedIssueCommandAdapter,
  },
  purOutsourcedReceipts: {
    draft: purchaseOutsourcedReceiptDraftAdapter,
    commands: purchaseOutsourcedReceiptCommandAdapter,
  },
  purQuotations: {
    draft: purchaseQuotationDraftAdapter,
    commands: purchaseQuotationCommandAdapter,
  },
  purReceipts: {
    draft: purchaseReceiptDraftAdapter,
    commands: purchaseReceiptCommandAdapter,
  },
  purReconciliations: {
    draft: purchaseReconciliationDraftAdapter,
    commands: purchaseReconciliationCommandAdapter,
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
  salReconciliations: {
    draft: salesReconciliationDraftAdapter,
    commands: salesReconciliationCommandAdapter,
  },
} as const

describe('Aggregate Draft ResourceBinding 能力边界', () => {
  test('十个聚合头只经 draft 创建/替换，普通 writer 仅保留删除', () => {
    for (const [resource, expected] of Object.entries(aggregateResources)) {
      const key = resource as keyof typeof aggregateResources
      const binding = resourceBindingFor(key)
      const writer = binding.writer as
        | {
            create?: unknown
            update?: unknown
            delete?: unknown
          }
        | undefined

      expect(binding.draft, `${resource}.draft`).toBe(expected.draft)
      expect(aggregateDraftFor(key), `${resource} typed draft`).toBe(
        expected.draft,
      )
      expect(writer?.create, `${resource}.writer.create`).toBeUndefined()
      expect(writer?.update, `${resource}.writer.update`).toBeUndefined()
      expect(typeof writer?.delete, `${resource}.writer.delete`).toBe(
        'function',
      )
    }
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
