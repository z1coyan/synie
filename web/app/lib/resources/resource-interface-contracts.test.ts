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
  'sysStorages',
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

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method
  return input instanceof Request ? input.method : 'GET'
}

describe('生产 ResourceBinding interface 契约', () => {
  test('96 个资源从同一 binding seam 到达类型化 REST Adapter', async () => {
    expect(listResourceBindingKeys()).toEqual([...EXPECTED_RESOURCES])

    const requests: Array<{ url: string; method: string }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: requestUrl(input),
        method: requestMethod(input, init),
      })
      return Response.json({ count: 0, results: [] })
    }) as typeof fetch

    try {
      for (const resource of EXPECTED_RESOURCES) {
        const binding = resourceBindingFor(resource)
        const transport = resourceTransportFor(resource)
        const remote = resolveSource({ resource })

        expect(binding.resource).toBe(resource)
        expect(transport.id).toBe(`rest:${resource}`)
        expect(binding.cache.gridScope).toEqual([
          'gridRows',
          `rest:${resource}`,
          resource,
        ])
        expect(remote?.client.id).toBe(`rest:${resource}`)
        const result = await binding.reader.query({ limit: 1, offset: 0 })
        expect(typeof result.count, resource).toBe('number')
        expect(Array.isArray(result.results), resource).toBe(true)
      }
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(requests).toHaveLength(EXPECTED_RESOURCES.length)
    expect(new Set(requests.map(({ url }) => url)).size).toBe(
      EXPECTED_RESOURCES.length,
    )
    for (const request of requests) {
      expect(request.url).toStartWith('/api/v1/')
      expect(request.url).not.toContain('/graphql')
      expect(['GET', 'POST']).toContain(request.method)
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
        `rest:${resource}`,
        resource,
      ]),
    )

    invalidated.length = 0
    await resourceBindingFor('purOutsourcedReceipts').cache.invalidateAll(
      queryClient,
    )
    expect(invalidated).toEqual([
      ['gridRows', 'rest:purOutsourcedReceipts', 'purOutsourcedReceipts'],
      ['rowById', 'rest:purOutsourcedReceipts', 'purOutsourcedReceipts'],
    ])
    expect(
      resourceBindingFor('salDeliveries').cache.rowKey('delivery-1'),
    ).toEqual(['rowById', 'rest:salDeliveries', 'salDeliveries', 'delivery-1'])
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
