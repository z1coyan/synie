import { describe, expect, test } from 'bun:test'
import { listResourceBindingKeys, resourceBindingFor } from './registry'

const EXPECTED_COMMANDS = {
  accBankTransactions: { reconcile: 'row' },
  accBillTransactions: { audit: 'row', void: 'row' },
  accExpenseReports: { audit: 'row', void: 'row' },
  accGlJournals: { audit: 'row', cancel: 'row' },
  accVatInvoices: { audit: 'row', void: 'row', reverse: 'row' },
  basMarketPricePoints: { void: 'row' },
  hrAttendanceDays: { recalc: 'collection' },
  invStockCounts: { approve: 'row', cancel: 'row' },
  invStockDocs: { audit: 'row', void: 'row' },
  invStockTransfers: { ship: 'row', receive: 'row' },
  mfgBoms: { activate: 'row', deactivate: 'row' },
  mfgDemands: { audit: 'row', close: 'row', void: 'row' },
  mfgOutputs: { audit: 'row', void: 'row' },
  mfgWorkOrders: { void: 'row' },
  purOrders: { audit: 'row', close: 'row', void: 'row' },
  purOutsourcedIssues: { audit: 'row', void: 'row' },
  purOutsourcedReceipts: { audit: 'row', void: 'row' },
  purOutsourcedReturns: { audit: 'row', void: 'row' },
  purQuotations: { audit: 'row', void: 'row' },
  purReceipts: { audit: 'row', void: 'row' },
  purReconciliations: { confirm: 'row', unconfirm: 'row', audit: 'row', void: 'row' },
  purReturns: { audit: 'row', void: 'row' },
  salDeliveries: { audit: 'row', void: 'row' },
  salOrders: { audit: 'row', close: 'row', void: 'row' },
  salQuotations: { audit: 'row', void: 'row' },
  salReconciliations: { confirm: 'row', unconfirm: 'row', audit: 'row', void: 'row' },
  salReturns: { audit: 'row', void: 'row', generate_replenishment: 'row' },
  sysPrintTemplates: { setDefault: 'row', unsetDefault: 'row' },
  sysStorages: { setDefault: 'row' },
} as const

describe('ResourceBinding 语义 CommandAdapter 覆盖', () => {
  test('声明命令的 28 个资源均由显式 key/target adapter 覆盖', () => {
    let commandCount = 0
    for (const [resource, expected] of Object.entries(EXPECTED_COMMANDS)) {
      const commands = resourceBindingFor(resource).commands?.commands
      expect(commands, resource).toBeDefined()
      const actual = Object.fromEntries(
        Object.entries(commands ?? {}).map(([key, command]) => [key, command.target]),
      )
      expect(actual, resource).toEqual(expected)
      commandCount += Object.keys(actual).length
    }
    expect(commandCount).toBe(62)
  })

  test('未声明命令的资源不获得 Proxy/action fallback', () => {
    for (const resource of listResourceBindingKeys()) {
      if (resource in EXPECTED_COMMANDS) continue
      expect(resourceBindingFor(resource).commands, resource).toBeUndefined()
    }
  })
})
