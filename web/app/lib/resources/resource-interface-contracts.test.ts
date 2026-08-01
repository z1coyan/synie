import { describe, expect, test } from 'bun:test'
import {
  resolveSource,
  listRemoteDefaultKeys,
} from '~/components/synie-remote-select/remote-query'
import {
  listResourceBindingKeys,
  resourceBindingFor,
  resourceTransportFor,
} from './registry'

const EXPECTED_RESOURCES = [
  'accBankAccounts',
  'accBankImportItems',
  'accBankImportTemplates',
  'accBankImports',
  'accBankReconciliations',
  'accBankTransactions',
  'accBillHoldings',
  'accBillTransactions',
  'accBills',
  'accExpenseReportItems',
  'accExpenseReports',
  'accGlEntries',
  'accGlJournalLines',
  'accGlJournals',
  'accSettings',
  'accVatInvoices',
  'basAccounts',
  'basCompanies',
  'basCurrencies',
  'basMarketInstruments',
  'basMarketPricePoints',
  'basUnits',
  'hrAttendanceCorrections',
  'hrAttendanceDays',
  'hrAttendanceImports',
  'hrAttendancePunches',
  'hrEmployeeLoans',
  'hrEmployees',
  'hrPayrollPayments',
  'hrPayrolls',
  'invMaterialCategories',
  'invMaterialUnits',
  'invMaterials',
  'invStockCountItems',
  'invStockCounts',
  'invStockDocItems',
  'invStockDocs',
  'invStockEntries',
  'invStockTransferItems',
  'invStockTransfers',
  'invWarehouses',
  'mfgBomByproducts',
  'mfgBomComponents',
  'mfgBomRoutes',
  'mfgBoms',
  'mfgDemandItems',
  'mfgDemands',
  'mfgOperations',
  'mfgOutputItems',
  'mfgOutputs',
  'mfgProcessTemplateItems',
  'mfgProcessTemplates',
  'mfgSettings',
  'mfgWorkOrders',
  'purOrderItemByproducts',
  'purOrderItemMaterials',
  'purOrderItems',
  'purOrders',
  'purOutsourcedIssueItems',
  'purOutsourcedIssues',
  'purOutsourcedReceiptItemByproducts',
  'purOutsourcedReceiptItemMaterials',
  'purOutsourcedReceiptItems',
  'purOutsourcedReceipts',
  'purQuotationItems',
  'purQuotationTiers',
  'purQuotations',
  'purReceiptItems',
  'purReceipts',
  'purReconciliationItems',
  'purReconciliations',
  'purSuppliers',
  'salCompanyAccountDefaults',
  'salCustomers',
  'salDeliveries',
  'salDeliveryItems',
  'salDeliveryPackBoxes',
  'salDeliveryPackLines',
  'salOrderItems',
  'salOrders',
  'salQuotationItems',
  'salQuotationTiers',
  'salQuotations',
  'salReconciliationItems',
  'salReconciliations',
  'salSettings',
  'scmOrderFlowItems',
  'sysAuditLogs',
  'sysFiles',
  'sysNumberingCounters',
  'sysNumberingRules',
  'sysPrintTemplates',
  'sysRoles',
  'sysSettings',
  'sysUsers',
] as const

const READ_ONLY_RESOURCES = [
  'accBillHoldings',
  'accGlEntries',
  'hrAttendanceDays',
  'hrAttendancePunches',
  'invStockEntries',
  'salDeliveryItems',
  'salDeliveryPackBoxes',
  'salDeliveryPackLines',
  'scmOrderFlowItems',
  'sysAuditLogs',
] as const

const COMPLEX_DRAWER_CACHE_RESOURCES = [
  'mfgBoms',
  'mfgBomComponents',
  'mfgBomRoutes',
  'mfgBomByproducts',
  'mfgDemands',
  'mfgDemandItems',
  'mfgOutputs',
  'mfgOutputItems',
  'mfgWorkOrders',
  'salReconciliations',
  'salReconciliationItems',
  'purReconciliations',
  'purReconciliationItems',
  'purOutsourcedIssues',
  'purOutsourcedIssueItems',
  'purOrderItemMaterials',
  'purOutsourcedReceipts',
  'purOutsourcedReceiptItems',
  'purOutsourcedReceiptItemMaterials',
  'purOutsourcedReceiptItemByproducts',
  'purOrderItems',
  'salDeliveries',
  'salDeliveryItems',
  'salDeliveryPackBoxes',
  'salDeliveryPackLines',
  'salOrderItems',
] as const

const DIRECT_CONVEX_TRANSPORTS = new Set(['sysFiles', 'sysPrintTemplates'])

describe('生产 ResourceBinding interface 契约', () => {
  test('资源从同一 binding seam 到达各自唯一 Convex transport', () => {
    expect(listResourceBindingKeys()).toEqual([...EXPECTED_RESOURCES])

    for (const resource of EXPECTED_RESOURCES) {
      const binding = resourceBindingFor(resource)
      const transport = resourceTransportFor(resource)
      const remote = resolveSource({ resource })
      const transportId = DIRECT_CONVEX_TRANSPORTS.has(resource)
        ? `convex:${resource}`
        : `convex-unbound:${resource}`
      expect(binding.resource).toBe(resource)
      expect(transport.id).toBe(transportId)
      expect(binding.cache.gridScope).toEqual(['gridRows', transportId, resource])
      expect(remote?.client.id).toBe(transportId)
    }
  })

  test('只读资源不伪造 Writer，销售发货写入只暴露聚合草稿 seam', () => {
    const actualReadOnly = listResourceBindingKeys().filter(
      (resource) => resourceBindingFor(resource).writer === undefined,
    )
    expect(actualReadOnly).toEqual([...READ_ONLY_RESOURCES])

    const delivery = resourceBindingFor('salDeliveries')
    expect(delivery.writer?.create).toBeUndefined()
    expect(delivery.writer?.update).toBeUndefined()
    expect(typeof delivery.writer?.delete).toBe('function')
    expect(typeof delivery.draft?.loadDraft).toBe('function')
    expect(typeof delivery.draft?.createDraft).toBe('function')
    expect(typeof delivery.draft?.replaceDraft).toBe('function')
  })

  test('复杂 Drawer 的跨资源刷新由各自 binding 发布缓存身份', async () => {
    const invalidated: Array<readonly unknown[]> = []
    const queryClient = {
      invalidateQueries: async ({
        queryKey,
      }: {
        queryKey: readonly unknown[]
      }) => {
        invalidated.push(queryKey)
      },
    }

    for (const resource of COMPLEX_DRAWER_CACHE_RESOURCES) {
      await resourceBindingFor(resource).cache.invalidateGrid(queryClient)
    }
    expect(invalidated).toEqual(
      COMPLEX_DRAWER_CACHE_RESOURCES.map((resource) => [
        'gridRows',
        `convex-unbound:${resource}`,
        resource,
      ]),
    )

    invalidated.length = 0
    await resourceBindingFor('purOutsourcedReceipts').cache.invalidateAll(
      queryClient,
    )
    expect(invalidated).toEqual([
      ['gridRows', 'convex-unbound:purOutsourcedReceipts', 'purOutsourcedReceipts'],
      ['rowById', 'convex-unbound:purOutsourcedReceipts', 'purOutsourcedReceipts'],
    ])
    expect(
      resourceBindingFor('salDeliveries').cache.rowKey('delivery-1'),
    ).toEqual(['rowById', 'convex-unbound:salDeliveries', 'salDeliveries', 'delivery-1'])
  })

  test('远程选择器不维护第二份默认表，未知资源 fail-closed', () => {
    expect(listRemoteDefaultKeys()).toEqual([])
    expect(resolveSource({})).toBeNull()
    expect(() => resourceBindingFor('__missing_resource__')).toThrow(
      /未注册 ResourceBinding/,
    )
    expect(() => resourceTransportFor('__missing_resource__')).toThrow(
      /未注册 ResourceBinding/,
    )
    expect(() => resolveSource({ resource: '__missing_resource__' })).toThrow(
      /未注册 ResourceBinding/,
    )
  })
})
