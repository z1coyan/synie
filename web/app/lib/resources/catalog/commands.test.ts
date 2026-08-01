import { describe, expect, test } from 'bun:test'
import {
  createCommandAdapter,
  createRowCommandAdapter,
  decodeBulkTarget,
  decodeCollectionTarget,
  decodeRowOrBulkTarget,
  decodeRowTarget,
  defineCommand,
  executeSingleRowCommand,
} from './commands'
import { attendanceDayCommandAdapter } from '../hr-operations'
import { bankTransactionCommandAdapter } from '../finance-operations'
import { glJournalCommandAdapter } from '../accounting'
import {
  stockCountCommandAdapter,
  stockDocCommandAdapter,
  stockTransferCommandAdapter,
} from '../inventory'
import {
  outputCommandAdapter,
  workOrderCommandAdapter,
} from '../manufacturing'
import {
  purchaseReconciliationCommandAdapter,
  salesReconciliationCommandAdapter,
} from '../reconciliations'
import {
  purchaseOutsourcedIssueCommandAdapter,
  purchaseOutsourcedReceiptCommandAdapter,
  purchaseReceiptCommandAdapter,
  salesDeliveryCommandAdapter,
} from '../fulfillment'
import {
  purchaseOrderCommandAdapter,
  salesOrderCommandAdapter,
} from '../orders'
import {
  purchaseQuotationCommandAdapter,
  salesQuotationCommandAdapter,
} from '../quotations'

describe('Command target 解码 fail-closed', () => {
  test('row：恰好一个 id；拒绝 ids / 空 / 非对象', () => {
    expect(decodeRowTarget({ id: 'a' })).toBe('a')
    expect(() => decodeRowTarget({ ids: ['a'] })).toThrow(/不接受 ids/)
    expect(() => decodeRowTarget({ id: '' })).toThrow(/非空/)
    expect(() => decodeRowTarget(null)).toThrow(/对象/)
    expect(() => decodeRowTarget({})).toThrow(/非空/)
  })

  test('bulk：非空 ids；空数组失败', () => {
    expect(decodeBulkTarget({ ids: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(() => decodeBulkTarget({ ids: [] })).toThrow(/不可为空/)
    expect(() => decodeBulkTarget({ id: 'a' })).toThrow(/非空 ids/)
    expect(() => decodeBulkTarget({})).toThrow(/非空 ids/)
  })

  test('rowOrBulk：至少一个 id', () => {
    expect(decodeRowOrBulkTarget({ id: 'x' })).toEqual(['x'])
    expect(decodeRowOrBulkTarget({ ids: ['x'] })).toEqual(['x'])
    expect(() => decodeRowOrBulkTarget({ ids: [] })).toThrow(/不可为空/)
  })

  test('collection：不接受伪造记录 target；允许领域 payload', () => {
    expect(decodeCollectionTarget({ dateFrom: '2026-01-01', dateTo: '2026-01-31' })).toEqual({
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
    })
    expect(() => decodeCollectionTarget({ id: 'x' })).toThrow(/不需要记录 ID/)
    expect(() => decodeCollectionTarget({ ids: ['x'] })).toThrow(/不需要记录 ID/)
    expect(decodeCollectionTarget({})).toEqual({})
  })
})

describe('已迁移语义 CommandAdapter 契约', () => {
  test('单记录界面命令把保存后的唯一 id 作为 row target 传给审核', async () => {
    const received: string[] = []
    const adapter = createRowCommandAdapter({
      audit: {
        handler: async (id) => {
          received.push(id)
        },
        affectedResources: ['orderItems'],
      },
      legacy: async (id) => received.push(`legacy:${id}`),
    })

    await executeSingleRowCommand(adapter, 'audit', 'saved-order-id')
    await executeSingleRowCommand(adapter, 'legacy', 'old-handler-id')

    expect(received).toEqual(['saved-order-id', 'legacy:old-handler-id'])
    expect(adapter.commands.audit.affectedResources).toEqual(['orderItems'])
    expect(adapter.commands.legacy.affectedResources).toBeUndefined()
  })

  test('recalc：collection target，不要求记录 ID', async () => {
    expect(attendanceDayCommandAdapter.commands.recalc.target).toBe('collection')
    expect(Object.keys(attendanceDayCommandAdapter.commands)).toEqual(['recalc'])
    await expect(
      attendanceDayCommandAdapter.execute('recalc', { id: 'fake' } as never),
    ).rejects.toThrow(/不需要记录 ID/)
    await expect(
      attendanceDayCommandAdapter.execute('recalc', {
        dateFrom: 'bad',
        dateTo: '2026-01-01',
      } as never),
    ).rejects.toThrow(/dateFrom/)
  })

  test('reconcile：语义 key 非 export；row target', async () => {
    expect(bankTransactionCommandAdapter.commands.reconcile.target).toBe('row')
    expect(Object.keys(bankTransactionCommandAdapter.commands)).toEqual(['reconcile'])
    expect('export' in bankTransactionCommandAdapter.commands).toBe(false)
    await expect(
      bankTransactionCommandAdapter.execute('reconcile', { ids: ['a'] } as never),
    ).rejects.toThrow()
    await expect(
      bankTransactionCommandAdapter.execute('reconcile', { id: 'a' } as never),
    ).rejects.toThrow(/journalId/)
  })

  test('createCommandAdapter 未知 key 失败', async () => {
    const adapter = createCommandAdapter({
      ping: defineCommand('collection', async () => 'pong'),
    })
    await expect(adapter.execute('ping', {})).resolves.toBe('pong')
    await expect(adapter.execute('missing' as 'ping', {})).rejects.toThrow(/未知命令/)
  })

  test('库存、制造、对账与总账命令共置可证明的跨资源 effects', () => {
    expect(
      bankTransactionCommandAdapter.commands.reconcile.affectedResources,
    ).toEqual(['accBankReconciliations'])
    expect(stockDocCommandAdapter.commands.audit.affectedResources).toEqual([
      'invStockEntries',
    ])
    expect(stockCountCommandAdapter.commands.cancel.affectedResources).toEqual([
      'invStockEntries',
    ])
    expect(
      stockTransferCommandAdapter.commands.receive.affectedResources,
    ).toEqual(['invStockTransferItems', 'invStockEntries'])
    expect(workOrderCommandAdapter.commands.void.affectedResources).toEqual([
      'mfgDemandItems',
      'mfgDemands',
    ])
    expect(outputCommandAdapter.commands.audit.affectedResources).toEqual([
      'mfgOutputItems',
      'mfgWorkOrders',
      'mfgDemandItems',
      'mfgDemands',
      'invStockEntries',
    ])
    expect(
      salesReconciliationCommandAdapter.commands.audit.affectedResources,
    ).toEqual([
      'salReconciliationItems',
      'salDeliveryItems',
      'accGlEntries',
    ])
    expect(
      purchaseReconciliationCommandAdapter.commands.confirm.affectedResources,
    ).toEqual([
      'purReconciliationItems',
      'purReceiptItems',
      'purOutsourcedReceiptItems',
    ])
    expect(glJournalCommandAdapter.commands.audit.affectedResources).toEqual([
      'accGlEntries',
    ])
  })

  test('聚合命令 effects 与服务端投影、库存、总账和 order-flow 写集合一致', () => {
    expect(salesDeliveryCommandAdapter.commands.audit.affectedResources).toEqual([
      'salDeliveryItems',
      'salOrderItems',
      'invStockEntries',
      'accGlEntries',
      'scmOrderFlowItems',
    ])
    expect(purchaseReceiptCommandAdapter.commands.void.affectedResources).toEqual([
      'purReceiptItems',
      'purOrderItems',
      'mfgDemandItems',
      'invStockEntries',
      'accGlEntries',
      'scmOrderFlowItems',
    ])
    expect(
      purchaseOutsourcedIssueCommandAdapter.commands.audit.affectedResources,
    ).toEqual([
      'purOutsourcedIssueItems',
      'purOrderItemMaterials',
      'invStockEntries',
      'scmOrderFlowItems',
    ])
    expect(
      purchaseOutsourcedReceiptCommandAdapter.commands.audit.affectedResources,
    ).toEqual([
      'purOutsourcedReceiptItems',
      'purOrderItems',
      'mfgDemandItems',
      'invStockEntries',
      'accGlEntries',
      'scmOrderFlowItems',
    ])
    expect(salesOrderCommandAdapter.commands.close.affectedResources).toEqual([
      'salOrderItems',
    ])
    expect(purchaseOrderCommandAdapter.commands.audit.affectedResources).toEqual([
      'purOrderItems',
      'purOrderItemMaterials',
      'mfgDemandItems',
    ])
    expect(purchaseOrderCommandAdapter.commands.close.affectedResources).toEqual([
      'purOrderItems',
      'purOrderItemMaterials',
    ])
    expect(salesQuotationCommandAdapter.commands.audit.affectedResources).toEqual([
      'salQuotationItems',
    ])
    expect(
      purchaseQuotationCommandAdapter.commands.void.affectedResources,
    ).toEqual(['purQuotationItems'])
  })
})
