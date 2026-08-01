import { describe, expect, test } from 'bun:test'
import { resourceManifest } from './resourceManifest'
import { legacySqlTables, tableManifest } from './tableManifest'
import { decimalManifest, legacyNumericColumns } from './decimalManifest'

describe('Convex migration ledger', () => {
  test('covers every current SQL table and sealed Catalog resource exactly once', () => {
    expect(tableManifest).toHaveLength(105)
    expect(new Set(tableManifest.map((entry) => entry.legacyTable)).size).toBe(105)
    expect(tableManifest.map((entry) => entry.legacyTable)).toEqual([...legacySqlTables])

    expect(resourceManifest).toHaveLength(100)
    expect(new Set(resourceManifest.map((entry) => entry.resource)).size).toBe(100)
  })

  test('proves every legacy numeric column fits scaled signed int64', () => {
    expect(legacyNumericColumns).toHaveLength(148)
    expect(decimalManifest).toHaveLength(148)
    expect(new Set(decimalManifest.map((entry) => entry.legacyColumn)).size).toBe(148)
    for (const entry of decimalManifest) {
      expect([2, 4, 6]).toContain(entry.scale)
      expect(entry.maxAbsScaled).toBeLessThan(9_223_372_036_854_775_807n)
    }
  })

  test('切流后所有活动资源只保留 Convex 写权威', () => {
    const convexWriters = resourceManifest
      .filter((entry) => entry.writerAuthority.convexMode === 'convex')
      .map((entry) => entry.resource)
      .sort()
    expect(convexWriters).toHaveLength(99)
    for (const entry of resourceManifest) {
      expect(entry.writerAuthority.legacyMode).toBe('none')
      expect(entry.writerAuthority.convexMode === 'convex' || entry.writerAuthority.convexMode === 'none').toBe(true)
    }
  })

  test('Plan 004 facts、numbering 与 formal audit 有显式去向', () => {
    const targets = new Map(tableManifest.map((entry) => [entry.legacyTable, entry.disposition]))
    expect(targets.get('inv_stock_entry')).toEqual({ targetTable: 'stockEntries' })
    expect(targets.get('acc_gl_entry')).toEqual({ targetTable: 'glEntries' })
    expect(targets.get('sys_numbering_rule')).toEqual({ targetTable: 'numberingRules' })
    expect(targets.get('sys_numbering_counter')).toEqual({ targetTable: 'numberingCounters' })
    expect(targets.get('sys_audit_log')).toEqual({ targetTable: 'auditLogs' })
    expect(resourceManifest.filter((entry) => entry.status === 'convex-verified').every((entry) => entry.audit === 'convex-formal')).toBe(true)
  })

  test('storage retirement is explicit and no target uses a later placeholder', () => {
    expect(
      resourceManifest.find((entry) => entry.resource === 'sysStorages')
        ?.retirementPlan,
    ).toBe('retired-by-006')
    expect(resourceManifest.find((entry) => entry.resource === 'sysStorages')).toMatchObject({
      status: 'retired', frontendBinding: false,
      writerAuthority: { legacyMode: 'none', convexMode: 'none' },
    })
    expect(
      resourceManifest.some((entry) => entry.targetFunctionModule.includes('later')),
    ).toBe(false)
  })
})
